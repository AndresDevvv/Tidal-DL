'use strict';

import axios from 'axios';
import { parseStringPromise } from 'xml2js';
import { exec } from 'child_process';
import { promises as fs, createWriteStream } from 'fs';
import path from 'path';
import util from 'util';

const execAsync = util.promisify(exec);

const TIDAL_API_BASE_URL = 'https://listen.tidal.com/v1';
const ARIA2C_DEFAULT_OPTIONS = '-c -x 16 -s 16 -k 1M -j 16 --console-log-level=warn --allow-overwrite=true --auto-file-renaming=false';

function buildPlaybackInfoUrl(trackId, audioQuality) {
    return `${TIDAL_API_BASE_URL}/tracks/${trackId}/playbackinfo?audioquality=${audioQuality}&playbackmode=STREAM&assetpresentation=FULL`;
}

function buildApiErrorMessage(prefix, errorResponse, audioQualityForContext = null) {
    let message = prefix;
    const responseData = errorResponse?.data;

    if (responseData?.userMessage) {
        message += ` Server message: ${responseData.userMessage}`;
    } else if (responseData?.title) {
        message += ` Title: ${responseData.title}`;
    } else if (typeof responseData === 'string' && responseData.length < 250) {
        message += ` Body: ${responseData}`;
    }

    if (errorResponse?.status === 404 && audioQualityForContext) {
        message += ` The audio quality '${audioQualityForContext}' might not be available for this track, or the track ID is invalid.`;
    }
    return message;
}

async function parseManifestAndExtractSegments(manifestXml) {
    const parsedXml = await parseStringPromise(manifestXml);

    const representation = parsedXml?.MPD?.Period?.[0]?.AdaptationSet?.[0]?.Representation?.[0];
    if (!representation) {
        throw new Error('Could not find Representation element in XML manifest.');
    }

    const segmentTemplate = representation.SegmentTemplate?.[0];
    if (!segmentTemplate) {
        throw new Error('Could not find SegmentTemplate element in XML manifest.');
    }

    const initializationUrlPath = segmentTemplate.$?.initialization;
    const mediaUrlTemplate = segmentTemplate.$?.media;
    const startNumberStr = segmentTemplate.$?.startNumber;

    if (!initializationUrlPath || !mediaUrlTemplate || !startNumberStr) {
        throw new Error('Manifest SegmentTemplate is missing critical attributes (initialization, media, or startNumber).');
    }

    const segmentTimelineSlices = segmentTemplate.SegmentTimeline?.[0]?.S;
    if (!segmentTimelineSlices || !Array.isArray(segmentTimelineSlices) || segmentTimelineSlices.length === 0) {
        throw new Error('Manifest SegmentTimeline S array is missing or empty.');
    }

    const segmentUrls = [initializationUrlPath];
    const segmentBasenames = [path.basename(new URL(initializationUrlPath, 'http://dummybase').pathname)]; // Base URL for relative paths

    let currentSegmentNumber = parseInt(startNumberStr, 10);
    segmentTimelineSlices.forEach(segment => {
        const repeatCount = segment.$.r ? parseInt(segment.$.r, 10) : 0;
        for (let i = 0; i <= repeatCount; i++) {
            const mediaUrl = mediaUrlTemplate.replace('$Number$', currentSegmentNumber.toString());
            segmentUrls.push(mediaUrl);
            segmentBasenames.push(path.basename(new URL(mediaUrl, 'http://dummybase').pathname).replace(/\?.*/, ''));
            currentSegmentNumber++;
        }
    });

    return { segmentUrls, segmentBasenames };
}

async function downloadMusicTrack(options) {
    const {
        trackId,
        audioQuality,
        accessToken,
        outputDir = '.',
        tempDirPrefix = 'temp_tidal_music',
    } = options;

    if (!trackId || !audioQuality || !accessToken) {
        throw new Error('trackId, audioQuality, and accessToken are mandatory options.');
    }

    const playbackInfoUrl = buildPlaybackInfoUrl(trackId, audioQuality);
    const apiHeaders = { 'Authorization': `Bearer ${accessToken}` };

    const outputFileName = `${trackId}_${audioQuality}.flac`;
    const outputFilePath = path.join(outputDir, outputFileName);
    let tempDirPath = '';

    try {
        console.log(`Requesting playback info for track ${trackId} (Quality: ${audioQuality})...`);
        const response = await axios.get(playbackInfoUrl, { headers: apiHeaders });
        const playbackData = response.data;

        if (!playbackData?.manifest) {
            const detail = playbackData?.userMessage || playbackData?.title || 'Manifest not found in API response.';
            throw new Error(`Playback info response missing manifest: ${detail}`);
        }
        console.log(`Received playback info for track ${playbackData.trackId}.`);

        const manifestXml = Buffer.from(playbackData.manifest, 'base64').toString('utf8');
        console.log('Parsing XML manifest...');
        const { segmentUrls, segmentBasenames } = await parseManifestAndExtractSegments(manifestXml);
        console.log(`Found ${segmentUrls.length} segments to download.`);

        tempDirPath = path.join(outputDir, `${tempDirPrefix}_${trackId}_${audioQuality}_${Date.now()}`);
        await fs.mkdir(tempDirPath, { recursive: true });
        console.log(`Temporary directory created: ${tempDirPath}`);

        const aria2cInputFilePath = path.join(tempDirPath, 'segment_urls.txt');
        await fs.writeFile(aria2cInputFilePath, segmentUrls.join('\n'));
        console.log('Generated URL list for aria2c.');

        const aria2cCommand = `aria2c ${ARIA2C_DEFAULT_OPTIONS} -d "${tempDirPath}" -i "${aria2cInputFilePath}"`;
        console.log('Starting download with aria2c...');
        console.log(`Executing: ${aria2cCommand}`);
        await execAsync(aria2cCommand);
        console.log('aria2c download process completed.');

        console.log(`Concatenating ${segmentBasenames.length} segments into ${outputFilePath}...`);
        const outputStream = createWriteStream(outputFilePath);

        try {
            for (const segmentName of segmentBasenames) {
                const segmentPath = path.join(tempDirPath, segmentName);
                try {
                    const segmentData = await fs.readFile(segmentPath);
                    outputStream.write(segmentData);
                } catch (readError) {
                    console.warn(`Segment ${segmentPath} unreadable or missing: ${readError.message}. Skipping.`);
                }
            }
        } finally {
            outputStream.end();
        }

        await new Promise((resolve, reject) => {
            outputStream.on('finish', resolve);
            outputStream.on('error', (err) => reject(new Error(`Error writing to output file ${outputFilePath}: ${err.message}`)));
        });

        console.log(`Successfully created output file: ${outputFilePath}`);
        return { success: true, filePath: path.resolve(outputFilePath) };

    } catch (error) {
        let errorMessage = `Error during download for track ${trackId} (Quality: ${audioQuality}): ${error.message}`;
        if (axios.isAxiosError(error)) {
            errorMessage = buildApiErrorMessage(`API request failed with status ${error.response?.status || 'unknown'}.`, error.response, audioQuality);
            if (error.response?.data && typeof error.response.data === 'object') {
                console.error(`Full API error response: ${JSON.stringify(error.response.data, null, 2)}`);
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
                if (cleanupError.code === 'ENOENT') {
                } else {
                    console.error(`Failed to cleanup temporary directory ${tempDirPath}: ${cleanupError.message}`);
                }
            }
        }
    }
}

export { downloadMusicTrack };