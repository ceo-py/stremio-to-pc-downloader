// Copyright (C) 2017-2023 Smart code 203358507

/**
 * Client for the "Stremio -> qBittorrent" bridge that runs on the PC.
 *
 * The bridge is a small local service that forwards the torrent of a stream to
 * the qBittorrent instance running on the same machine and starts the
 * download there.
 *
 * The endpoint is resolved in this order:
 *  1. `window.STREMIO_DOWNLOAD_ENDPOINT` - injected by the bridge through
 *     `/config.js`, so the address can be changed without rebuilding;
 *  2. `localStorage.stremioDownloadEndpoint` - manual override;
 *  3. `/api/download` on the current origin - works out of the box when the
 *     bridge serves this very app.
 */

const DEFAULT_ENDPOINT = '/api/download';
const STORAGE_KEY = 'stremioDownloadEndpoint';

const getEndpoint = () => {
    try {
        if (typeof window !== 'undefined') {
            if (typeof window.STREMIO_DOWNLOAD_ENDPOINT === 'string' && window.STREMIO_DOWNLOAD_ENDPOINT.length > 0) {
                return window.STREMIO_DOWNLOAD_ENDPOINT;
            }

            const stored = window.localStorage.getItem(STORAGE_KEY);
            if (typeof stored === 'string' && stored.length > 0) {
                return stored;
            }
        }
    } catch (error) {
        // localStorage throws in some private browsing modes - use the default.
    }

    return DEFAULT_ENDPOINT;
};

/**
 * Ask the bridge to start the download of a torrent stream on the PC.
 *
 * @param {object} payload
 * @param {string} payload.magnet            magnet link of the torrent
 * @param {string} [payload.infoHash]        info hash of the torrent
 * @param {number} [payload.fileIdx]         index of the wanted file in the torrent
 * @param {string[]} [payload.fileMustInclude] name fragments of the wanted file
 * @param {string} [payload.title]           display name of the stream
 * @returns {Promise<object>} the bridge answer
 */
const sendToDownloadClient = async (payload) => {
    const endpoint = getEndpoint();

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });

    let result = null;

    try {
        result = await response.json();
    } catch (error) {
        // The bridge answered with something that is not JSON.
    }

    if (!response.ok || !result || result.ok === false) {
        const message = (result && result.error) || `the PC bridge answered with ${response.status}`;

        throw new Error(message);
    }

    return result;
};

module.exports = { sendToDownloadClient, getEndpoint, DEFAULT_ENDPOINT, STORAGE_KEY };
