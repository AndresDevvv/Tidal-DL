'use strict';

const axios = require('axios');
const { exec } = require('child_process');
const { promises: fs, createWriteStream } = require('fs');
const path = require('path');
const util = require('util');
const readline = require('readline');

const execPromise = util.promisify(exec);

const DEFAULT_PLAYBACKINFO_VIDEO_QUALITY = 'HIGH';
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';

function parseM3U8Master(m3u8Content) {
    const lines = m3u8Content.split('\n');
    const streams = [];
    let currentStreamInfo = null;

    for (const line of lines) {
        if (line.startsWith('#EXT-X-STREAM-INF:')) {
            currentStreamInfo = line;
        } else if (currentStreamInfo && (line.startsWith('http://') || line.startsWith('https://'))) {
            const resolutionMatch = currentStreamInfo.match(/RESOLUTION=(\d+x\d+)/);
            const bandwidthMatch = currentStreamInfo.match(/BANDWIDTH=(\d+)/);
            const codecsMatch = currentStreamInfo.match(/CODECS="([^"]+)"/);
            const resolution = resolutionMatch ? resolutionMatch[1] : 'Unknown';
            const bandwidth = bandwidthMatch ? parseInt(bandwidthMatch[1], 10) : 0;
            const codecs = codecsMatch ? codecsMatch[1] : 'Unknown';
            streams.push({
                resolution: resolution,
                bandwidth: bandwidth,
                codecs: codecs,
                url: line.trim()
            });
            currentStreamInfo = null;
        }
    }
    streams.sort((a, b) => b.bandwidth - a.bandwidth);
    return streams;
}

function parseM3U8Media(m3u8Content) {
    const lines = m3u8Content.split('\n');
    const segmentUrls = [];
    const segmentFilenames = [];

    for (const line of lines) {
        const trimmedLine = line.trim();
        if (trimmedLine.length > 0 && !trimmedLine.startsWith('#')) {
           segmentUrls.push(trimmedLine);
           try {
                const urlObject = new URL(trimmedLine);
                const baseName = path.basename(urlObject.pathname);
                segmentFilenames.push(baseName.includes('.') ? baseName : `segment_${segmentUrls.length}.ts`);
           } catch (e) {
                console.warn(`Could not parse URL to get filename: ${trimmedLine}, using generic name.`);
                segmentFilenames.push(`segment_${segmentUrls.length}.ts`);
           }
        }
    }
    return { urls: segmentUrls, filenames: segmentFilenames };
}

async function fetchAvailableVideoStreams(videoId, accessToken, userAgent = DEFAULT_USER_AGENT) {
    if (!videoId || !accessToken) {
        throw new Error('videoId and accessToken are required to fetch video streams.');
    }
    const apiUrl = `https://listen.tidal.com/v1/videos/${videoId}/playbackinfo?videoquality=${DEFAULT_PLAYBACKINFO_VIDEO_QUALITY}&playbackmode=STREAM&assetpresentation=FULL`;
    const headers = {
        'authorization': `Bearer ${accessToken}`,
        'User-Agent': userAgent
    };

    console.log(`Requesting playback info for video ${videoId} to get stream list...`);
    const response = await axios.get(apiUrl, { headers });

    if (!response.data || !response.data.manifest) {
        let errorMsg = 'Manifest not found in API response when fetching video streams.';
        if (response.data && response.data.userMessage) {
            errorMsg += ` Server message: ${response.data.userMessage}`;
        }
        throw new Error(errorMsg);
    }

    const manifestBase64 = response.data.manifest;
    const manifestJsonString = Buffer.from(manifestBase64, 'base64').toString('utf8');
    const manifestJson = JSON.parse(manifestJsonString);

    if (!manifestJson.urls || manifestJson.urls.length === 0) {
        throw new Error('Master M3U8 URL not found in manifest.');
    }

    const masterM3U8Url = manifestJson.urls[0];
    console.log(`Found master playlist: ${masterM3U8Url}`);

    console.log('Fetching master playlist...');
    const masterPlaylistResponse = await axios.get(masterM3U8Url, { headers });
    const masterPlaylistContent = masterPlaylistResponse.data;

    const availableStreams = parseM3U8Master(masterPlaylistContent);

    if (availableStreams.length === 0) {
        throw new Error('No video streams found in master playlist.');
    }
    return availableStreams;
}

