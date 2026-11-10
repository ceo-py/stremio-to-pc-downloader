'use strict';

/**
 * Stremio -> qBittorrent bridge.
 *
 * Runs on the PC that hosts qBittorrent. It does two jobs:
 *
 *  1. It serves the modified Stremio web app (the `stremio-web/build` folder)
 *     so the phone can use it as an installed PWA.
 *  2. It exposes `POST /api/download`, which the "Download to PC" button in the
 *     Stremio UI calls. The bridge forwards the magnet to the local qBittorrent
 *     WebUI, picks the right file inside the torrent and starts the download.
 *
 * Everything the bridge does on the qBittorrent side happens on localhost, so
 * the browser on the phone never talks to qBittorrent directly (qBittorrent
 * sends no CORS headers and rejects cross site requests).
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { URL } = require('url');

const { loadConfig } = require('./lib/config');
const { QBittorrentClient, QBittorrentError } = require('./lib/qbittorrent');
const { sendToQbittorrent } = require('./lib/downloader');
const { buildMagnet, infoHashFromMagnet } = require('./lib/magnet');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const config = loadConfig(CONFIG_PATH);

const client = new QBittorrentClient(config.qbittorrent);

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.wasm': 'application/wasm',
    '.map': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
};

const escapeHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const sendJson = (response, status, payload) => {
    const body = JSON.stringify(payload, null, 2);
    response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
    });
    response.end(body);
};

const sendHtml = (response, status, html) => {
    response.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(html),
        'Cache-Control': 'no-store',
    });
    response.end(html);
};

const applyCors = (request, response) => {
    if (!config.allowOrigin) return;

    const origin = config.allowOrigin === '*'
        ? '*'
        : (request.headers.origin || config.allowOrigin);

    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Bridge-Token');
};

const readBody = (request, limit = 1024 * 512) => new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    request.on('data', (chunk) => {
        size += chunk.length;
        if (size > limit) {
            reject(new Error('Request body too large'));
            request.destroy();
            return;
        }
        chunks.push(chunk);
    });

    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
});

/**
 * Authorization: only needed when a shared token is configured.
 */
const isAuthorized = (request, url) => {
    if (!config.token) return true;

    const header = request.headers['x-bridge-token'];
    if (header && header === config.token) return true;

    const queryToken = url.searchParams.get('token');
    if (queryToken && queryToken === config.token) return true;

    return false;
};

/**
 * The bridge injects a tiny runtime configuration script into the app shell so
 * the download endpoint can be changed without rebuilding the Stremio app.
 */
const CONFIG_SCRIPT_TAG = '<script src="/config.js"></script>';

const injectConfigScript = (html) => {
    if (html.includes('/config.js')) return html;

    if (html.includes('</head>')) {
        return html.replace('</head>', `  ${CONFIG_SCRIPT_TAG}\n</head>`);
    }

    return `${CONFIG_SCRIPT_TAG}\n${html}`;
};

const renderConfigScript = () => {
    const endpoint = config.downloadEndpoint || '/api/download';

    return `window.STREMIO_DOWNLOAD_ENDPOINT = ${JSON.stringify(endpoint)};\n`;
};

/**
 * Development helper: adds the local test addon to the Stremio profile of the
 * browser that visits this page, so the torrent stream rows can be verified
 * without installing a real torrent addon.
 *
 * Only available when the bridge is started with BRIDGE_DEV_ROUTES=1.
 */
/**
 * The official addons that a fresh Stremio profile contains (stremio-core's
 * OFFICIAL_ADDONS). Without them the core finds no metadata, because meta
 * requests are only dispatched to addons that live in `profile.addons`.
 */
const OFFICIAL_MANIFEST_URLS = ['https://v3-cinemeta.strem.io/manifest.json'];

