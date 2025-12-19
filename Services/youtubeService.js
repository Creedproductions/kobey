// youtubeService.js (CommonJS)
const axios = require("axios");
const audioMergerService = require("./audioMergerService");

// ---------------------------
// youtubei.js (Innertube)
// ---------------------------
let _innertube = null;

async function getInnertube() {
  if (_innertube) return _innertube;

  const mod = await import("youtubei.js");
  const { Innertube, UniversalCache, Log } = mod;

  // Silence noisy parser logs (TicketShelf/TicketEvent spam)
  try {
    Log.setLevel(Log.Level.NONE);
  } catch (_) {}

  // Optional: provide cookies / visitor_data / po_token if you have them
  // (helps if YouTube starts requiring PO tokens / harsher bot checks)
  // :contentReference[oaicite:2]{index=2}
  const cookie = process.env.YT_COOKIE;
  const visitor_data = process.env.YT_VISITOR_DATA;
  const po_token = process.env.YT_PO_TOKEN;

  _innertube = await Innertube.create({
    lang: "en",
    location: "US",
    user_agent: getRandomUserAgent(),
    retrieve_player: true,
    enable_session_cache: true,
    cache: new UniversalCache(true),
    generate_session_locally: true,

    ...(cookie ? { cookie } : {}),
    ...(visitor_data ? { visitor_data } : {}),
    ...(po_token ? { po_token } : {}),
  });

  return _innertube;
}

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

function isShortsUrl(url) {
  return typeof url === "string" && url.includes("/shorts/");
}

/**
 * FIX: prevents "www.www.youtube.com"
 */
