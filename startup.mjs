'use strict';

import readline from 'readline';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import util from 'util';
import { promises as fs } from 'fs';
import axios from 'axios';

import { authenticate } from './v2/login.mjs';
import { downloadMusicTrack } from './v2/music.mjs';
import { downloadVideo, fetchAvailableVideoStreams } from './v2/video.mjs';
import { fetchPlaylistMetadata, fetchPlaylistTrackIds } from './v2/playlist.mjs';

const execAsync = util.promisify(exec);
const TIDAL_API_BASE_URL = 'https://listen.tidal.com/v1';

const ANSI_COLORS = {
    green: '32',
    yellow: '33',
    red: '31',
    cyan: '36',
    dim: '2',
};

function colorize(colorCode, text) {
    if (!process.stdout.isTTY) return text;
    return `\x1b[${colorCode}m${text}\x1b[0m`;
}

function formatStatus(label, colorCode) {
    return colorize(colorCode, label);
}

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const UI_TEXT = {
    WELCOME_BANNER_TOP: "╔═════════════════════════════════════════════════╗",
    WELCOME_BANNER_MID: "║           Welcome to Tidal Downloader!          ║",
    WELCOME_BANNER_BOT: "╚═════════════════════════════════════════════════╝",
    ARIA2C_NOTICE: "\nMake sure you have 'aria2c' installed and in your system's PATH.",
    DOWNLOAD_DIR_NOTICE: "Default downloads directory is './downloads' (you can change this at startup).",
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
    DEFAULT_OUTPUT_BASE_DIR: './downloads',
    MUSIC_SUBDIR: 'music',
    VIDEO_SUBDIR: 'videos',
    PLAYLIST_SUBDIR: 'playlists',
    DEFAULT_AXIOS_TIMEOUT: 15000,
    MAX_FILENAME_LENGTH: 200,
};

const ITEM_TYPE = {
    SONG: 'song',
    VIDEO: 'video',
    PLAYLIST: 'playlist',
};

