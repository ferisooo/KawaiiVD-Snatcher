// Full-tab CyberPlayer page. Reads the media to play from the query string
// (?u=<url>&ext=<ext>&kind=<kind>&name=<title>) — populated by the popup's
// "open in tab" button — and hands it to the shared playback engine.

const params = new URLSearchParams(location.search);
const url = params.get("u") || "";
const ext = (params.get("ext") || "").toLowerCase();
const kind = params.get("kind") || "video";
const name = params.get("name") || "";

const video = document.getElementById("video");
const statusEl = document.getElementById("status");
const titleEl = document.getElementById("title");
const metaEl = document.getElementById("meta");

function showStatus(stage, message) {
  if (stage === "ready" || stage === "playing") {
    statusEl.classList.add("hidden");
    statusEl.textContent = "";
  } else {
    statusEl.classList.remove("hidden");
    statusEl.textContent = message || (stage === "loading" ? "Loading…" : "");
    statusEl.classList.toggle("err", stage === "error");
  }
}

titleEl.textContent = name || (url ? url.split("/").pop().split("?")[0] : "—");
titleEl.title = url;
document.title = "CyberPlayer — " + titleEl.textContent;
metaEl.textContent = [kind.toUpperCase(), ext && ext.toUpperCase(), url].filter(Boolean).join("  ·  ");

if (!url) {
  showStatus("error", "No media URL was provided.");
} else {
  attachPlayer(video, { url, ext: ext || "mp4", kind }, showStatus);
}
