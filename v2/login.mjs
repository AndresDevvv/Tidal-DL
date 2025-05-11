import { promises as fs } from 'fs';

const API_CLIENT = {
    clientId: '7m7Ap0JC9j1cOM3n',
    clientSecret: 'vRAdA108tlvkJpTsGZS8rGZ7xTlbJ0qaZ2K9saEzsgY=',
    scope: 'r_usr w_usr w_sub'
};

const AUTH_URL_BASE = 'https://auth.tidal.com/v1/oauth2';
const SESSION_STORAGE_FILE = 'tidal_session.json';

class TidalSession {
    constructor(initialData = {}) {
        this.deviceCode = initialData.deviceCode || null;
        this.userCode = initialData.userCode || null;
        this.verificationUrl = initialData.verificationUrl || null;
        this.authCheckTimeout = initialData.authCheckTimeout || null;
        this.authCheckInterval = initialData.authCheckInterval || null;
        this.userId = initialData.userId || null;
        this.countryCode = initialData.countryCode || null;
        this.accessToken = initialData.accessToken || null;
        this.refreshToken = initialData.refreshToken || null;
        this.tokenExpiresAt = initialData.tokenExpiresAt || null;
    }

    isAccessTokenValid() {
        return this.accessToken && this.tokenExpiresAt && Date.now() < this.tokenExpiresAt;
    }

    hasRefreshToken() {
        return !!this.refreshToken;
    }

    updateTokens(tokenResponse) {
        this.accessToken = tokenResponse.access_token;
        if (tokenResponse.refresh_token) {
            this.refreshToken = tokenResponse.refresh_token;
        }
        this.tokenExpiresAt = Date.now() + (tokenResponse.expires_in * 1000);
        if (tokenResponse.user) {
            this.userId = tokenResponse.user.userId;
            this.countryCode = tokenResponse.user.countryCode;
        }
    }

    clearAuthDetails() {
        this.accessToken = null;
        this.refreshToken = null;
        this.tokenExpiresAt = null;
        this.userId = null;
        this.countryCode = null;
    }

    clearDeviceAuthDetails() {
        this.deviceCode = null;
        this.userCode = null;
        this.verificationUrl = null;
        this.authCheckTimeout = null;
        this.authCheckInterval = null;
    }
}

async function saveSession(session) {
    const dataToSave = {
        userId: session.userId,
        countryCode: session.countryCode,
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        tokenExpiresAt: session.tokenExpiresAt,
    };
    try {
        await fs.writeFile(SESSION_STORAGE_FILE, JSON.stringify(dataToSave, null, 2));
        console.log(`Session saved to ${SESSION_STORAGE_FILE}`);
    } catch (error) {
        console.error(`Error saving session to ${SESSION_STORAGE_FILE}:`, error.message);
    }
}

async function loadSession() {
    try {
        const data = await fs.readFile(SESSION_STORAGE_FILE, 'utf8');
        const loadedData = JSON.parse(data);
        console.log(`Session loaded from ${SESSION_STORAGE_FILE}`);
        return new TidalSession(loadedData);
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.warn(`Could not load session from ${SESSION_STORAGE_FILE}: ${error.message}. A new session will be created.`);
        } else {
            console.log(`No session file found at ${SESSION_STORAGE_FILE}. A new session will be created.`);
        }
        return new TidalSession();
    }
}