const fetchDescriptor = async (transportUrl, official) => {
    const response = await fetch(transportUrl, { headers: { Accept: 'application/json' } });

    if (!response.ok) {
        throw new Error(`manifest fetch failed for ${transportUrl}: ${response.status}`);
    }

    return {
        manifest: await response.json(),
        transportUrl,
        flags: { official, protected: false },
    };
};

const buildLocalDescriptor = () => {
    // The manifest mirrors exactly how stremio-core serializes a Manifest,
    // so that the profile still deserializes in the core.
    const manifest = {
        id: 'org.local.torrenttest',
        version: '1.0.0',
        name: 'Local Torrent Test',
        contactEmail: null,
        description: 'Serves a single torrent stream so the download button can be tested.',
        logo: null,
        background: null,
        types: ['movie'],
        resources: ['catalog', 'meta', 'stream'],
        idPrefixes: null,
        catalogs: [{ id: 'local-torrents', type: 'movie', name: 'Local Torrents', extra: [] }],
        addonCatalogs: [],
        behaviorHints: {
            adult: false,
            p2p: false,
            configurable: false,
            configurationRequired: false,
            epgProvider: false,
        },
    };

    return {
        manifest,
        transportUrl: 'http://127.0.0.1:7000/manifest.json',
        flags: { official: false, protected: false },
    };
};

// stremio-core's Settings::default() - the profile requires every field.
const DEFAULT_SETTINGS = {
        interfaceLanguage: 'eng',
        interfaceScale: 100,
        hideSpoilers: false,
        gamepadSupport: false,
        streamingServerUrl: 'http://127.0.0.1:11470',
        playerType: null,
        bingeWatching: true,
        playInBackground: true,
        hardwareDecoding: true,
        gpuVideoProcessing: false,
        videoMode: null,
        frameRateMatchingStrategy: 'Disabled',
        nextVideoNotificationDuration: 35000,
        audioPassthrough: false,
        audioLanguage: 'eng',
        secondaryAudioLanguage: null,
        subtitlesLanguage: 'eng',
        secondarySubtitlesLanguage: null,
        subtitlesAutoSelect: true,
        subtitlesSize: 100,
        subtitlesFont: 'Roboto',
        subtitlesBold: false,
        subtitlesOffset: 5,
        subtitlesTextColor: '#FFFFFFFF',
        subtitlesBackgroundColor: '#00000000',
        subtitlesOutlineColor: '#000000',
        subtitlesOpacity: 100,
        assSubtitlesStyling: false,
        escExitFullscreen: true,
        seekTimeDuration: 10000,
        seekShortTimeDuration: 3000,
        pauseOnMinimize: false,
        quitOnClose: true,
        surroundSound: false,
        streamingServerWarningDismissed: null,
        serverInForeground: false,
        sendCrashReports: true,
        discordRpcEnabled: false,
    };

/**
 * Renders the page that writes the given addon descriptors into the Stremio
 * profile of the visiting browser.
 */
const renderSeedHtml = ({ descriptors, defaultSettings, title }) => `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family:system-ui,sans-serif;background:#1e1b2e;color:#fff;padding:2rem">
<h1>${title}</h1>
<p id="status">Working...</p>
<script>
try {
    const remove = location.search.indexOf('remove=1') !== -1;
    const descriptors = ${JSON.stringify(descriptors)};
    const profile = JSON.parse(localStorage.getItem('profile') || '{}');
    profile.auth = profile.auth || null;
    profile.addons = (profile.addons || []).filter((addon) => !descriptors.some((d) => d.transportUrl === addon.transportUrl));
    if (!remove) profile.addons = profile.addons.concat(descriptors);
    profile.addonsLocked = profile.addonsLocked === true;
    profile.settings = profile.settings || ${JSON.stringify(defaultSettings)};
    localStorage.setItem('profile', JSON.stringify(profile));
    document.getElementById('status').textContent = (remove ? 'Addons removed' : 'Addons installed: ' + descriptors.map((d) => d.manifest.id).join(', ')) + ', redirecting...';
    location.replace('/#/');
} catch (error) {
    document.getElementById('status').textContent = 'Failed: ' + error.message;
}
</script>
</body></html>`;

