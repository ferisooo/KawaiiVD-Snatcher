# CyberSnatcher — Chrome Extension

A pure Manifest V3 Chrome extension that sniffs media on the current tab and
downloads the direct files in one click. This is a browser-native port of the
CyberSnatcher desktop app's **downloader** — re-themed in the same cyberpunk
style, with no external binaries required.

## How it works

- A background service worker watches network responses (`chrome.webRequest`)
  and flags anything that looks like media (by `Content-Type` or file
  extension), tracked **per tab**. Noise is filtered at capture: known
  ad-network hosts, tiny files (beacons/bumpers), and HLS/DASH **fragments**
  (`.ts`/`.m4s`/numbered fMP4 chunks) are dropped — only the playlist that
  represents the stream is kept, and stream manifests are never evicted from
  the per-tab list.
- When you open the popup it also runs a live DOM scan of the page for
  `<video>`, `<audio>`, `<source>` and direct media links.
- The popup **probes each HLS playlist** (one small GET) to find the master,
  fold variant/audio renditions into a single entry per stream, show the best
  resolution, and flag **DRM up front** — instead of listing five playlists
  for one video and failing after you click. Items that can't be downloaded
  (DRM, DASH, blob URLs) live in a collapsed **NOT DOWNLOADABLE** section.
- **Direct files** get a one-click **GET** button (saved via `chrome.downloads`).
- **HLS streams** (`.m3u8`) get a **MERGE** button. An offscreen document
  fetches the playlist, downloads every segment, decrypts **AES-128** if the
  stream is encrypted (using WebCrypto), concatenates everything into a single
  file, and downloads it — with a live progress bar and a desktop notification
  on completion. This is what makes the `blob:` MSE players used by most
  streaming sites (which play from an underlying HLS playlist) downloadable.
- A manual URL box lets you paste any direct media link.
- The toolbar badge shows detected-media counts, and merge progress while a
  stream is downloading.

## Install (unpacked)

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select this `extension/` folder
4. Pin the CyberSnatcher icon and click it on any page with media

## What it can and can't do

Because it's a **pure extension** (no native helper, unlike the Tauri desktop
app), it is limited to what the browser sandbox allows:

- ✅ Detect and download **direct files** (`.mp4`, `.webm`, `.m4a`, `.mp3`, …)
- ✅ **Full HLS download & merge** — clear *and* **AES-128**-encrypted streams
  (TS or fMP4), assembled into one playable file in-browser. Covers the
  `blob:`/MSE players on most streaming, news, and social sites.
- ✅ Per-tab detection, DOM scan, manual URL download, live progress + notify
- ✅ Ad-network media, beacons, and stream fragments are filtered out of the
  detected list; HLS playlists are grouped to one entry per stream
- ⚠️ **HLS with separate audio + video tracks**: prefers a muxed variant when
  the master offers one at comparable quality; otherwise downloads **both
  tracks** and saves them as two files (`*.video.mp4` + `*.audio.m4a`) with a
  note — combining them into one file still needs `ffmpeg` or the desktop app.
  No more silent videos.
- ❌ **DASH** (`.mpd`) is detected but not merged — it generally splits audio
  and video, which requires `ffmpeg` muxing. Surfaced and flagged, not offered.
- ❌ **YouTube**: serves DASH with separated audio/video + signature throttling
  → needs `ffmpeg`; not supported in a pure extension.
- ❌ **DRM** (Widevine / PlayReady / FairPlay / HLS SAMPLE-AES — Netflix,
  Disney+, Spotify, etc.): impossible by design. The popup flags DRM streams
  up front (in the NOT DOWNLOADABLE section) and the engine double-checks at
  download time rather than saving garbage.
- ❌ No format conversion, no `yt-dlp`, no scraper-to-disk — those depend on
  native binaries and remain in the desktop build.
- ❌ Plain `blob:` media with no detectable underlying stream cannot be fetched
  by extensions and are shown as non-downloadable.

> Large streams are assembled in memory before saving, so multi-GB videos can
> be heavy on RAM — fine for typical clips and episodes.

## Files

| File | Purpose |
|------|---------|
| `manifest.json` | MV3 manifest, permissions, action popup |
| `background.js` | Service worker: network sniffing, per-tab state, job orchestration |
| `offscreen.html/.js` | HLS engine: playlist parse, segment fetch, AES-128 decrypt, merge |
| `popup.html/.css/.js` | Cyberpunk popup UI, DOM scan, download + merge logic |
| `icons/` | Toolbar / store icons |
