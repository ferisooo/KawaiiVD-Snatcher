# CyberPlayer — Media Detector & Player

A sibling to CyberSnatcher. Instead of **downloading** videos, CyberPlayer
**detects** the real videos on a page (filtering out ads and stream fragments)
and **plays them inside the extension** — either in a compact mini-player in the
popup or in a full browser tab.

## What it does

- **Detects media** the same way the downloader does: sniffs network responses
  (`webRequest`) and scans the page DOM for `<video>`/`<audio>`/`<source>` and
  media links.
- **Filters out the junk:** known ad/tracking CDNs, tiny bumper/beacon files,
  and HLS/DASH segment fragments never show up — only real, playable videos.
- **Plays in-extension:**
  - Direct files (`mp4`, `webm`, `mov`, `ogg`, audio, …) play in a native
    `<video>`/`<audio>` element.
  - **HLS streams** (`.m3u8`) play via [hls.js](https://github.com/video-dev/hls.js)
    (bundled in `vendor/`), including AES-128 encrypted streams.
  - **▶ PLAY** runs it in the popup; **⛶** pops it out to a full tab
    (`player.html`).
- **No downloads.** There is no `downloads` permission and nothing is ever
  written to disk.

## What it can't play

These appear under a collapsed **CAN'T PLAY** section so you know why:

- **DRM** streams (Widevine, PlayReady, SAMPLE-AES) — protected by design.
- **DASH** (`.mpd`) — no in-browser player ships for it here.
- **`blob:` URLs** — created by the page's own MSE player and not reachable
  from an extension page. Play those on the original tab.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this `player-extension/` folder.
4. Browse to a page with video, open the popup, and hit **▶ PLAY**.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | MV3 config — detection permissions only, no `downloads`. |
| `background.js` | Service worker: network sniffing + per-tab media list + ad/segment filtering. |
| `popup.html/.css/.js` | Detected-media list, manual-URL play, inline mini-player. |
| `player.html/.css/.js` | Full-tab player page. |
| `player-core.js` | Shared playback engine (hls.js for HLS, native otherwise). |
| `vendor/hls.min.js` | Bundled hls.js for HLS playback. |

Built for Chromium browsers (Chrome / Edge / Brave), Manifest V3.
