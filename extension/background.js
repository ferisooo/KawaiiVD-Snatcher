// CyberSnatcher background service worker.
// Sniffs network traffic for media responses and tracks them per-tab.
// State lives in chrome.storage.session so it survives service-worker restarts.

const MEDIA_EXT = [
  "mp4", "m4v", "webm", "mkv", "mov", "avi", "flv", "3gp",
  "mp3", "m4a", "aac", "ogg", "oga", "opus", "wav", "flac",
  "m3u8", "mpd",
];

const STREAM_EXT = ["m3u8", "mpd"]; // manifests, not directly playable once saved
const MAX_ITEMS_PER_TAB = 150;

// HLS/DASH fragments are useless individually and one stream fires hundreds of
// them — never list these. The manifest is the downloadable thing.
const SEGMENT_EXT = ["ts", "m4s", "m4f", "m4i", "mts", "m2ts", "cmfv", "cmfa", "cmft"];
const SEGMENT_CT = ["video/mp2t", "video/iso.segment", "video/x-m2ts"];
// fMP4 fragments often masquerade as plain video/mp4. Catches seg-42.mp4,
// chunk_007.m4a, init.mp4, media-720p-000123.mp4, or a trailing 3+ digit
// counter. Only enforced once the tab is known to be playing a stream (see
// addMedia) so ordinary numbered files on stream-free pages still show up.
const SEGMENT_NAME_RE =
  /(?:^|[-_.])(?:seg(?:ment)?|chunk|frag(?:ment)?|init|media|part)[-_.]?\d*\.[a-z0-9]{2,4}$|[-_.]\d{3,}\.(?:mp4|m4v|m4a|aac)$/i;

// Ad/tracking CDNs whose "videos" are creatives and beacons, not page content.
const AD_HOSTS = [
  "doubleclick.net", "googlesyndication.com", "googleadservices.com",
  "adservice.google.com", "2mdn.net", "adsafeprotected.com", "moatads.com",
  "adnxs.com", "adsrvr.org", "criteo.com", "criteo.net", "taboola.com",
  "outbrain.com", "teads.tv", "springserve.com", "spotxchange.com",
  "spotx.tv", "innovid.com", "tremorhub.com", "yieldmo.com",
  "smartadserver.com", "rubiconproject.com", "pubmatic.com", "openx.net",
  "casalemedia.com", "amazon-adsystem.com", "advertising.com",
  "serving-sys.com", "flashtalking.com", "undertone.com", "zedo.com",
  "exoclick.com", "trafficjunky.net", "popads.net", "propellerads.com",
  "adsterra.com",
];

// Direct files smaller than this are bumpers, beacons and preview sprites.
// Only applied when the server reports a Content-Length.
const MIN_BYTES = { video: 102400, audio: 30720 };

// Serialise read-modify-write on session storage to avoid lost updates.
let writeChain = Promise.resolve();

function keyFor(tabId) {
  return `media_${tabId}`;
}

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

function isAdHost(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch (_) {
    return false;
  }
  return AD_HOSTS.some((d) => host === d || host.endsWith("." + d));
}

function guessFilename(url, ext) {
  const clean = stripUrl(url);
  let name = clean.slice(clean.lastIndexOf("/") + 1) || "media";
  try {
    name = decodeURIComponent(name);
  } catch (_) {
    /* keep raw */
  }
  name = name.replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_").trim();
  if (!name) name = "media";
  const hasExt = /\.[a-z0-9]{1,5}$/i.test(name);
  if (!hasExt && ext) name += "." + ext;
  return name;
}

