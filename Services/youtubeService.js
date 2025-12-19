// youtubeService.js (CommonJS) — yt-dlp based (recommended 2025)
const fs = require("fs");
const path = require("path");
const youtubedl = require("youtube-dl-exec"); // auto-installs latest yt-dlp at build time :contentReference[oaicite:5]{index=5}

/**
 * ENV options (optional but recommended):
 * - YTDLP_COOKIES_PATH: absolute/relative path to cookies.txt
 * - YTDLP_EXTRACTOR_ARGS: override extractor args
 * - YTDLP_NO_MERGE_ONLY: "1" to return only muxed formats (audio+video in one file)
 *
 * Why cookies/PO tokens matter:
 * YouTube is enforcing PO Tokens for some clients; yt-dlp documents how to handle this. :contentReference[oaicite:6]{index=6}
 */

function extractYouTubeId(url) {
  if (!url) return null;

  const vMatch = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  if (vMatch) return vMatch[1];

  const shortMatch = url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
  if (shortMatch) return shortMatch[1];

  const shortsMatch = url.match(/youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/);
  if (shortsMatch) return shortsMatch[1];

  const embedMatch = url.match(/youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/);
  if (embedMatch) return embedMatch[1];

  return null;
}

function normalizeYouTubeUrl(input) {
  if (!input) return input;

  // youtu.be -> watch
  if (input.includes("youtu.be/")) {
    const id = input.split("youtu.be/")[1].split("?")[0].split("&")[0];
    return `https://www.youtube.com/watch?v=${id}`;
  }

  try {
    const u = new URL(input);
    if (u.hostname === "youtube.com" || u.hostname === "m.youtube.com") {
      u.hostname = "www.youtube.com";
    }
    return u.toString();
  } catch (_) {
    return input.replace("m.youtube.com", "www.youtube.com");
  }
}

function extractQualityNumber(label) {
  if (!label) return 0;
  const m = String(label).match(/(\d+)p/);
  if (m) return parseInt(m[1], 10);
  const q = String(label).toLowerCase();
  if (q.includes("2160") || q.includes("4k")) return 2160;
  if (q.includes("1440") || q.includes("2k")) return 1440;
  if (q.includes("1080")) return 1080;
  if (q.includes("720")) return 720;
  if (q.includes("480")) return 480;
  if (q.includes("360")) return 360;
  if (q.includes("240")) return 240;
  if (q.includes("144")) return 144;
  return 0;
}

function getExtensionFromType(mimeType, fallbackExt = "mp4") {
  if (!mimeType) return fallbackExt;
  const m = String(mimeType).toLowerCase();
  if (m.includes("video/mp4")) return "mp4";
  if (m.includes("video/webm")) return "webm";
  if (m.includes("audio/mp4")) return "m4a";
  if (m.includes("audio/webm")) return "webm";
  if (m.includes("audio/mpeg")) return "mp3";
  return fallbackExt;
}

function pickThumbnail(meta) {
  // yt-dlp can give thumbnail or thumbnails[]
  if (meta.thumbnail) return meta.thumbnail;
  const arr = Array.isArray(meta.thumbnails) ? meta.thumbnails : [];
  if (!arr.length) return null;
  // pick largest-ish
  const sorted = [...arr].sort((a, b) => (a.width || 0) - (b.width || 0));
  return sorted[sorted.length - 1].url || null;
}

/**
 * Converts yt-dlp format objects to your service "items" array
 */