async function fetchWithRetry(url, options, maxRetries = 3) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const response = await fetch(url, options);
            if (response.status === 429) {
                const retryAfter = parseInt(response.headers.get('Retry-After') || "20", 10);
                console.warn(`Rate limit hit (429) for ${url}. Retrying after ${retryAfter} seconds... (Attempt ${attempt + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
                continue;
            }
            return response;
        } catch (error) {
            console.warn(`Fetch attempt ${attempt + 1}/${maxRetries} failed for ${url}: ${error.message}`);
            if (attempt === maxRetries - 1) throw error;
            await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
        }
    }
    throw new Error(`Failed to fetch ${url} after ${maxRetries} retries`);
}


async function getDeviceCode(session) {
    console.log("Requesting new device code...");
    const body = new URLSearchParams({
        client_id: API_CLIENT.clientId,
        scope: API_CLIENT.scope
    });

    const response = await fetchWithRetry(`${AUTH_URL_BASE}/device_authorization`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
    });

    if (!response.ok) {
        let errorData;
        try {
            errorData = await response.json();
        } catch (e) {
            errorData = { message: response.statusText };
        }
        throw new Error(`Failed to get device code: ${response.status} - ${errorData.userMessage || errorData.message || 'Unknown error'}`);
    }

    const data = await response.json();
    session.deviceCode = data.deviceCode;
    session.userCode = data.userCode;
    session.verificationUrl = data.verificationUriComplete || data.verificationUri;
    session.authCheckTimeout = Date.now() + (data.expiresIn * 1000);
    session.authCheckInterval = data.interval * 1000;

    console.log("\n---------------------------------------------------------------------");
    console.log(" TIDAL DEVICE AUTHENTICATION REQUIRED");
    console.log("---------------------------------------------------------------------");
    console.log(`1. Open your web browser and go to: https://${session.verificationUrl}`);
    console.log(`2. Enter the following code: ${session.userCode} if asked`);
    console.log("---------------------------------------------------------------------");
    console.log("\nWaiting for authorization (this may take a moment)...");
}

async function pollForToken(session) {
    const basicAuth = `Basic ${Buffer.from(`${API_CLIENT.clientId}:${API_CLIENT.clientSecret}`).toString('base64')}`;
    const body = new URLSearchParams({
        client_id: API_CLIENT.clientId,
        device_code: session.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        scope: API_CLIENT.scope
    });

    while (Date.now() < session.authCheckTimeout) {
        await new Promise(resolve => setTimeout(resolve, session.authCheckInterval));
        process.stdout.write(".");

        const response = await fetchWithRetry(`${AUTH_URL_BASE}/token`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': basicAuth
            },
            body: body.toString()
        });

        if (response.ok) {
            const tokenData = await response.json();
            session.updateTokens(tokenData);
            console.log("\nAuthorization successful!");
            await saveSession(session);
            session.clearDeviceAuthDetails();
            return true;
        } else {
            let errorData;
            try {
                errorData = await response.json();
            } catch (e) {
                errorData = { status: response.status, sub_status: 0, userMessage: response.statusText };
            }

            if (errorData.status === 400 && errorData.sub_status === 1002) {
                // Authorization pending, continue polling
            } else {
                console.error(`\nError polling for token: ${errorData.status} - ${errorData.sub_status || ''} - ${errorData.userMessage || errorData.error_description || 'Unknown error'}`);
                session.clearDeviceAuthDetails();
                return false;
            }
        }
    }
    console.log("\nDevice-code authorization timed out.");
    session.clearDeviceAuthDetails();
    return false;
}

async function refreshAccessToken(session) {
    if (!session.hasRefreshToken()) {
        console.log("No refresh token available to refresh session.");
        return false;
    }
    console.log("Attempting to refresh access token...");
    const basicAuth = `Basic ${Buffer.from(`${API_CLIENT.clientId}:${API_CLIENT.clientSecret}`).toString('base64')}`;
    const body = new URLSearchParams({
        client_id: API_CLIENT.clientId,
        refresh_token: session.refreshToken,
        grant_type: 'refresh_token',
        scope: API_CLIENT.scope
    });

    const response = await fetchWithRetry(`${AUTH_URL_BASE}/token`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': basicAuth
        },
        body: body.toString()
    });

    if (response.ok) {
        const tokenData = await response.json();
        session.updateTokens(tokenData);
        console.log("Access token refreshed successfully.");
        await saveSession(session);
        return true;
    } else {
        let errorData;
        try {
            errorData = await response.json();
        } catch(e) {
            errorData = {};
        }
        console.error(`Failed to refresh access token: ${response.status} - ${errorData.userMessage || errorData.error_description || 'Unknown error'}`);
        session.clearAuthDetails();
        await saveSession(session);
        return false;
    }
}

async function authenticate() {
    let session = await loadSession();

    if (session.isAccessTokenValid()) {
        console.log("Found valid access token in session. Authentication successful (using existing session).");
        return session;
    }

    if (session.hasRefreshToken()) {
        console.log("Access token expired or invalid. Attempting to use refresh token.");
        if (await refreshAccessToken(session)) {
            console.log("Authentication successful (after refreshing token).");
            return session;
        }
    }

    console.log("No valid session found or refresh failed. Starting new device authentication flow.");
    session.clearAuthDetails();
    try {
        await getDeviceCode(session);
        if (await pollForToken(session)) {
            console.log("Authentication successful (new device authorization).");
            return session;
        } else {
            console.error("Device authentication process failed or timed out.");
            return null;
        }
    } catch (error) {
        console.error(`Device authentication flow error: ${error.message}`);
        return null;
    }
}

export { authenticate, TidalSession, saveSession, loadSession, refreshAccessToken, getDeviceCode, pollForToken, API_CLIENT };