// Decide whether a response is media, using content-type first then URL extension.
function classify(url, contentType) {
  const ct = (contentType || "").toLowerCase().split(";")[0].trim();
  const ext = extOf(url);

  // Stream fragments are never listed — only their manifest is actionable.
  if (SEGMENT_EXT.includes(ext) || SEGMENT_CT.includes(ct)) return null;

  let isMedia = false;
  if (ct.startsWith("video/") || ct.startsWith("audio/")) isMedia = true;
  else if (
    ct === "application/x-mpegurl" ||
    ct === "application/vnd.apple.mpegurl" ||
    ct === "application/dash+xml"
  )
    isMedia = true;
  else if (MEDIA_EXT.includes(ext)) isMedia = true;

  if (!isMedia) return null;

  const kind = STREAM_EXT.includes(ext) || ct.includes("mpegurl") || ct.includes("dash+xml")
    ? "stream"
    : ct.startsWith("audio/") || ["mp3", "m4a", "aac", "ogg", "oga", "opus", "wav", "flac"].includes(ext)
      ? "audio"
      : "video";

  return { ext: ext || (kind === "audio" ? "mp3" : "mp4"), kind };
}

function getHeader(headers, name) {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const h of headers) {
    if (h.name && h.name.toLowerCase() === lower) return h.value;
  }
  return undefined;
}

async function addMedia(tabId, item) {
  if (tabId < 0) return;
  writeChain = writeChain.then(async () => {
    const key = keyFor(tabId);
    const stored = await chrome.storage.session.get(key);
    let list = stored[key] || [];
    if (list.some((m) => m.url === item.url)) return; // dedupe
    const hasStream = list.some((m) => m.kind === "stream");
    if (item.seg && hasStream) return; // fragment of a stream we already track
    if (item.kind === "stream" && !hasStream) {
      // First manifest on this tab: purge fragments captured before it arrived.
      list = list.filter((m) => !m.seg);
    }
    list.push(item);
    if (list.length > MAX_ITEMS_PER_TAB) {
      // Evict oldest non-stream items first so manifests are never lost.
      let excess = list.length - MAX_ITEMS_PER_TAB;
      for (let i = 0; i < list.length && excess > 0; ) {
        if (list[i].kind !== "stream") {
          list.splice(i, 1);
          excess--;
        } else i++;
      }
      if (excess > 0) list.splice(0, excess);
    }
    await chrome.storage.session.set({ [key]: list });
    await updateBadge(tabId, list.length);
  });
  return writeChain;
}

async function clearTab(tabId) {
  if (tabId < 0) return;
  writeChain = writeChain.then(async () => {
    await chrome.storage.session.remove(keyFor(tabId));
    await updateBadge(tabId, 0);
  });
  return writeChain;
}

async function updateBadge(tabId, count) {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: "#b400ff", tabId });
    await chrome.action.setBadgeText({ text: count > 0 ? String(count) : "", tabId });
  } catch (_) {
    /* tab may be gone */
  }
}

// ── HLS merge jobs (offscreen engine) ────────────────────────────────────────
let creatingOffscreen = null;

async function ensureOffscreen() {
  const has = await chrome.offscreen.hasDocument();
  if (has) return;
  if (creatingOffscreen) { await creatingOffscreen; return; }
  creatingOffscreen = chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["BLOBS"],
    justification: "Merge HLS media segments into a single downloadable file.",
  });
  try { await creatingOffscreen; } finally { creatingOffscreen = null; }
}

let jobChain = Promise.resolve();

function updateJob(id, patch) {
  jobChain = jobChain.then(async () => {
    const stored = await chrome.storage.session.get("jobs");
    const all = stored.jobs || {};
    const job = { ...(all[id] || {}), id, ...patch, ts: Date.now() };
    all[id] = job;
    // Keep the map from growing without bound: drop oldest finished jobs.
    const ids = Object.keys(all);
    if (ids.length > 30) {
      ids.sort((a, b) => (all[a].ts || 0) - (all[b].ts || 0));
      for (const old of ids.slice(0, ids.length - 30)) {
        if (all[old].status === "done" || all[old].status === "error") delete all[old];
      }
    }
    await chrome.storage.session.set({ jobs: all });
    chrome.runtime.sendMessage({ type: "jobUpdate", job }).catch(() => {});

    if (typeof job.tabId === "number") {
      if (job.status === "done" || job.status === "error") {
        const media = await chrome.storage.session.get(keyFor(job.tabId));
        updateBadge(job.tabId, (media[keyFor(job.tabId)] || []).length);
      } else if (typeof job.pct === "number") {
        try {
          await chrome.action.setBadgeBackgroundColor({ color: "#00f5ff", tabId: job.tabId });
          await chrome.action.setBadgeText({ text: job.pct + "%", tabId: job.tabId });
        } catch (_) { /* tab gone */ }
      }
    }

    if (job.status === "done") {
      const msg = (job.filename || "Stream saved.") + (job.note ? "\n" + job.note : "");
      notify("Snatch complete", msg);
    } else if (job.status === "error") {
      notify("Snatch failed", job.error || "Could not download stream.");
    }
  });
  return jobChain;
}

