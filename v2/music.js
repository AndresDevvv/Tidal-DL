'use strict';

const axios = require('axios');
const { parseStringPromise } = require('xml2js');
const { exec } = require('child_process');
const { promises: fs, createWriteStream } = require('fs');
const path = require('path');
const util = require('util');

const execPromise = util.promisify(exec);

async function downloadMusicTrack(options) {
    const {
        trackId,
        audioQuality,
        accessToken,
        outputDir = '.',
        tempDirPrefix = 'temp_music',
    } = options;

    if (!trackId || !accessToken || !audioQuality) {
        throw new Error('trackId, accessToken, and audioQuality are required options.');
    }

    const url = `https://listen.tidal.com/v1/tracks/${trackId}/playbackinfo?audioquality=${audioQuality}&playbackmode=STREAM&assetpresentation=FULL`;
    const headers = {
        'authorization': `Bearer ${accessToken}`,
    };

    const outputFilename = path.join(outputDir, `${trackId}_${audioQuality}.flac`);
    const tempDir = path.join(outputDir, `${tempDirPrefix}_${trackId}_${audioQuality}`);
    let aria2cInputFile = '';

    try {
        console.log(`Requesting playback info for track ${trackId} (Quality: ${audioQuality})...`);
        const response = await axios.get(url, { headers });

        if (!response.data || !response.data.manifest) {
             let errorMsg = 'Manifest not found in API response.';
             if (response.data && response.data.userMessage) {
                 errorMsg += ` Server message: ${response.data.userMessage}`;
             } else if (response.data && response.data.status && response.data.title) {
                 errorMsg += ` Server error ${response.data.status}: ${response.data.title}`;
             }
             if (response.status === 404 && audioQuality) {
                 errorMsg += ` The audio quality '${audioQuality}' might not be available for this track.`;
             }
            throw new Error(errorMsg);
        }

        const manifestBase64 = response.data.manifest;
        const trackIdFromResponse = response.data.trackId;
        console.log(`Received playback info for track ${trackIdFromResponse}.`);

        const manifestXml = Buffer.from(manifestBase64, 'base64').toString('utf8');

        console.log('Parsing XML manifest...');
        const parsedXml = await parseStringPromise(manifestXml);

        const representation = parsedXml.MPD.Period[0].AdaptationSet[0].Representation[0];
        const segmentTemplate = representation.SegmentTemplate[0];
        const segmentTimeline = segmentTemplate.SegmentTimeline[0].S;

        const initializationUrl = segmentTemplate.$.initialization;
        const mediaUrlTemplate = segmentTemplate.$.media;
        const startNumber = parseInt(segmentTemplate.$.startNumber, 10);

        const segmentUrls = [initializationUrl];
        const segmentFilenames = [];
        const initFilename = path.basename(new URL(initializationUrl).pathname);
        segmentFilenames.push(initFilename);

        let currentSegment = startNumber;
        segmentTimeline.forEach(segment => {
            const duration = parseInt(segment.$.d, 10);
            const repeat = segment.$.r ? parseInt(segment.$.r, 10) : 0;
            for (let i = 0; i <= repeat; i++) {
                const url = mediaUrlTemplate.replace('$Number$', currentSegment.toString());
                segmentUrls.push(url);
                const filename = path.basename(new URL(url).pathname).replace(/\?.*/, '');
                 segmentFilenames.push(filename);
                currentSegment++;
            }
        });

        console.log(`Found ${segmentUrls.length} segments (1 init + ${segmentUrls.length - 1} media).`);

        console.log(`Ensuring output directory exists: ${outputDir}`);
        await fs.mkdir(outputDir, { recursive: true });
        console.log(`Creating temporary directory: ${tempDir}`);
        await fs.mkdir(tempDir, { recursive: true });

        aria2cInputFile = path.join(tempDir, 'urls.txt');
        await fs.writeFile(aria2cInputFile, segmentUrls.join('\n'));
        console.log('Generated URL list for aria2c.');

        const aria2cCommand = `aria2c --console-log-level=warn -c -x 16 -s 16 -k 1M -j 16 -d "${tempDir}" -i "${aria2cInputFile}"`;

        console.log('Starting download with aria2c...');
        console.log(`Executing: ${aria2cCommand}`);

        await execPromise(aria2cCommand);
        console.log('aria2c download completed.');

        console.log(`Concatenating segments into ${outputFilename}...`);
        const outputStream = createWriteStream(outputFilename);
        const orderedSegmentPaths = segmentFilenames.map(fname => path.join(tempDir, fname));

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

        return { success: true, filePath: path.resolve(outputFilename) };

    } catch (error) {
        console.error(`An error occurred during download for track ${trackId} (Quality: ${audioQuality}):`);
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
            if (aria2cInputFile && await fs.stat(tempDir).catch(() => false)) {
                console.log(`Cleaning up temporary directory: ${tempDir}`);
                await fs.rm(tempDir, { recursive: true, force: true });
                console.log('Cleanup complete.');
            }
        } catch (cleanupError) {
            console.error(`Failed to cleanup temporary directory ${tempDir}: ${cleanupError.message}`);
        }
    }
}

module.exports = { downloadMusicTrack };