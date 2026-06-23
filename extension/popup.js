// CyberSnatcher popup: merges network-sniffed media (from the background
// worker) with a live DOM scan of the page, collapses HLS playlists into one
// entry per stream (probing manifests to find masters and flag DRM up front),
// and downloads via chrome.downloads. Items that can't be downloaded (DRM,
// DASH, blob URLs) sit in a collapsed "not downloadable" section instead of
// posing as snatches that will never work.

const AUDIO_EXT = ["mp3", "m4a", "aac", "ogg", "oga", "opus", "wav", "flac"];
const STREAM_EXT = ["m3u8", "mpd"];

const PLATFORMS = [
  { test: (u) => u.includes("youtube") || u.includes("youtu.be"), name: "YouTube" },
  { test: (u) => u.includes("twitter") || u.includes("x.com"), name: "Twitter/X" },
  { test: (u) => u.includes("instagram"), name: "Instagram" },
  { test: (u) => u.includes("tiktok"), name: "TikTok" },
  { test: (u) => u.includes("reddit"), name: "Reddit" },
  { test: (u) => u.includes("vimeo"), name: "Vimeo" },
  { test: (u) => u.includes("facebook"), name: "Facebook" },
];

let activeTab = null;
let lastItems = [];
let showUnavailable = false;
let currentPlayer = null; // active attachPlayer controller (in-extension playback)

// ── helpers ──
function stripUrl(url) {
  const q = url.indexOf("?");
  const h = url.indexOf("#");
  let end = url.length;
  if (q >= 0) end = Math.min(end, q);
  if (h >= 0) end = Math.min(end, h);
  return url.slice(0, end);
}
function extOf(url) {
  const clean = stripUrl(url);
  const dot = clean.lastIndexOf(".");
  const slash = clean.lastIndexOf("/");
  if (dot < 0 || dot < slash) return "";
  return clean.slice(dot + 1).toLowerCase();
}
function dirOf(url) {
  const clean = stripUrl(url);
  return clean.slice(0, clean.lastIndexOf("/") + 1);
}
function kindFor(ext) {
  if (STREAM_EXT.includes(ext)) return "stream";
  if (AUDIO_EXT.includes(ext)) return "audio";
  return "video";
}
function guessFilename(url, ext) {
  const clean = stripUrl(url);
  let name = clean.slice(clean.lastIndexOf("/") + 1) || "media";
  try { name = decodeURIComponent(name); } catch (_) { /* keep raw */ }
  name = name.replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_").trim();
  if (!name) name = "media";
  if (!/\.[a-z0-9]{1,5}$/i.test(name) && ext) name += "." + ext;
  return name;
}
function formatSize(bytes) {
  if (!bytes || bytes <= 0) return "";
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(2) + " GB";
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + " MB";
  return (bytes / 1024).toFixed(0) + " KB";
}
function baseNameFor(m) {
  const title = activeTab && activeTab.title ? activeTab.title.trim() : "";
  if (title) return title;
  return (m.filename || "cybersnatch").replace(/\.[a-z0-9]{1,5}$/i, "");
}
function resolveUrl(base, rel) {
  try { return new URL(rel, base).href; } catch (_) { return rel; }
}
function parseAttributes(str) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    let val = m[2];
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    attrs[m[1]] = val;
  }
  return attrs;
}

// Injected into the page to scrape <video>/<audio>/<source> and media links.
function scanDom() {
  const found = [];
  const push = (u) => { if (u && /^https?:/i.test(u)) found.push(u); };
  document.querySelectorAll("video, audio").forEach((el) => {
    push(el.currentSrc || el.src);
    el.querySelectorAll("source").forEach((s) => push(s.src));
  });
  const re = /\.(mp4|m4v|webm|mkv|mov|avi|flv|3gp|mp3|m4a|aac|ogg|oga|opus|wav|flac|m3u8|mpd)(\?|#|$)/i;
  document.querySelectorAll("a[href]").forEach((a) => { if (re.test(a.href)) push(a.href); });
  return Array.from(new Set(found));
}

async function gatherMedia() {
  // Network-sniffed items from the background worker (carry size info).
  const netResp = await chrome.runtime.sendMessage({ type: "getMedia", tabId: activeTab.id }).catch(() => null);
  const items = new Map();
  const stripped = new Set();
  if (netResp && netResp.list) {
    for (const m of netResp.list) {
      items.set(m.url, m);
      stripped.add(stripUrl(m.url));
    }
  }

  // Live DOM scan (best effort; may fail on restricted pages).
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      func: scanDom,
    });
    const urls = (results && results[0] && results[0].result) || [];
    for (const url of urls) {
      // Skip exact matches and query-only variations of already-sniffed media.
      if (items.has(url) || (!url.startsWith("blob:") && stripped.has(stripUrl(url)))) continue;
      const ext = extOf(url) || "mp4";
      items.set(url, {
        url,
        ext,
        kind: kindFor(ext),
        size: null,
        filename: guessFilename(url, ext),
        ts: Date.now(),
      });
    }
  } catch (_) {
    /* injection blocked (chrome:// pages, store, etc.) */
  }

  return Array.from(items.values()).sort((a, b) => b.ts - a.ts);
}