const renderStoragePage = () => `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Storage</title></head>
<body style="font-family:system-ui,sans-serif;background:#1e1b2e;color:#fff;padding:2rem">
<h1>localStorage</h1>
<pre id="out"></pre>
<script>
const lines = [];
for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    const value = localStorage.getItem(key);
    lines.push('KEY: ' + key + ' (' + value.length + ' chars)');
    lines.push('---');
}
try {
    const profile = JSON.parse(localStorage.getItem('profile') || '{}');
    lines.push('addons in profile:');
    for (const addon of (profile.addons || [])) {
        lines.push('  - ' + addon.manifest.id + ' @ ' + addon.transportUrl);
    }
    lines.push('profile keys: ' + Object.keys(profile).join(', '));
    lines.push('settings keys: ' + Object.keys(profile.settings || {}).length);
} catch (error) {
    lines.push('profile parse failed: ' + error.message);
}
document.getElementById('out').textContent = lines.join('\\n');
</script>
</body></html>`;

const renderResetPage = () => `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Reset</title></head>
<body style="font-family:system-ui,sans-serif;background:#1e1b2e;color:#fff;padding:2rem">
<h1>Resetting</h1>
<p id="status">Working...</p>
<script>
(async () => {
    const lines = [];
    try {
        const registrations = await navigator.serviceWorker.getRegistrations();
        for (const registration of registrations) {
            lines.push('unregistering ' + registration.scope);
            await registration.unregister();
        }
        const keys = await caches.keys();
        for (const key of keys) {
            lines.push('deleting cache ' + key);
            await caches.delete(key);
        }
        localStorage.clear();
        lines.push('localStorage cleared');
    } catch (error) {
        lines.push('error: ' + error.message);
    }
    document.getElementById('status').textContent = lines.join(' | ');
    setTimeout(() => location.replace('/#/'), 800);
})();
</script>
</body></html>`;

/**
 * Serve the built Stremio web app.
 */
const serveStatic = (request, response, url) => {
    const staticDir = config.staticDir;

    if (!staticDir || !fs.existsSync(staticDir)) {
        sendHtml(response, 503, `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Stremio bridge</title>
<style>body{font-family:system-ui,sans-serif;background:#1e1b2e;color:#fff;padding:2rem;line-height:1.6}
code{background:#00000040;padding:.15rem .4rem;border-radius:.3rem}</style></head>
<body><h1>Stremio bridge is running</h1>
<p>The modified Stremio web app has not been built yet.</p>
<p>Build it with <code>corepack pnpm install &amp;&amp; corepack pnpm build</code> inside <code>stremio-web/</code>,
then reload this page.</p>
<p>API health check: <a href="/api/health">/api/health</a> &middot; downloads: <a href="/bridge/">/bridge/</a></p>
</body></html>`);
        return;
    }

    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';

    const filePath = path.join(staticDir, path.normalize(pathname));

    // Prevent path traversal outside of the static folder.
    if (!filePath.startsWith(staticDir)) {
        sendHtml(response, 403, 'Forbidden');
        return;
    }

    fs.stat(filePath, (error, stats) => {
        if (error || !stats.isFile()) {
            // Single page app fallback.
            const fallback = path.join(staticDir, 'index.html');
            fs.readFile(fallback, (fallbackError, content) => {
                if (fallbackError) {
                    sendHtml(response, 404, 'Not found');
                    return;
                }
                response.writeHead(200, {
                    'Content-Type': 'text/html; charset=utf-8',
                    'Content-Length': content.length,
                    'Cache-Control': 'no-cache',
                });
                response.end(injectConfigScript(content.toString('utf8')));
            });
            return;
        }

        if (path.basename(filePath) === 'index.html') {
            fs.readFile(filePath, (readError, content) => {
                if (readError) {
                    sendHtml(response, 500, 'Could not read index.html');
                    return;
                }
                const html = injectConfigScript(content.toString('utf8'));
                response.writeHead(200, {
                    'Content-Type': 'text/html; charset=utf-8',
                    'Content-Length': Buffer.byteLength(html),
                    'Cache-Control': 'no-cache',
                });
                response.end(html);
            });
            return;
        }

        const extension = path.extname(filePath).toLowerCase();
        const headers = {
            'Content-Type': MIME_TYPES[extension] || 'application/octet-stream',
            'Content-Length': stats.size,
        };

        // The service worker and the html shell must never be cached hard,
        // everything else can be cached by the browser.
        if (filePath.endsWith('index.html') || filePath.endsWith('sw.js')) {
            headers['Cache-Control'] = 'no-cache';
        } else {
            headers['Cache-Control'] = 'public, max-age=3600';
        }

        response.writeHead(200, headers);
        fs.createReadStream(filePath).pipe(response);
    });
};

