// CyberSnatcher HLS engine (offscreen document).
// Fetches an .m3u8 playlist, downloads every segment, decrypts AES-128 if
// needed, concatenates them into a single file, and hands the blob to
// chrome.downloads. Streams that carry audio in a separate rendition group
// are downloaded as two files (video + audio) rather than producing a silent
// video. Refuses DRM-protected streams (SAMPLE-AES / Widevine / PlayReady /
// FairPlay) because their bytes are unrecoverable by design.

const SEGMENT_CONCURRENCY = 6;
const jobs = new Map(); // id -> { cancelled, controllers:Set }

function report(id, patch) {
  chrome.runtime.sendMessage({ target: "sw", type: "hlsProgress", id, ...patch }).catch(() => {});
}

function resolveUrl(base, rel) {
  try { return new URL(rel, base).href; } catch (_) { return rel; }
}

function parseAttributes(str) {
  const attrs = {};
  // Split on commas that are not inside quotes.
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    let val = m[2];
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    attrs[m[1]] = val;
  }
  return attrs;
}

async function fetchText(url, job) {
  const ctrl = new AbortController();
  job.controllers.add(ctrl);
  try {
    const r = await fetch(url, { signal: ctrl.signal, credentials: "include" });
    if (!r.ok) throw new Error("HTTP " + r.status + " for playlist");
    return await r.text();
  } finally {
    job.controllers.delete(ctrl);
  }
}

async function fetchBuffer(url, job) {
  const ctrl = new AbortController();
  job.controllers.add(ctrl);
  try {
    const r = await fetch(url, { signal: ctrl.signal, credentials: "include" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.arrayBuffer();
  } finally {
    job.controllers.delete(ctrl);
  }
}

function hexToBytes(hex) {
  const clean = hex.replace(/^0x/i, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

function seqToIv(seq) {
  const iv = new Uint8Array(16);
  const view = new DataView(iv.buffer);
  // 64-bit big-endian sequence number in the low 8 bytes.
  view.setUint32(8, Math.floor(seq / 0x100000000));
  view.setUint32(12, seq >>> 0);
  return iv;
}

// Parse a master playlist into variants and audio rendition groups.
function parseMaster(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const variants = [];
  const audio = {}; // GROUP-ID -> [{ uri, isDefault }]
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("#EXT-X-MEDIA:")) {
      const a = parseAttributes(line.slice(line.indexOf(":") + 1));
      if ((a.TYPE || "").toUpperCase() === "AUDIO" && a["GROUP-ID"]) {
        (audio[a["GROUP-ID"]] = audio[a["GROUP-ID"]] || []).push({
          uri: a.URI ? resolveUrl(baseUrl, a.URI) : null,
          isDefault: (a.DEFAULT || "").toUpperCase() === "YES",
        });
      }
    } else if (line.startsWith("#EXT-X-STREAM-INF")) {
      const attrs = parseAttributes(line.slice(line.indexOf(":") + 1));
      const bw = parseInt(attrs.BANDWIDTH || attrs["AVERAGE-BANDWIDTH"] || "0", 10);
      let uri = "";
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j].trim();
        if (l && !l.startsWith("#")) { uri = l; break; }
      }
      if (uri) {
        variants.push({
          bw,
          url: resolveUrl(baseUrl, uri),
          res: attrs.RESOLUTION || "",
          audioGroup: attrs.AUDIO || null,
        });
      }
    }
  }
  return { variants, audio };
}

// The audio rendition a variant needs, or null when its audio is muxed in.
// An EXT-X-MEDIA entry without URI means the audio lives inside the variant.
function audioRenditionFor(variant, audioGroups) {
  if (!variant.audioGroup) return null;
  const group = (audioGroups[variant.audioGroup] || []).filter((r) => r.uri);
  if (group.length === 0) return null;
  return group.find((r) => r.isDefault) || group[0];
}

// Prefer a muxed variant — it yields a single playable file — unless the only
// muxed options are less than half the best bandwidth (too big a quality
// drop). In that case take the best variant and save its audio separately.
function chooseVariant(variants, audioGroups) {
  const sorted = variants.slice().sort((a, b) => b.bw - a.bw);
  const best = sorted[0];
  const muxed = sorted.find((v) => !audioRenditionFor(v, audioGroups));
  if (muxed && muxed.bw >= best.bw * 0.5) return muxed;
  return best;
}

