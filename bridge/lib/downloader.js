'use strict';

const { QBittorrentError } = require('./qbittorrent');
const {
    buildMagnet,
    infoHashFromMagnet,
    pickTargetFile,
} = require('./magnet');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const NOT_READY_STATES = new Set(['metaDL', 'moving', 'unknown']);

/**
 * Wait until qBittorrent knows the torrent and its metadata has been fetched.
 *
 * A magnet link carries no file list, so the file selection can only happen
 * after libtorrent downloaded the metadata from the swarm.
 */
const waitForMetadata = async (client, hash, { timeout = 90000, interval = 1500 } = {}) => {
    const deadline = Date.now() + timeout;
    let last = null;

    while (Date.now() < deadline) {
        const torrent = await client.getTorrent(hash);
        last = torrent;

        if (torrent) {
            if (torrent.has_metadata === false) {
                // qBittorrent 5.2+ reports this explicitly.
                await sleep(interval);
                continue;
            }
            if (!NOT_READY_STATES.has(torrent.state)) return torrent;
        }

        await sleep(interval);
    }

    return last;
};

/**
 * Hand a Stremio torrent stream over to qBittorrent and start the download.
 *
 * @param {import('./qbittorrent').QBittorrentClient} client
 * @param {object} request
 * @param {string} [request.magnet]        magnet URI (preferred)
 * @param {string} [request.infoHash]      info hash, used when no magnet is given
 * @param {string[]} [request.trackers]    tracker urls, used to build a magnet
 * @param {string} [request.title]         display name of the stream
 * @param {number} [request.fileIdx]       index of the wanted file inside the torrent
 * @param {string[]} [request.fileMustInclude] name fragments of the wanted file
 * @param {object} [options]               qBittorrent add options
 */
const sendToQbittorrent = async (client, request, options = {}) => {
    const {
        magnet: providedMagnet,
        infoHash,
        trackers = [],
        title,
        fileIdx = null,
        fileMustInclude = [],
    } = request;

    const magnet = providedMagnet || buildMagnet({ infoHash, trackers, name: title });

    if (!magnet) {
        throw new QBittorrentError('Neither a magnet link nor an info hash was provided.');
    }

    const hash = infoHashFromMagnet(magnet);
    if (!hash) {
        throw new QBittorrentError('Could not read the info hash out of the magnet link.');
    }

    await client.login();

    let existed = true;
    let torrent = await client.getTorrent(hash);

    if (!torrent) {
        existed = false;
        await client.addMagnet(magnet, options);
        torrent = await waitForMetadata(client, hash, options);
    }

    if (!torrent) {
        throw new QBittorrentError(
            'qBittorrent did not pick up the torrent. The torrent may be dead (no seeds).'
        );
    }

    const files = await client.getFiles(hash);

    let target = null;
    let selectedFile = null;

    if (files.length > 0) {
        target = pickTargetFile(files, fileIdx, fileMustInclude);

        if (target) {
            const alreadySelected = Number(target.priority || 0) !== 0;

            if (!alreadySelected) {
                const others = files
                    .filter((file) => file.index !== target.index)
                    .map((file) => file.index);

                await client.setFilePriorities(hash, others, 0);
                await client.setFilePriorities(hash, [target.index], 1);
            }

            selectedFile = {
                index: target.index,
                name: target.name,
                size: target.size,
                priority: target.priority,
            };
        }
    }

    await client.start(hash);

    return {
        ok: true,
        hash,
        magnet,
        name: torrent.name || title || null,
        state: torrent.state || null,
        progress: typeof torrent.progress === 'number' ? torrent.progress : 0,
        savePath: torrent.save_path || null,
        alreadyPresent: existed,
        file: selectedFile,
        fileCount: files.length,
        fileHint: {
            fileIdx: fileIdx ?? null,
            fileMustInclude: fileMustInclude || [],
        },
    };
};

module.exports = { sendToQbittorrent, waitForMetadata };