/**
 * The "Download to PC" landing page - usable as a plain bookmark and as the
 * target of an `externalUrl` stream.
 */
const renderDownloadPage = ({ ok, title, message, details, magnet }) => {
    const rows = (details || [])
        .map((detail) => `<li><strong>${escapeHtml(detail.name || '')}</strong><br><span>${escapeHtml(detail.detail || '')}</span></li>`)
        .join('');

    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${ok ? 'Added to qBittorrent' : 'Download failed'}</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;background:#1e1b2e;color:#f4f1ff;padding:1.5rem;display:flex;justify-content:center}
.card{max-width:34rem;width:100%;background:#2a2843;border-radius:1rem;padding:1.5rem}
h1{margin:0 0 .5rem;font-size:1.4rem}
p{margin:.4rem 0;color:#c9c4e0;line-height:1.5}
.ok{color:#63d471}.bad{color:#ff6b6b}
ul{padding-left:1.1rem;color:#c9c4e0}li{margin:.5rem 0}
code{background:#00000040;padding:.15rem .4rem;border-radius:.3rem;font-size:.85rem;word-break:break-all}
a{color:#8f7bff}
</style></head>
<body><div class="card">
<h1 class="${ok ? 'ok' : 'bad'}">${ok ? 'Added to qBittorrent' : 'Could not start the download'}</h1>
${title ? `<p><strong>${escapeHtml(title)}</strong></p>` : ''}
<p>${escapeHtml(message)}</p>
${rows ? `<ul>${rows}</ul>` : ''}
${magnet ? `<p><code>${escapeHtml(magnet)}</code></p>` : ''}
<p><a href="/bridge/">Open the download list</a></p>
</div></body></html>`;
};

/**
 * A small dashboard that lists everything qBittorrent is working on.
 */
const renderDashboard = () => `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Stremio downloads</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;background:#1e1b2e;color:#f4f1ff;padding:1.5rem}
h1{font-size:1.3rem}
table{width:100%;border-collapse:collapse;margin-top:1rem}
th,td{text-align:left;padding:.55rem .4rem;border-bottom:1px solid #ffffff18;font-size:.9rem;vertical-align:top}
th{color:#a49ec2;font-weight:500}
.bar{height:.4rem;background:#ffffff18;border-radius:.3rem;overflow:hidden;min-width:6rem}
.bar>div{height:100%;background:#8f7bff}
.state{color:#a49ec2;font-size:.8rem}
</style></head>
<body>
<h1>qBittorrent downloads</h1>
<p class="state" id="summary">Loading...</p>
<table><thead><tr><th>Name</th><th>Progress</th><th>Size</th><th>State</th></tr></thead><tbody id="rows"></tbody></table>
<script>
async function refresh() {
    try {
        const response = await fetch('/api/torrents');
        const data = await response.json();
        if (!data.ok) { document.getElementById('summary').textContent = data.error || 'Bridge error'; return; }
        const torrents = data.torrents || [];
        document.getElementById('summary').textContent = torrents.length + ' torrent(s)';
        document.getElementById('rows').innerHTML = torrents.map((torrent) => {
            const progress = Math.round((torrent.progress || 0) * 100);
            return '<tr><td>' + (torrent.name || torrent.hash || '') + '</td>' +
                '<td><div class="bar"><div style="width:' + progress + '%"></div></div><span class="state">' + progress + '%</span></td>' +
                '<td>' + (torrent.size || 0) + '</td>' +
                '<td class="state">' + (torrent.state || '') + '</td></tr>';
        }).join('');
    } catch (error) {
        document.getElementById('summary').textContent = 'Bridge unreachable: ' + error.message;
    }
}
refresh();
setInterval(refresh, 2000);
</script>
</body></html>`;

/**
 * Turn the payload coming from the Stremio UI into a magnet link.
 */
const resolveMagnet = (payload) => {
    if (typeof payload.magnet === 'string' && payload.magnet.length > 0) {
        return payload.magnet;
    }

    const trackers = Array.isArray(payload.trackers)
        ? payload.trackers
        : (Array.isArray(payload.announce) ? payload.announce : []);

    return buildMagnet({
        infoHash: payload.infoHash,
        trackers,
        name: payload.title,
    });
};

const handleDownload = async (payload) => {
    const magnet = resolveMagnet(payload);

    if (!magnet) {
        throw new QBittorrentError('The request did not contain a magnet link or an info hash.');
    }

    const result = await sendToQbittorrent(client, {
        magnet,
        infoHash: payload.infoHash || infoHashFromMagnet(magnet),
        trackers: payload.trackers || payload.announce || [],
        title: payload.title || payload.name || null,
        fileIdx: typeof payload.fileIdx === 'number' ? payload.fileIdx : null,
        fileMustInclude: Array.isArray(payload.fileMustInclude) ? payload.fileMustInclude : [],
    }, {
        savePath: config.downloads.savePath || undefined,
        category: config.downloads.category || undefined,
        tags: config.downloads.tags || undefined,
        timeout: config.downloads.metadataTimeout,
    });

    return result;
};

const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

    applyCors(request, response);

    if (request.method === 'OPTIONS') {
        response.writeHead(204);
        response.end();
        return;
    }

    try {
        if (url.pathname.startsWith('/api/') || url.pathname === '/download' || url.pathname === '/bridge/') {
            if (!isAuthorized(request, url)) {
                sendJson(response, 401, { ok: false, error: 'Invalid or missing bridge token.' });
                return;
            }
        }

        if (url.pathname === '/config.js') {
            const body = renderConfigScript();
            response.writeHead(200, {
                'Content-Type': 'text/javascript; charset=utf-8',
                'Content-Length': Buffer.byteLength(body),
                'Cache-Control': 'no-store',
            });
            response.end(body);
            return;
        }

        if (url.pathname === '/dev/reset' && process.env.BRIDGE_DEV_ROUTES === '1') {
            sendHtml(response, 200, renderResetPage());
            return;
        }

        if (url.pathname === '/dev/storage' && process.env.BRIDGE_DEV_ROUTES === '1') {
            sendHtml(response, 200, renderStoragePage());
            return;
        }

        if (url.pathname === '/dev/seed-test-addon' && process.env.BRIDGE_DEV_ROUTES === '1') {
            const descriptors = [buildLocalDescriptor()];

            for (const manifestUrl of OFFICIAL_MANIFEST_URLS) {
                try {
                    descriptors.push(await fetchDescriptor(manifestUrl, true));
                } catch (error) {
                    console.warn(`[bridge] could not fetch official manifest: ${error.message}`);
                }
            }

            sendHtml(response, 200, renderSeedHtml({
                descriptors,
                defaultSettings: DEFAULT_SETTINGS,
                title: 'Seeding addons',
            }));
            return;
        }

        if (url.pathname === '/api/health') {
            let qbittorrent = { ok: false, error: 'qBittorrent is not reachable.' };

            try {
                const version = await client.getVersion();
                qbittorrent = { ok: true, version };
            } catch (error) {
                qbittorrent = { ok: false, error: error.message };
            }

            sendJson(response, 200, {
                ok: true,
                service: 'stremio-qbittorrent-bridge',
                qbittorrent,
                staticDir: config.staticDir,
                staticReady: fs.existsSync(path.join(config.staticDir, 'index.html')),
            });
            return;
        }

        if (url.pathname === '/api/torrents') {
            try {
                const torrents = await client.getTorrents();
                sendJson(response, 200, { ok: true, torrents });
            } catch (error) {
                sendJson(response, 502, { ok: false, error: error.message });
            }
            return;
        }

        if (url.pathname === '/api/download' && request.method === 'POST') {
            let payload;

            try {
                const raw = await readBody(request);
                payload = raw ? JSON.parse(raw) : {};
            } catch (error) {
                sendJson(response, 400, { ok: false, error: `Invalid JSON body: ${error.message}` });
                return;
            }

            const label = payload.title || payload.infoHash || 'torrent';
            const from = request.socket.remoteAddress || 'unknown';

            try {
                const result = await handleDownload(payload);
                console.log(`[bridge] download from ${from}: ${label} -> started in qBittorrent`);
                sendJson(response, 200, result);
            } catch (error) {
                console.log(`[bridge] download from ${from}: ${label} -> failed: ${error.message}`);
                const status = error instanceof QBittorrentError ? 502 : 500;
                sendJson(response, status, { ok: false, error: error.message });
            }
            return;
        }

        if (url.pathname === '/download' && request.method === 'GET') {
            const payload = {
                magnet: url.searchParams.get('magnet'),
                infoHash: url.searchParams.get('infoHash'),
                title: url.searchParams.get('title'),
                fileIdx: url.searchParams.get('fileIdx') !== null ? Number(url.searchParams.get('fileIdx')) : null,
                fileMustInclude: (url.searchParams.get('fileMustInclude') || '').split('|').filter(Boolean),
            };

            try {
                const result = await handleDownload(payload);
                const details = [];
                if (result.file) {
                    details.push({ name: result.file.name, detail: `Selected file #${result.file.index}` });
                }
                details.push({ name: result.name || result.hash, detail: `${result.state || 'unknown'} - ${result.savePath || ''}` });

                sendHtml(response, 200, renderDownloadPage({
                    ok: true,
                    title: payload.title,
                    message: result.alreadyPresent
                        ? 'The torrent was already in qBittorrent and is now running.'
                        : 'The torrent was handed over to qBittorrent on your PC.',
                    details,
                    magnet: result.magnet,
                }));
            } catch (error) {
                sendHtml(response, 502, renderDownloadPage({
                    ok: false,
                    title: payload.title,
                    message: error.message,
                    magnet: payload.magnet,
                }));
            }
            return;
        }

        if (url.pathname === '/bridge/' || url.pathname === '/bridge') {
            sendHtml(response, 200, renderDashboard());
            return;
        }

        // Everything else is the Stremio web app.
        serveStatic(request, response, url);
    } catch (error) {
        sendJson(response, 500, { ok: false, error: error.message });
    }
});

server.listen(config.port, config.host, () => {
    console.log(`Stremio -> qBittorrent bridge listening on http://${config.host}:${config.port}`);
    console.log(`  qBittorrent : ${config.qbittorrent.url}`);
    console.log(`  static app  : ${config.staticDir}`);
    console.log(`  downloads   : ${config.downloads.savePath || '(qBittorrent default save path)'}`);
});