const TIDAL_URL_PATTERNS = {
    TRACK: /\/(?:browse\/)?track\/(\d+)/,
    VIDEO: /\/(?:browse\/)?video\/(\d+)/,
    PLAYLIST: /\/(?:browse\/)?playlist\/([a-f0-9-]+)/i,
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
    { id: 'DOWNLOAD_PLAYLIST', name: 'Download a Playlist' },
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

async function promptForOutputBaseDir() {
    const answer = (await askQuestion(`\nOutput base directory (default: ${APP_CONFIG.DEFAULT_OUTPUT_BASE_DIR}): `)).trim();
    if (!answer) {
        return APP_CONFIG.DEFAULT_OUTPUT_BASE_DIR;
    }
    if (answer.startsWith('~')) {
        return path.join(os.homedir(), answer.slice(1));
    }
    return answer;
}

async function promptForMp3ConversionOptions() {
    const convertToMp3 = await promptUserForConfirmation("Convert downloads to MP3 after download?", false);
    if (!convertToMp3) {
        return { enabled: false };
    }

    const bitrateAnswer = (await askQuestion("MP3 bitrate in kbps (default: 320): ")).trim();
    const bitrateKbps = bitrateAnswer === '' ? 320 : parseInt(bitrateAnswer, 10);
    const normalizedBitrate = Number.isFinite(bitrateKbps) && bitrateKbps > 0 ? bitrateKbps : 320;
    const deleteOriginal = await promptUserForConfirmation("Delete original file after MP3 conversion?", false);

    return { enabled: true, bitrateKbps: normalizedBitrate, deleteOriginal };
}

async function resolveMp3OutputPath(inputFilePath) {
    const parsed = path.parse(inputFilePath);
    if (parsed.ext.toLowerCase() === '.mp3') {
        return null;
    }

    let outputFilePath = path.join(parsed.dir, `${parsed.name}.mp3`);
    try {
        await fs.access(outputFilePath);
        outputFilePath = path.join(parsed.dir, `${parsed.name}_mp3_${Date.now()}.mp3`);
    } catch (error) {
        if (error.code !== 'ENOENT') {
            throw error;
        }
    }
    return outputFilePath;
}

async function convertFileToMp3(inputFilePath, options) {
    if (!options?.enabled) {
        return null;
    }

    const outputFilePath = await resolveMp3OutputPath(inputFilePath);
    if (!outputFilePath) {
        if (options?.verbose !== false) {
            console.log(`MP3 conversion skipped (already MP3): ${path.basename(inputFilePath)}`);
        }
        return inputFilePath;
    }

    const bitrateKbps = options.bitrateKbps || 320;
    const command = `ffmpeg -y -i "${inputFilePath}" -b:a ${bitrateKbps}k "${outputFilePath}"`;
    if (options?.verbose !== false) {
        console.log(`Converting to MP3 (${bitrateKbps} kbps): ${path.basename(outputFilePath)}`);
    }

    try {
        await execAsync(command);
        if (options.deleteOriginal) {
            await fs.unlink(inputFilePath);
        }
        return outputFilePath;
    } catch (error) {
        if (options?.verbose !== false) {
            console.error(`MP3 conversion failed for ${path.basename(inputFilePath)}: ${error.message}`);
        }
        return null;
    }
}

function extractIdFromTidalUrl(url, itemType) {
    if (!url || typeof url !== 'string') return null;
    let regex = null;
    if (itemType === ITEM_TYPE.SONG) {
        regex = TIDAL_URL_PATTERNS.TRACK;
    } else if (itemType === ITEM_TYPE.VIDEO) {
        regex = TIDAL_URL_PATTERNS.VIDEO;
    } else if (itemType === ITEM_TYPE.PLAYLIST) {
        regex = TIDAL_URL_PATTERNS.PLAYLIST;
    }
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

async function fetchTrackMetadataFromApi(trackId, accessToken, countryCode) {
    if (!trackId || !accessToken) {
        return { title: null, artist: null };
    }

    const url = new URL(`${TIDAL_API_BASE_URL}/tracks/${trackId}`);
    if (countryCode) {
        url.searchParams.set('countryCode', countryCode);
    }

    try {
        const response = await axios.get(url.toString(), {
            headers: { 'Authorization': `Bearer ${accessToken}` },
            timeout: APP_CONFIG.DEFAULT_AXIOS_TIMEOUT
        });
        const data = response.data || {};
        const title = data.title ? String(data.title).trim() : null;
        const artist = data.artist?.name ? String(data.artist.name).trim() : null;
        return { title, artist };
    } catch (error) {
        console.warn(`API metadata fetch failed for track ${trackId}: ${error.message}`);
        return { title: null, artist: null };
    }
}

function sanitizeFilenameSegment(name) {
    if (!name || typeof name !== 'string') return '';
    let sanitized = name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
    sanitized = sanitized.replace(/\s+/g, ' ').trim();
    return (sanitized === '' || sanitized.match(/^\.+$/)) ? 'untitled' : sanitized;
}

async function renameDownloadedSong(originalFilePath, songUrl, options = {}) {
    const { promptUser = true, autoRename = false, trackId = null, accessToken = null, countryCode = null, verbose = true } = options;
    const log = (...args) => {
        if (verbose) {
            console.log(...args);
        }
    };
    log("Fetching metadata for potential renaming...");
    let metadata = await fetchTrackMetadataFromApi(trackId, accessToken, countryCode);
    if (!metadata.title || !metadata.artist) {
        metadata = await fetchTrackMetadataForRenaming(songUrl);
    }
    const { title, artist } = metadata;

    if (!title || !artist) {
        log("Skipping renaming: insufficient metadata (title/artist missing).");
        return { filePath: originalFilePath, title: null, artist: null, renamed: false };
    }

    const doRename = promptUser ? await promptUserForConfirmation("Rename file using Artist - Title?", true) : autoRename;
    if (!doRename) {
        log("Skipping renaming as per user choice.");
        return { filePath: originalFilePath, title, artist, renamed: false };
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
        log("Generated filename is same as original. No rename needed.");
        return { filePath: originalFilePath, title, artist, renamed: false };
    }

    try {
        log(`Renaming "${path.basename(originalFilePath)}" to "${path.basename(newFilePath)}"`);
        await fs.rename(originalFilePath, newFilePath);
        log(`✅ File renamed successfully to: ${newFilePath}`);
        return { filePath: newFilePath, title, artist, renamed: true };
    } catch (renameError) {
        console.error(`❌ Failed to rename file: ${renameError.message}. Using original filename.`);
        return { filePath: originalFilePath, title, artist, renamed: false };
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

async function handleSongDownload(session, itemUrl, itemId, outputBaseDir, mp3Options) {
    const selectedQuality = await selectAudioDownloadQuality();
    if (!selectedQuality) {
        console.log("No audio quality selected. Aborting song download.");
        return;
    }
    console.log(`Selected audio quality: ${selectedQuality.name}`);

    const outputDir = path.join(outputBaseDir, APP_CONFIG.MUSIC_SUBDIR);
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
        const renameResult = await renameDownloadedSong(downloadResult.filePath, itemUrl, {
            trackId: itemId,
            accessToken: session.accessToken,
            countryCode: session.countryCode
        });
        console.log(`   Final file location: ${renameResult.filePath}`);
        if (mp3Options?.enabled) {
            const mp3Path = await convertFileToMp3(renameResult.filePath, mp3Options);
            if (mp3Path) {
                console.log(`   MP3 file location: ${mp3Path}`);
            }
        }
    } else {
        const errorMsg = downloadResult ? downloadResult.error : 'Unknown download error';
        console.error(`\n❌ Song ${itemId} download failed. ${errorMsg}`);
    }
}

async function handleVideoDownload(session, itemUrl, itemId, outputBaseDir) {
    const selectedStream = await selectVideoDownloadQuality(itemId, session.accessToken);
    if (!selectedStream) {
        console.log("No video quality selected or error fetching. Aborting video download.");
        return;
    }
    console.log(`Selected video quality: ${selectedStream.resolution} @ ${selectedStream.bandwidth}bps`);

    const outputDir = path.join(outputBaseDir, APP_CONFIG.VIDEO_SUBDIR);
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

async function handlePlaylistDownload(session, itemUrl, playlistId, outputBaseDir, mp3Options) {
    const selectedQuality = await selectAudioDownloadQuality();
    if (!selectedQuality) {
        console.log("No audio quality selected. Aborting playlist download.");
        return;
    }
    console.log(`Selected audio quality: ${selectedQuality.name}`);

    const renameAll = await promptUserForConfirmation("Rename tracks using Artist - Title? (applies to all tracks)", true);

    let playlistTitle = null;
    try {
        const playlistMetadata = await fetchPlaylistMetadata(playlistId, session.accessToken, session.countryCode);
        playlistTitle = playlistMetadata?.title || null;
    } catch (error) {
        console.warn(`Failed to fetch playlist metadata: ${error.message}`);
    }

    const playlistFolderName = sanitizeFilenameSegment(playlistTitle || `playlist_${playlistId}`);
    const outputDir = path.join(outputBaseDir, APP_CONFIG.PLAYLIST_SUBDIR, playlistFolderName);
    await fs.mkdir(outputDir, { recursive: true });

    const playlistLabel = playlistTitle || playlistId;
    console.log(`\n${formatStatus('PLAYLIST', ANSI_COLORS.cyan)} ${playlistLabel}`);
    console.log(`   Output directory: ${path.resolve(outputDir)}`);

    const { trackIds, skippedCount, totalItems } = await fetchPlaylistTrackIds(
        playlistId,
        session.accessToken,
        session.countryCode
    );

    if (!trackIds.length) {
        console.log("No tracks found in playlist. Nothing to download.");
        return;
    }

    console.log(`Tracks: ${trackIds.length}, skipped items: ${skippedCount}`);

    let successCount = 0;
    let failureCount = 0;
    const quietMp3Options = mp3Options?.enabled ? { ...mp3Options, verbose: false } : mp3Options;
    for (let index = 0; index < trackIds.length; index++) {
        const trackId = trackIds[index];
        const trackUrl = `https://tidal.com/browse/track/${trackId}`;
        const progressLabel = `[${index + 1}/${trackIds.length}]`;
        console.log(`${formatStatus(progressLabel, ANSI_COLORS.dim)} Downloading track ${trackId}`);

        try {
            const downloadResult = await downloadMusicTrack({
                trackId: trackId,
                audioQuality: selectedQuality.apiCode,
                accessToken: session.accessToken,
                outputDir: outputDir,
                countryCode: session.countryCode,
                verbose: false
            });

            if (downloadResult && downloadResult.success && downloadResult.filePath) {
                const renameResult = await renameDownloadedSong(downloadResult.filePath, trackUrl, {
                    promptUser: false,
                    autoRename: renameAll,
                    trackId: trackId,
                    accessToken: session.accessToken,
                    countryCode: session.countryCode,
                    verbose: false
                });
                if (quietMp3Options?.enabled) {
                    await convertFileToMp3(renameResult.filePath, quietMp3Options);
                }
                const displayName = renameResult?.title && renameResult?.artist
                    ? `${renameResult.artist} - ${renameResult.title}`
                    : path.basename(renameResult.filePath);
                console.log(`${formatStatus('OK', ANSI_COLORS.green)} ${displayName}`);
                successCount++;
            } else {
                const errorMsg = downloadResult ? downloadResult.error : 'Unknown download error';
                console.error(`${formatStatus('ERR', ANSI_COLORS.red)} Track ${trackId} failed. ${errorMsg}`);
                failureCount++;
            }
        } catch (error) {
            console.error(`${formatStatus('ERR', ANSI_COLORS.red)} Track ${trackId} error: ${error.message}`);
            failureCount++;
        }
    }

    const summary = `Success: ${successCount}, Failed: ${failureCount}.`;
    console.log(`\n${formatStatus('DONE', ANSI_COLORS.green)} ${summary}`);
}

async function main() {
    console.log(UI_TEXT.WELCOME_BANNER_TOP);
    console.log(UI_TEXT.WELCOME_BANNER_MID);
    console.log(UI_TEXT.WELCOME_BANNER_BOT);
    console.log(UI_TEXT.ARIA2C_NOTICE);
    console.log(UI_TEXT.DOWNLOAD_DIR_NOTICE);

    const outputBaseDir = await promptForOutputBaseDir();
    const mp3Options = await promptForMp3ConversionOptions();

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

    await fs.mkdir(outputBaseDir, { recursive: true });

    while (true) {
        console.log(UI_TEXT.SEPARATOR_LINE);
        const choice = await promptUserForSelection(UI_TEXT.MAIN_MENU_PROMPT, MAIN_MENU_OPTIONS);

        if (choice.id === 'EXIT') {
            console.log(UI_TEXT.EXIT_MESSAGE);
            break;
        }

        let currentItemType = ITEM_TYPE.SONG;
        if (choice.id === 'DOWNLOAD_VIDEO') {
            currentItemType = ITEM_TYPE.VIDEO;
        } else if (choice.id === 'DOWNLOAD_PLAYLIST') {
            currentItemType = ITEM_TYPE.PLAYLIST;
        }

        let exampleUrl = 'https://tidal.com/browse/track/TRACK_ID';
        if (currentItemType === ITEM_TYPE.VIDEO) {
            exampleUrl = 'https://tidal.com/browse/video/VIDEO_ID';
        } else if (currentItemType === ITEM_TYPE.PLAYLIST) {
            exampleUrl = 'https://tidal.com/browse/playlist/PLAYLIST_UUID';
        }
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
                await handleSongDownload(session, itemUrl, idInfo.id, outputBaseDir, mp3Options);
            } else if (currentItemType === ITEM_TYPE.VIDEO) {
                await handleVideoDownload(session, itemUrl, idInfo.id, outputBaseDir);
            } else {
                await handlePlaylistDownload(session, itemUrl, idInfo.id, outputBaseDir, mp3Options);
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