function notify(title, message) {
  try {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "CyberSnatcher — " + title,
      message: String(message).slice(0, 240),
    });
  } catch (_) { /* notifications may be disabled */ }
}

async function startStream(tabId, url, baseName) {
  const id = "hls-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7);
  await updateJob(id, { tabId, url, baseName, status: "queued", pct: 0 });
  await ensureOffscreen();
  chrome.runtime.sendMessage({ target: "offscreen", type: "hlsDownload", id, url, baseName }).catch(() => {});
  return id;
}

// ── Network sniffing ─────────────────────────────────────────────────────────
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (isAdHost(details.url)) return;
    const ct = getHeader(details.responseHeaders, "content-type");
    const info = classify(details.url, ct);
    if (!info) return;
    const len = getHeader(details.responseHeaders, "content-length");
    const size = len ? parseInt(len, 10) : null;
    if (size && info.kind !== "stream" && size < (MIN_BYTES[info.kind] || 0)) return;
    const filename = guessFilename(details.url, info.ext);
    addMedia(details.tabId, {
      url: details.url,
      ext: info.ext,
      kind: info.kind,
      size,
      filename,
      seg: info.kind !== "stream" && SEGMENT_NAME_RE.test(filename) ? true : undefined,
      ts: Date.now(),
    });
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// ── Reset a tab's list on top-level navigation ───────────────────────────────
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId === 0) clearTab(details.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => clearTab(tabId));

// Refresh badge when switching tabs.
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const stored = await chrome.storage.session.get(keyFor(tabId));
  const list = stored[keyFor(tabId)] || [];
  updateBadge(tabId, list.length);
});

// ── Messaging from the popup ─────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return false;

  if (msg.type === "getMedia") {
    chrome.storage.session.get(keyFor(msg.tabId)).then((stored) => {
      sendResponse({ list: stored[keyFor(msg.tabId)] || [] });
    });
    return true; // async response
  }
  if (msg.type === "clearMedia") {
    clearTab(msg.tabId).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "snatchStream") {
    startStream(msg.tabId, msg.url, msg.baseName).then((id) => sendResponse({ id }));
    return true;
  }
  if (msg.type === "cancelStream") {
    chrome.runtime.sendMessage({ target: "offscreen", type: "cancel", id: msg.id }).catch(() => {});
    updateJob(msg.id, { status: "error", error: "Cancelled" }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "getJobs") {
    chrome.storage.session.get("jobs").then((stored) => {
      const all = stored.jobs || {};
      const list = Object.values(all)
        .filter((j) => j.tabId === msg.tabId)
        .sort((a, b) => (b.ts || 0) - (a.ts || 0));
      sendResponse({ list });
    });
    return true;
  }

  // Offscreen engine asks us to save its assembled blob (chrome.downloads
  // is unavailable in offscreen documents).
  if (msg.target === "sw" && msg.type === "saveBlob") {
    chrome.downloads.download({ url: msg.url, filename: msg.filename }, (id) => {
      const err = chrome.runtime.lastError;
      if (err || id === undefined) sendResponse({ ok: false, error: err ? err.message : "Download rejected" });
      else sendResponse({ ok: true, id });
    });
    return true; // async response
  }

  // Progress relayed up from the offscreen engine.
  if (msg.target === "sw" && msg.type === "hlsProgress") {
    const { id, ...patch } = msg;
    delete patch.target;
    delete patch.type;
    updateJob(id, patch);
    return false;
  }
  return false;
});
