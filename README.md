# CyberSnatcher 🎯

**One-click video & audio downloader that lives in your Chrome toolbar.** Open a
page, hit the icon, grab the media. No sketchy websites, no accounts, no junk.

It even rebuilds chopped-up streaming video (HLS, incl. AES-128) into a single
playable file — right inside your browser.

## What it does

- **🩻 Finds hidden media.** Lists every real video/audio on a page, even with no
  download button.
- **▶️ Plays in-place.** Watch detected videos in the popup or pop out to a tab
  (direct + HLS, via bundled [hls.js](https://github.com/video-dev/hls.js)).
- **🧬 Saves "unsaveable" streams.** Grabs all HLS fragments, decrypts AES-128,
  and merges into one file with a progress bar.
- **🧹 No noise.** Filters out ads, pixels, and stream scraps; picks the best
  resolution automatically.
- **🙅 Honest limits.** Can't-save items (DRM, etc.) are flagged up front, not
  after you click. No YouTube/DASH; no DRM (Netflix/Disney+/Spotify — impossible
  by design).

## Setup (no coding needed)

1. **Download:** green **`< > Code`** button → **Download ZIP**, then unzip.
2. **Open** `chrome://extensions` (Chrome/Edge/Brave).
3. **Enable Developer mode** (top-right toggle).
4. **Load unpacked** → select the **`extension`** folder from the unzipped project.
5. **Pin it** via the toolbar puzzle-piece icon.

Then click the icon on any page with video → **GET** (direct) / **MERGE**
(streams) to download, or **▶** to play. Nothing showing? Press play on the video
or hit **⟳ refresh** — it detects media as it loads.

## Safety

No installer, no compiled binary — just ~1,700 lines of plain, readable
JavaScript. It **collects nothing, phones home to no one**, runs no outside code,
and only talks to the *same* video servers the site already uses. The one
minified file, `extension/vendor/hls.min.js`, is a stock copy of hls.js you can
verify or swap. Read it yourself: `manifest.json`, `background.js`, `popup.js`,
`offscreen.js`, `player-core.js`.

The "all sites" permission is required only so it can spot media on whatever tab
you open it on — used only while you're using it.

## Credits & terms

- **💡 Idea — Feris.** **⌨️ Engineering — Claude (Anthropic).**
- **[Terms](TERMS.md)** — free to use/fork/modify (even commercially) with credit
  to Feris & Claude. **[Privacy](PRIVACY.md)** — runs entirely on your device,
  collects & sends nothing.

*Deeper technical docs: [`extension/README.md`](extension/README.md).*
