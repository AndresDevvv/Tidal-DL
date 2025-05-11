'use strict';

import readline from 'readline';
import path from 'path';
import { promises as fs } from 'fs';
import axios from 'axios';

import { authenticate } from './v2/login.mjs';
import { downloadMusicTrack } from './v2/music.mjs';
import { downloadVideo, fetchAvailableVideoStreams } from './v2/video.mjs';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const UI_TEXT = {
    WELCOME_BANNER_TOP: "╔═════════════════════════════════════════════════╗",
    WELCOME_BANNER_MID: "║         Welcome to Tidal Downloader!          ║",
    WELCOME_BANNER_BOT: "╚═════════════════════════════════════════════════╝",
    ARIA2C_NOTICE: "\nMake sure you have 'aria2c' installed and in your system's PATH.",
    DOWNLOAD_DIR_NOTICE: "Downloads will be saved in a './downloads' directory relative to this script.",
    AUTHENTICATING_MSG: "\nAttempting to authenticate with Tidal...",
    AUTH_SUCCESS_MSG: "\n✅ Successfully authenticated with Tidal!",
    AUTH_FAILED_MSG: "\nAuthentication failed, or no valid session obtained. Cannot proceed.",
    AUTH_RETRY_PROMPT: "Please ensure you complete the device authorization if prompted.",
    SEPARATOR_LINE: "\n---------------------------------------------",
    MAIN_MENU_PROMPT: "What would you like to do?",
    EXIT_MESSAGE: "\nExiting. Goodbye! 👋",
    INVALID_CHOICE: "Invalid choice. Please try again.",
    DOWNLOAD_ANOTHER_PROMPT: "\nDo you want to download another item?",
};

const APP_CONFIG = {
    OUTPUT_BASE_DIR: './downloads',
    MUSIC_SUBDIR: 'music',
    VIDEO_SUBDIR: 'videos',
    DEFAULT_AXIOS_TIMEOUT: 15000,
    MAX_FILENAME_LENGTH: 200,
};

const ITEM_TYPE = {
    SONG: 'song',
    VIDEO: 'video',
};

const TIDAL_URL_PATTERNS = {
    TRACK: /\/(?:browse\/)?track\/(\d+)/,
    VIDEO: /\/(?:browse\/)?video\/(\d+)/,
};

const AUDIO_QUALITIES = [
    { name: "Standard (AAC 96 kbps)", apiCode: "LOW" },
    { name: "High (AAC 320 kbps)", apiCode: "HIGH" },
    { name: "HiFi (CD Quality FLAC 16-bit/44.1kHz - Lossless)", apiCode: "LOSSLESS" },
    { name: "Max (HiRes FLAC up to 24-bit/192kHz - Lossless)", apiCode: "HI_RES_LOSSLESS" }
];

const MAIN_MENU_OPTIONS = [
    { id: 'DOWNLOAD_SONG', name: 'Download a Song' },
    { id: 'DOWNLOAD_VIDEO', name: 'Download a Music Video' },
    { id: 'EXIT', name: 'Exit' },
];

function askQuestion(query) {
  return new Promise(resolve => rl.question(query, resolve));
}

async function promptUserForSelection(promptMessage, options, optionFormatter = (opt) => opt.name || opt) {
    console.log(`\n${promptMessage}`);
    options.forEach((option, index) => {
        console.log(`  ${index + 1}. ${optionFormatter(option)}`);
    });

    let choiceIndex = -1;
    const maxChoice = options.length;
    while (choiceIndex < 0 || choiceIndex >= maxChoice) {
        const answer = await askQuestion(`Select an option (1-${maxChoice}): `);
        const parsedAnswer = parseInt(answer, 10);
        if (!isNaN(parsedAnswer) && parsedAnswer >= 1 && parsedAnswer <= maxChoice) {
            choiceIndex = parsedAnswer - 1;
        } else {
            console.log(`Invalid selection. Please enter a number between 1 and ${maxChoice}.`);
        }
    }
    return options[choiceIndex];
}

async function promptUserForConfirmation(promptMessage, defaultValue = true) {
    const reminder = defaultValue ? '(Y/n)' : '(y/N)';
    const validYes = ['yes', 'y'];
    const validNo = ['no', 'n'];

    while (true) {
        const answer = (await askQuestion(`${promptMessage} ${reminder}: `)).toLowerCase().trim();
        if (answer === '') return defaultValue;
        if (validYes.includes(answer)) return true;
        if (validNo.includes(answer)) return false;
        console.log("Invalid input. Please enter 'yes' or 'no'.");
    }
}