// Parse a media playlist into { segments, map, drm }.
function parseMedia(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const segments = [];
  let mediaSeq = 0;
  let curKey = null; // { method, uri, iv }
  let map = null; // init segment url
  let drm = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      mediaSeq = parseInt(line.split(":")[1], 10) || 0;
    } else if (line.startsWith("#EXT-X-KEY:")) {
      const a = parseAttributes(line.slice(line.indexOf(":") + 1));
      const method = (a.METHOD || "").toUpperCase();
      const kf = (a.KEYFORMAT || "").toLowerCase();
      if (method === "NONE" || method === "") {
        curKey = null;
      } else if (method === "AES-128" && (!kf || kf === "identity")) {
        curKey = { method, uri: resolveUrl(baseUrl, a.URI || ""), iv: a.IV || null };
      } else {
        drm = method + (kf ? " / " + kf : "");
      }
    } else if (line.startsWith("#EXT-X-MAP:")) {
      const a = parseAttributes(line.slice(line.indexOf(":") + 1));
      if (a.URI) map = resolveUrl(baseUrl, a.URI);
    } else if (line.startsWith("#EXTINF")) {
      // Next non-comment line is the segment URI.
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j].trim();
        if (!l) continue;
        if (l.startsWith("#")) continue;
        const seq = mediaSeq + segments.length;
        segments.push({
          url: resolveUrl(baseUrl, l),
          key: curKey,
          iv: curKey ? (curKey.iv ? hexToBytes(curKey.iv) : seqToIv(seq)) : null,
        });
        i = j;
        break;
      }
    }
  }
  return { segments, map, drm };
}

async function getKey(uri, cache, job) {
  if (cache.has(uri)) return cache.get(uri);
  const buf = await fetchBuffer(uri, job);
  const key = await crypto.subtle.importKey("raw", buf.slice(0, 16), { name: "AES-CBC" }, false, ["decrypt"]);
  cache.set(uri, key);
  return key;
}

// Download every segment of one media playlist (plus its init segment).
// Progress is shared across tracks so the UI shows one combined percentage.
async function fetchTrack(job, id, track, progress, keyCache) {
  const tick = () => {
    progress.done++;
    report(id, {
      status: "downloading",
      pct: Math.round((progress.done / progress.total) * 100),
      done: progress.done,
      total: progress.total,
    });
  };

  let initBuf = null;
  if (track.map) {
    initBuf = new Uint8Array(await fetchBuffer(track.map, job));
    tick();
  }

  const parts = new Array(track.segments.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      if (job.cancelled) throw new Error("__cancelled__");
      const idx = nextIndex++;
      if (idx >= track.segments.length) return;
      const seg = track.segments[idx];
      let buf = await fetchBuffer(seg.url, job);
      if (seg.key) {
        const key = await getKey(seg.key.uri, keyCache, job);
        buf = await crypto.subtle.decrypt({ name: "AES-CBC", iv: seg.iv }, key, buf);
      }
      parts[idx] = new Uint8Array(buf);
      tick();
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(SEGMENT_CONCURRENCY, track.segments.length); i++) workers.push(worker());
  await Promise.all(workers);
  return { initBuf, parts };
}

