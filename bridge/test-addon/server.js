'use strict';

/**
 * A tiny local Stremio addon that serves exactly one movie with one torrent
 * stream. It exists so the "Download to PC" button can be verified without
 * installing a real torrent addon.
 *
 * Run with: node bridge/test-addon/server.js
 * Install in Stremio with the url: http://127.0.0.1:7000/manifest.json
 */

const http = require('http');

const PORT = Number(process.env.TEST_ADDON_PORT || 7000);

const INFO_HASH = 'df389295484b3059a4726dc6d8a57f71bb5f4c81';
const MAGNET = `magnet:?dn=Big+Buck+Bunny+2008+1080p&xt=urn:btih:${INFO_HASH}&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce`;

const MANIFEST = {
    id: 'org.local.torrenttest',
    version: '1.0.0',
    name: 'Local Torrent Test',
    description: 'Serves a single torrent stream so the download button can be tested.',
    logo: 'https://i.imgur.com/5VOqlSF.png',
    resources: ['catalog', 'meta', 'stream'],
    types: ['movie'],
    catalogs: [
        { type: 'movie', id: 'local-torrents', name: 'Local Torrents' },
    ],
    behaviorHints: { configurable: false },
};

const META = {
    id: 'local-torrent-test-1',
    type: 'movie',
    name: 'Big Buck Bunny',
    poster: 'https://upload.wikimedia.org/wikipedia/commons/c/c5/Big_buck_bunny_poster_big.jpg',
    background: 'https://upload.wikimedia.org/wikipedia/commons/c/c5/Big_buck_bunny_poster_big.jpg',
    logo: 'https://upload.wikimedia.org/wikipedia/commons/c/c5/Big_buck_bunny_poster_big.jpg',
    description: 'A test movie with a torrent stream, used to verify the download button.',
    releaseInfo: '2008',
    runtime: '10 min',
    videos: [
        {
            id: 'local-torrent-test-1:1',
            title: 'Big Buck Bunny',
            released: '2008-05-20',
            overview: 'A large and lovable rabbit deals with three tiny bullies.',
        },
    ],
};

const CATALOG = {
    metas: [META],
};

const STREAMS = {
    streams: [
        {
            name: 'Torrentio',
            description: '1080p\nTorrentio\n👤 25 seeders',
            infoHash: INFO_HASH,
            fileIdx: 1,
            fileMustInclude: ['BigBuckBunny_1080p.mkv'],
            sources: ['tracker:udp://tracker.opentrackr.org:1337/announce'],
            behaviorHints: {
                filename: 'BigBuckBunny_1080p.mkv',
                videoSize: 300 * 1024 * 1024,
                notWebReady: true,
            },
        },
    ],
};

const send = (response, payload) => {
    const body = JSON.stringify(payload);
    response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
    });
    response.end(body);
};

http.createServer((request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${PORT}`);
    const path = url.pathname;

    console.log(`${request.method} ${path}${url.search} (origin: ${request.headers.origin || 'none'})`);

    if (request.method === 'OPTIONS') {
        response.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': '*',
        });
        response.end();
        return;
    }

    if (path === '/manifest.json') return send(response, MANIFEST);
    if (path.startsWith('/catalog/')) return send(response, CATALOG);
    if (path.startsWith('/meta/')) {
        // The addon protocol wraps meta items in a `metas` map keyed by id.
        const id = path.split('/').pop().replace(/\.json$/, '');
        return send(response, { metas: { [id]: META } });
    }
    if (path.startsWith('/stream/')) return send(response, STREAMS);

    response.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
    response.end('{}');
}).listen(PORT, '127.0.0.1', () => {
    console.log(`Test addon listening on http://127.0.0.1:${PORT}/manifest.json`);
});
