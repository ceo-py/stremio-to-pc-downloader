# Stremio → qBittorrent: start the download on your PC from your phone

Tap a torrent stream in Stremio on your **phone**, and the download starts in
**qBittorrent on your PC**. The phone never downloads anything itself.

This repository contains:

| Folder | What it is |
|---|---|
| `bridge/` | The PC-side service. Serves the Stremio UI and forwards torrents to qBittorrent. |
| `stremio-web/` | The official open-source Stremio Web UI, modified with a **“Download to PC”** button on every torrent stream. |
| `stremio-web.patch` | The exact diff against upstream `stremio-web` v5.0.0-beta.43, in case you want to re-apply it to a fresh clone. |
| `bridge/SETUP.md` | Step-by-step installation for the PC and the phone. |

---

## 1. How it works

```
┌──────────────┐   TailScale (HTTPS)   ┌────────────────────────────┐   127.0.0.1:8080   ┌──────────────┐
│  Android      │ ────────────────────► │  PC                         │ ─────────────────► │  qBittorrent │
│  phone        │  POST /api/download  │  • bridge (Node)           │   Web UI API      │  (Web UI)    │
│  (PWA)        │ ◄──────────────────── │  • modified stremio-web    │ ◄───────────────── │              │
└──────────────┘   toast: "Downloading  └────────────────────────────┘   file selection   └──────────────┘
                     on your PC"
```

1. The phone opens the bridge's URL (through TailScale) and installs it as a
   PWA — it behaves like the native Stremio app, fullscreen, with its own icon.
2. You browse normally. Torrent streams (anything Torrentio or a similar addon
   returns) show an extra **⤓** button next to the stream.
3. Tapping it `POST`s the magnet to `POST /api/download` **on the bridge** —
   same origin, so no CORS and no public exposure needed.
4. The bridge logs into qBittorrent's local Web UI (`127.0.0.1:8080`),
   adds the torrent **stopped**, waits for the metadata, picks the right file
   inside the torrent, deselects the rest, and starts it.
5. The phone gets a toast: *"Downloading on your PC"* (or the error, if
   something went wrong).

### Why the browser cannot talk to qBittorrent directly

qBittorrent's Web UI sends **no CORS headers** and rejects cross-site
requests (it validates the `Host`/`Origin` header). A browser therefore may
never call it from a web page. Every qBittorrent call has to come from a
server on the same machine — which is exactly what `bridge/` is.

### Why not the official Stremio Android app

The Stremio app for Android/iOS is **closed source** — only the Rust core
(`stremio-core`) and the archived Kotlin bindings are public, so the app
cannot be patched to add a button. Modifying `stremio-web` (the official,
open-source UI) is the cheapest way to get the same experience, and it works
with *every* torrent addon you have installed, not just one.

A "bridge addon" is the alternative, but an addon can only serve its **own**
streams: it cannot add a button to Torrentio's rows. It would have to replace
your torrent addon and be reachable over public HTTPS. The bridge does expose
`GET /download?magnet=…` for that scenario, but the web app is the better
default.

---

## 2. Repository layout

```
.
├── README.md                  ← this file
├── stremio-web.patch          ← diff vs upstream stremio-web
├── bridge/
│   ├── server.js              ← HTTP server: static app + /api/download + dashboard
│   ├── config.json            ← your local settings (git-ignored)
│   ├── config.example.json    ← template to copy
│   ├── start-bridge.cmd       ← double-clickable launcher
│   ├── SETUP.md               ← full installation guide
│   ├── lib/
│   │   ├── magnet.js          ← magnet parsing/building, info-hash normalisation
│   │   ├── qbittorrent.js     ← qBittorrent Web UI client (login, add, filePrio, start)
│   │   ├── downloader.js      ← the "add → pick file → start" orchestration
│   │   └── config.js          ← config loading (file + env overrides)
│   ├── test-addon/server.js   ← local test addon (development only)
│   ├── test.js                ← unit tests for magnet parsing / file selection
│   └── check.js               ← smoke test of the running server
└── stremio-web/               ← the modified Stremio Web UI
    └── src/
        ├── common/downloadClient.js                     ← NEW: talks to the bridge
        └── routes/MetaDetails/StreamsList/Stream/
            ├── Stream.js        ← + "Download to PC" button and context-menu entry
            ├── styles.less      ← + button styling
            └── …
```

