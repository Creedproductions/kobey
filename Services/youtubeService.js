const axios = require("axios");
const audioMergerService = require("./audioMergerService");

// ---------------------------
// youtubei.js configuration
// ---------------------------
let _innertube = null;

async function getInnertube() {
  if (_innertube) return _innertube;

  try {
    const mod = await import("youtubei.js");
    _innertube = await mod.Innertube.create({
      lang: "en",
      location: "US",
      retrieve_player: true,
      generate_session_locally: true,
      player: true,
      user_agent: getRandomUserAgent()
    });
    return _innertube;
  } catch (error) {
    console.error("❌ Failed to initialize youtubei.js:", error.message);
    throw error;
  }
}

function extractYouTubeId(url) {
  try {
    // Remove tracking parameters and normalize
    const cleanUrl = url.split('?')[0];

    // watch?v=
    const vMatch = cleanUrl.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
    if (vMatch) return vMatch[1];

    // youtu.be/
    const shortMatch = cleanUrl.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
    if (shortMatch) return shortMatch[1];

    // shorts/
    const shortsMatch = cleanUrl.match(/shorts\/([a-zA-Z0-9_-]{11})/);
    if (shortsMatch) return shortsMatch[1];

    // embed/
    const embedMatch = cleanUrl.match(/embed\/([a-zA-Z0-9_-]{11})/);
    if (embedMatch) return embedMatch[1];

    return null;
  } catch (error) {
    console.error("❌ Error extracting YouTube ID:", error);
    return null;
  }
}

// ---------------------------
// Primary: yt-dlp style API with multiple fallbacks
// ---------------------------
async function fetchWithYTDLPStyle(url) {
  const videoId = extractYouTubeId(url);
  if (!videoId) throw new Error("Could not extract video ID");

  console.log(`🔄 Using yt-dlp style API for video ID: ${videoId}`);

  // Try multiple API endpoints
  const apiEndpoints = [
    {
      name: "Invidious (yewtu.be)",
      url: `https://yewtu.be/latest_version?id=${videoId}&itag=0&local=true`,
      parser: parseInvidiousResponse
    },
    {
      name: "Piped API",
      url: `https://pipedapi.kavin.rocks/streams/${videoId}`,
      parser: parsePipedResponse
    },
    {
      name: "Piped (backup)",
      url: `https://pipedapi.moomoo.me/streams/${videoId}`,
      parser: parsePipedResponse
    },
    {
      name: "Invidious (vid.puffyan.us)",
      url: `https://vid.puffyan.us/api/v1/videos/${videoId}`,
      parser: parseInvidiousAPIResponse
    }
  ];

  for (const endpoint of apiEndpoints) {
    try {
      console.log(`🔄 Trying ${endpoint.name}...`);

      const response = await axios.get(endpoint.url, {
        timeout: 15000,
        headers: {
          'User-Agent': getRandomUserAgent(),
          'Accept': 'application/json',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': 'https://www.youtube.com/',
          'Origin': 'https://www.youtube.com'
        }
      });

      if (response.data) {
        const parsed = endpoint.parser(response.data);
        if (parsed && parsed.items && parsed.items.length > 0) {
          console.log(`✅ ${endpoint.name} found ${parsed.items.length} formats`);
          return parsed;
        }
      }
    } catch (error) {
      console.log(`⚠️ ${endpoint.name} failed: ${error.message}`);
      continue;
    }
  }

  throw new Error("All yt-dlp style APIs failed");
}

// Parser functions for different APIs
function parseInvidiousResponse(data) {
  // Simple direct format (used by some invidious instances)
  if (data && data.url) {
    return {
      title: data.title || "YouTube Video",
      cover: data.thumbnail || data.thumbnailUrl,
      duration: data.duration || 0,
      items: [{
        url: data.url,
        label: data.quality || 'unknown',
        type: 'video/mp4',
        ext: 'mp4',
        filesize: 'unknown'
      }]
    };
  }
  return null;
}

