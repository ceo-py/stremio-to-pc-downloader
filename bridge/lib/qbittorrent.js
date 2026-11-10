'use strict';

/**
 * Minimal qBittorrent WebUI API client.
 *
 * Reference: https://github.com/qbittorrent/qBittorrent/wiki/WebUI-API-(qBittorrent-4.1)
 *
 * Version notes that matter here:
 *  - the session cookie is `SID` up to 5.1.x and `QBT_SID_<webui port>` from 5.2.0,
 *    so the cookie name is parsed from the `Set-Cookie` header instead of hardcoded;
 *  - a failed login answers `200` + body `Fails.` up to 5.1.x and `401` from 5.2.0;
 *  - `torrents/add` uses `paused=true` on 4.x and `stopped=true` on 5.x, so both are sent
 *    (unknown parameters are ignored by the WebUI);
 *  - "pause" is `torrents/stop` and "resume" is `torrents/start` in the 4.1+ API;
 *  - file priorities are set through `torrents/filePrio` (there is no `setFilePriorities`).
 */

class QBittorrentError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = 'QBittorrentError';
        this.status = details.status;
        this.body = details.body;
        this.cause = details.cause;
    }
}

const SESSION_COOKIE_PATTERN = /^(SID|QBT_SID_\d+)=/;

class QBittorrentClient {
    constructor({ url, username, password, timeout = 20000 } = {}) {
        if (!url) throw new Error('qBittorrent url is required');

        this.baseUrl = String(url).replace(/\/+$/, '');
        this.username = username;
        this.password = password;
        this.timeout = timeout;

        this.cookie = null;
        this.authenticated = false;
        this.version = null;
    }

    /**
     * Low level request helper.
     *
     * No `Origin` / `Referer` header is sent on purpose: qBittorrent's CSRF
     * protection only kicks in when one of those headers is present, and a
     * server side client is allowed to omit them.
     */
    async rawRequest(method, path, { query, form } = {}) {
        const url = new URL(this.baseUrl + path);

        if (query) {
            for (const [key, value] of Object.entries(query)) {
                if (value === undefined || value === null) continue;
                url.searchParams.append(key, String(value));
            }
        }

        const headers = { Accept: 'application/json' };
        let body;

        if (form) {
            headers['Content-Type'] = 'application/x-www-form-urlencoded';
            body = new URLSearchParams(form).toString();
        }

        if (this.cookie) headers.Cookie = this.cookie;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeout);

        let response;
        try {
            response = await fetch(url, {
                method,
                headers,
                body,
                redirect: 'manual',
                signal: controller.signal,
            });
        } catch (error) {
            throw new QBittorrentError(
                `Cannot reach qBittorrent at ${this.baseUrl}: ${error.message}`,
                { cause: error }
            );
        } finally {
            clearTimeout(timer);
        }