function formatsToItems(meta) {
  const formats = Array.isArray(meta.formats) ? meta.formats : [];
  const items = [];
  const seen = new Set();

  for (const f of formats) {
    if (!f || !f.url) continue;

    // yt-dlp fields: acodec, vcodec, ext, format_note, format_id, filesize, filesize_approx, protocol, etc.
    const acodec = f.acodec || "none";
    const vcodec = f.vcodec || "none";
    const hasAudio = acodec !== "none";
    const hasVideo = vcodec !== "none";

    // Skip storyboards / images
    if (!hasAudio && !hasVideo) continue;

    const labelParts = [];
    const q = f.height ? `${f.height}p` : (f.format_note || f.format_id || "unknown");
    labelParts.push(q);

    if (hasVideo && !hasAudio) labelParts.push("video only");
    if (hasAudio && !hasVideo) labelParts.push("audio only");

    // Prefer showing container/codec info lightly
    if (f.ext) labelParts.push(f.ext);

    const label = labelParts.join(" • ");

    const mime =
        f.mime_type ||
        (hasVideo ? `video/${f.ext || "mp4"}` : `audio/${f.ext || "m4a"}`);

    const filesize = f.filesize || f.filesize_approx || "unknown";

    const key = `${f.format_id}::${label}`;
    if (seen.has(key)) continue;
    seen.add(key);

    items.push({
      url: f.url,
      label,
      type: mime,
      ext: f.ext || getExtensionFromType(mime, "mp4"),
      filesize,
      has_audio: hasAudio,
      has_video: hasVideo,
      // optional extra fields if you want them later
      format_id: f.format_id,
      fps: f.fps,
      abr: f.abr,
      tbr: f.tbr,
      vcodec,
      acodec,
    });
  }

  // sort by quality asc (audio-only last)
  items.sort((a, b) => {
    const aAudioOnly = a.has_audio && !a.has_video;
    const bAudioOnly = b.has_audio && !b.has_video;
    if (aAudioOnly && !bAudioOnly) return 1;
    if (!aAudioOnly && bAudioOnly) return -1;

    const aq = extractQualityNumber(a.label);
    const bq = extractQualityNumber(b.label);
    return aq - bq;
  });

  return items;
}

/**
 * Strong defaults for 2025:
 * Use clients that are currently less likely to require PO tokens for playback URLs.
 * yt-dlp’s PO token guide notes tv clients generally don’t require them, and web_safari can provide HLS formats. :contentReference[oaicite:7]{index=7}
 */
function defaultExtractorArgs() {
  return "youtube:player_client=tv,web_safari,web";
}

async function fetchYouTubeData(url) {
  const normalizedUrl = normalizeYouTubeUrl(url);
  const id = extractYouTubeId(normalizedUrl);
  if (!id) throw new Error("Could not extract YouTube video id");

  // If someone passes /shorts/, yt-dlp can handle it, but watch URL is safer
  const safeUrl = normalizedUrl.includes("/shorts/")
      ? `https://www.youtube.com/watch?v=${id}`
      : normalizedUrl;

  const cookiesPath = process.env.YTDLP_COOKIES_PATH;
  const noMergeOnly = process.env.YTDLP_NO_MERGE_ONLY === "1";

  // main extractor args (overrideable)
  const extractorArgs = process.env.YTDLP_EXTRACTOR_ARGS || defaultExtractorArgs();

  // yt-dlp JSON metadata
  let meta;
  try {
    meta = await youtubedl(safeUrl, {
      dumpSingleJson: true,
      noWarnings: true,
      noPlaylist: true,
      // Helps reduce random failures / scraping paths
      preferFreeFormats: true,
      // keep it quick; you’re only extracting URLs, not downloading here
      socketTimeout: 20,
      extractorArgs,

      ...(cookiesPath && fs.existsSync(cookiesPath) ? { cookies: cookiesPath } : {}),
    });
  } catch (e) {
    // yt-dlp returns useful stderr in e.stderr sometimes
    const extra = e?.stderr ? ` | stderr: ${String(e.stderr).slice(0, 300)}` : "";
    throw new Error(`yt-dlp failed: ${e.message}${extra}`);
  }

  if (!meta) throw new Error("yt-dlp returned empty metadata");

  // Build items
  let items = formatsToItems(meta);

  if (noMergeOnly) {
    // only muxed formats (audio+video) — this is the only way to guarantee “no merging”
    // Reality: YouTube usually caps muxed quality (often <=720p).
    items = items.filter((x) => x.has_audio && x.has_video);
  }

  if (!items.length) {
    throw new Error(
        "No formats found by yt-dlp. If this is happening for many videos, you likely need cookies/PO tokens per yt-dlp PO Token Guide."
    );
  }

  return {
    title: meta.title || "YouTube Video",
    cover: pickThumbnail(meta),
    duration: meta.duration || null,
    items,
  };
}

module.exports = { fetchYouTubeData };