function audioExtFor(isFmp4, firstUrl) {
  if (isFmp4) return "m4a";
  const m = firstUrl && firstUrl.split(/[?#]/)[0].match(/\.([a-z0-9]{2,4})$/i);
  const ext = m ? m[1].toLowerCase() : "";
  return ["aac", "mp3", "ac3", "ec3"].includes(ext) ? ext : "ts";
}

function mimeFor(role, ext) {
  if (ext === "mp4") return "video/mp4";
  if (ext === "m4a") return "audio/mp4";
  if (ext === "aac") return "audio/aac";
  if (ext === "mp3") return "audio/mpeg";
  return role === "audio" ? "audio/mp2t" : "video/mp2t";
}

// Offscreen documents can only use chrome.runtime — chrome.downloads is not
// available here. Create the blob URL in this document (service workers
// can't) and ask the service worker to perform the actual download.
async function saveBlob(blob, filename) {
  const objectUrl = URL.createObjectURL(blob);
  let resp;
  try {
    resp = await chrome.runtime.sendMessage({ target: "sw", type: "saveBlob", url: objectUrl, filename });
  } finally {
    // Keep the URL alive long enough for the download to start reading it.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 120000);
  }
  if (!resp || !resp.ok) throw new Error((resp && resp.error) || "Download rejected");
  return resp.id;
}

async function downloadHls(id, url, baseName) {
  const job = { cancelled: false, controllers: new Set() };
  jobs.set(id, job);
  const fail = (error) => report(id, { status: "error", error });

  try {
    report(id, { status: "parsing", pct: 0 });
    let text = await fetchText(url, job);
    let playlistUrl = url;
    let audioRend = null;

    // Resolve master -> media playlist (one level).
    if (text.includes("#EXT-X-STREAM-INF")) {
      const { variants, audio } = parseMaster(text, url);
      if (variants.length === 0) return fail("No playable variant found in master playlist");
      const chosen = chooseVariant(variants, audio);
      audioRend = audioRenditionFor(chosen, audio);
      playlistUrl = chosen.url;
      text = await fetchText(playlistUrl, job);
    }

    const tracks = [{ role: "video", ...parseMedia(text, playlistUrl) }];
    if (audioRend) {
      const aText = await fetchText(audioRend.uri, job);
      const aTrack = { role: "audio", ...parseMedia(aText, audioRend.uri) };
      if (aTrack.segments.length > 0 || aTrack.drm) tracks.push(aTrack);
    }

    for (const t of tracks) {
      if (t.drm) return fail("DRM-protected stream (" + t.drm + ") — cannot download");
    }
    if (tracks[0].segments.length === 0) return fail("No segments found in playlist");

    const progress = {
      total: tracks.reduce((n, t) => n + t.segments.length + (t.map ? 1 : 0), 0),
      done: 0,
    };
    const keyCache = new Map();

    const outputs = [];
    for (const t of tracks) {
      const data = await fetchTrack(job, id, t, progress, keyCache);
      if (job.cancelled) return fail("Cancelled");
      outputs.push({
        role: t.role,
        isFmp4: !!t.map,
        firstUrl: t.segments.length ? t.segments[0].url : "",
        ...data,
      });
    }

    report(id, { status: "assembling", pct: 99 });

    const twoFiles = outputs.length > 1;
    const names = [];
    for (const o of outputs) {
      const blobParts = [];
      if (o.initBuf) blobParts.push(o.initBuf);
      for (const p of o.parts) blobParts.push(p);
      const ext = o.role === "audio" ? audioExtFor(o.isFmp4, o.firstUrl) : o.isFmp4 ? "mp4" : "ts";
      const filename = sanitize(baseName + (twoFiles ? "." + o.role : ""), ext);
      const blob = new Blob(blobParts, { type: mimeFor(o.role, ext) });
      await saveBlob(blob, filename);
      names.push(filename);
    }

    report(id, {
      status: "done",
      pct: 100,
      filename: names.join(" + "),
      note: twoFiles
        ? "This stream keeps audio and video in separate tracks — saved as two files. Combine them with ffmpeg or the desktop app."
        : undefined,
    });
  } catch (e) {
    if (e && e.message === "__cancelled__") fail("Cancelled");
    else fail(String(e && e.message ? e.message : e));
  } finally {
    jobs.delete(id);
  }
}

function sanitize(name, ext) {
  let n = (name || "cybersnatch").replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_").trim();
  if (!n) n = "cybersnatch";
  n = n.replace(/\.(m3u8|mpd)$/i, "");
  if (!new RegExp("\\." + ext + "$", "i").test(n)) n += "." + ext;
  return n;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.target !== "offscreen") return;
  if (msg.type === "hlsDownload") {
    downloadHls(msg.id, msg.url, msg.baseName);
  } else if (msg.type === "cancel") {
    const job = jobs.get(msg.id);
    if (job) {
      job.cancelled = true;
      for (const c of job.controllers) { try { c.abort(); } catch (_) {} }
    }
  }
});
