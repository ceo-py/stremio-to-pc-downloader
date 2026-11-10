'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
    host: '0.0.0.0',
    port: 8787,
    // Absolute base url of this bridge as seen by the phone, e.g.
    // https://mypc.mytailnet.ts.net - only used for display purposes.
    publicUrl: '',
    // Shared secret. When set, requests must carry it as `X-Bridge-Token`
    // header or `?token=` query parameter. Leave empty for a private network.
    token: '',
    // Value for the Access-Control-Allow-Origin header. Empty = same origin only.
    allowOrigin: '',
    // Endpoint the Stremio UI posts the torrent to. Relative to this server.
    downloadEndpoint: '/api/download',
    qbittorrent: {
        url: 'http://127.0.0.1:8080',
        username: 'admin',
        password: 'adminadmin',
        timeout: 20000,
    },
    downloads: {
        // Where the files are stored. Empty = qBittorrent's default save path.
        savePath: '',
        category: 'stremio',
        tags: 'stremio',
        // How long to wait for the torrent metadata to arrive.
        metadataTimeout: 90000,
    },
    // Static folder that hosts the modified Stremio web app.
    staticDir: '../stremio-web/build',
};

const merge = (base, override) => {
    if (!override || typeof override !== 'object') return { ...base };

    const result = { ...base };
    for (const [key, value] of Object.entries(override)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            result[key] = merge(base[key] || {}, value);
        } else if (value !== undefined) {
            result[key] = value;
        }
    }
    return result;
};

/**
 * Load the configuration from `bridge/config.json`, falling back to the
 * environment for the few values that are handy to override per process.
 */
const loadConfig = (configPath) => {
    let fileConfig = {};

    try {
        fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }

    const config = merge(DEFAULTS, fileConfig);

    if (process.env.BRIDGE_PORT) config.port = Number(process.env.BRIDGE_PORT);
    if (process.env.BRIDGE_HOST) config.host = process.env.BRIDGE_HOST;
    if (process.env.BRIDGE_TOKEN) config.token = process.env.BRIDGE_TOKEN;
    if (process.env.QBITTORRENT_URL) config.qbittorrent.url = process.env.QBITTORRENT_URL;
    if (process.env.QBITTORRENT_USER) config.qbittorrent.username = process.env.QBITTORRENT_USER;
    if (process.env.QBITTORRENT_PASSWORD) config.qbittorrent.password = process.env.QBITTORRENT_PASSWORD;
    if (process.env.QBITTORRENT_SAVE_PATH) config.downloads.savePath = process.env.QBITTORRENT_SAVE_PATH;
    if (process.env.BRIDGE_STATIC_DIR) config.staticDir = process.env.BRIDGE_STATIC_DIR;

    config.staticDir = path.resolve(path.dirname(configPath), config.staticDir);

    return config;
};

module.exports = { loadConfig, DEFAULTS };
