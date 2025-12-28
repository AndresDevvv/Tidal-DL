'use strict';

import axios from 'axios';

const TIDAL_API_BASE_URL = 'https://listen.tidal.com/v1';
const PLAYLIST_ITEMS_PAGE_SIZE = 100;

function buildPlaylistItemsUrl(playlistId, countryCode, limit, offset) {
    const url = new URL(`${TIDAL_API_BASE_URL}/playlists/${playlistId}/items`);
    if (countryCode) {
        url.searchParams.set('countryCode', countryCode);
    }
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', String(offset));
    return url.toString();
}

function buildPlaylistMetadataUrl(playlistId, countryCode) {
    const url = new URL(`${TIDAL_API_BASE_URL}/playlists/${playlistId}`);
    if (countryCode) {
        url.searchParams.set('countryCode', countryCode);
    }
    return url.toString();
}

function extractTrackIdFromPlaylistItem(item) {
    if (!item || typeof item !== 'object') return null;

    const candidate = item.item || item;
    const type = candidate.type || item.type;
    if (type && type !== 'track') return null;

    return (
        candidate.id ||
        candidate.trackId ||
        candidate?.resource?.id ||
        item.trackId ||
        null
    );
}

async function fetchPlaylistMetadata(playlistId, accessToken, countryCode) {
    if (!playlistId || !accessToken) {
        throw new Error('playlistId and accessToken are required to fetch playlist metadata.');
    }

    const apiUrl = buildPlaylistMetadataUrl(playlistId, countryCode);
    const headers = { 'Authorization': `Bearer ${accessToken}` };

    const response = await axios.get(apiUrl, { headers });
    return response.data;
}

async function fetchPlaylistTrackIds(playlistId, accessToken, countryCode) {
    if (!playlistId || !accessToken) {
        throw new Error('playlistId and accessToken are required to fetch playlist items.');
    }

    const headers = { 'Authorization': `Bearer ${accessToken}` };
    const trackIds = [];
    let skippedCount = 0;
    let offset = 0;
    let totalItems = null;

    while (true) {
        const apiUrl = buildPlaylistItemsUrl(playlistId, countryCode, PLAYLIST_ITEMS_PAGE_SIZE, offset);
        const response = await axios.get(apiUrl, { headers });
        const items = response.data?.items || [];

        if (totalItems === null) {
            totalItems = response.data?.totalNumberOfItems ?? response.data?.total ?? null;
        }

        for (const item of items) {
            const trackId = extractTrackIdFromPlaylistItem(item);
            if (trackId) {
                trackIds.push(trackId);
            } else {
                skippedCount++;
            }
        }

        offset += items.length;

        if (items.length < PLAYLIST_ITEMS_PAGE_SIZE) {
            break;
        }
        if (totalItems !== null && offset >= totalItems) {
            break;
        }
    }

    const resolvedTotalItems = totalItems ?? (trackIds.length + skippedCount);
    return { trackIds, skippedCount, totalItems: resolvedTotalItems };
}

export { fetchPlaylistMetadata, fetchPlaylistTrackIds };
