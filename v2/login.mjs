import { promises as fs } from 'fs';

const API_CLIENT_CONFIG = {
    clientId: '7m7Ap0JC9j1cOM3n',
    clientSecret: 'vRAdA108tlvkJpTsGZS8rGZ7xTlbJ0qaZ2K9saEzsgY=',
    scope: 'r_usr w_usr w_sub'
};

const TIDAL_AUTH_BASE_URL = 'https://auth.tidal.com/v1/oauth2';
const SESSION_PERSISTENCE_FILE = 'tidal_session.json';
const DEFAULT_HTTP_RETRY_DELAY_SECONDS = 20;
const DEFAULT_FETCH_MAX_RETRIES = 3;
const GENERIC_RETRY_BASE_MILLISECONDS = 2000;

class TidalAuthSession {
    constructor(initialSessionData = {}) {
        const defaults = {
            deviceCode: null,
            userCode: null,
            verificationUrl: null,
            authCheckTimeoutTimestamp: null,
            authCheckIntervalMs: null,
            userId: null,
            countryCode: null,
            accessToken: null,
            refreshToken: null,
            tokenExpiresAtTimestamp: null,
        };
        Object.assign(this, defaults, initialSessionData);
    }

    isAccessTokenCurrentlyValid() {
        return this.accessToken && this.tokenExpiresAtTimestamp && Date.now() < this.tokenExpiresAtTimestamp;
    }

    hasValidRefreshToken() {
        return !!this.refreshToken;
    }

    updateAccessTokens(tokenApiResponse) {
        this.accessToken = tokenApiResponse.access_token;
        if (tokenApiResponse.refresh_token) {
            this.refreshToken = tokenApiResponse.refresh_token;
        }
        this.tokenExpiresAtTimestamp = Date.now() + (tokenApiResponse.expires_in * 1000);
        if (tokenApiResponse.user) {
            this.userId = tokenApiResponse.user.userId;
            this.countryCode = tokenApiResponse.user.countryCode;
        }
    }

    invalidateCurrentTokens() {
        this.accessToken = null;
        this.refreshToken = null;
        this.tokenExpiresAtTimestamp = null;
        this.userId = null;
        this.countryCode = null;
    }

    clearActiveDeviceAuthParameters() {
        this.deviceCode = null;
        this.userCode = null;
        this.verificationUrl = null;
        this.authCheckTimeoutTimestamp = null;
        this.authCheckIntervalMs = null;
    }
}

async function persistSession(sessionInstance) {
    const dataToPersist = {
        userId: sessionInstance.userId,
        countryCode: sessionInstance.countryCode,
        accessToken: sessionInstance.accessToken,
        refreshToken: sessionInstance.refreshToken,
        tokenExpiresAtTimestamp: sessionInstance.tokenExpiresAtTimestamp,
    };
    try {
        await fs.writeFile(SESSION_PERSISTENCE_FILE, JSON.stringify(dataToPersist, null, 2));
        console.log(`Session data saved to ${SESSION_PERSISTENCE_FILE}`);
    } catch (error) {
        console.error(`Failed to save session to ${SESSION_PERSISTENCE_FILE}:`, error.message);
    }
}

async function retrievePersistedSession() {
    try {
        const rawData = await fs.readFile(SESSION_PERSISTENCE_FILE, 'utf8');
        const loadedSessionData = JSON.parse(rawData);
        console.log(`Session data loaded from ${SESSION_PERSISTENCE_FILE}`);
        return new TidalAuthSession(loadedSessionData);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log(`No session file found (${SESSION_PERSISTENCE_FILE}). A new session will be initiated.`);
        } else {
            console.warn(`Could not load session from ${SESSION_PERSISTENCE_FILE} (${error.message}). A new session will be initiated.`);
        }
        return new TidalAuthSession();
    }
}

