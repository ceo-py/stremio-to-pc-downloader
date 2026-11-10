# Stremio → qBittorrent bridge — setup on the PC and the phone

Two pieces:

| Piece | Where | What it does |
|---|---|---|
| `stremio-web` (modified) | this PC, served by the bridge | Stremio UI with a **Download to PC** button on every torrent stream |
| `bridge/` | this PC | Serves the UI and forwards the magnet to qBittorrent over its local Web UI |

The phone only ever talks to the bridge. qBittorrent is never contacted from the phone.

---

## 1. Install qBittorrent on the PC

Download from <https://www.qbittorrent.org/download/> or:

```powershell
winget install qBittorrent.qBittorrent
```

Then enable its Web UI:

1. qBittorrent → **Tools → Preferences → Web UI**
2. Tick **Enable the Web UI (remote control)**
3. Port: `8080` (default), tick **Use authentication**
4. Set a username/password (default `adminadmin` — change it)
5. Under **Bypass authentication for localhost** you can leave it unticked; the bridge logs in with your credentials either way.

## 2. Point the bridge at qBittorrent

Edit `bridge/config.json`:

```json
{
    "qbittorrent": {
        "url": "http://127.0.0.1:8080",
        "username": "admin",
        "password": "YOUR_PASSWORD",
        "timeout": 20000
    }
}
```

Check it works:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/api/health
```

`qbittorrent.ok` must be `true`. (The bridge reads qBittorrent's Web UI from
`127.0.0.1` only — qBittorrent sends no CORS headers and rejects cross-site
requests, so the browser can never talk to it directly.)

## 3. Start the bridge

```powershell
cd "D:\MiniMax Code Repos\Stremio\bridge"
node server.js
```

`node start-bridge.cmd` does the same thing in a double-clickable window.

It listens on `0.0.0.0:8787` and serves the built Stremio app on `/`.

**To run it in the background with a log file** (so you can close the window
and still see what happened):

```powershell
cd "D:\MiniMax Code Repos\Stremio\bridge"
Start-Process node -ArgumentList "server.js" -WorkingDirectory (Get-Location) `
    -RedirectStandardOutput bridge.log -RedirectStandardError bridge-error.log -WindowStyle Hidden
```

Then watch it with `Get-Content bridge.log -Wait`. Every download request is
logged there, e.g.:

```
[bridge] download from 100.x.y.z: Big Buck Bunny -> started in qBittorrent
```

To stop it: `Stop-Process -Id (Get-Process node | Where-Object { $_.StartTime -gt (Get-Date).AddHours(-1) } | Select-Object -First 1).Id`

**Development-only helpers** (`/dev/seed-test-addon`, `/dev/storage`,
`/dev/reset`) are disabled unless the process is started with
`$env:BRIDGE_DEV_ROUTES="1"`. Leave them off for normal use.

## 4. Reach the PC from the phone with TailScale

**On the PC**

```powershell
winget install tailscale.tailscale
tailscale up
tailscale ip -4          # -> 100.x.y.z
tailscale status
```

Give the machine a stable name, e.g. `stremio-pc`, so it becomes
`stremio-pc.<your-tailnet>.ts.net`.

**Serve it over HTTPS (recommended — the phone then gets a real PWA):**

```powershell
tailscale serve --bg 8787
```

`tailscale serve` prints the URL, e.g. `https://stremio-pc.tail1234.ts.net/`.
Use that URL on the phone. HTTPS is needed for "Add to Home Screen" to install
Stremio as an app instead of a bookmark.

**Without Serve (plain HTTP over TailScale):** open
`http://100.x.y.z:8787/` on the phone. Works, but no PWA install and the
browser may complain about insecure content.

**Windows firewall:** allow inbound TCP 8787 for private networks, or
`tailscale serve` (which proxies) is enough.

### Optional: shared token

The bridge accepts a token on every API call:

```json
{ "token": "some-long-random-string" }
```

The phone then has to send it. The simplest way to do that from the app is to
point `downloadEndpoint` at the tokenized URL in `config.json`:

```json
{
    "downloadEndpoint": "/api/download?token=some-long-random-string"
}
```

Leave the token empty on a private TailScale network.

## 5. Use it on the phone

1. Open the URL in the phone browser.
2. Install a torrent addon (e.g. Torrentio — `https://torrentio.strem.fun/manifest.json`)
   via **Addons → Add addon → paste URL → Install**. The modified UI has this
   in the Addons screen.
3. Open any movie, expand the stream list on the right.
4. Every torrent row now has a green **⤓** button — tap it.
5. The PC starts the download in qBittorrent; the phone shows a toast.

`stremio-web` already ships a PWA manifest and a service worker, so
**Add to Home Screen** turns it into a standalone app (needs the HTTPS URL from
`tailscale serve`).

### Confirming that a tap arrived

The bridge logs every download request in its console, with the caller's IP:

```
[bridge] download from 100.x.y.z: Big Buck Bunny -> started in qBittorrent
```

If you see the line, the phone reached the PC. If not, the phone is not
talking to this machine (TailScale not connected, wrong URL, firewall).

> The metadata (poster, title) comes from Cinemeta. If a detail page shows
> “No metadata was found!”, the addon that serves metadata is missing from the
> profile — reinstall Cinemeta or check the profile's `addons` list.

## 6. What the bridge does with the torrent

1. `POST /api/v2/auth/login` → session cookie (`SID` ≤5.1.x, `QBT_SID_<port>` ≥5.2).
2. `POST /api/v2/torrents/add` with `paused=true&stopped=true`, category/tag `stremio`.
3. Waits for the torrent metadata (up to `downloads.metadataTimeout`).
4. Picks the file: `fileIdx` → `fileMustInclude` substring match → largest file.
5. Demotes every other file with `torrents/filePrio` (priority `0`), promotes the
   chosen one (priority `1`).
6. `POST /api/v2/torrents/start`.

## 7. Troubleshooting

| Symptom | Cause |
|---|---|
| Toast: *Cannot reach qBittorrent at http://127.0.0.1:8080* | qBittorrent is not running or the Web UI is disabled |
| Toast: *Fails.* / 401 | Wrong username/password in `bridge/config.json` |
| Button missing on a row | The stream is not a torrent (no magnet) or it is an EPG/Live TV row |
| Phone cannot open the page | TailScale not connected on the phone, or firewall blocking 8787 |
| “No metadata was found!” | Cinemeta missing from the profile's addon list |

Bridge dashboard (torrents, recent downloads): <http://127.0.0.1:8787/bridge/>

## 8. Rebuilding the UI after a code change

```powershell
cd "D:\MiniMax Code Repos\Stremio\stremio-web"
corepack pnpm build
```

The bridge serves `stremio-web/build` straight from disk, so a restart of the
bridge is enough. The phone's service worker caches the old build — the app
shows an update prompt, or force-close and reopen the installed PWA.

The bridge injects `/config.js` into `index.html` at request time to publish
the download endpoint; the service worker caches the *unmodified* `index.html`,
so on the phone the endpoint falls back to the same-origin `/api/download`.
That is the intended setup (the bridge serves the app itself) and needs no
extra configuration.