function extractIdFromTidalUrl(url, itemType) {
    if (!url || typeof url !== 'string') return null;
    const regex = itemType === ITEM_TYPE.SONG ? TIDAL_URL_PATTERNS.TRACK : TIDAL_URL_PATTERNS.VIDEO;
    const match = url.match(regex);
    return match && match[1] ? { type: itemType, id: match[1] } : null;
}

async function fetchHtmlContent(url) {
    const urlObj = new URL(url);
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Language': 'en-US,en;q=0.9',
        'Host': urlObj.hostname,
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Connection': 'keep-alive',
    };

    try {
        const response = await axios.get(url, { headers, timeout: APP_CONFIG.DEFAULT_AXIOS_TIMEOUT });
        return response.data;
    } catch (error) {
        console.error(`Error fetching HTML from ${url}: ${error.message}`);
        if (error.response) {
            console.error(`Status: ${error.response.status}, Data (first 200 chars): ${String(error.response.data).substring(0, 200)}`);
        } else if (error.request) {
            console.error('No response received from server.');
        }
        throw error;
    }
}

function parseOgMetaProperty(htmlContent, property) {
    const regex = new RegExp(`<meta[^>]*property="og:${property}"[^>]*content="([^"]+)"`, 'i');
    const match = htmlContent.match(regex);
    return match ? match[1] : null;
}

function normalizeTidalTrackUrlForMetadata(inputUrlStr) {
    try {
        const url = new URL(inputUrlStr);
        let path = url.pathname;

        if (path.startsWith('/u/')) path = path.substring(2);

        const segments = path.split('/').filter(Boolean);
        let trackId = null;

        if (segments[0] === 'track' && segments[1]) {
            trackId = segments[1];
        } else if (segments[0] === 'browse' && segments[1] === 'track' && segments[2]) {
            trackId = segments[2];
        }

        if (trackId && /^\d+$/.test(trackId)) {
            return `${url.protocol}//${url.host}/browse/track/${trackId}`;
        }
        return inputUrlStr;
    } catch (e) {
        return inputUrlStr;
    }
}

async function fetchTrackMetadataForRenaming(trackUrl) {
    const urlToFetch = normalizeTidalTrackUrlForMetadata(trackUrl);
    if (urlToFetch !== trackUrl) {
        console.log(`Normalized URL for metadata fetching: ${urlToFetch}`);
    }

    try {
        console.log(`Fetching HTML from: ${urlToFetch}`);
        const htmlContent = await fetchHtmlContent(urlToFetch);
        let title = null;
        let artist = null;

        const pageTitleTagMatch = htmlContent.match(/<title>(.+?) by (.+?) on TIDAL<\/title>/i);
        if (pageTitleTagMatch && pageTitleTagMatch[1] && pageTitleTagMatch[2]) {
            title = pageTitleTagMatch[1].trim();
            artist = pageTitleTagMatch[2].trim();
            console.log(`Metadata from <title>: Title "${title}", Artist "${artist}"`);
        } else {
            const ogTitle = parseOgMetaProperty(htmlContent, 'title');
            if (ogTitle) {
                const parts = ogTitle.split(' - ');
                if (parts.length >= 2) {
                    title = parts[0].trim();
                    artist = parts.slice(1).join(' - ').trim();
                    console.log(`Metadata from og:title (split): Title "${title}", Artist "${artist}"`);
                } else {
                    title = ogTitle.trim();
                    console.log(`Metadata from og:title (no split): Title "${title}"`);
                }
            } else {
                console.log("Could not extract title/artist from <title> or og:title tags.");
            }
        }
        return { title, artist };
    } catch (error) {
        console.error(`Error fetching metadata from ${urlToFetch}: ${error.message}`);
        return { title: null, artist: null };
    }
}

function sanitizeFilenameSegment(name) {
    if (!name || typeof name !== 'string') return '';
    let sanitized = name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
    sanitized = sanitized.replace(/\s+/g, ' ').trim();
    return (sanitized === '' || sanitized.match(/^\.+$/)) ? 'untitled' : sanitized;
}

