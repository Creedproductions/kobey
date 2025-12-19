// youtubeService.js (CommonJS)
const axios = require("axios");
const audioMergerService = require("./audioMergerService");

// ---------------------------
// youtubei.js (Innertube)
// ---------------------------
let _innertube = null;

async function getInnertube() {
  if (_innertube) return _innertube;

  const mod = await import("youtubei.js"); // works from CommonJS in your setup
  const { Innertube, UniversalCache, Log } = mod;

  // Mute noisy parser logs (TicketShelf/TicketEvent spam)
  try {
    Log.setLevel(Log.Level.NONE);
  } catch (_) {}

  _innertube = await Innertube.create({
    lang: "en",
    location: "US",
    user_agent: getRandomUserAgent(),
    retrieve_player: true, // needed for decipher in general
    enable_session_cache: true,
    cache: new UniversalCache(true),
    // generate_session_locally can improve stability on some hosts
    generate_session_locally: true,
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

/**
 * IMPORTANT FIX: no more "www.www.youtube.com"
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
    if (u.hostname === "m.youtube.com" || u.hostname === "youtube.com") {
      u.hostname = "www.youtube.com";
    }
    // Keep shorts path if provided
    return u.toString();
  } catch (_) {
    // fallback: very conservative replace
    return input.replace("m.youtube.com", "www.youtube.com");
  }
}

// Simple concurrency limiter (so you don’t stall / timeout)
async function mapLimit(list, limit, fn) {
  const ret = [];
  let i = 0;

  const workers = Array.from({ length: Math.max(1, limit) }, async () => {
    while (i < list.length) {
      const idx = i++;
      ret[idx] = await fn(list[idx], idx);
    }
  });

  await Promise.all(workers);
  return ret;
}

function safeQualityLabel(q) {
  return typeof q === "number" ? `${q}p` : String(q || "");
}

/**
 * Build an "items" list using getStreamingData() (deciphered direct URLs)
 * This avoids getInfo() parser issues. :contentReference[oaicite:2]{index=2}
 */
async function fetchWithYouTubeJs(url) {
  const yt = await getInnertube();
  const id = extractYouTubeId(url);
  if (!id) throw new Error("Could not extract YouTube video id");

  // 1) metadata (try basic info, but don't fail the whole download if it breaks)
  let title = "YouTube Video";
  let cover = null;
  let duration = null;

  try {
    // getBasicInfo exists and is lighter than getInfo (less parser surface)
    // second param is an object on newer versions (you’re on 16.0.1)
    const info = await yt.getBasicInfo(id, { client: "ANDROID" });
    title =
        info?.basic_info?.title ||
        info?.video_details?.title ||
        title;

    const thumbs =
        info?.basic_info?.thumbnail ||
        info?.video_details?.thumbnail?.thumbnails ||
        [];
    cover = Array.isArray(thumbs) && thumbs.length ? thumbs[thumbs.length - 1].url : null;

    duration =
        info?.basic_info?.duration ||
        info?.video_details?.lengthSeconds ||
        null;
  } catch (_) {
    // ignore
  }

  // 2) formats via getStreamingData()
  const client = "ANDROID";
  const wantedQualities = [144, 240, 360, 480, 720, 1080, 1440, 2160];

  // Audio candidates (mp4a + opus)
  const audioRequests = [
    { type: "audio", quality: "best", format: "mp4", codec: "mp4a" },
    { type: "audio", quality: "best", format: "webm", codec: "opus" },
  ];

  const audioFormats = (await mapLimit(audioRequests, 2, async (opt) => {
    try {
      const f = await yt.getStreamingData(id, { client, ...opt });
      return f || null;
    } catch (_) {
      return null;
    }
  })).filter(Boolean);

  // Video requests:
  // - For <=360p, try video+audio mp4 first (if available)
  // - Otherwise get video-only (mp4 first, then webm)
  const videoRequests = [];

  for (const q of wantedQualities) {
    const qLabel = safeQualityLabel(q);

    if (q <= 360) {
      videoRequests.push({ quality: qLabel, type: "video+audio", format: "mp4" });
    }

    videoRequests.push({ quality: qLabel, type: "video", format: "mp4" });
    videoRequests.push({ quality: qLabel, type: "video", format: "webm" });
  }

  const videoFormats = (await mapLimit(videoRequests, 3, async (opt) => {
    try {
      const f = await yt.getStreamingData(id, { client, ...opt });
      return f || null;
    } catch (_) {
      return null;
    }
  })).filter(Boolean);

  // Deduplicate by itag/url
  const seen = new Set();
  const items = [];

  function pushFormat(f, fallbackLabel, forceKind) {
    if (!f) return;

    const directUrl = f.url;
    if (!directUrl || typeof directUrl !== "string") return;

    const itag = f.itag ?? "";
    const key = `${itag}::${directUrl.slice(0, 80)}`;
    if (seen.has(key)) return;
    seen.add(key);

    const mime = f.mime_type || f.mimeType || "";
    const hasVideo = /video\//i.test(mime);
    const hasAudio = /audio\//i.test(mime) || (!hasVideo && forceKind === "audio");

    const qualityLabel =
        f.quality_label ||
        f.qualityLabel ||
        (hasVideo ? fallbackLabel : "audio");

    items.push({
      url: directUrl,
      label: qualityLabel,
      type: mime || (hasVideo ? "video/mp4" : "audio/mp4"),
      ext: getExtensionFromType(mime),
      filesize: f.content_length || f.contentLength || "unknown",
      has_audio: !!hasAudio,
      has_video: !!hasVideo,
      itag: f.itag,
      bitrate: f.bitrate,
      fps: f.fps,
    });
  }

  // Add video first, then audio
  for (const vf of videoFormats) {
    const q = vf.quality_label || vf.qualityLabel || "video";
    pushFormat(vf, q, "video");
  }
  for (const af of audioFormats) {
    const label = af.bitrate ? `audio (${Math.round(af.bitrate / 1000)}kbps)` : "audio";
    pushFormat(af, label, "audio");
  }

  if (!items.length) throw new Error("No formats returned by getStreamingData()");

  return { title, cover, duration, items };
}

/**
 * Public API
 */
async function fetchYouTubeData(url) {
  const normalizedUrl = normalizeYouTubeUrl(url);
  console.log(`🔍 Fetching YouTube data for: ${normalizedUrl}`);

  // 1) youtubei.js first
  try {
    console.log("🔄 Attempting to fetch via youtubei.js (InnerTube getStreamingData)...");
    const ytjs = await fetchWithYouTubeJs(normalizedUrl);
    console.log("✅ Successfully fetched via youtubei.js");
    return processYouTubeData(ytjs, url);
  } catch (e) {
    console.warn(`⚠️ youtubei.js failed, falling back to VidFly: ${e.message}`);
  }

  // 2) VidFly fallback (same as you had, but fix shorts->watch and keep sane URL)
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
 * VidFly fallback
 */
async function fetchWithVidFlyApi(url, attemptNum, originalUrl) {
  try {
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
 * Process YouTube data with your existing merge/dedupe logic (kept)
 */
function processYouTubeData(data, url) {
  const isShorts = url.includes("/shorts/");
  console.log(`📊 YouTube: Found ${data.items.length} total formats (${isShorts ? "SHORTS" : "REGULAR"})`);

  let availableFormats = data.items.filter((item) => item.url && item.url.length > 0);
  console.log(`✅ Found ${availableFormats.length} total formats with URLs`);

  const formatWithAudioInfo = availableFormats.map((item) => {
    const label = (item.label || "").toLowerCase();
    const type = (item.type || "").toLowerCase();

    const hasAudioFlag = typeof item.has_audio === "boolean" ? item.has_audio : undefined;
    const hasVideoFlag = typeof item.has_video === "boolean" ? item.has_video : undefined;

    const isAudioOnly =
        hasVideoFlag === false && hasAudioFlag === true
            ? true
            : label.includes("audio only") || (type.includes("audio") && !type.includes("video"));

    const isVideoOnly =
        hasAudioFlag === false && hasVideoFlag === true
            ? true
            : label.includes("video only") || label.includes("without audio");

    const hasAudio =
        typeof hasAudioFlag === "boolean" ? hasAudioFlag : !isVideoOnly && !isAudioOnly;

    return { ...item, hasAudio, isVideoOnly, isAudioOnly };
  });

  availableFormats = formatWithAudioInfo;

  const seenVideoQualities = new Map();
  const deduplicatedFormats = [];
  const audioFormats = [];

  availableFormats.forEach((format) => {
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
          const index = deduplicatedFormats.findIndex(
              (f) => !f.isAudioOnly && extractQualityNumber(f.label || "") === qualityNum
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

  console.log(`🔄 After deduplication: ${availableFormats.length} formats (${audioFormats.length} audio-only)`);

  const mergedFormats = [];

  availableFormats.forEach((format) => {
    if (format.isVideoOnly && audioFormats.length > 0) {
      const compatibleAudio = audioMergerService.findCompatibleAudio(format, audioFormats);
      if (compatibleAudio) {
        const mergedFormat = {
          ...format,
          url: buildMergeToken(format.url, compatibleAudio.url),
          hasAudio: true,
          isVideoOnly: false,
          isMergedFormat: true,
          originalVideoUrl: format.url,
          audioUrl: compatibleAudio.url,
          audioQuality: compatibleAudio.label,
        };
        mergedFormats.push(mergedFormat);
      } else {
        mergedFormats.push(format);
      }
    } else {
      mergedFormats.push(format);
    }
  });

  availableFormats = mergedFormats;

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
      hasAudio: format.hasAudio,
      isVideoOnly: format.isVideoOnly,
      isAudioOnly: format.isAudioOnly,
      isMergedFormat: format.isMergedFormat || false,
      originalVideoUrl: format.originalVideoUrl,
      audioUrl: format.audioUrl,
    };
  });

  qualityOptions.sort((a, b) => {
    if (a.isAudioOnly && !b.isAudioOnly) return 1;
    if (!a.isAudioOnly && b.isAudioOnly) return -1;
    return a.qualityNum - b.qualityNum;
  });

  const selectedFormat =
      qualityOptions.find((opt) => !opt.isAudioOnly && opt.qualityNum === 360) ||
      qualityOptions.find((opt) => !opt.isAudioOnly) ||
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
    audioGuaranteed: selectedFormat.hasAudio,
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
  const m = String(mimeType).toLowerCase();

  if (m.includes("video/mp4")) return "mp4";
  if (m.includes("video/webm")) return "webm";
  if (m.includes("audio/mp4")) return "m4a";
  if (m.includes("audio/webm")) return "webm";
  if (m.includes("audio/mpeg")) return "mp3";
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
