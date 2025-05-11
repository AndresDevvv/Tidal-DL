import axios from 'axios';
import { exec } from 'child_process';
import { promises as fs, createWriteStream } from 'fs';
import path from 'path';
import util from 'util';
import readline from 'readline';

const execAsync = util.promisify(exec);

const TIDAL_API_BASE_URL = 'https://listen.tidal.com/v1';
const DEFAULT_PLAYBACKINFO_VIDEO_QUALITY = 'HIGH';
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const ARIA2C_VIDEO_OPTIONS = '--console-log-level=warn -c -x 16 -s 16 -k 1M -j 16 --allow-overwrite=true --auto-file-renaming=false';
const TEMP_DIR_VIDEO_PREFIX = 'temp_tidal_video';

function sanitizeForFilename(name, replacement = '_') {
    if (!name || typeof name !== 'string') return 'untitled';
    let sanitized = name.replace(/[<>:"/\\|?*\x00-\x1F]/g, replacement);
    sanitized = sanitized.replace(/\s+/g, ' ').trim();
    sanitized = sanitized.replace(/\.$/, replacement); // Replace trailing dots
    return sanitized.substring(0, 240) || 'untitled'; // Limit length
}

function parseM3U8MasterPlaylist(m3u8Content) {
    const lines = m3u8Content.split('\n');
    const streams = [];
    let currentStreamInfoLine = null;

    for (const line of lines) {
        const trimmedLine = line.trim();
        if (trimmedLine.startsWith('#EXT-X-STREAM-INF:')) {
            currentStreamInfoLine = trimmedLine;
        } else if (currentStreamInfoLine && (trimmedLine.startsWith('http://') || trimmedLine.startsWith('https://'))) {
            const resolutionMatch = currentStreamInfoLine.match(/RESOLUTION=(\d+x\d+)/);
            const bandwidthMatch = currentStreamInfoLine.match(/BANDWIDTH=(\d+)/);
            const codecsMatch = currentStreamInfoLine.match(/CODECS="([^"]+)"/);

            streams.push({
                resolution: resolutionMatch ? resolutionMatch[1] : 'Unknown',
                bandwidth: bandwidthMatch ? parseInt(bandwidthMatch[1], 10) : 0,
                codecs: codecsMatch ? codecsMatch[1] : 'Unknown',
                url: trimmedLine
            });
            currentStreamInfoLine = null;
        }
    }
    streams.sort((a, b) => b.bandwidth - a.bandwidth);
    return streams;
}

function parseM3U8MediaPlaylist(m3u8Content) {
    const lines = m3u8Content.split('\n');
    const segmentUrls = [];
    const segmentFilenames = [];
    let segmentCounter = 0;

    for (const line of lines) {
        const trimmedLine = line.trim();
        if (trimmedLine.length > 0 && !trimmedLine.startsWith('#')) {
           segmentUrls.push(trimmedLine);
           segmentCounter++;
           try {
                const urlObject = new URL(trimmedLine);
                const baseName = path.basename(urlObject.pathname);
                segmentFilenames.push(baseName.includes('.') ? baseName : `segment_${segmentCounter}.ts`);
           } catch (e) {
                segmentFilenames.push(`segment_${segmentCounter}.ts`);
           }
        }
    }
    return { urls: segmentUrls, filenames: segmentFilenames };
}

async function fetchAvailableVideoStreams(videoId, accessToken, userAgent = DEFAULT_USER_AGENT) {
    if (!videoId || !accessToken) {
        throw new Error('videoId and accessToken are required to fetch video streams.');
    }
    const apiUrl = `${TIDAL_API_BASE_URL}/videos/${videoId}/playbackinfo?videoquality=${DEFAULT_PLAYBACKINFO_VIDEO_QUALITY}&playbackmode=STREAM&assetpresentation=FULL`;

    const playbackInfoHeaders = {
        'Authorization': `Bearer ${accessToken}`,
    };

    console.log(`Requesting playback info for video ${videoId} to list available streams (URL: ${apiUrl})...`);
    const response = await axios.get(apiUrl, { headers: playbackInfoHeaders });
    const responseData = response.data;

    if (!responseData?.manifest) {
        const detail = responseData?.userMessage || 'Manifest not found in API response for video streams.';
        throw new Error(detail);
    }

    const manifestBase64 = responseData.manifest;
    const manifestJsonString = Buffer.from(manifestBase64, 'base64').toString('utf8');
    const manifestJson = JSON.parse(manifestJsonString);

    if (!manifestJson.urls || manifestJson.urls.length === 0) {
        throw new Error('Master M3U8 URL not found in video manifest.');
    }

    const masterM3U8Url = manifestJson.urls[0];
    console.log(`Fetching master M3U8 playlist: ${masterM3U8Url}`);

    const m3u8Headers = {
        'User-Agent': userAgent,
        'Authorization': `Bearer ${accessToken}`, // Some M3U8s might be protected
    };
    const masterPlaylistResponse = await axios.get(masterM3U8Url, { headers: m3u8Headers });
    const masterPlaylistContent = masterPlaylistResponse.data;

    const availableStreams = parseM3U8MasterPlaylist(masterPlaylistContent);
    if (availableStreams.length === 0) {
        throw new Error('No video streams parsed from master playlist.');
    }
    return availableStreams;
}

async function scrapeVideoTitleFromUrl(url, userAgent = DEFAULT_USER_AGENT) {
    try {
        console.log(`Scraping title from URL: ${url}`);
        const response = await axios.get(url, { headers: { 'User-Agent': userAgent } });
        const htmlContent = response.data;
        const titleMatch = htmlContent.match(/<title>(.*?)<\/title>/i);
        if (titleMatch && titleMatch[1]) {
            let title = titleMatch[1].replace(/\s*on TIDAL$/i, '').trim();
            return sanitizeForFilename(title);
        }
        console.log('No title tag found or title was empty.');
        return null;
    } catch (error) {
        console.warn(`Failed to scrape title from ${url}: ${error.message}. Proceeding without scraped title.`);
        return null;
    }
}

async function internalAskQuestion(query) {
    const rlInterface = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    return new Promise(resolve => rlInterface.question(query, ans => {
        rlInterface.close();
        resolve(ans);
    }));
}

async function determineOutputFilenameAndTempBase(videoId, selectedStreamUrl, tidalUrl, userAgent) {
    let outputBasename;
    let tempDirIdentifier;

    if (tidalUrl) {
        const scrapedTitle = await scrapeVideoTitleFromUrl(tidalUrl, userAgent);
        if (scrapedTitle) {
            const proposedFilename = `${scrapedTitle}.ts`;
            const useScraped = await internalAskQuestion(`Use "${proposedFilename}" as filename? (y/n, default y): `);
            if (useScraped.toLowerCase() !== 'n') {
                outputBasename = proposedFilename;
                tempDirIdentifier = scrapedTitle; // Use the unsanitized for broader uniqueness if possible
            }
        }
    }

    if (!outputBasename) {
        let qualityTag = 'selected_quality';
        try {
            const urlParts = selectedStreamUrl.split('/');
            const qualityPart = urlParts.find(part => part.match(/^\d+p$/i) || part.match(/^\d+k$/i));
            if (qualityPart) {
                qualityTag = qualityPart;
            } else {
                const resMatch = selectedStreamUrl.match(/(\d+x\d+)/);
                if (resMatch && resMatch[1]) qualityTag = resMatch[1];
            }
        } catch (e) { /* Ignore errors in heuristic quality tag extraction */ }
        outputBasename = sanitizeForFilename(`${videoId}_${qualityTag}.ts`);
        tempDirIdentifier = `${videoId}_${qualityTag}`;
    }
    return { outputBasename: sanitizeForFilename(outputBasename), tempDirIdentifier: sanitizeForFilename(tempDirIdentifier) };
}

async function downloadVideo(options) {
    const {
        videoId,
        accessToken,
        selectedStreamUrl,
        tidalUrl,
        userAgent = DEFAULT_USER_AGENT,
        outputDir = '.',
    } = options;

    if (!videoId || !accessToken || !selectedStreamUrl) {
        throw new Error('videoId, accessToken, and selectedStreamUrl are mandatory options.');
    }

    const { outputBasename, tempDirIdentifier } = await determineOutputFilenameAndTempBase(videoId, selectedStreamUrl, tidalUrl, userAgent);
    const outputFilePath = path.resolve(outputDir, outputBasename);
    const tempDirPath = path.resolve(outputDir, `${TEMP_DIR_VIDEO_PREFIX}_${tempDirIdentifier}_${Date.now()}`);
    let aria2cInputFilePath = '';

    try {
        console.log(`Fetching media playlist for selected quality: ${selectedStreamUrl}`);
        const mediaPlaylistResponse = await axios.get(selectedStreamUrl, { headers: { 'User-Agent': userAgent }});
        const mediaPlaylistContent = mediaPlaylistResponse.data;

        const { urls: segmentUrls, filenames: segmentFilenames } = parseM3U8MediaPlaylist(mediaPlaylistContent);
        if (segmentUrls.length === 0) {
            throw new Error('No video segments found in the selected media playlist.');
        }
        console.log(`Found ${segmentUrls.length} video segments.`);

        await fs.mkdir(outputDir, { recursive: true });
        await fs.mkdir(tempDirPath, { recursive: true });
        console.log(`Temporary directory created: ${tempDirPath}`);

        aria2cInputFilePath = path.join(tempDirPath, 'segment_urls.txt');
        const aria2cUrlsWithHeaders = segmentUrls.map(url => `${url}\n header=User-Agent: ${userAgent}`);
        await fs.writeFile(aria2cInputFilePath, aria2cUrlsWithHeaders.join('\n'));
        console.log('Generated URL list with headers for aria2c.');

        const aria2cCommand = `aria2c ${ARIA2C_VIDEO_OPTIONS} -d "${tempDirPath}" -i "${aria2cInputFilePath}"`;
        console.log('Starting video download with aria2c...');
        console.log(`Executing: ${aria2cCommand}`);
        await execAsync(aria2cCommand);
        console.log('aria2c video download process completed.');

        console.log(`Concatenating ${segmentFilenames.length} segments into ${outputFilePath}...`);
        const outputStream = createWriteStream(outputFilePath);
        try {
            for (const segmentName of segmentFilenames) {
                const segmentPath = path.join(tempDirPath, segmentName);
                 try {
                    await fs.access(segmentPath); // Check existence before reading
                    const segmentData = await fs.readFile(segmentPath);
                    outputStream.write(segmentData);
                } catch (readError) {
                    console.warn(`Segment ${segmentPath} not found or unreadable: ${readError.message}. Skipping.`);
                }
            }
        } finally {
            outputStream.end();
        }

        await new Promise((resolve, reject) => {
            outputStream.on('finish', resolve);
            outputStream.on('error', (err) => reject(new Error(`Error writing to output file ${outputFilePath}: ${err.message}`)));
        });

        console.log(`Successfully created video file: ${outputFilePath}`);
        return { success: true, filePath: outputFilePath };

    } catch (error) {
        let errorMessage = `Error during download for video ${videoId}: ${error.message}`;
         if (axios.isAxiosError(error)) {
            errorMessage = `API request failed for video ${videoId}. Status: ${error.response?.status || 'unknown'}.`;
            if(error.response?.data){
                errorMessage += ` Detail: ${typeof error.response.data === 'string' ? error.response.data.substring(0,300) : JSON.stringify(error.response.data).substring(0,300)}`;
            }
        } else if (error.stderr || error.stdout) {
            errorMessage += `\n  aria2c Stderr: ${error.stderr}\n  aria2c Stdout: ${error.stdout}`;
        }
        console.error(errorMessage);
        throw error;
    } finally {
        if (tempDirPath) {
            try {
                await fs.stat(tempDirPath);
                console.log(`Cleaning up temporary directory: ${tempDirPath}`);
                await fs.rm(tempDirPath, { recursive: true, force: true });
                console.log('Temporary directory cleanup complete.');
            } catch (cleanupError) {
                 if (cleanupError.code !== 'ENOENT') {
                    console.error(`Failed to cleanup temporary directory ${tempDirPath}: ${cleanupError.message}`);
                }
            }
        }
    }
}

export { downloadVideo, fetchAvailableVideoStreams };