async function renameDownloadedSong(originalFilePath, songUrl) {
    console.log("Fetching metadata for potential renaming...");
    const { title, artist } = await fetchTrackMetadataForRenaming(songUrl);

    if (!title || !artist) {
        console.log("Skipping renaming: insufficient metadata (title/artist missing).");
        return originalFilePath;
    }

    const doRename = await promptUserForConfirmation("Rename file using Artist - Title?", true);
    if (!doRename) {
        console.log("Skipping renaming as per user choice.");
        return originalFilePath;
    }

    const fileExt = path.extname(originalFilePath);
    const outputDir = path.dirname(originalFilePath);
    const newBaseName = `${sanitizeFilenameSegment(artist)} - ${sanitizeFilenameSegment(title)}`;
    let newFilePath = path.join(outputDir, `${newBaseName}${fileExt}`);

    if (newFilePath.length > APP_CONFIG.MAX_FILENAME_LENGTH) {
        const excessLength = newFilePath.length - APP_CONFIG.MAX_FILENAME_LENGTH;
        const baseNamePathLength = newBaseName.length + outputDir.length + fileExt.length + 1;

        if (newBaseName.length > excessLength) {
             const truncatedBaseName = newBaseName.substring(0, newBaseName.length - excessLength - 3) + "...";
             newFilePath = path.join(outputDir, `${truncatedBaseName}${fileExt}`);
        } else {
            console.warn("Filename is too long even after attempting truncation. Using a generic short name.");
            newFilePath = path.join(outputDir, `tidal_download_${Date.now()}${fileExt}`);
        }
    }


    if (newFilePath === originalFilePath) {
        console.log("Generated filename is same as original. No rename needed.");
        return originalFilePath;
    }

    try {
        console.log(`Renaming "${path.basename(originalFilePath)}" to "${path.basename(newFilePath)}"`);
        await fs.rename(originalFilePath, newFilePath);
        console.log(`✅ File renamed successfully to: ${newFilePath}`);
        return newFilePath;
    } catch (renameError) {
        console.error(`❌ Failed to rename file: ${renameError.message}. Using original filename.`);
        return originalFilePath;
    }
}

async function selectAudioDownloadQuality() {
    return await promptUserForSelection(
        "Available Audio Qualities:",
        AUDIO_QUALITIES,
        (q) => `${q.name} (API Code: ${q.apiCode})`
    );
}

async function selectVideoDownloadQuality(videoId, accessToken) {
    console.log("\nFetching available video qualities...");
    try {
        const streams = await fetchAvailableVideoStreams(videoId, accessToken);
        if (!streams || streams.length === 0) {
            console.log("No video streams found or an error occurred during fetch.");
            return null;
        }
        return await promptUserForSelection(
            "Available Video Qualities (sorted best first by bandwidth):",
            streams,
            (s) => `Resolution: ${s.resolution}, Bandwidth: ${s.bandwidth} bps, Codecs: ${s.codecs}`
        );
    } catch (error) {
        console.error("Error fetching video qualities:", error.message);
        return null;
    }
}

async function handleSongDownload(session, itemUrl, itemId) {
    const selectedQuality = await selectAudioDownloadQuality();
    if (!selectedQuality) {
        console.log("No audio quality selected. Aborting song download.");
        return;
    }
    console.log(`Selected audio quality: ${selectedQuality.name}`);

    const outputDir = path.join(APP_CONFIG.OUTPUT_BASE_DIR, APP_CONFIG.MUSIC_SUBDIR);
    await fs.mkdir(outputDir, { recursive: true });

    console.log(`\n🎵 Starting download for song ID: ${itemId}`);
    console.log(`   Output directory: ${path.resolve(outputDir)}`);

    const downloadResult = await downloadMusicTrack({
        trackId: itemId,
        audioQuality: selectedQuality.apiCode,
        accessToken: session.accessToken,
        outputDir: outputDir,
        countryCode: session.countryCode
    });

    if (downloadResult && downloadResult.success && downloadResult.filePath) {
        console.log(`\n✅ Song ${itemId} (${selectedQuality.apiCode}) download process finished. Original file: ${downloadResult.filePath}`);
        const finalFilePath = await renameDownloadedSong(downloadResult.filePath, itemUrl);
        console.log(`   Final file location: ${finalFilePath}`);
    } else {
        const errorMsg = downloadResult ? downloadResult.error : 'Unknown download error';
        console.error(`\n❌ Song ${itemId} download failed. ${errorMsg}`);
    }
}

