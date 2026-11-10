'use strict';

/**
 * Magnet URI helpers.
 *
 * Stremio's core builds magnet URIs in `stremio-core/src/types/resource/stream.rs`
 * (`build_magnet_uri`) with the shape:
 *
 *     magnet:?dn=<name>&xt=urn:btih:<40 hex chars>&tr=<tracker>&tr=<tracker>
 *
 * Trackers may also be prefixed with `tracker:` or `dht:` in the raw addon
 * payload; the core strips those prefixes before writing the magnet.
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Decode a RFC 4648 base32 string into a Buffer.
 * Node's Buffer has no base32 codec, so this is implemented locally.
 */
const decodeBase32 = (input) => {
    const cleaned = input.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
    let bits = 0;
    let value = 0;
    const out = [];

    for (const char of cleaned) {
        const index = BASE32_ALPHABET.indexOf(char);
        if (index === -1) return null;
        value = (value << 5) | index;
        bits += 5;
        if (bits >= 8) {
            bits -= 8;
            out.push((value >>> bits) & 0xff);
        }
    }

    return Buffer.from(out);
};

/**
 * Normalize a BitTorrent v1 info hash to lowercase 40 char hex.
 * Accepts 40 char hex or 32 char base32. Returns null when not recognizable.
 */
const normalizeInfoHash = (raw) => {
    if (typeof raw !== 'string') return null;

    const value = raw.trim();

    if (/^[0-9a-fA-F]{40}$/.test(value)) return value.toLowerCase();

    if (/^[a-zA-Z2-7]{32}$/.test(value)) {
        const decoded = decodeBase32(value);
        if (decoded && decoded.length === 20) return decoded.toString('hex');
    }

    return null;
};

/**
 * Extract the v1 info hash from a magnet URI.
 */
const infoHashFromMagnet = (magnet) => {
    if (typeof magnet !== 'string') return null;

    const match = magnet.match(/xt=urn:btih:([^&]+)/i);
    if (!match) return null;

    return normalizeInfoHash(decodeURIComponent(match[1]));
};

/**
 * Collect the tracker list (`tr=` params) of a magnet URI.
 */
const trackersFromMagnet = (magnet) => {
    if (typeof magnet !== 'string') return [];

    const trackers = [];
    const pattern = /[?&]tr=([^&]+)/gi;
    let match = pattern.exec(magnet);

    while (match !== null) {
        trackers.push(decodeURIComponent(match[1]));
        match = pattern.exec(magnet);
    }

    return trackers;
};

/**
 * Read the display name (`dn=`) of a magnet URI.
 */
const displayNameFromMagnet = (magnet) => {
    if (typeof magnet !== 'string') return null;

    const match = magnet.match(/[?&]dn=([^&]+)/i);
    if (!match) return null;

    try {
        return decodeURIComponent(match[1]);
    } catch (error) {
        return match[1];
    }
};

/**
 * Build a magnet URI out of the pieces Stremio gives us.
 *
 * @param {object} options
 * @param {string} [options.infoHash] 40 hex chars (or 32 base32 chars)
 * @param {string[]} [options.trackers] tracker urls
 * @param {string} [options.name] display name
 */
const buildMagnet = ({ infoHash, trackers = [], name } = {}) => {
    const hash = normalizeInfoHash(infoHash);
    if (!hash) return null;

    const params = [];
    params.push(`xt=urn:btih:${hash}`);

    if (name) params.push(`dn=${encodeURIComponent(name)}`);

    for (const tracker of trackers) {
        if (typeof tracker !== 'string' || tracker.length === 0) continue;
        // Stremio's core strips the `tracker:` / `dht:` prefixes.
        const cleaned = tracker.replace(/^tracker:/i, '').replace(/^dht:/i, '');
        params.push(`tr=${encodeURIComponent(cleaned)}`);
    }

    return `magnet:?${params.join('&')}`;
};

/**
 * Pick the file inside a torrent that matches what Stremio asked for.
 *
 * Stremio describes the wanted file with two optional hints:
 *  - `fileIdx`        the index of the file inside the torrent
 *  - `fileMustInclude` a list of substrings; the streaming server picks the
 *                      first file whose name contains one of them
 *
 * When neither is given the streaming server falls back to "largest file in
 * the torrent" (the `-1` file index), so we do the same here.
 *
 * @param {Array<{name: string, size: number}>} files
 * @param {number|undefined|null} fileIdx
 * @param {string[]} fileMustInclude
 */
const pickTargetFile = (files, fileIdx, fileMustInclude = []) => {
    if (!Array.isArray(files) || files.length === 0) return null;

    if (typeof fileIdx === 'number' && Number.isInteger(fileIdx) && fileIdx >= 0) {
        const byIndex = files.find((file) => file.index === fileIdx)
            || files[fileIdx];
        if (byIndex) return byIndex;
    }

    const needles = (fileMustInclude || [])
        .filter((needle) => typeof needle === 'string' && needle.length > 0)
        .map((needle) => needle.toLowerCase());

    if (needles.length > 0) {
        const byName = files.find((file) => {
            const name = String(file.name || '').toLowerCase();
            return needles.some((needle) => name.includes(needle));
        });
        if (byName) return byName;
    }

    // Fallback: the largest file, matching the streaming server's behaviour.
    return files.reduce((largest, file) => (
        !largest || (file.size || 0) > (largest.size || 0) ? file : largest
    ), null);
};

module.exports = {
    buildMagnet,
    decodeBase32,
    displayNameFromMagnet,
    infoHashFromMagnet,
    normalizeInfoHash,
    pickTargetFile,
    trackersFromMagnet,
};