function parsePipedResponse(data) {
  if (!data) return null;

  const items = [];

  // Video streams
  if (data.videoStreams && Array.isArray(data.videoStreams)) {
    data.videoStreams.forEach(stream => {
      if (stream.url) {
        items.push({
          url: stream.url,
          label: stream.quality || 'unknown',
          type: stream.mimeType || 'video/mp4',
          ext: getExtensionFromType(stream.mimeType),
          filesize: stream.filesize || 'unknown'
        });
      }
    });
  }

  // Audio streams
  if (data.audioStreams && Array.isArray(data.audioStreams)) {
    data.audioStreams.forEach(stream => {
      if (stream.url) {
        items.push({
          url: stream.url,
          label: stream.quality || 'audio',
          type: stream.mimeType || 'audio/mp4',
          ext: getExtensionFromType(stream.mimeType),
          filesize: stream.filesize || 'unknown'
        });
      }
    });
  }

  return {
    title: data.title || "YouTube Video",
    cover: data.thumbnailUrl || data.thumbnail,
    duration: data.duration || 0,
    items: items
  };
}

function parseInvidiousAPIResponse(data) {
  if (!data) return null;

  const items = [];

  // Format streams
  if (data.formatStreams && Array.isArray(data.formatStreams)) {
    data.formatStreams.forEach(stream => {
      if (stream.url) {
        items.push({
          url: stream.url,
          label: stream.quality || 'unknown',
          type: stream.type || 'video/mp4',
          ext: getExtensionFromType(stream.type),
          filesize: stream.size || 'unknown'
        });
      }
    });
  }

  // Adaptive formats
  if (data.adaptiveFormats && Array.isArray(data.adaptiveFormats)) {
    data.adaptiveFormats.forEach(format => {
      if (format.url) {
        const isAudio = format.type && format.type.includes('audio');
        items.push({
          url: format.url,
          label: isAudio ? 'audio' : (format.quality || 'unknown'),
          type: format.type || 'video/mp4',
          ext: getExtensionFromType(format.type),
          filesize: format.size || 'unknown'
        });
      }
    });
  }

  return {
    title: data.title || "YouTube Video",
    cover: data.videoThumbnails && data.videoThumbnails.length > 0
        ? data.videoThumbnails[data.videoThumbnails.length - 1].url
        : null,
    duration: data.lengthSeconds || 0,
    items: items
  };
}

// ---------------------------
// Simple metadata fetcher (for when we can't get streams)
// ---------------------------
async function fetchVideoMetadata(videoId) {
  try {
    // Try to get basic metadata from oEmbed
    const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;

    const response = await axios.get(oembedUrl, {
      timeout: 10000,
      headers: {
        'User-Agent': getRandomUserAgent()
      }
    });

    if (response.data) {
      return {
        title: response.data.title || "YouTube Video",
        thumbnail: response.data.thumbnail_url || null,
        author: response.data.author_name || null
      };
    }
  } catch (error) {
    console.log("⚠️ oEmbed metadata fetch failed:", error.message);
  }

  // Fallback: try to get from YouTube page directly
  try {
    const response = await axios.get(`https://www.youtube.com/watch?v=${videoId}`, {
      timeout: 10000,
      headers: {
        'User-Agent': getRandomUserAgent()
      }
    });

    const html = response.data;

    // Try to extract title from meta tags
    const titleMatch = html.match(/<meta name="title" content="([^"]+)"/) ||
        html.match(/<title>([^<]+)<\/title>/);

    // Try to extract thumbnail
    const thumbnailMatch = html.match(/<meta property="og:image" content="([^"]+)"/);

    return {
      title: titleMatch ? titleMatch[1].replace(' - YouTube', '') : "YouTube Video",
      thumbnail: thumbnailMatch ? thumbnailMatch[1] : null
    };
  } catch (error) {
    console.log("⚠️ Direct page fetch failed:", error.message);
  }

  return {
    title: "YouTube Video",
    thumbnail: null
  };
}

