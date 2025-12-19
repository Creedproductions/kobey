// youtubeService.js
// CommonJS module

const axios = require("axios");
const audioMergerService = require("./audioMergerService");

// ---------------------------
// youtubei.js primary (Innertube)
// ---------------------------
let _innertube = null;

async function getInnertube() {
  if (_innertube) return _innertube;

  const mod = await import("youtubei.js"); // works from CommonJS
  const { Innertube, UniversalCache } = mod;

  _innertube = await Innertube.create({
    lang: "en",
    location: "US",
    user_agent: getRandomUserAgent(),

    // Important for deciphering formats (player needed)
    retrieve_player: true, // default true, but keep explicit :contentReference[oaicite:2]{index=2}

    // Helps stability + avoids recreating sessions too often
    enable_session_cache: true,
    cache: new UniversalCache(true),
  });

  return _innertube;
}

function extractYouTubeId(url) {
  if (!url) return null;

  // watch?v=
  const vMatch = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  if (vMatch) return vMatch[1];

  // youtu.be/
  const shortMatch = url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
  if (shortMatch) return shortMatch[1];

  // shorts/
  const shortsMatch = url.match(/youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/);
  if (shortsMatch) return shortsMatch[1];

  // embed/
  const embedMatch = url.match(/youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/);
  if (embedMatch) return embedMatch[1];

  return null;
}

function isShortsUrl(url) {
  return typeof url === "string" && url.includes("/shorts/");
}

function normalizeYouTubeUrl(url) {
  if (!url) return url;

  // unify domains
  url = url.replace("m.youtube.com", "www.youtube.com");
  url = url.replace("youtube.com", "www.youtube.com");

  // Convert youtu.be to watch
  if (url.includes("youtu.be/")) {
    const videoId = url.split("youtu.be/")[1].split("?")[0].split("&")[0];
    return `https://www.youtube.com/watch?v=${videoId}`;
  }

  // Keep shorts as-is (we’ll call Shorts-specific API), but ensure www
  if (url.includes("/shorts/")) return url;

  // Ensure watch has www
  if (url.includes("www.youtube.com/watch")) return url;

  return url;
}

/**
 * Call yt.getInfo() in a version-compatible way:
 * some versions accept (id, clientString)
 * others accept (id, { client: 'WEB' })
 */
async function callGetInfo(yt, id, client) {
  // try object signature first
  try {
    return await yt.getInfo(id, { client });
  } catch (_) {
    // fallback to string signature
    return await yt.getInfo(id, client);
  }
}

/**
 * Call yt.getShortsVideoInfo() in a version-compatible way
 */
async function callGetShortsInfo(yt, id, client) {
  // Signature per docs: getShortsVideoInfo(video_id, client?) :contentReference[oaicite:3]{index=3}
  return await yt.getShortsVideoInfo(id, client);
}

/**
 * Extract streaming formats from different shapes safely
 */
function getStreamingFormatsFromInfo(info) {
  const sd =
      info?.streaming_data ||
      info?.streamingData ||
      info?.player_response?.streamingData ||
      info?.playerResponse?.streamingData ||
      null;

  const formats =
      sd?.formats ||
      sd?.adaptive_formats ||
      sd?.adaptiveFormats ||
      [];

  // Some libs separate them; normalize both arrays
  const all = [];
  if (sd?.formats?.length) all.push(...sd.formats);
  if (sd?.adaptive_formats?.length) all.push(...sd.adaptive_formats);
  if (sd?.adaptiveFormats?.length) all.push(...sd.adaptiveFormats);

  // If we didn’t find split arrays, fallback to "formats" var
  if (!all.length && Array.isArray(formats)) all.push(...formats);

  return all;
}

/**
 * Decipher a single format safely using the correct player
 */
async function decipherFormatUrl(format, player) {
  // Best case: youtubei.js Format has decipher(player)
  if (typeof format?.decipher === "function" && player) {
    try {
      return await format.decipher(player);
    } catch (_) {
      // continue
    }
  }

  // Sometimes it already has a direct URL
  if (typeof format?.url === "string" && format.url.startsWith("http")) {
    return format.url;
  }

  return null;
}

/**
 * Primary: fetch via youtubei.js
 * - Shorts use getShortsVideoInfo (when available)
 * - Regular uses getInfo
 * - Tries multiple clients (ANDROID often returns more usable streams)
 */