The bridge has **zero npm dependencies** — plain Node 18+.

---

## 3. Installation

The full guide is in [`bridge/SETUP.md`](bridge/SETUP.md). The short version:

### On the PC

**1. Install qBittorrent and turn on its Web UI**

```powershell
winget install qBittorrent.qBittorrent
```

Then in qBittorrent: **Tools → Preferences → Web UI → Enable the Web UI**,
port `8080`, tick **Use authentication**, and set a username and password.

**2. Tell the bridge those credentials**

```powershell
cd bridge
Copy-Item config.example.json config.json
notepad config.json      # set qbittorrent.username / qbittorrent.password
```

**3. Build the UI (only once, or after changing the UI code)**

```powershell
cd ..\stremio-web
corepack pnpm install --frozen-lockfile
corepack pnpm build
```

**4. Start the bridge**

```powershell
cd ..\bridge
node server.js
```

or double-click `bridge\start-bridge.cmd`, or run it detached with a log file
(see `bridge/SETUP.md`).

Check it: `Invoke-RestMethod http://127.0.0.1:8787/api/health` →
`qbittorrent.ok` must be `true`.

**5. Install TailScale and expose the PC**

```powershell
winget install tailscale.tailscale
tailscale up
tailscale serve --bg 8787
```

`tailscale serve` prints a URL like `https://stremio-pc.tail1234.ts.net/`.
HTTPS matters: without it Chrome on Android will not offer *"Install app"* for
the PWA.

### On the phone

1. Install **TailScale** from the Play Store and sign in with the same account.
2. Open the `https://…ts.net/` URL in Chrome.
3. **⋮ → Add to Home screen** → the app installs with the Stremio icon and
   opens fullscreen.
4. Open **Addons → Add addon** and install a torrent addon, e.g.
   `https://torrentio.strem.fun/manifest.json`.
5. Open a movie, expand the stream list, and tap **⤓** on any torrent row.

The PC console shows every request that arrives:

```
[bridge] download from 100.x.y.z: Big Buck Bunny -> started in qBittorrent
```

---

## 4. How the torrent is handled on the PC

`bridge/lib/downloader.js` performs, against qBittorrent's Web UI:

| Step | Call |
|---|---|
| Log in | `POST /api/v2/auth/login` → session cookie (`SID` ≤5.1.x, `QBT_SID_<port>` ≥5.2) |
| Add, stopped | `POST /api/v2/torrents/add` with `paused=true&stopped=true`, category/tag `stremio` |
| Wait for metadata | poll `GET /api/v2/torrents/info?hashes=…` until the state is not `metaDL` |
| List files | `GET /api/v2/torrents/files?hash=…` |
| Deselect the rest | `POST /api/v2/torrents/filePrio` with `priority=0` |
| Select the target | `POST /api/v2/torrents/filePrio` with `priority=1` |
| Start | `POST /api/v2/torrents/start` |

**Which file is picked** (multi-file torrents are the norm for movies):

1. the stream's `fileIdx`, if the addon provided one;
2. otherwise the first file whose name contains one of the stream's
   `fileMustInclude` fragments;
3. otherwise the largest file in the torrent.

This mirrors what Stremio's own streaming server does when a stream has no
file index (`-1` → biggest file).

---

## 5. Configuration

`bridge/config.json` (copy from `bridge/config.example.json`):