// ---------------------------
// Main fetch function with multiple strategies
// ---------------------------
async function fetchYouTubeData(url) {
  const normalizedUrl = normalizeYouTubeUrl(url);
  const videoId = extractYouTubeId(normalizedUrl);
  const isShorts = normalizedUrl.includes('/shorts/');

  console.log(`🔍 Fetching YouTube data: ${videoId} ${isShorts ? '(SHORTS)' : ''}`);

  if (!videoId) {
    throw new Error("Invalid YouTube URL");
  }

  // Strategy 1: yt-dlp style APIs (most reliable for public videos)
  try {
    console.log("🔄 Strategy 1: Trying yt-dlp style APIs...");
    const result = await fetchWithYTDLPStyle(normalizedUrl);
    return processYouTubeData(result, normalizedUrl);
  } catch (error) {
    console.log("⚠️ Strategy 1 failed:", error.message);
  }

  // Strategy 2: Alternative services for age-restricted content
  try {
    console.log("🔄 Strategy 2: Trying alternative services...");
    const result = await fetchWithAlternativeServices(videoId);
    return processYouTubeData(result, normalizedUrl);
  } catch (error) {
    console.log("⚠️ Strategy 2 failed:", error.message);
  }

  // Strategy 3: Try to get at least metadata
  try {
    console.log("🔄 Strategy 3: Falling back to metadata only...");
    const metadata = await fetchVideoMetadata(videoId);

    // Return basic info with error message
    return {
      title: metadata.title,
      thumbnail: metadata.thumbnail,
      duration: 0,
      isShorts: isShorts,
      formats: [],
      allFormats: [],
      url: null,
      selectedQuality: null,
      audioGuaranteed: false,
      error: "This video may be age-restricted or unavailable for download",
      metadataOnly: true
    };
  } catch (error) {
    console.log("⚠️ Strategy 3 failed:", error.message);
  }

  throw new Error("Could not fetch YouTube video data");
}

// ---------------------------
// Alternative services for age-restricted content
// ---------------------------
async function fetchWithAlternativeServices(videoId) {
  const services = [
    {
      name: "SaveTube",
      url: `https://www.savetube.io/api/ajaxSearch`,
      method: "POST",
      data: `query=https://www.youtube.com/watch?v=${videoId}`,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': getRandomUserAgent()
      },
      parser: parseSaveTubeResponse
    },
    {
      name: "Y2Mate",
      url: `https://www.y2mate.com/mates/analyzeV2/ajax`,
      method: "POST",
      data: `k_query=https://www.youtube.com/watch?v=${videoId}&k_page=home&hl=en&q_auto=0`,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': getRandomUserAgent(),
        'Origin': 'https://www.y2mate.com',
        'Referer': 'https://www.y2mate.com/'
      },
      parser: parseY2MateResponse
    }
  ];

  for (const service of services) {
    try {
      console.log(`🔄 Trying ${service.name}...`);

      let response;
      if (service.method === "POST") {
        response = await axios.post(service.url, service.data, {
          timeout: 20000,
          headers: service.headers
        });
      } else {
        response = await axios.get(service.url, {
          timeout: 20000,
          headers: service.headers
        });
      }

      if (response.data) {
        const parsed = service.parser(response.data, videoId);
        if (parsed && parsed.items && parsed.items.length > 0) {
          console.log(`✅ ${service.name} found ${parsed.items.length} formats`);
          return parsed;
        }
      }
    } catch (error) {
      console.log(`⚠️ ${service.name} failed: ${error.message}`);
      continue;
    }
  }

  throw new Error("All alternative services failed");
}

function parseSaveTubeResponse(data, videoId) {
  if (!data || !data.links) return null;

  const items = [];
  const title = data.title || "YouTube Video";
  const thumbnail = data.thumbnail || `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;

  // Parse video links
  Object.entries(data.links).forEach(([quality, formats]) => {
    if (formats && formats.mp4 && formats.mp4.url) {
      items.push({
        url: formats.mp4.url,
        label: quality,
        type: 'video/mp4',
        ext: 'mp4',
        filesize: formats.mp4.size || 'unknown'
      });
    }
  });

  return {
    title,
    cover: thumbnail,
    duration: 0,
    items
  };
}

function parseY2MateResponse(data, videoId) {
  if (!data || !data.links) return null;

  const items = [];
  const title = data.title || "YouTube Video";
  const thumbnail = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;

  // Parse video links from Y2Mate response
  if (data.links.mp4) {
    Object.entries(data.links.mp4).forEach(([quality, info]) => {
      if (info && info.url) {
        items.push({
          url: info.url,
          label: quality,
          type: 'video/mp4',
          ext: 'mp4',
          filesize: info.size || 'unknown'
        });
      }
    });
  }

  // Parse audio links
  if (data.links.mp3) {
    Object.entries(data.links.mp3).forEach(([quality, info]) => {
      if (info && info.url) {
        items.push({
          url: info.url,
          label: quality,
          type: 'audio/mp3',
          ext: 'mp3',
          filesize: info.size || 'unknown'
        });
      }
    });
  }

  return {
    title,
    cover: thumbnail,
    duration: 0,
    items
  };
}

// ---------------------------
// Helper functions (keep from previous)
// ---------------------------

function normalizeYouTubeUrl(url) {
  // Remove tracking parameters
  let normalized = url.split('?')[0];

  // Convert youtu.be to youtube.com
  if (normalized.includes('youtu.be/')) {
    const videoId = normalized.split('youtu.be/')[1];
    normalized = `https://www.youtube.com/watch?v=${videoId}`;
  }

  // Ensure www
  normalized = normalized.replace('youtube.com', 'www.youtube.com')
      .replace('m.youtube.com', 'www.youtube.com');

  return normalized;
}