async function fetchWithYouTubeJs(originalUrl) {
  const yt = await getInnertube();
  const id = extractYouTubeId(originalUrl);
  if (!id) throw new Error("Could not extract YouTube video id");

  const shorts = isShortsUrl(originalUrl);

  const clientsToTry = ["ANDROID", "WEB", "TV_EMBEDDED"];

  let info = null;
  let lastErr = null;

  for (const client of clientsToTry) {
    try {
      if (shorts && typeof yt.getShortsVideoInfo === "function") {
        info = await callGetShortsInfo(yt, id, client);
      } else {
        info = await callGetInfo(yt, id, client);
      }

      const formats = getStreamingFormatsFromInfo(info);
      if (formats && formats.length) break;

      lastErr = new Error(`No formats for client=${client}`);
      info = null;
    } catch (e) {
      lastErr = e;
      info = null;
    }
  }

  if (!info) {
    throw new Error(
        `youtubei.js returned no usable info (${shorts ? "shorts" : "watch"}). Last error: ${
            lastErr?.message || "unknown"
        }`
    );
  }

  const title =
      info?.basic_info?.title ||
      info?.video_details?.title ||
      info?.primary_info?.title?.text ||
      "YouTube Video";

  const thumbs =
      info?.basic_info?.thumbnail ||
      info?.video_details?.thumbnail?.thumbnails ||
      info?.thumbnail?.thumbnails ||
      [];

  const cover = Array.isArray(thumbs) && thumbs.length ? thumbs[thumbs.length - 1].url : null;

  const duration =
      info?.basic_info?.duration ||
      info?.video_details?.lengthSeconds ||
      info?.duration ||
      null;

  const rawFormats = getStreamingFormatsFromInfo(info);
  if (!rawFormats.length) throw new Error("No formats returned by youtubei.js");

  // Correct player object: yt.session.player (NOT info.actions.session.player)
  const player = yt?.session?.player || null;

  const items = [];

  // decipher sequentially (safe + predictable)
  for (const f of rawFormats) {
    const directUrl = await decipherFormatUrl(f, player);
    if (!directUrl) continue;

    const mime = f.mime_type || f.mimeType || "";
    const qualityLabel =
        f.quality_label ||
        f.qualityLabel ||
        (f.has_audio && !f.has_video ? "audio" : f.has_video ? "video" : "unknown");

    const hasAudio = typeof f.has_audio === "boolean" ? f.has_audio : /audio\//i.test(mime);
    const hasVideo = typeof f.has_video === "boolean" ? f.has_video : /video\//i.test(mime);

    items.push({
      url: directUrl,
      label: qualityLabel,
      type: mime,
      ext: getExtensionFromType(mime),
      filesize: f.content_length || f.contentLength || "unknown",
      has_audio: hasAudio,
      has_video: hasVideo,
      bitrate: f.bitrate,
      fps: f.fps,
    });
  }

  if (!items.length) throw new Error("All formats failed to decipher or had no direct URL");

  return { title, cover, duration, items };
}

/**
 * Fetches YouTube video data with automatic fallback
 */