// ── HLS manifest probing ─────────────────────────────────────────────────────
// One small GET per playlist tells us whether it's a master (so variants fold
// under it), the best resolution, and whether it's DRM'd — before the user
// clicks MERGE and gets a late failure.
const probeResults = new Map(); // url -> { master, children, res, drm } | { failed: true }
const probeStarted = new Map(); // url -> Promise

function detectDrm(text) {
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("#EXT-X-KEY:") && !line.startsWith("#EXT-X-SESSION-KEY:")) continue;
    const a = parseAttributes(line.slice(line.indexOf(":") + 1));
    const method = (a.METHOD || "").toUpperCase();
    const kf = (a.KEYFORMAT || "").toLowerCase();
    if (method === "NONE" || method === "") continue;
    if (method === "AES-128" && (!kf || kf === "identity")) continue;
    return method + (kf && kf !== "identity" ? " / " + kf : "");
  }
  return null;
}

function parseMasterVariants(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const variants = [];
  const mediaUris = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("#EXT-X-MEDIA:")) {
      const a = parseAttributes(line.slice(line.indexOf(":") + 1));
      if (a.URI) mediaUris.push(resolveUrl(baseUrl, a.URI));
    } else if (line.startsWith("#EXT-X-STREAM-INF")) {
      const attrs = parseAttributes(line.slice(line.indexOf(":") + 1));
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j].trim();
        if (l && !l.startsWith("#")) {
          variants.push({
            url: resolveUrl(baseUrl, l),
            bw: parseInt(attrs.BANDWIDTH || attrs["AVERAGE-BANDWIDTH"] || "0", 10),
            res: attrs.RESOLUTION || "",
          });
          break;
        }
      }
    }
  }
  return { variants, mediaUris };
}

