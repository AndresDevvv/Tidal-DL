'use strict';

import axios from 'axios';
import { exec } from 'child_process';
import { promises as fs, createWriteStream } from 'fs';
import path from 'path';
import util from 'util';

const execAsync = util.promisify(exec);

let aria2cAvailabilityPromise;

async function hasAria2c() {
    if (!aria2cAvailabilityPromise) {
        aria2cAvailabilityPromise = execAsync('command -v aria2c')
            .then(() => true)
            .catch(() => false);
    }
    return aria2cAvailabilityPromise;
}

function buildAria2cInput(entries, headers = {}) {
    const headerLines = Object.entries(headers).map(([name, value]) => ` header=${name}: ${value}`);
    return entries.map(({ url, fileName }) => {
        const lines = [url, ` out=${fileName}`, ...headerLines];
        return lines.join('\n');
    }).join('\n');
}

async function runAria2cDownload({ entries, tempDirPath, inputFileName, aria2cOptions, headers, log }) {
    const aria2cInputFilePath = path.join(tempDirPath, inputFileName);
    await fs.writeFile(aria2cInputFilePath, buildAria2cInput(entries, headers));

    const aria2cCommand = `aria2c ${aria2cOptions} -d "${tempDirPath}" -i "${aria2cInputFilePath}"`;
    log('Using aria2c for segmented download.');
    log(`Executing: ${aria2cCommand}`);
    await execAsync(aria2cCommand);
    log('aria2c download process completed.');
}

async function downloadFileToPath(url, destinationPath, headers = {}) {
    const response = await axios.get(url, {
        headers,
        responseType: 'stream',
    });

    await new Promise((resolve, reject) => {
        const outputStream = createWriteStream(destinationPath);
        response.data.pipe(outputStream);
        response.data.on('error', reject);
        outputStream.on('finish', resolve);
        outputStream.on('error', reject);
    });
}

async function runNativeDownload({ entries, tempDirPath, headers, log }) {
    log('aria2c not found. Falling back to the built-in downloader.');

    for (const [index, entry] of entries.entries()) {
        const segmentPath = path.join(tempDirPath, entry.fileName);
        log(`Downloading segment ${index + 1}/${entries.length}: ${entry.fileName}`);
        await downloadFileToPath(entry.url, segmentPath, headers);
    }

    log('Built-in segmented download completed.');
}

async function downloadSegments(options) {
    const {
        entries,
        tempDirPath,
        inputFileName = 'segment_urls.txt',
        aria2cOptions,
        headers = {},
        log = () => {},
    } = options;

    if (!Array.isArray(entries) || entries.length === 0) {
        throw new Error('downloadSegments requires at least one segment entry.');
    }

    if (await hasAria2c()) {
        await runAria2cDownload({ entries, tempDirPath, inputFileName, aria2cOptions, headers, log });
        return { downloader: 'aria2c' };
    }

    await runNativeDownload({ entries, tempDirPath, headers, log });
    return { downloader: 'native' };
}

export { downloadSegments, hasAria2c };