async function fetchYouTubeData(url) {
  const originalUrl = url;
  const normalizedUrl = normalizeYouTubeUrl(url);

  console.log(`🔍 Fetching YouTube data for: ${normalizedUrl}`);

  // 1) First try youtubei.js (preferred)
  try {
    console.log("🔄 Attempting to fetch via youtubei.js (InnerTube)...");
    const ytjs = await fetchWithYouTubeJs(normalizedUrl);
    console.log("✅ Successfully fetched via youtubei.js");
    return processYouTubeData(ytjs, originalUrl);
  } catch (e) {
    console.warn(`⚠️ youtubei.js failed, falling back to VidFly: ${e.message}`);
  }

  // 2) VidFly fallback (with retries)
  let attempts = 0;
  const maxAttempts = 3;
  let lastError = null;

  while (attempts < maxAttempts) {
    attempts++;
    try {
      console.log(`🔄 Attempt ${attempts}/${maxAttempts} via VidFly API...`);
      return await fetchWithVidFlyApi(normalizedUrl, attempts, originalUrl);
    } catch (err) {
      lastError = err;
      console.error(`❌ Attempt ${attempts}/${maxAttempts} failed: ${err.message}`);
      if (attempts < maxAttempts) {
        const backoffMs = Math.min(1200 * Math.pow(2, attempts - 1), 12000);
        console.log(`⏱️ Retrying in ${backoffMs / 1000} seconds...`);
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
  }

  throw new Error(`YouTube download failed after ${maxAttempts} attempts: ${lastError?.message || "unknown error"}`);
}

/**
 * Primary fallback using vidfly.ai
 */
async function fetchWithVidFlyApi(url, attemptNum, originalUrl) {
  try {
    // Normalize Shorts to watch for VidFly (many 3rd-party APIs fail on /shorts/)
    const id = extractYouTubeId(url);
    const vidflyUrl =
        isShortsUrl(url) && id ? `https://www.youtube.com/watch?v=${id}` : url;

    const timeout = 70000 + (attemptNum - 1) * 25000;

    const res = await axios.get("https://api.vidfly.ai/api/media/youtube/download", {
      params: { url: vidflyUrl },
      headers: {
        accept: "*/*",
        "content-type": "application/json",
        "x-app-name": "vidfly-web",
        "x-app-version": "1.0.0",
        Referer: "https://vidfly.ai/",
        "User-Agent": getRandomUserAgent(),
      },
      timeout,
    });

    // Some VidFly errors look like: { code: 9999, info: "Unknown error..." }
    if (res.data && typeof res.data === "object" && res.data.code && res.data.code !== 0) {
      throw new Error(`VidFly error code=${res.data.code}: ${res.data.info || "unknown"}`);
    }

    const data = res.data?.data;

    if (!data || !Array.isArray(data.items) || !data.title) {
      const peek =
          typeof res.data === "string"
              ? res.data.slice(0, 220)
              : JSON.stringify(res.data).slice(0, 220);
      throw new Error(`Invalid VidFly response. Peek: ${peek}`);
    }

    return processYouTubeData(data, originalUrl);
  } catch (err) {
    console.error(`❌ YouTube API error on attempt ${attemptNum}:`, err.message);

    if (err.response) {
      console.error(`📡 Response status: ${err.response.status}`);
      if (err.response.data) {
        console.error(
            `📡 Response data:`,
            typeof err.response.data === "object"
                ? JSON.stringify(err.response.data).substring(0, 220) + "..."
                : String(err.response.data).substring(0, 220) + "..."
        );
      }
    }

    throw new Error(`YouTube downloader API request failed: ${err.message}`);
  }
}

/**
 * Build merge token with safe delimiter
 */
function buildMergeToken(videoUrl, audioUrl) {
  return `MERGE::${encodeURIComponent(videoUrl)}::${encodeURIComponent(audioUrl)}`;
}

/**
 * Process YouTube data with automatic audio merging
 */
function processYouTubeData(data, originalUrlForFlags) {
  const shorts = isShortsUrl(originalUrlForFlags);
  console.log(
      `📊 YouTube: Found ${data.items.length} total formats (${shorts ? "SHORTS" : "REGULAR"})`
  );

  // Keep formats that have a URL
  let availableFormats = data.items.filter((item) => item.url && item.url.length > 0);
  console.log(`✅ Found ${availableFormats.length} total formats with URLs`);

  // Prefer real flags when present; fallback to label/type heuristics
  const formatWithAudioInfo = availableFormats.map((item) => {
    const label = (item.label || "").toLowerCase();
    const type = (item.type || "").toLowerCase();

    const hasAudioFlag =
        typeof item.has_audio === "boolean" ? item.has_audio : undefined;
    const hasVideoFlag =
        typeof item.has_video === "boolean" ? item.has_video : undefined;

    const isAudioOnly =
        hasVideoFlag === false && hasAudioFlag === true
            ? true
            : label.includes("audio only") || (type.includes("audio") && !type.includes("video"));

    const isVideoOnly =
        hasAudioFlag === false && hasVideoFlag === true
            ? true
            : label.includes("video only") ||
            label.includes("without audio") ||
            (type.includes("video") && !type.includes("audio") && label.includes("p"));

    const hasAudio =
        typeof hasAudioFlag === "boolean"
            ? hasAudioFlag
            : !isVideoOnly && !isAudioOnly;

    return {
      ...item,
      hasAudio,
      isVideoOnly,
      isAudioOnly,
    };
  });

  availableFormats = formatWithAudioInfo;

  // Deduplicate video qualities + separate audio formats
  const seenVideoQualities = new Map();
  const deduplicatedFormats = [];
  const audioFormats = [];

  availableFormats.forEach((format) => {
    if (format.isAudioOnly) {
      audioFormats.push(format);
      deduplicatedFormats.push(format);
      return;
    }

    const qualityNum = extractQualityNumber(format.label || "");
    if (qualityNum === 0) {
      deduplicatedFormats.push(format);
      return;
    }

    if (!seenVideoQualities.has(qualityNum)) {
      seenVideoQualities.set(qualityNum, format);
      deduplicatedFormats.push(format);
    } else {
      const existing = seenVideoQualities.get(qualityNum);

      // prefer a version that already has audio
      if (existing && !existing.hasAudio && format.hasAudio) {
        const idx = deduplicatedFormats.findIndex(
            (f) => !f.isAudioOnly && extractQualityNumber(f.label || "") === qualityNum
        );
        if (idx !== -1) {
          deduplicatedFormats[idx] = format;
          seenVideoQualities.set(qualityNum, format);
        }
      }
    }
  });

  availableFormats = deduplicatedFormats;

  console.log(
      `🔄 After deduplication: ${availableFormats.length} formats (${audioFormats.length} audio-only)`
  );

  // Auto merge token for video-only formats
  const mergedFormats = [];

  availableFormats.forEach((format) => {
    if (format.isVideoOnly && audioFormats.length > 0) {
      const compatibleAudio = audioMergerService.findCompatibleAudio(format, audioFormats);

      if (compatibleAudio) {
        console.log(`🎵 Found audio for ${format.label}: ${compatibleAudio.label}`);

        mergedFormats.push({
          ...format,
          url: buildMergeToken(format.url, compatibleAudio.url),
          hasAudio: true,
          isVideoOnly: false,
          isMergedFormat: true,
          originalVideoUrl: format.url,
          audioUrl: compatibleAudio.url,
          audioQuality: compatibleAudio.label,
        });

        console.log(`✅ Created merged format: ${format.label} + ${compatibleAudio.label}`);
      } else {
        mergedFormats.push(format);
      }
    } else {
      mergedFormats.push(format);
    }
  });

  availableFormats = mergedFormats;

  // Build quality options
  const qualityOptions = availableFormats.map((format) => {
    const quality = format.label || "unknown";
    const qualityNum = extractQualityNumber(quality);

    const isPremium = !format.isAudioOnly && qualityNum > 360;

    return {
      quality,
      qualityNum,
      url: format.url,
      type: format.type || "video/mp4",
      extension: format.ext || format.extension || getExtensionFromType(format.type),
      filesize: format.filesize || "unknown",
      isPremium,
      hasAudio: !!format.hasAudio,
      isVideoOnly: !!format.isVideoOnly,
      isAudioOnly: !!format.isAudioOnly,
      isMergedFormat: !!format.isMergedFormat,
      originalVideoUrl: format.originalVideoUrl,
      audioUrl: format.audioUrl,
    };
  });

  // Sort: videos by quality asc, audio-only last
  qualityOptions.sort((a, b) => {
    if (a.isAudioOnly && !b.isAudioOnly) return 1;
    if (!a.isAudioOnly && b.isAudioOnly) return -1;
    return a.qualityNum - b.qualityNum;
  });

  // Default: 360p if exists, else first video, else first
  const selectedFormat =
      qualityOptions.find((o) => !o.isAudioOnly && o.qualityNum === 360) ||
      qualityOptions.find((o) => !o.isAudioOnly) ||
      qualityOptions[0];

  const result = {
    title: data.title,
    thumbnail: data.cover,
    duration: data.duration,
    isShorts: shorts,
    formats: qualityOptions,
    allFormats: qualityOptions,
    url: selectedFormat.url,
    selectedQuality: selectedFormat,
    audioGuaranteed: selectedFormat.hasAudio,
  };

  console.log(`✅ YouTube service completed with ${qualityOptions.length} quality options`);
  return result;
}

/**
 * Extract quality number from label
 */
function extractQualityNumber(qualityLabel) {
  if (!qualityLabel) return 0;

  const match = qualityLabel.match(/(\d+)p/);
  if (match) return parseInt(match[1], 10);

  const q = qualityLabel.toLowerCase();
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

function getExtensionFromType(mimeType) {
  if (!mimeType) return "mp4";

  const m = mimeType.toLowerCase();

  if (m.includes("video/mp4")) return "mp4";
  if (m.includes("video/webm")) return "webm";
  if (m.includes("video/x-flv")) return "flv";
  if (m.includes("audio/mp4")) return "m4a";
  if (m.includes("audio/mpeg")) return "mp3";
  if (m.includes("audio/webm")) return "webm";
  if (m.includes("audio/ogg")) return "ogg";

  return "mp4";
}

function getRandomUserAgent() {
  const userAgents = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  ];
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

module.exports = { fetchYouTubeData };