async function fetchTextTimeout(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, credentials: "include" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

function probeStream(url) {
  if (probeStarted.has(url)) return probeStarted.get(url);
  const p = (async () => {
    let result;
    try {
      const text = await fetchTextTimeout(url, 4000);
      let drm = detectDrm(text);
      if (text.includes("#EXT-X-STREAM-INF")) {
        const { variants, mediaUris } = parseMasterVariants(text, url);
        let res = "";
        if (variants.length) {
          const best = variants.reduce((a, b) => (b.bw > a.bw ? b : a));
          res = best.res;
          if (!drm) {
            // DRM keys usually live in the media playlist, not the master.
            try { drm = detectDrm(await fetchTextTimeout(best.url, 4000)); } catch (_) { /* unknown */ }
          }
        }
        result = {
          master: true,
          children: variants.map((v) => stripUrl(v.url)).concat(mediaUris.map(stripUrl)),
          res,
          drm,
        };
      } else {
        result = { master: false, drm };
      }
    } catch (_) {
      result = { failed: true };
    }
    probeResults.set(url, result);
    return result;
  })();
  probeStarted.set(url, p);
  return p;
}

// ── Grouping ─────────────────────────────────────────────────────────────────
// Collapse HLS playlists to one entry per stream and split out items that
// can't be downloaded, so the list shows real, actionable videos.
function buildEntries(items) {
  const entries = [];
  const unavailable = [];

  const hls = items.filter((m) => m.ext === "m3u8");
  const rest = items.filter((m) => m.ext !== "m3u8");

  const isMaster = (m) => (probeResults.get(m.url) || {}).master === true;
  const claimed = new Set();

  // Fold variant/rendition playlists under their master.
  for (const m of hls) {
    if (!isMaster(m)) continue;
    const pr = probeResults.get(m.url);
    const children = new Set(pr.children || []);
    for (const s of hls) {
      if (s === m || isMaster(s) || claimed.has(s.url)) continue;
      if (children.has(stripUrl(s.url)) || dirOf(s.url).startsWith(dirOf(m.url))) claimed.add(s.url);
    }
  }

  // Variant ladders sniffed without their master: group by directory, keep
  // the earliest playlist (the first one requested is closest to the source).
  const seenDirs = new Map();
  for (const s of hls) {
    if (claimed.has(s.url) || isMaster(s)) continue;
    const d = dirOf(s.url);
    const prev = seenDirs.get(d);
    if (!prev) seenDirs.set(d, s);
    else if (s.ts < prev.ts) { claimed.add(prev.url); seenDirs.set(d, s); }
    else claimed.add(s.url);
  }

  for (const m of hls) {
    if (claimed.has(m.url)) continue;
    const pr = probeResults.get(m.url) || {};
    if (pr.drm) {
      unavailable.push({ item: m, reason: "DRM (" + pr.drm + ") — cannot be downloaded", btn: "DRM" });
    } else {
      entries.push({ item: m, probe: pr });
    }
  }

  for (const m of rest) {
    if (m.url.startsWith("blob:")) {
      unavailable.push({ item: m, reason: "blob URL (MSE player) — extensions can't fetch it", btn: "GET" });
    } else if (m.ext === "mpd") {
      unavailable.push({ item: m, reason: "DASH — muxing needs ffmpeg (use the desktop app)", btn: "DASH" });
    } else {
      entries.push({ item: m });
    }
  }

  entries.sort((a, b) => (b.item.ts || 0) - (a.item.ts || 0));
  return { entries, unavailable };
}

function download(url, filename, saveAs, btn) {
  const original = btn ? btn.textContent : "";
  if (btn) { btn.disabled = true; btn.textContent = "..."; }
  const opts = { url, saveAs: !!saveAs };
  if (filename) opts.filename = filename;
  chrome.downloads.download(opts, (id) => {
    const err = chrome.runtime.lastError;
    if (btn) {
      if (err || id === undefined) {
        btn.textContent = "FAIL";
        btn.title = err ? err.message : "Download failed";
      } else {
        btn.textContent = "✓";
      }
      setTimeout(() => {
        btn.disabled = false;
        btn.textContent = original;
        btn.title = "";
      }, 1800);
    }
  });
}

function snatchStream(url, baseName, btn) {
  const original = btn ? btn.textContent : "";
  if (btn) { btn.disabled = true; btn.textContent = "..."; }
  chrome.runtime.sendMessage({ type: "snatchStream", tabId: activeTab.id, url, baseName }, () => {
    void chrome.runtime.lastError;
    if (btn) {
      setTimeout(() => { btn.disabled = false; btn.textContent = original; }, 1500);
    }
  });
}

// ── In-extension playback ─────────────────────────────────────────────────────
function titleFor(m) {
  const title = activeTab && activeTab.title ? activeTab.title.trim() : "";
  if (title) return title;
  return m.filename || "video";
}

function showStatus(stage, message) {
  const el = document.getElementById("playerStatus");
  if (stage === "ready" || stage === "playing") {
    el.classList.add("hidden");
    el.textContent = "";
  } else {
    el.classList.remove("hidden");
    el.textContent = message || (stage === "loading" ? "Loading…" : "");
    el.classList.toggle("err", stage === "error");
  }
}

function playInline(m) {
  const section = document.getElementById("player");
  const video = document.getElementById("video");
  const title = document.getElementById("playerTitle");

  if (currentPlayer) { currentPlayer.destroy(); currentPlayer = null; }
  video.pause();

  section.classList.remove("hidden");
  title.textContent = titleFor(m);
  title.title = m.url;
  const ext = m.ext || extOf(m.url) || "mp4";
  const kind = m.kind || kindFor(ext);
  // Remember the active item so the pop-out button knows what to open.
  section.dataset.url = m.url;
  section.dataset.ext = ext;
  section.dataset.kind = kind;

  currentPlayer = attachPlayer(video, { url: m.url, ext, kind }, showStatus);
  section.scrollIntoView({ block: "nearest" });
}

function closeInline() {
  const section = document.getElementById("player");
  const video = document.getElementById("video");
  if (currentPlayer) { currentPlayer.destroy(); currentPlayer = null; }
  video.pause();
  section.classList.add("hidden");
}

function openInTab(m) {
  const ext = (m && m.ext) || extOf(m.url) || "mp4";
  const kind = (m && m.kind) || kindFor(ext);
  const params = new URLSearchParams({ u: m.url, ext, kind, name: titleFor(m) });
  chrome.tabs.create({ url: chrome.runtime.getURL("player.html") + "?" + params.toString() });
}

// ── Active merge jobs ──
const jobsMap = new Map();

function renderJobs() {
  const box = document.getElementById("jobs");
  box.innerHTML = "";
  const list = Array.from(jobsMap.values()).sort((a, b) => (b.ts || 0) - (a.ts || 0));
  for (const j of list) {
    const active = j.status !== "done" && j.status !== "error";
    const row = document.createElement("div");
    row.className = "job";

    const top = document.createElement("div");
    top.className = "job-top";
    const name = document.createElement("div");
    name.className = "job-name";
    name.textContent = j.baseName || j.filename || "stream";
    name.title = j.url || "";
    const status = document.createElement("span");
    const pct = typeof j.pct === "number" ? j.pct : 0;
    if (j.status === "done") { status.className = "job-status done"; status.textContent = "✓ DONE"; }
    else if (j.status === "error") { status.className = "job-status err"; status.textContent = "✕ " + (j.error || "ERROR"); }
    else { status.className = "job-status run"; status.textContent = (j.status || "merging").toUpperCase() + " " + pct + "%"; }
    top.appendChild(name);
    top.appendChild(status);

    if (active) {
      const cancel = document.createElement("button");
      cancel.className = "job-cancel";
      cancel.textContent = "✕";
      cancel.title = "Cancel";
      cancel.addEventListener("click", () => {
        chrome.runtime.sendMessage({ type: "cancelStream", id: j.id }, () => void chrome.runtime.lastError);
      });
      top.appendChild(cancel);
    }
    row.appendChild(top);

    const bar = document.createElement("div");
    bar.className = "job-bar";
    const fill = document.createElement("div");
    fill.className = "job-fill";
    fill.style.width = (j.status === "done" ? 100 : pct) + "%";
    if (j.status === "error") fill.style.background = "var(--red)";
    bar.appendChild(fill);
    row.appendChild(bar);

    if (j.note && j.status === "done") {
      const note = document.createElement("div");
      note.className = "job-note";
      note.textContent = j.note;
      row.appendChild(note);
    }

    box.appendChild(row);
  }
}

function rowFor(e, unavail) {
  const m = e.item;
  const row = document.createElement("div");
  row.className = "item" + (unavail ? " unavail" : "");

  const kind = document.createElement("span");
  kind.className = "kind " + (unavail ? "dead" : m.kind);
  kind.textContent = m.ext || m.kind;
  row.appendChild(kind);

  const info = document.createElement("div");
  info.className = "item-info";
  const name = document.createElement("div");
  name.className = "item-name";
  name.textContent = m.filename;
  name.title = m.url;
  const meta = document.createElement("div");
  meta.className = "item-meta";
  const bits = [];
  if (m.size) bits.push(formatSize(m.size));
  if (unavail) {
    bits.push(e.reason);
  } else if (m.kind === "stream") {
    const pr = e.probe || {};
    if (pr.master) bits.push("HLS" + (pr.res ? " · best " + pr.res : "") + " — merge to file");
    else if (probeResults.has(m.url)) bits.push("HLS stream — merge to file");
    else bits.push("HLS stream — checking…");
  }
  meta.textContent = bits.join(" · ") || m.kind;
  info.appendChild(name);
  info.appendChild(meta);
  row.appendChild(info);

  if (!unavail) {
    // Playable in-extension: hls.js handles HLS, native handles direct files.
    const play = document.createElement("button");
    play.className = "play-btn";
    play.textContent = "▶";
    play.title = "Play in the extension";
    play.addEventListener("click", () => playInline(m));
    row.appendChild(play);
  }

  const btn = document.createElement("button");
  btn.className = "dl-btn";
  if (unavail) {
    btn.textContent = e.btn;
    btn.disabled = true;
    btn.title = e.reason;
  } else if (m.kind === "stream") {
    btn.textContent = "MERGE";
    btn.title = "Download all segments and merge into one file";
    btn.addEventListener("click", () => snatchStream(m.url, baseNameFor(m), btn));
  } else {
    btn.textContent = "GET";
    btn.addEventListener("click", () => download(m.url, m.filename, false, btn));
  }
  row.appendChild(btn);
  return row;
}

function render(items) {
  const { entries, unavailable } = buildEntries(items);
  const list = document.getElementById("list");
  const count = document.getElementById("count");
  count.textContent = String(entries.length);
  list.innerHTML = "";

  if (entries.length === 0 && unavailable.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.innerHTML = "No media detected yet.<br />Play a video or reload the page.";
    list.appendChild(empty);
    return;
  }

  for (const e of entries) list.appendChild(rowFor(e, false));

  if (unavailable.length > 0) {
    const head = document.createElement("div");
    head.className = "unavail-head";
    head.textContent = (showUnavailable ? "▾" : "▸") + " NOT DOWNLOADABLE (" + unavailable.length + ")";
    head.title = "Media this extension can't save: DRM streams, DASH, blob URLs";
    head.addEventListener("click", () => {
      showUnavailable = !showUnavailable;
      render(lastItems);
    });
    list.appendChild(head);
    if (showUnavailable) {
      for (const u of unavailable) list.appendChild(rowFor(u, true));
    }
  }
}

async function refresh() {
  const items = await gatherMedia();
  lastItems = items;
  render(items);

  // Probe HLS playlists in the background, then re-render with what we learn
  // (master grouping, best resolution, DRM flags).
  const pending = items
    .filter((m) => m.ext === "m3u8" && !probeResults.has(m.url))
    .map((m) => probeStream(m.url));
  if (pending.length > 0) {
    await Promise.all(pending);
    if (lastItems === items) render(items);
  }
}

// ── init ──
document.addEventListener("DOMContentLoaded", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab;

  if (tab && tab.url) {
    const p = PLATFORMS.find((pl) => pl.test(tab.url));
    if (p) document.getElementById("platform").textContent = "◈ " + p.name;
  }

  document.getElementById("manualBtn").addEventListener("click", () => {
    const input = document.getElementById("manualUrl");
    const url = input.value.trim();
    if (!/^https?:\/\//i.test(url)) {
      input.style.borderColor = "var(--red)";
      setTimeout(() => (input.style.borderColor = ""), 1200);
      return;
    }
    const ext = extOf(url) || "mp4";
    const btn = document.getElementById("manualBtn");
    if (ext === "m3u8") {
      snatchStream(url, baseNameFor({ filename: guessFilename(url, ext) }), btn);
      return;
    }
    const saveAs = document.getElementById("saveAs").checked;
    download(url, guessFilename(url, ext), saveAs, btn);
  });
  document.getElementById("manualUrl").addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("manualBtn").click();
  });

  document.getElementById("refreshBtn").addEventListener("click", refresh);
  document.getElementById("clearBtn").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "clearMedia", tabId: activeTab.id }).catch(() => {});
    lastItems = [];
    render([]);
  });

  document.getElementById("closePlayer").addEventListener("click", closeInline);
  document.getElementById("popoutBtn").addEventListener("click", () => {
    const section = document.getElementById("player");
    if (!section.dataset.url) return;
    openInTab({ url: section.dataset.url, ext: section.dataset.ext, kind: section.dataset.kind });
  });

  // Live progress from in-flight merge jobs.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "jobUpdate" && msg.job && msg.job.tabId === activeTab.id) {
      jobsMap.set(msg.job.id, msg.job);
      renderJobs();
    }
  });

  // Seed any jobs already running for this tab.
  chrome.runtime.sendMessage({ type: "getJobs", tabId: activeTab.id }, (resp) => {
    void chrome.runtime.lastError;
    if (resp && resp.list) {
      for (const j of resp.list) jobsMap.set(j.id, j);
      renderJobs();
    }
  });

  refresh();
});