async function fetchWithRetries(url, fetchOptions, maxRetries = DEFAULT_FETCH_MAX_RETRIES) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await fetch(url, fetchOptions);
            if (response.status === 429) {
                const retryAfterSeconds = parseInt(response.headers.get('Retry-After') || String(DEFAULT_HTTP_RETRY_DELAY_SECONDS), 10);
                console.warn(`Rate limit hit for ${url}. Retrying after ${retryAfterSeconds}s. (Attempt ${attempt}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, retryAfterSeconds * 1000));
                continue;
            }
            return response;
        } catch (error) {
            console.warn(`Fetch attempt ${attempt}/${maxRetries} for ${url} failed: ${error.message}`);
            if (attempt === maxRetries) {
                throw new Error(`Failed to fetch ${url} after ${maxRetries} attempts: ${error.message}`);
            }
            await new Promise(resolve => setTimeout(resolve, GENERIC_RETRY_BASE_MILLISECONDS * attempt));
        }
    }
    throw new Error(`Exhausted all retries for ${url} without a successful fetch or specific non-retryable error.`);
}

function createBasicAuthHeader(clientId, clientSecret) {
    return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
}

async function parseErrorResponse(response) {
    try {
        return await response.json();
    } catch (e) {
        return { messageFromStatus: response.statusText, status: response.status };
    }
}

async function requestDeviceCode(sessionInstance) {
    console.log("Requesting new device authorization code...");
    const requestBody = new URLSearchParams({
        client_id: API_CLIENT_CONFIG.clientId,
        scope: API_CLIENT_CONFIG.scope
    });

    const response = await fetchWithRetries(`${TIDAL_AUTH_BASE_URL}/device_authorization`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: requestBody.toString()
    });

    if (!response.ok) {
        const errorDetails = await parseErrorResponse(response);
        const errorMessage = errorDetails.userMessage || errorDetails.message || errorDetails.messageFromStatus || 'Unknown server error';
        throw new Error(`Failed to request device code: ${response.status} - ${errorMessage}`);
    }

    const responseData = await response.json();
    sessionInstance.deviceCode = responseData.deviceCode;
    sessionInstance.userCode = responseData.userCode;
    sessionInstance.verificationUrl = responseData.verificationUriComplete || responseData.verificationUri;
    sessionInstance.authCheckTimeoutTimestamp = Date.now() + (responseData.expiresIn * 1000);
    sessionInstance.authCheckIntervalMs = responseData.interval * 1000;

    console.log("\n--- TIDAL DEVICE AUTHENTICATION REQUIRED ---");
    console.log(`1. Open a web browser and go to: https://${sessionInstance.verificationUrl}`);
    console.log(`2. If prompted, enter this code: ${sessionInstance.userCode}`);
    console.log("--- WAITING FOR AUTHORIZATION ---");
}

async function pollForDeviceAccessToken(sessionInstance) {
    const basicAuthToken = createBasicAuthHeader(API_CLIENT_CONFIG.clientId, API_CLIENT_CONFIG.clientSecret);
    const requestBody = new URLSearchParams({
        client_id: API_CLIENT_CONFIG.clientId,
        device_code: sessionInstance.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        scope: API_CLIENT_CONFIG.scope
    });

    process.stdout.write("Polling for authorization");
    while (Date.now() < sessionInstance.authCheckTimeoutTimestamp) {
        await new Promise(resolve => setTimeout(resolve, sessionInstance.authCheckIntervalMs));
        process.stdout.write(".");

        const response = await fetchWithRetries(`${TIDAL_AUTH_BASE_URL}/token`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': basicAuthToken
            },
            body: requestBody.toString()
        });

        if (response.ok) {
            const tokenData = await response.json();
            sessionInstance.updateAccessTokens(tokenData);
            process.stdout.write("\n");
            console.log("Authorization successful!");
            await persistSession(sessionInstance);
            sessionInstance.clearActiveDeviceAuthParameters();
            return true;
        }

        const errorData = await parseErrorResponse(response);
        if (errorData.status === 400 && errorData.sub_status === 1002) {
            continue;
        } else {
            process.stdout.write("\n");
            const userMessage = errorData.userMessage || errorData.error_description || errorData.messageFromStatus || 'Unknown polling error';
            console.error(`Error polling for token: ${errorData.status} ${errorData.sub_status || ''} - ${userMessage}`);
            sessionInstance.clearActiveDeviceAuthParameters();
            return false;
        }
    }
    process.stdout.write("\n");
    console.log("Device-code authorization timed out.");
    sessionInstance.clearActiveDeviceAuthParameters();
    return false;
}

async function attemptTokenRefresh(sessionInstance) {
    if (!sessionInstance.hasValidRefreshToken()) {
        console.log("No refresh token available. Cannot refresh session.");
        return false;
    }
    console.log("Attempting to refresh access token...");
    const basicAuthToken = createBasicAuthHeader(API_CLIENT_CONFIG.clientId, API_CLIENT_CONFIG.clientSecret);
    const requestBody = new URLSearchParams({
        client_id: API_CLIENT_CONFIG.clientId,
        refresh_token: sessionInstance.refreshToken,
        grant_type: 'refresh_token',
        scope: API_CLIENT_CONFIG.scope
    });

    const response = await fetchWithRetries(`${TIDAL_AUTH_BASE_URL}/token`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': basicAuthToken
        },
        body: requestBody.toString()
    });

    if (response.ok) {
        const tokenData = await response.json();
        sessionInstance.updateAccessTokens(tokenData);
        console.log("Access token refreshed successfully.");
        await persistSession(sessionInstance);
        return true;
    }

    const errorData = await parseErrorResponse(response);
    const userMessage = errorData.userMessage || errorData.error_description || errorData.messageFromStatus || 'Unknown token refresh error';
    console.error(`Failed to refresh access token: ${response.status} - ${userMessage}`);
    sessionInstance.invalidateCurrentTokens();
    await persistSession(sessionInstance);
    return false;
}

async function establishAuthenticatedSession() {
    let currentSession = await retrievePersistedSession();

    if (currentSession.isAccessTokenCurrentlyValid()) {
        console.log("Valid access token found. Authentication successful (using existing session).");
        return currentSession;
    }

    if (currentSession.hasValidRefreshToken()) {
        console.log("Access token expired or invalid. Attempting to use refresh token.");
        if (await attemptTokenRefresh(currentSession)) {
            console.log("Authentication successful (token refreshed).");
            return currentSession;
        }
    }

    console.log("No valid session or refresh failed. Initiating new device authentication.");
    currentSession.invalidateCurrentTokens();
    try {
        await requestDeviceCode(currentSession);
        if (await pollForDeviceAccessToken(currentSession)) {
            console.log("Authentication successful (new device authorization).");
            return currentSession;
        } else {
            console.error("Device authentication process failed or timed out.");
            return null;
        }
    } catch (error) {
        console.error(`Device authentication flow encountered an error: ${error.message}`);
        return null;
    }
}

export {
    establishAuthenticatedSession as authenticate,
    TidalAuthSession as TidalSession,
    persistSession as saveSession,
    retrievePersistedSession as loadSession,
    attemptTokenRefresh as refreshAccessToken,
    requestDeviceCode as getDeviceCode,
    pollForDeviceAccessToken as pollForToken,
    API_CLIENT_CONFIG as API_CLIENT
};