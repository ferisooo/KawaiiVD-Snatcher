# CyberSnatcher 🎯

**A one-click video & audio downloader that lives in your Chrome toolbar.**
Open a page, hit the icon, grab the media. No websites, no accounts, no shady
"download" buttons that install junk. It even rebuilds streaming videos (the
kind that normally *can't* be saved) into a single playable file — right inside
your browser.

---

## ✨ Why you'll want this

- **🩻 X-ray vision for media.** It quietly watches the page and lists every
  real video and audio file playing on it — even ones with no visible download
  button.
- **🧬 Downloads "unsaveable" streaming video.** Most sites chop a video into
  hundreds of tiny pieces (HLS streams) so you *can't* just right-click → save.
  CyberSnatcher grabs all the pieces, **decrypts AES-128 protected ones**, and
  stitches them back into **one finished file** with a live progress bar.
- **🧹 Zero junk in the list.** Ads, tracking pixels, and stream fragments are
  filtered out automatically. You see the actual video — not 200 useless
  scraps.
- **🎚️ Smart about quality.** When a video offers several resolutions, it finds
  the **best one** and shows it before you download. No guessing.
- **🙅 Honest about limits.** Things it genuinely *can't* save (Netflix-style
  DRM, etc.) are clearly listed in a separate **"NOT DOWNLOADABLE"** box —
  instead of failing silently after you click.
- **📋 Paste-a-link box.** Got a direct media URL? Paste it, hit **SNATCH**,
  done.
- **🔔 Fire-and-forget.** Start a download, switch tabs, and get a desktop
  notification when it's ready.
- **😎 Cyberpunk look.** Because a tool this good shouldn't be ugly.

---

## 🆚 How it's different from other downloaders

| Other tools | CyberSnatcher |
|---|---|
| Make you paste links into a **sketchy website** full of ads | Runs **inside your own browser**, on your machine |
| Often **install separate programs** or background services | **Pure Chrome extension** — nothing else gets installed |
| **Bundle adware** or upsells | Zero ads, zero accounts, zero tracking, zero phone-home |
| List a confusing pile of fragments and ad clips | **Filters the noise** and groups it into clean, real videos |
| Fail with a vague error on protected streams | **Tells you up front** what's downloadable and what isn't |
| Closed "black box" you have to trust | **Every line is readable** — see "Worried about viruses?" below |

In short: it does the genuinely hard part (rebuilding chopped-up streams) that
simple right-click savers can't, **without** the malware risk of the random
download websites that *can*.

> **Honest scope:** It can't break DRM (Netflix, Disney+, Spotify — impossible
> by design) and it doesn't do YouTube or DASH, which need extra video-muxing
> tools. It's brilliant at direct files and standard HLS streams, which covers
> most news, social, and streaming clips.

---

## 🚀 Setup (no coding knowledge needed)

You don't need to understand any code. Just follow these steps once:

1. **Download this project.** On the project's GitHub page, click the green
   **`< > Code`** button → **Download ZIP**.
2. **Unzip it.** Double-click the downloaded ZIP. You'll get a folder — inside
   it is a folder called **`extension`**. Remember where it is.
3. **Open Chrome's extensions page.** In Chrome (or Edge/Brave), type this into
   the address bar and press Enter:
   ```
   chrome://extensions
   ```
4. **Turn on Developer mode.** Flip the **Developer mode** switch in the
   **top-right corner** to ON.
5. **Load it.** Click **Load unpacked** (top-left), then select the
   **`extension`** folder from step 2.
6. **Pin it.** Click the little puzzle-piece icon in your toolbar and pin
   **CyberSnatcher** so its icon is always visible.

**That's it.** Go to any page with a video, click the CyberSnatcher icon, and
your media will appear. Click **GET** (direct files) or **MERGE** (streams) to
download.

> 💡 If a video doesn't show up right away, press **play** on it or hit the
> **⟳ refresh** button in the popup — that's normal, the tool detects media as
> it actually loads.

---

## 🛡️ Worried about viruses? Read these files yourself.

Totally fair — you should never trust a downloader blindly. The good news:
**this extension is small, 100% readable, and hides nothing.** There's no
installer, no compiled program, and no minified/obfuscated code. It's just a
handful of plain text files you (or any tech friend) can open in Notepad and
read.

Here's exactly what to check and what to look for:

| Open this file | What it does / what to verify |
|---|---|
| **`extension/manifest.json`** | The "permission slip." Lists everything the extension is allowed to do. Short and human-readable. |
| **`extension/background.js`** | Watches the page for media and filters out ads. **Look for:** there are **no servers it reports to** — it only reads what your page already loaded. |
| **`extension/popup.js`** | The button panel you click. Handles detecting and downloading. |
| **`extension/offscreen.js`** | The engine that downloads stream pieces and merges them. **Look for:** it `fetch`es **only the video's own URLs** — the same server the website already uses. |

**The key safety facts, in plain English:**

- 🚫 **It never sends your data anywhere.** There is no analytics, no tracking,
  no "home server." Search the files — you won't find one, because there isn't
  one. Everything happens locally on your computer.
- 🚫 **It never downloads or runs outside code.** What you load is 100% of what
  runs. No hidden updates, no remote scripts.
- 👀 **It only talks to the *same* video servers the website is already using.**
  When it grabs a stream, it requests that stream's own files — nothing new
  that the page wasn't already loading.
- 📦 **It's tiny.** The whole thing is about 1,700 lines of ordinary
  JavaScript. You can read all of it in an afternoon.

> About permissions: the extension asks to access "all sites." That sounds
> scary, but it's required for a simple reason — it can't know *in advance*
> which site you'll want to download a video from, so it has to be allowed to
> watch the page you're currently on. It uses that access **only** to spot
> media on the tab you have open, and **only** when you're using it.

---

## 🙏 Credits

- **💡 Idea & concept — Feris.** The vision for CyberSnatcher: a clean,
  honest, malware-free media snatcher that does the hard streaming work other
  tools won't.
- **⌨️ Engineering & code — Claude (Anthropic).** Implementation of the
  detection, filtering, HLS download/decrypt/merge engine, and UI was built by
  Claude.

---

*For developers: a deeper technical breakdown lives in
[`extension/README.md`](extension/README.md).*
