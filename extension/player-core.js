// Shared playback engine for CyberPlayer, used by both the popup mini-player
// and the full-tab player page. Picks the right strategy per media kind:
//   • HLS (.m3u8)  → hls.js (MSE) when supported, native HLS otherwise
//   • DASH (.mpd)  → native only (rare); flagged unsupported when it can't play
//   • blob: URLs   → can't be reached from an extension page
//   • everything else (mp4/webm/ogg/audio…) → native <video>/<audio>
//
// attachPlayer returns a controller whose destroy() tears down hls.js and
// releases the element, so callers can safely swap sources.

function canPlayNativeHls(video) {
  return !!video.canPlayType(
    "application/vnd.apple.mpegurl"
  ) || !!video.canPlayType("application/x-mpegURL");
}

// item: { url, ext, kind }. onStatus(stage, message): "loading" | "ready" |
// "error" | "playing". Returns { destroy() }.
function attachPlayer(video, item, onStatus) {
  const say = (stage, message) => { if (onStatus) onStatus(stage, message); };
  let hls = null;
  let destroyed = false;

  const ext = (item.ext || "").toLowerCase();
  const url = item.url;

  if (url.startsWith("blob:")) {
    say("error", "This is a blob: URL created by the page's own player — an extension page can't fetch it. Try playing it on the original tab.");
    return { destroy() {} };
  }

  video.addEventListener("playing", () => say("playing", ""), { once: false });

  if (ext === "m3u8") {
    if (typeof Hls !== "undefined" && Hls.isSupported()) {
      say("loading", "Loading HLS stream…");
      // Workers are spun up from blob: URLs, which the MV3 extension-page CSP
      // blocks — keep hls.js on the main thread so playback just works.
      hls = new Hls({ enableWorker: false, lowLatencyMode: false });
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (destroyed) return;
        say("ready", "");
        video.play().catch(() => {/* autoplay may be blocked; user can press play */});
      });
      hls.on(Hls.Events.ERROR, (_evt, data) => {
        if (destroyed || !data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          say("error", "Network error loading the stream (it may be DRM-protected, expired, or CORS-restricted).");
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          say("error", "Media error — the stream may use an unsupported or encrypted codec.");
        } else {
          say("error", "Could not play this HLS stream.");
        }
      });
      hls.loadSource(url);
      hls.attachMedia(video);
    } else if (canPlayNativeHls(video)) {
      say("loading", "Loading HLS stream (native)…");
      video.src = url;
      video.play().catch(() => {});
    } else {
      say("error", "HLS playback isn't supported in this browser.");
    }
    return {
      destroy() {
        destroyed = true;
        if (hls) { try { hls.destroy(); } catch (_) {} hls = null; }
        video.removeAttribute("src");
        video.load();
      },
    };
  }

  if (ext === "mpd") {
    // hls.js doesn't do DASH and Chromium has no native MPEG-DASH support.
    say("error", "DASH (.mpd) streams can't be played in-extension.");
    return { destroy() {} };
  }

  // Direct file — let the browser handle it.
  say("loading", "Loading…");
  video.src = url;
  const onCanPlay = () => { say("ready", ""); video.play().catch(() => {}); };
  const onError = () => say("error", "The browser couldn't play this file (unsupported codec, CORS, or a broken link).");
  video.addEventListener("canplay", onCanPlay, { once: true });
  video.addEventListener("error", onError, { once: true });

  return {
    destroy() {
      destroyed = true;
      video.removeEventListener("canplay", onCanPlay);
      video.removeEventListener("error", onError);
      video.removeAttribute("src");
      video.load();
    },
  };
}