function buildMergeToken(videoUrl, audioUrl) {
  return `MERGE::${encodeURIComponent(videoUrl)}::${encodeURIComponent(audioUrl)}`;
}

function getExtensionFromType(mimeType) {
  if (!mimeType) return 'mp4';

  const typeMap = {
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'audio/mp4': 'm4a',
    'audio/mpeg': 'mp3',
    'audio/webm': 'webm'
  };

  for (const [type, ext] of Object.entries(typeMap)) {
    if (mimeType.includes(type)) return ext;
  }

  return 'mp4';
}

function getRandomUserAgent() {
  const agents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1'
  ];

  return agents[Math.floor(Math.random() * agents.length)];
}

// ---------------------------
// Process YouTube Data (simplified version)
// ---------------------------
function processYouTubeData(data, url) {
  const isShorts = url.includes('/shorts/');

  console.log(`📊 Processing ${data.items.length} formats`);

  if (data.items.length === 0) {
    return {
      title: data.title || "YouTube Video",
      thumbnail: data.cover,
      duration: data.duration || 0,
      isShorts: isShorts,
      formats: [],
      allFormats: [],
      url: null,
      selectedQuality: null,
      audioGuaranteed: false,
      error: "No downloadable formats available"
    };
  }

  // Create quality options
  const qualityOptions = data.items.map(item => {
    const qualityNum = extractQualityNumber(item.label);
    const isAudio = item.label.toLowerCase().includes('audio') ||
        item.type.includes('audio');
    const isPremium = !isAudio && qualityNum > 360;

    return {
      quality: item.label,
      qualityNum: qualityNum,
      url: item.url,
      type: item.type,
      extension: item.ext,
      filesize: item.filesize,
      isPremium: isPremium,
      hasAudio: !isAudio,
      isAudioOnly: isAudio
    };
  });

  // Sort by quality
  qualityOptions.sort((a, b) => {
    if (a.isAudioOnly && !b.isAudioOnly) return 1;
    if (!a.isAudioOnly && b.isAudioOnly) return -1;
    return a.qualityNum - b.qualityNum;
  });

  // Select default (360p or first available)
  const selectedFormat = qualityOptions.find(opt => !opt.isAudioOnly && opt.qualityNum === 360) ||
      qualityOptions.find(opt => !opt.isAudioOnly) ||
      qualityOptions[0];

  return {
    title: data.title,
    thumbnail: data.cover,
    duration: data.duration || 0,
    isShorts: isShorts,
    formats: qualityOptions,
    allFormats: qualityOptions,
    url: selectedFormat ? selectedFormat.url : null,
    selectedQuality: selectedFormat,
    audioGuaranteed: selectedFormat ? selectedFormat.hasAudio : false
  };
}

function extractQualityNumber(qualityLabel) {
  if (!qualityLabel) return 0;

  const match = qualityLabel.match(/(\d+)p/);
  if (match) return parseInt(match[1]);

  if (qualityLabel.includes('1440') || qualityLabel.includes('2k')) return 1440;
  if (qualityLabel.includes('2160') || qualityLabel.includes('4k')) return 2160;
  if (qualityLabel.includes('1080')) return 1080;
  if (qualityLabel.includes('720')) return 720;
  if (qualityLabel.includes('480')) return 480;
  if (qualityLabel.includes('360')) return 360;
  if (qualityLabel.includes('240')) return 240;
  if (qualityLabel.includes('144')) return 144;

  return 0;
}

module.exports = { fetchYouTubeData };