        return response;
    }

    /**
     * Authenticate against the WebUI.
     * Safe to call repeatedly - it only logs in when there is no session yet.
     */
    async login() {
        if (this.authenticated) return;

        if (!this.username) {
            // No credentials configured: hope the WebUI has auth disabled.
            this.authenticated = true;
            return;
        }

        const response = await this.rawRequest('POST', '/api/v2/auth/login', {
            form: { username: this.username, password: this.password },
        });

        const body = (await response.text()).trim();

        if (response.status === 403) {
            throw new QBittorrentError(
                'qBittorrent refused the request (403). The IP may be banned, or the Host header was rejected.',
                { status: response.status, body }
            );
        }

        if (response.status === 401) {
            throw new QBittorrentError(
                'qBittorrent authentication failed (401). Check the username and password in bridge/config.json.',
                { status: response.status, body }
            );
        }

        if (body.toLowerCase() === 'fails.') {
            throw new QBittorrentError(
                'qBittorrent authentication failed. Check the username and password in bridge/config.json.',
                { status: response.status, body }
            );
        }

        const setCookies = typeof response.headers.getSetCookie === 'function'
            ? response.headers.getSetCookie()
            : [response.headers.get('set-cookie')].filter(Boolean);

        const sessionCookie = setCookies
            .map((cookie) => cookie.split(';')[0].trim())
            .find((cookie) => SESSION_COOKIE_PATTERN.test(cookie));

        if (sessionCookie) {
            this.cookie = sessionCookie;
            this.authenticated = true;
            return;
        }

        // No cookie: either the WebUI has authentication disabled, or something
        // is off. Probe a harmless endpoint to find out which.
        const probe = await this.rawRequest('GET', '/api/v2/app/version');
        if (!probe.ok) {
            throw new QBittorrentError(
                'qBittorrent did not return a session cookie and the API is not reachable without it. ' +
                'Enable "Use authentication" in Preferences > Web UI, or set the credentials in bridge/config.json.',
                { status: probe.status }
            );
        }

        this.authenticated = true;
    }

    async request(method, path, options = {}) {
        await this.login();
        const response = await this.rawRequest(method, path, options);
        const text = await response.text();

        if (!response.ok) {
            throw new QBittorrentError(
                `qBittorrent returned ${response.status} for ${path}`,
                { status: response.status, body: text }
            );
        }

        if (!text) return null;

        try {
            return JSON.parse(text);
        } catch (error) {
            return text;
        }
    }

    async getVersion() {
        if (this.version) return this.version;
        const result = await this.request('GET', '/api/v2/app/version');
        this.version = typeof result === 'string' ? result : String(result || '');
        return this.version;
    }

    /**
     * Add a magnet link to the torrent client.
     *
     * The torrent is added in a stopped state so that the wanted file can be
     * selected before anything is downloaded.
     */
    async addMagnet(magnet, { savePath, category, tags } = {}) {
        const form = {
            urls: magnet,
            // 4.x uses `paused`, 5.x uses `stopped`; the WebUI ignores what it
            // does not know about.
            paused: 'true',
            stopped: 'true',
        };

        if (savePath) form.savepath = savePath;
        if (category) form.category = category;
        if (tags) form.tags = tags;

        await this.request('POST', '/api/v2/torrents/add', { form });
    }

    async getTorrents(query = {}) {
        const result = await this.request('GET', '/api/v2/torrents/info', { query });
        return Array.isArray(result) ? result : [];
    }

    async getTorrent(hash) {
        const torrents = await this.getTorrents({ hashes: hash });
        return torrents[0] || null;
    }

    async findTorrentByMagnet(magnet) {
        const torrents = await this.getTorrents();
        return torrents.find((torrent) => torrent.magnet_uri === magnet) || null;
    }

    async getFiles(hash) {
        const result = await this.request('GET', '/api/v2/torrents/files', { query: { hash } });
        return Array.isArray(result) ? result : [];
    }

    /**
     * Set the download priority of a set of files inside a torrent.
     * priority: 0 = do not download, 1 = normal, 6 = high, 7 = maximal
     */
    async setFilePriorities(hash, ids, priority) {
        if (!ids || ids.length === 0) return;

        // The `id` parameter is a `|` separated list; keep the chunks small
        // enough to stay well below any request size limits.
        const chunks = [];
        for (let index = 0; index < ids.length; index += 200) {
            chunks.push(ids.slice(index, index + 200));
        }

        for (const chunk of chunks) {
            await this.request('POST', '/api/v2/torrents/filePrio', {
                form: { hash, id: chunk.join('|'), priority: String(priority) },
            });
        }
    }

    async start(hash) {
        await this.request('POST', '/api/v2/torrents/start', { form: { hashes: hash } });
    }

    async stop(hash) {
        await this.request('POST', '/api/v2/torrents/stop', { form: { hashes: hash } });
    }

    async remove(hash, deleteFiles = false) {
        await this.request('POST', '/api/v2/torrents/delete', {
            form: { hashes: hash, deleteFiles: deleteFiles ? 'true' : 'false' },
        });
    }
}

module.exports = { QBittorrentClient, QBittorrentError };