async function handleVideoDownload(session, itemUrl, itemId) {
    const selectedStream = await selectVideoDownloadQuality(itemId, session.accessToken);
    if (!selectedStream) {
        console.log("No video quality selected or error fetching. Aborting video download.");
        return;
    }
    console.log(`Selected video quality: ${selectedStream.resolution} @ ${selectedStream.bandwidth}bps`);

    const outputDir = path.join(APP_CONFIG.OUTPUT_BASE_DIR, APP_CONFIG.VIDEO_SUBDIR);
    await fs.mkdir(outputDir, { recursive: true });

    console.log(`\n🎬 Starting download for music video ID: ${itemId}`);
    console.log(`   Output directory: ${path.resolve(outputDir)}`);

    await downloadVideo({
        videoId: itemId,
        accessToken: session.accessToken,
        selectedStreamUrl: selectedStream.url,
        outputDir: outputDir,
        tidalUrl: itemUrl
    });
    console.log(`\n✅ Music video ${itemId} (Res: ${selectedStream.resolution}) download finished.`);
}

async function main() {
    console.log(UI_TEXT.WELCOME_BANNER_TOP);
    console.log(UI_TEXT.WELCOME_BANNER_MID);
    console.log(UI_TEXT.WELCOME_BANNER_BOT);
    console.log(UI_TEXT.ARIA2C_NOTICE);
    console.log(UI_TEXT.DOWNLOAD_DIR_NOTICE);

    let session;
    try {
        console.log(UI_TEXT.AUTHENTICATING_MSG);
        session = await authenticate();
    } catch (error) {
        console.error("\nFatal error during authentication:", error.message);
        rl.close();
        return;
    }

    if (!session || !session.isAccessTokenCurrentlyValid()) {
        console.error(UI_TEXT.AUTH_FAILED_MSG);
        console.log(UI_TEXT.AUTH_RETRY_PROMPT);
        rl.close();
        return;
    }
    console.log(UI_TEXT.AUTH_SUCCESS_MSG);
    console.log(`   User ID: ${session.userId}, Country: ${session.countryCode}`);

    await fs.mkdir(APP_CONFIG.OUTPUT_BASE_DIR, { recursive: true });

    while (true) {
        console.log(UI_TEXT.SEPARATOR_LINE);
        const choice = await promptUserForSelection(UI_TEXT.MAIN_MENU_PROMPT, MAIN_MENU_OPTIONS);

        if (choice.id === 'EXIT') {
            console.log(UI_TEXT.EXIT_MESSAGE);
            break;
        }

        const currentItemType = choice.id === 'DOWNLOAD_SONG' ? ITEM_TYPE.SONG : ITEM_TYPE.VIDEO;
        const exampleUrl = currentItemType === ITEM_TYPE.SONG ? 'https://tidal.com/browse/track/TRACK_ID' : 'https://tidal.com/browse/video/VIDEO_ID';
        const itemUrl = await askQuestion(`\nPlease enter the Tidal URL for the ${currentItemType} (e.g., ${exampleUrl}): `);
        const idInfo = extractIdFromTidalUrl(itemUrl, currentItemType);

        if (!idInfo) {
            console.error(`\n❌ Could not extract a ${currentItemType} ID from URL: ${itemUrl}`);
            console.error(`   Ensure URL format is like: ${exampleUrl}`);
            continue;
        }

        console.log(`\n🆔 Extracted ${idInfo.type} ID: ${idInfo.id}`);

        try {
            if (currentItemType === ITEM_TYPE.SONG) {
                await handleSongDownload(session, itemUrl, idInfo.id);
            } else {
                await handleVideoDownload(session, itemUrl, idInfo.id);
            }
        } catch (error) {
            console.error(`\n❌ Error during download of ${currentItemType} ID ${idInfo.id}: ${error.message}`);
            console.error(error.stack);
        }

        const Rerun = await promptUserForConfirmation(UI_TEXT.DOWNLOAD_ANOTHER_PROMPT, true);
        if (!Rerun) {
            console.log(UI_TEXT.EXIT_MESSAGE);
            break;
        }
    }
    rl.close();
}

main().catch(error => {
    console.error("\n🚨 Unexpected critical error in application:", error.message);
    console.error(error.stack);
    if (rl && typeof rl.close === 'function') {
        rl.close();
    }
    process.exit(1);
});