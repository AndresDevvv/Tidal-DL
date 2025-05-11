'use strict';

import readline from 'readline';
import path from 'path';
import { promises as fs } from 'fs';
import axios from 'axios';
import { URL } from 'url';

import { authenticate } from './v2/login.mjs';
import musicModule from './v2/music.js';
const { downloadMusicTrack } = musicModule;
import videoModule from './v2/video.js';
const { downloadVideo, fetchAvailableVideoStreams } = videoModule;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function askQuestion(query) {
  return new Promise(resolve => rl.question(query, resolve));
}

function extractIdFromUrl(url, expectedType) {
    if (!url || typeof url !== 'string') {
        return null;
    }
    const regex = new RegExp(`\/(?:browse\/)?${expectedType}\/(\\d+)`);
    const match = url.match(regex);

    if (match && match[1]) {
        return { type: expectedType, id: match[1] };
    }
    return null;
}

async function fetchHtmlContent(url) {
    const urlObj = new URL(url);
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Language': 'en-US,en;q=0.9',
        'Host': urlObj.hostname,
        'Upgrade-Insecure-Requests': '1',
        'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Connection': 'keep-alive',
    };

    try {
        const response = await axios.get(url, { headers, timeout: 15000 });
        return response.data;
    } catch (error) {
        console.error(`[fetchHtmlContent] Axios error fetching ${url}: ${error.message}`);
        if (error.response) {
            console.error(`[fetchHtmlContent] Status: ${error.response.status}`);
            console.error(`[fetchHtmlContent] Data (first 200): ${String(error.response.data).substring(0,200)}`);
        } else if (error.request) {
            console.error('[fetchHtmlContent] No response received for URL:', url);
        }
        throw error;
    }
}

function parseOgMeta(htmlContent, property) {
    const regex = new RegExp(`<meta[^>]*property="og:${property}"[^>]*content="([^"]+)"`, 'i');
    const match = htmlContent.match(regex);
    return match ? match[1] : null;
}

async function fetchSongMetadataForRenaming(trackUrl) {
    try {
        let browseTrackUrl = trackUrl;
        const urlObjInput = new URL(trackUrl);

        if (urlObjInput.pathname.startsWith('/u/')) {
            urlObjInput.pathname = urlObjInput.pathname.substring(2);
        }
        if (urlObjInput.pathname.startsWith('/track/')) {
            urlObjInput.pathname = '/browse' + urlObjInput.pathname;
        }
        
        const pathSegments = urlObjInput.pathname.split('/').filter(Boolean);
        let trackIdFromPath = null;
        const trackSegmentIndex = pathSegments.indexOf('track');

        if (trackSegmentIndex !== -1 && pathSegments.length > trackSegmentIndex + 1) {
            trackIdFromPath = pathSegments[trackSegmentIndex + 1];
            browseTrackUrl = `${urlObjInput.protocol}//${urlObjInput.host}/browse/track/${trackIdFromPath}`;
        } else {
            console.warn(`[fetchSongMetadataForRenaming] Could not normalize to a /browse/track/ URL from: ${trackUrl}. Using it as is for fetching.`);
            browseTrackUrl = trackUrl; 
        }

        console.log(`[fetchSongMetadataForRenaming] Fetching HTML from (normalized): ${browseTrackUrl}`);
        const htmlContent = await fetchHtmlContent(browseTrackUrl);

        let title = null;
        let artist = null;

        const pageTitleTagMatch = htmlContent.match(/<title>(.+?) by (.+?) on TIDAL<\/title>/i);
        if (pageTitleTagMatch && pageTitleTagMatch[1] && pageTitleTagMatch[2]) {
            title = pageTitleTagMatch[1].trim();
            artist = pageTitleTagMatch[2].trim();
            console.log(`[fetchSongMetadataForRenaming] From <title> tag - Title: "${title}", Artist: "${artist}"`);
        } else {
            console.log(`[fetchSongMetadataForRenaming] Could not parse <title> tag. Trying og:title.`);
            const ogTitle = parseOgMeta(htmlContent, 'title');
            if (ogTitle) {
                const parts = ogTitle.split(' - ');
                if (parts.length >= 2) {
                    title = parts[0].trim(); 
                    artist = parts.slice(1).join(' - ').trim();
                    console.log(`[fetchSongMetadataForRenaming] From og:title (assuming "Title - Artist") - Title: "${title}", Artist: "${artist}"`);
                } else {
                    title = ogTitle.trim();
                    console.log(`[fetchSongMetadataForRenaming] From og:title (no separator) - Title: "${title}" (Artist not found in og:title alone)`);
                }
            }
        }
        
        console.log(`[fetchSongMetadataForRenaming] Final extracted - Title: "${title}", Artist: "${artist}"`);
        return { title, artist };

    } catch (error) {
        console.error(`[fetchSongMetadataForRenaming] Error fetching metadata from URL ${trackUrl}: ${error.message}`);
        return { title: null, artist: null };
    }
}