async function scrapeTitleFromUrl(url, userAgent = DEFAULT_USER_AGENT) {
    try {
        const response = await axios.get(url, { headers: { 'User-Agent': userAgent } });
        const htmlContent = response.data;
        const titleMatch = htmlContent.match(/<title>(.*?)<\/title>/i);
        if (titleMatch && titleMatch[1]) {
            let title = titleMatch[1];
            title = title.replace(/\s*on TIDAL$/i, '').trim();
            title = title.replace(/[<>:"/\\|?*]+/g, '_');
            title = title.replace(/\.$/, '_');
            return title;
        }
        return null;
    } catch (error) {
        console.warn(`Failed to scrape title from ${url}: ${error.message}`);
        return null;
    }
}

function askQuestion(query) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    return new Promise(resolve => rl.question(query, ans => {
        rl.close();
        resolve(ans);
    }));
}

async function downloadVideo(options) {
    const {
        videoId,
        accessToken,
        selectedStreamUrl,
        tidalUrl,
        userAgent = DEFAULT_USER_AGENT,
        outputDir = '.',
        tempDirPrefix = 'temp_video'
    } = options;

    if (!videoId || !accessToken || !selectedStreamUrl) {
        throw new Error('videoId, accessToken, and selectedStreamUrl are required options.');
    }

    const headers = {
        'authorization': `Bearer ${accessToken}`,
        'User-Agent': userAgent
    };
    
    let outputFilename;
    let tempDirNameBase;

    if (tidalUrl) {
        const scrapedTitle = await scrapeTitleFromUrl(tidalUrl, userAgent);
        if (scrapedTitle) {
            const proposedFullFilename = `${scrapedTitle}.ts`;
            const useScrapedNameAnswer = await askQuestion(`Use "${proposedFullFilename}" as filename? (y/n): `);
            if (useScrapedNameAnswer.toLowerCase() === 'y') {
                outputFilename = proposedFullFilename;
                tempDirNameBase = scrapedTitle;
            }
        }
    }

    if (!outputFilename) {
        let qualityIdentifier = 'selected';
        try {
            const urlParts = selectedStreamUrl.split('/');
            const qualityPart = urlParts.find(part => part.match(/^\d+p$/) || part.match(/^\d+k$/));
            if (qualityPart) qualityIdentifier = qualityPart;
            else {
                const resMatch = selectedStreamUrl.match(/(\d+x\d+)/);
                if (resMatch) qualityIdentifier = resMatch[1];
            }
        } catch (e) { /* ignore */ }
        outputFilename = `${videoId}_${qualityIdentifier}.ts`;
        tempDirNameBase = `${videoId}_${qualityIdentifier}`;
    }
    
    const outputFilePath = path.resolve(outputDir, outputFilename);
    const safeTempDirNameBase = tempDirNameBase.replace(/[<>:"/\\|?*]+/g, '_').replace(/\.$/, '_');
    const tempDirPath = path.resolve(outputDir, `${tempDirPrefix}_${safeTempDirNameBase}`);
    let aria2cInputFilePath = '';

    try {
        console.log(`Using selected stream URL: ${selectedStreamUrl}`);
        console.log('Fetching media playlist for selected quality...');
        const mediaPlaylistResponse = await axios.get(selectedStreamUrl, { headers });
        const mediaPlaylistContent = mediaPlaylistResponse.data;

        const { urls: segmentUrls, filenames: segmentFilenames } = parseM3U8Media(mediaPlaylistContent);

        if (segmentUrls.length === 0) {
            throw new Error('No segments found in the selected media playlist.');
        }
        console.log(`Found ${segmentUrls.length} video segments.`);

        console.log(`Ensuring output directory exists: ${outputDir}`);
        await fs.mkdir(outputDir, { recursive: true });
        console.log(`Creating temporary directory: ${tempDirPath}`);
        await fs.mkdir(tempDirPath, { recursive: true });

        aria2cInputFilePath = path.join(tempDirPath, 'urls.txt');
        const aria2cUrlsWithOptions = segmentUrls.map(url => {
            return `${url}\n header=User-Agent: ${userAgent}`;
        });
        await fs.writeFile(aria2cInputFilePath, aria2cUrlsWithOptions.join('\n'));
        console.log('Generated URL list for aria2c with headers.');

        const aria2cCommand = `aria2c --console-log-level=warn -c -x 16 -s 16 -k 1M -j 16 -d "${tempDirPath}" -i "${aria2cInputFilePath}"`;

        console.log('Starting download with aria2c...');
        console.log(`Executing: ${aria2cCommand}`);
        await execPromise(aria2cCommand);
        console.log('aria2c download completed.');

        console.log(`Concatenating segments into ${outputFilePath}...`);
        const outputStream = createWriteStream(outputFilePath);
        const orderedSegmentPaths = segmentFilenames.map(fname => path.join(tempDirPath, fname));

        for (const segmentPath of orderedSegmentPaths) {
             try {
                 await fs.access(segmentPath);
                 const segmentData = await fs.readFile(segmentPath);
                 outputStream.write(segmentData);
             } catch (err) {
                  console.error(`Error accessing or appending segment ${segmentPath}: ${err.message}. Skipping.`);
             }
        }
        outputStream.end();

        await new Promise((resolve, reject) => {
            outputStream.on('finish', resolve);
            outputStream.on('error', reject);
        });

        console.log(`Successfully created ${outputFilename}.`);

    } catch (error) {
        console.error(`An error occurred during download for video ${videoId}:`);
        if (error.response) {
            console.error(`  Status: ${error.response.status}`);
            console.error(`  Data: ${JSON.stringify(error.response.data)}`);
        } else if (error.request) {
            console.error('  No response received:', error.request);
        } else {
            console.error('  Error:', error.message);
             if (error.stderr) {
                 console.error('  Stderr:', error.stderr);
             }
             if (error.stdout) {
                 console.error('  Stdout:', error.stdout);
             }
        }
        throw error;
    } finally {
        try {
             if (await fs.stat(tempDirPath).catch(() => false)) {
                console.log(`Cleaning up temporary directory: ${tempDirPath}`);
                await fs.rm(tempDirPath, { recursive: true, force: true });
                console.log('Cleanup complete.');
            }
        } catch (cleanupError) {
            console.error(`Failed to cleanup temporary directory ${tempDirPath}: ${cleanupError.message}`);
        }
    }
}

module.exports = { downloadVideo, fetchAvailableVideoStreams };