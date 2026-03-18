'use strict';

import { promises as fs } from 'fs';
import path from 'path';

const DEFAULT_LOG_DIR = 'logs';

function timestamp() {
    return new Date().toISOString();
}

function stringifyArg(arg) {
    if (typeof arg === 'string') {
        return arg;
    }
    if (arg instanceof Error) {
        return arg.stack || arg.message;
    }
    try {
        return JSON.stringify(arg);
    } catch (error) {
        return String(arg);
    }
}

async function initializeDebugLogging() {
    const logDir = process.env.TIDAL_LOG_DIR || DEFAULT_LOG_DIR;
    const fileName = process.env.TIDAL_LOG_FILE || `tidal-dl-${timestamp().replace(/[:.]/g, '-')}.log`;
    const logPath = path.resolve(logDir, fileName);

    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.writeFile(logPath, `[${timestamp()}] [INFO] Debug log initialized\n`, { flag: 'a' });

    for (const level of ['log', 'info', 'warn', 'error']) {
        const original = console[level].bind(console);
        console[level] = (...args) => {
            const line = `[${timestamp()}] [${level.toUpperCase()}] ${args.map(stringifyArg).join(' ')}`;
            fs.appendFile(logPath, `${line}\n`).catch(() => {});
            original(...args);
        };
    }

    return logPath;
}

export { initializeDebugLogging };