function sanitizeFilename(name) {
    if (!name || typeof name !== 'string') return '';
    let sanitized = name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
    sanitized = sanitized.replace(/\s+/g, ' ');
    sanitized = sanitized.trim();
    if (sanitized === '' || sanitized.match(/^\.+$/)) {
        return 'untitled';
    }
    return sanitized.substring(0, 200);
}

async function handleSongRenaming(originalSongFilePath, songUrl) {
    console.log("Fetching metadata for potential renaming...");
    const metadata = await fetchSongMetadataForRenaming(songUrl);

    let finalFilePath = originalSongFilePath;

    if (metadata.title && metadata.artist) {
        const confirmRename = await askQuestion("Do you want to rename the file based on Artist - Title? (yes/no): ");
        if (['yes', 'y'].includes(confirmRename.toLowerCase().trim())) {
            const fileExt = path.extname(originalSongFilePath);
            const outputDir = path.dirname(originalSongFilePath);
            const newBaseName = `${sanitizeFilename(metadata.artist)} - ${sanitizeFilename(metadata.title)}`;
            const newFilePath = path.join(outputDir, `${newBaseName}${fileExt}`);

            if (newFilePath !== originalSongFilePath) {
                try {
                    console.log(`Attempting to rename "${path.basename(originalSongFilePath)}" to "${path.basename(newFilePath)}"`);
                    await fs.rename(originalSongFilePath, newFilePath);
                    console.log(`✅ File renamed successfully to: ${newFilePath}`);
                    finalFilePath = newFilePath;
                } catch (renameError) {
                    console.error(`❌ Failed to rename file: ${renameError.message}. Proceeding with original filename.`);
                }
            } else {
                console.log("Generated filename is the same as the original or metadata is insufficient. No rename performed.");
            }
        } else {
            console.log("Skipping file renaming as per user choice.");
        }
    } else {
        console.log("Skipping file renaming due to missing title and/or artist metadata.");
    }
    return finalFilePath;
}


const AUDIO_QUALITIES = [
    { name: "Standard (AAC 96 kbps)", apiCode: "LOW" },
    { name: "High (AAC 320 kbps)", apiCode: "HIGH" },
    { name: "HiFi (CD Quality FLAC 16-bit/44.1kHz - Lossless)", apiCode: "LOSSLESS" },
    { name: "Max (HiRes FLAC up to 24-bit/192kHz - Lossless)", apiCode: "HI_RES_LOSSLESS" }
];

async function selectAudioQuality() {
    console.log("\nAvailable Audio Qualities:");
    AUDIO_QUALITIES.forEach((quality, index) => {
        console.log(`  ${index + 1}. ${quality.name} (API Code: ${quality.apiCode})`);
    });

    let choiceIndex = -1;
    while (choiceIndex < 0 || choiceIndex >= AUDIO_QUALITIES.length) {
        const answer = await askQuestion(`Select quality (1-${AUDIO_QUALITIES.length}): `);
        const parsedAnswer = parseInt(answer, 10);
        if (!isNaN(parsedAnswer) && parsedAnswer >= 1 && parsedAnswer <= AUDIO_QUALITIES.length) {
            choiceIndex = parsedAnswer - 1;
        } else {
            console.log("Invalid selection. Please enter a number from the list.");
        }
    }
    return AUDIO_QUALITIES[choiceIndex];
}

async function selectVideoQuality(videoId, accessToken) {
    console.log("\nFetching available video qualities...");
    let streams;
    try {
        streams = await fetchAvailableVideoStreams(videoId, accessToken);
    } catch (error) {
        console.error("Error fetching video qualities:", error.message);
        return null;
    }

    if (!streams || streams.length === 0) {
        console.log("No video streams found or an error occurred.");
        return null;
    }

    console.log("\nAvailable Video Qualities (sorted best first by bandwidth):");
    streams.forEach((stream, index) => {
        console.log(`  ${index + 1}. Resolution: ${stream.resolution}, Bandwidth: ${stream.bandwidth} bps, Codecs: ${stream.codecs}`);
    });

    let choiceIndex = -1;
    while (choiceIndex < 0 || choiceIndex >= streams.length) {
        const answer = await askQuestion(`Select quality (1-${streams.length}): `);
        const parsedAnswer = parseInt(answer, 10);
        if (!isNaN(parsedAnswer) && parsedAnswer >= 1 && parsedAnswer <= streams.length) {
            choiceIndex = parsedAnswer - 1;
        } else {
            console.log("Invalid selection. Please enter a number from the list.");
        }
    }
    return streams[choiceIndex];
}