| Key | Meaning |
|---|---|
| `host` / `port` | Where the bridge listens (default `0.0.0.0:8787`) |
| `publicUrl` | The URL the phone uses — only used for display |
| `token` | Shared secret required on every `/api/*` call (empty = open) |
| `allowOrigin` | `Access-Control-Allow-Origin` value (empty = same origin only) |
| `downloadEndpoint` | Endpoint the UI posts to (default `/api/download`) |
| `qbittorrent.url` | qBittorrent Web UI base URL — keep it on `127.0.0.1` |
| `qbittorrent.username` / `password` | qBittorrent Web UI credentials |
| `downloads.savePath` | Where torrents are stored (empty = qBittorrent's default) |
| `downloads.category` / `tags` | qBittorrent category/tag applied to Stremio downloads |
| `staticDir` | Folder with the built UI (default `../stremio-web/build`) |

Any of these can be overridden per process with environment variables:
`BRIDGE_PORT`, `BRIDGE_HOST`, `BRIDGE_TOKEN`, `QBITTORRENT_URL`,
`QBITTORRENT_USER`, `QBITTORRENT_PASSWORD`, `QBITTORRENT_SAVE_PATH`,
`BRIDGE_STATIC_DIR`.

The UI resolves its endpoint in this order: `window.STREMIO_DOWNLOAD_ENDPOINT`
(injected by the bridge through `/config.js`) → `localStorage.stremioDownloadEndpoint`
→ `/api/download` on the current origin.

---

## 6. Development

```powershell
cd bridge
node test.js     # unit tests: magnet parsing + file selection
node check.js    # smoke test against a running bridge
```

Re-apply the UI changes to a fresh upstream clone:

```powershell
git clone --depth 1 https://github.com/Stremio/stremio-web.git
cd stremio-web
git apply ..\stremio-web.patch
corepack pnpm install --frozen-lockfile
corepack pnpm build
```

Development-only helper routes (`/dev/seed-test-addon`, `/dev/storage`,
`/dev/reset`) are enabled by starting the bridge with
`$env:BRIDGE_DEV_ROUTES="1"`. **Leave them off in normal use.**

### What was changed in `stremio-web`

- `src/common/downloadClient.js` (new) — resolves the endpoint and POSTs the
  magnet.
- `src/routes/MetaDetails/StreamsList/Stream/Stream.js` — the **⤓** button
  (hidden for non-torrent, compact and Live TV rows), a context-menu entry
  *"Download to PC"*, and the success/error toast.
- `src/routes/MetaDetails/StreamsList/Stream/styles.less` — button styling.
- `src/routes/MetaDetails/StreamsList/StreamsList.js` — passes `infoHash`,
  `fileIdx` and `fileMustInclude` to each stream.
- `webpack.config.js` — `output.publicPath: '/'` so the built app works when
  served from a sub-path or a different host.

---

## 7. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Toast: *Cannot reach qBittorrent at http://127.0.0.1:8080* | qBittorrent is not running, or its Web UI is disabled |
| Toast: *Fails.* (5.1.x) or `401` (5.2+) | Wrong username/password in `bridge/config.json` |
| No **⤓** button on a stream | The stream is not a torrent (no magnet), or it is an EPG/Live TV row |
| Phone cannot open the page | TailScale not connected on the phone, or the firewall blocks 8787 |
| Chrome does not offer "Install app" | The URL is not HTTPS — use `tailscale serve` |
| Detail page says *"No metadata was found!"* | The addon serving metadata (Cinemeta) is missing from the profile's addon list |
| Torrent downloads, but the wrong file | The addon gave no `fileIdx`/`fileMustInclude`; the largest file is used as fallback |

---

## 8. Licensing

`stremio-web` is GPL-2.0 (© Stremio / Smart code 203358507) — the modified
sources keep that license. `bridge/` is provided under the same terms.
Stremio is a trademark of its respective owner. Use of torrent sources is
your own responsibility and must follow local law.