function normalizeYouTubeUrl(input) {
  if (!input) return input;

  // youtu.be -> watch
  if (input.includes("youtu.be/")) {
    const videoId = input.split("youtu.be/")[1].split("?")[0].split("&")[0];
    return `https://www.youtube.com/watch?v=${videoId}`;
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

/**
 * Primary: fetch via youtubei.js using getBasicInfo + streaming_data + decipher
 * This avoids the getInfo() watch-next parser surfaces that spam TicketShelf, etc.
 * :contentReference[oaicite:3]{index=3}
 */
async function fetchWithYouTubeJs(url) {
  const yt = await getInnertube();
  const id = extractYouTubeId(url);
  if (!id) throw new Error("Could not extract YouTube video id");

  const clientsToTry = ["ANDROID", "WEB", "TV_EMBEDDED"];

  let info = null;
  let lastErr = null;

  for (const client of clientsToTry) {
    try {
      // v16 supports passing options object
      info = await yt.getBasicInfo(id, { client });

      const sd = info?.streaming_data;
      const formats = [
        ...(sd?.formats || []),
        ...(sd?.adaptive_formats || [])
      ];

      if (formats.length) break;

      info = null;
      lastErr = new Error(`No streaming formats for client=${client}`);
    } catch (e) {
      info = null;
      lastErr = e;
    }
  }

  if (!info) {
    throw new Error(`youtubei.js getBasicInfo failed: ${lastErr?.message || "unknown error"}`);
  }

  const title =
      info?.basic_info?.title ||
      info?.video_details?.title ||
      "YouTube Video";

  const thumbs =
      info?.basic_info?.thumbnail ||
      info?.video_details?.thumbnail?.thumbnails ||
      [];
  const cover = Array.isArray(thumbs) && thumbs.length ? thumbs[thumbs.length - 1].url : null;

  const duration =
      info?.basic_info?.duration ||
      info?.video_details?.lengthSeconds ||
      null;

  const sd = info?.streaming_data;
  const rawFormats = [
    ...(sd?.formats || []),
    ...(sd?.adaptive_formats || [])
  ];

  if (!rawFormats.length) throw new Error("No formats in streaming_data");

  const player = yt?.session?.player;
  if (!player) throw new Error("No player available (retrieve_player must be true)");

  // Build items by deciphering each format
  const items = [];
  const seen = new Set();

  for (const f of rawFormats) {
    try {
      // recommended decipher path :contentReference[oaicite:4]{index=4}
      const directUrl = await f.decipher(player);
      if (!directUrl) continue;

      const mime = f.mime_type || f.mimeType || "";
      const label = f.quality_label || f.qualityLabel || (f.has_audio && !f.has_video ? "audio" : "unknown");

      const key = `${f.itag || ""}::${label}::${mime}`;
      if (seen.has(key)) continue;
      seen.add(key);

      items.push({
        url: directUrl,
        label,
        type: mime,
        ext: getExtensionFromType(mime),
        filesize: f.content_length || f.contentLength || "unknown",
        has_audio: !!f.has_audio,
        has_video: !!f.has_video,
        itag: f.itag,
        bitrate: f.bitrate,
        fps: f.fps
      });
    } catch (_) {
      // skip formats that fail to decipher
    }
  }

  if (!items.length) {
    throw new Error("All formats failed to decipher (items=0)");
  }

  return { title, cover, duration, items };
}

/**
 * Fetches YouTube video data with automatic fallback
 */
async function fetchYouTubeData(url) {
  const normalizedUrl = normalizeYouTubeUrl(url);
  console.log(`🔍 Fetching YouTube data for: ${normalizedUrl}`);

  // 1) youtubei.js first
  try {
    console.log("🔄 Attempting to fetch via youtubei.js (getBasicInfo + decipher)...");
    const ytjs = await fetchWithYouTubeJs(normalizedUrl);
    console.log("✅ Successfully fetched via youtubei.js");
    return processYouTubeData(ytjs, url);
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
      return await fetchWithVidFlyApi(normalizedUrl, attempts, url);
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
 * VidFly fallback (kept)
 */
async function fetchWithVidFlyApi(url, attemptNum, originalUrl) {
  try {
    // Some 3rd-party APIs behave better with watch URLs than shorts URLs
    const id = extractYouTubeId(url);
    const vidflyUrl = isShortsUrl(url) && id ? `https://www.youtube.com/watch?v=${id}` : url;

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

    if (res.data && typeof res.data === "object" && res.data.code && res.data.code !== 0) {
      throw new Error(`VidFly error code=${res.data.code}: ${res.data.info || "unknown"}`);
    }

    const data = res.data?.data;
    if (!data || !Array.isArray(data.items) || !data.title) {
      const peek = typeof res.data === "string"
          ? res.data.slice(0, 220)
          : JSON.stringify(res.data).slice(0, 220);
      throw new Error(`Invalid VidFly response. Peek: ${peek}`);
    }

    return processYouTubeData(data, originalUrl);
  } catch (err) {
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
 * Your existing processing logic (kept)
 */
function processYouTubeData(data, url) {
  const isShorts = url.includes("/shorts/");
  console.log(`📊 YouTube: Found ${data.items.length} total formats (${isShorts ? "SHORTS" : "REGULAR"})`);

  let availableFormats = data.items.filter(item => item.url && item.url.length > 0);
  console.log(`✅ Found ${availableFormats.length} total formats with URLs`);

  const formatWithAudioInfo = availableFormats.map(item => {
    const label = (item.label || "").toLowerCase();
    const type = (item.type || "").toLowerCase();

    const hasAudioFlag = typeof item.has_audio === "boolean" ? item.has_audio : undefined;
    const hasVideoFlag = typeof item.has_video === "boolean" ? item.has_video : undefined;

    const isVideoOnly =
        hasAudioFlag === false && hasVideoFlag === true
            ? true
            : label.includes("video only") ||
            label.includes("vid only") ||
            label.includes("without audio") ||
            type.includes("video only");

    const isAudioOnly =
        hasVideoFlag === false && hasAudioFlag === true
            ? true
            : label.includes("audio only") ||
            type.includes("audio only") ||
            (label.includes("audio") && !label.includes("video"));

    return {
      ...item,
      hasAudio: typeof hasAudioFlag === "boolean" ? hasAudioFlag : (!isVideoOnly && !isAudioOnly),
      isVideoOnly,
      isAudioOnly
    };
  });

  availableFormats = formatWithAudioInfo;

  const seenVideoQualities = new Map();
  const deduplicatedFormats = [];
  const audioFormats = [];

  availableFormats.forEach(format => {
    if (format.isAudioOnly) {
      audioFormats.push(format);
      deduplicatedFormats.push(format);
    } else {
      const qualityNum = extractQualityNumber(format.label || "");
      if (qualityNum === 0) {
        deduplicatedFormats.push(format);
        return;
      }
      if (!seenVideoQualities.has(qualityNum)) {
        seenVideoQualities.set(qualityNum, format);
        deduplicatedFormats.push(format);
      } else {
        const existingFormat = seenVideoQualities.get(qualityNum);
        if (!existingFormat.hasAudio && format.hasAudio) {
          const index = deduplicatedFormats.findIndex(f =>
              !f.isAudioOnly && extractQualityNumber(f.label || "") === qualityNum
          );
          if (index !== -1) {
            deduplicatedFormats[index] = format;
            seenVideoQualities.set(qualityNum, format);
          }
        }
      }
    }
  });

  availableFormats = deduplicatedFormats;

  const mergedFormats = [];

  availableFormats.forEach(format => {
    if (format.isVideoOnly && audioFormats.length > 0) {
      const compatibleAudio = audioMergerService.findCompatibleAudio(format, audioFormats);
      if (compatibleAudio) {
        mergedFormats.push({
          ...format,
          url: buildMergeToken(format.url, compatibleAudio.url),
          hasAudio: true,
          isVideoOnly: false,
          isMergedFormat: true,
          originalVideoUrl: format.url,
          audioUrl: compatibleAudio.url,
          audioQuality: compatibleAudio.label
        });
      } else {
        mergedFormats.push(format);
      }
    } else {
      mergedFormats.push(format);
    }
  });

  availableFormats = mergedFormats;

  const qualityOptions = availableFormats.map(format => {
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
      hasAudio: format.hasAudio,
      isVideoOnly: format.isVideoOnly,
      isAudioOnly: format.isAudioOnly,
      isMergedFormat: format.isMergedFormat || false,
      originalVideoUrl: format.originalVideoUrl,
      audioUrl: format.audioUrl
    };
  });

  qualityOptions.sort((a, b) => {
    if (a.isAudioOnly && !b.isAudioOnly) return 1;
    if (!a.isAudioOnly && b.isAudioOnly) return -1;
    return a.qualityNum - b.qualityNum;
  });

  const selectedFormat =
      qualityOptions.find(opt => !opt.isAudioOnly && opt.qualityNum === 360) ||
      qualityOptions.find(opt => !opt.isAudioOnly) ||
      qualityOptions[0];

  return {
    title: data.title,
    thumbnail: data.cover,
    duration: data.duration,
    isShorts,
    formats: qualityOptions,
    allFormats: qualityOptions,
    url: selectedFormat.url,
    selectedQuality: selectedFormat,
    audioGuaranteed: selectedFormat.hasAudio
  };
}

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

  const typeMap = {
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/x-flv": "flv",
    "audio/mp4": "m4a",
    "audio/mpeg": "mp3",
    "audio/webm": "webm",
    "audio/ogg": "ogg"
  };

  for (const [type, ext] of Object.entries(typeMap)) {
    if (String(mimeType).includes(type)) return ext;
  }

  return "mp4";
}

function getRandomUserAgent() {
  const userAgents = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
  ];

  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

module.exports = { fetchYouTubeData };