async function main() {
    console.log("╔═════════════════════════════════════════════════╗");
    console.log("║         Welcome to Tidal Downloader!          ║");
    console.log("╚═════════════════════════════════════════════════╝");
    console.log("\nMake sure you have 'aria2c' installed and in your system's PATH.");
    console.log("Downloads will be saved in a './downloads' directory relative to this script.");

    let session;
    try {
        console.log("\nAttempting to authenticate with Tidal...");
        session = await authenticate();
    } catch (error) {
        console.error("\nFatal error during the authentication process:", error.message);
        rl.close();
        return;
    }

    if (!session || !session.isAccessTokenValid()) {
        console.error("\nAuthentication failed, or no valid session obtained. Cannot proceed.");
        console.log("Please ensure you complete the device authorization if prompted.");
        rl.close();
        return;
    }
    console.log("\n✅ Successfully authenticated with Tidal!");
    console.log(`   User ID: ${session.userId}, Country: ${session.countryCode}`);

    const outputBaseDir = './downloads';

    mainLoop:
    while (true) {
        console.log("\n---------------------------------------------");
        console.log("What would you like to do?");
        console.log("  1. Download a Song");
        console.log("  2. Download a Music Video");
        console.log("  3. Exit");

        let choice = '';
        while (choice !== '1' && choice !== '2' && choice !== '3') {
            choice = await askQuestion("Enter your choice (1-3): ");
            if (choice !== '1' && choice !== '2' && choice !== '3') {
                console.log("Invalid choice. Please enter 1, 2, or 3.");
            }
        }

        if (choice === '3') {
            console.log("\nExiting. Goodbye! 👋");
            break mainLoop;
        }

        const isSong = choice === '1';
        const downloadType = isSong ? 'song' : 'music video';
        const idType = isSong ? 'track' : 'video';
        const exampleUrl = isSong ? 'https://tidal.com/browse/track/TRACK_ID' : 'https://tidal.com/browse/video/VIDEO_ID';

        const itemUrl = await askQuestion(`\nPlease enter the Tidal URL for the ${downloadType} (e.g., ${exampleUrl}): `);
        const idInfo = extractIdFromUrl(itemUrl, idType);

        if (!idInfo) {
            console.error(`\n❌ Could not extract a ${idType} ID from the URL provided.`);
            console.error(`   Please ensure the URL is correct and matches the format: ${exampleUrl}`);
            continue;
        }

        const itemId = idInfo.id;
        console.log(`\n🆔 Extracted ${idInfo.type} ID: ${itemId}`);

        let outputDir;
        try {
            if (isSong) {
                const selectedQuality = await selectAudioQuality();
                if (!selectedQuality) {
                    console.log("No audio quality selected. Aborting download.");
                    continue;
                }
                console.log(`Selected audio quality: ${selectedQuality.name} (API Code: ${selectedQuality.apiCode})`);

                outputDir = path.join(outputBaseDir, 'music');
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
                    const finalFilePath = await handleSongRenaming(downloadResult.filePath, itemUrl);
                    console.log(`   Final file location: ${finalFilePath}`);
                } else {
                    console.error(`\n❌ Song ${itemId} download failed. ${downloadResult ? downloadResult.error : 'Unknown error'}`);
                }

            } else { 
                const selectedStream = await selectVideoQuality(itemId, session.accessToken);
                if (!selectedStream) {
                    console.log("No video quality selected or error fetching qualities. Aborting download.");
                    continue;
                }
                console.log(`Selected video quality: ${selectedStream.resolution} @ ${selectedStream.bandwidth}bps`);

                outputDir = path.join(outputBaseDir, 'videos');
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
                console.log(`\n✅ Music video ${itemId} (Res: ${selectedStream.resolution}) download process finished.`);
            }
        } catch (error) {
            console.error(`\n❌ An error occurred during the download of ${downloadType} ID ${itemId}.`);
            console.error(`   Specific error: ${error.message}`);
            console.error(error.stack);
        }

        let another = '';
        while (another !== 'yes' && another !== 'y' && another !== 'no' && another !== 'n') {
            another = (await askQuestion("\nDo you want to download another item? (yes/no): ")).toLowerCase().trim();
        }
        if (another === 'no' || another === 'n') {
            console.log("\nExiting. Goodbye! 👋");
            break mainLoop;
        }
    }

    rl.close();
}

main().catch(error => {
    console.error("\n🚨 An unexpected critical error occurred in the startup script:", error.message);
    console.error(error.stack);
    if (rl && typeof rl.close === 'function') rl.close();
    process.exit(1);
});