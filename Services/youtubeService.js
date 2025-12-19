const axios = require("axios");
const audioMergerService = require("./audioMergerService");

// ---------------------------
// youtubei.js fallback (InnerTube)
// ---------------------------
let _innertube = null;
let _innertubeAndroid = null;

async function getInnertube(client = 'WEB') {
  if (client === 'WEB' && _innertube) return _innertube;
  if (client === 'ANDROID' && _innertubeAndroid) return _innertubeAndroid;

  const mod = await import("youtubei.js");

  const config = {
    lang: "en",
    location: "US",
    retrieve_player: true
  };

  if (client === 'ANDROID') {
    config.client = 'ANDROID';
    config.device = 'SM-G973F';
    _innertubeAndroid = await mod.Innertube.create(config);
    return _innertubeAndroid;
  } else {
    config.user_agent = getRandomUserAgent();
    _innertube = await mod.Innertube.create(config);
    return _innertube;
  }
}

function extractYouTubeId(url) {
  // watch?v=
  const vMatch = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  if (vMatch) return vMatch[1];

  // youtu.be/
  const shortMatch = url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
  if (shortMatch) return shortMatch[1];

  // shorts/
  const shortsMatch = url.match(/shorts\/([a-zA-Z0-9_-]{11})/);
  if (shortsMatch) return shortsMatch[1];

  return null;
}

async function fetchWithYouTubeJs(url, client = 'WEB') {
  try {
    const yt = await getInnertube(client);
    const id = extractYouTubeId(url);
    if (!id) throw new Error("Could not extract YouTube video id");

    console.log(`🔄 Fetching with youtubei.js (${client}) for ID: ${id}`);

    // Try different methods for different client types
    let info;
    if (client === 'ANDROID') {
      // For Android client, try to get info differently
      const video = yt.getVideo(id);
      info = await video.getInfo();
    } else {
      // For WEB client
      info = await yt.getBasicInfo(id);
    }

    const title = info?.basic_info?.title || info?.video_details?.title || "YouTube Video";
    const thumbs = info?.basic_info?.thumbnail || info?.video_details?.thumbnails || [];
    const cover = thumbs.length ? thumbs[thumbs.length - 1].url : null;
    const duration = info?.basic_info?.duration || info?.video_details?.duration?.seconds || 0;

    let formats = [];
    const sd = info?.streaming_data;

    if (sd) {
      formats = [
        ...(sd?.formats || []),
        ...(sd?.adaptive_formats || [])
      ];
    } else if (info?.streaming_data_formats) {
      formats = info.streaming_data_formats;
    } else if (info?.formats) {
      formats = info.formats;
    }

    if (!formats.length) {
      // Try to extract from download URLs
      if (info?.download) {
        const downloadOptions = info.download();
        if (downloadOptions && downloadOptions.video && downloadOptions.video.length > 0) {
          formats = downloadOptions.video.map(f => ({
            url: f.url,
            label: f.quality_label,
            type: f.mime_type,
            content_length: f.content_length
          }));
        }
      }
    }

    if (!formats.length) throw new Error("No formats returned by youtubei.js");

    const player = info?.player;
    const items = [];

    for (const f of formats) {
      try {
        let directUrl = f.url;

        // Try to decipher if needed
        if (f.signatureCipher || f.cipher) {
          try {
            directUrl = await f.decipher(player);
          } catch (decipherErr) {
            console.log(`⚠️ Could not decipher format: ${f.quality_label || f.qualityLabel}`);
            continue;
          }
        }

        if (!directUrl) continue;

        const qualityLabel = f.quality_label || f.qualityLabel ||
            (f.has_audio && !f.has_video ? "audio" : "unknown");
        const mime = f.mime_type || f.mimeType || "";
        const contentLength = f.content_length || f.contentLength ||
            f.clen || f.lengthBytes || "unknown";

        items.push({
          url: directUrl,
          label: qualityLabel,
          type: mime,
          ext: getExtensionFromType(mime),
          filesize: contentLength,
        });
      } catch (err) {
        console.log(`⚠️ Skipping format due to error: ${err.message}`);
      }
    }

    if (!items.length) throw new Error("All formats failed to process");

    console.log(`✅ youtubei.js (${client}) found ${items.length} formats`);

    return {
      title,
      cover,
      duration,
      items
    };
  } catch (error) {
    console.error(`❌ youtubei.js (${client}) error:`, error.message);
    throw error;
  }
}

// ---------------------------
// Alternative fallback: yt-dlp-style approach with public APIs
// ---------------------------
async function fetchWithPublicAPI(url) {
  try {
    console.log("🔄 Trying public API fallback...");

    const videoId = extractYouTubeId(url);
    if (!videoId) throw new Error("Could not extract video ID");

    // Try multiple public APIs
    const apiEndpoints = [
      `https://inv.riverside.rocks/api/v1/videos/${videoId}`,
      `https://pipedapi.kavin.rocks/streams/${videoId}`,
      `https://yt.lemnoslife.com/videos?part=id,snippet,contentDetails&id=${videoId}`
    ];

    for (const endpoint of apiEndpoints) {
      try {
        console.log(`🔄 Trying API: ${endpoint.split('/')[2]}`);
        const response = await axios.get(endpoint, {
          timeout: 10000,
          headers: {
            'User-Agent': getRandomUserAgent(),
            'Accept': 'application/json'
          }
        });

        if (response.data) {
          const data = response.data;
          let formats = [];
          let title = "YouTube Video";
          let cover = null;
          let duration = 0;

          // Parse based on API response format
          if (endpoint.includes('inv.riverside.rocks')) {
            // Invidious API format
            title = data.title || title;
            cover = data.videoThumbnails?.find(t => t.quality === 'medium')?.url ||
                data.videoThumbnails?.[0]?.url;
            duration = data.lengthSeconds || 0;
            formats = data.formatStreams || data.adaptiveFormats || [];
          } else if (endpoint.includes('pipedapi.kavin.rocks')) {
            // Piped API format
            title = data.title || title;
            cover = data.thumbnailUrl || data.thumbnail ||
                (data.thumbnails && data.thumbnails[0]?.url);
            duration = data.duration || 0;
            formats = data.videoStreams || data.audioStreams || [];
          } else if (endpoint.includes('lemnoslife.com')) {
            // LemnosLife API format
            const item = data.items?.[0];
            if (item) {
              title = item.snippet?.title || title;
              cover = item.snippet?.thumbnails?.medium?.url ||
                  item.snippet?.thumbnails?.default?.url;
              duration = item.contentDetails?.duration ?
                  parseDuration(item.contentDetails.duration) : 0;

              // This API doesn't provide streaming URLs directly
              // Return minimal info so we can try another method
              return {
                title,
                cover,
                duration,
                items: []
              };
            }
          }

          if (formats.length > 0) {
            const items = formats.map(f => ({
              url: f.url || f.url,
              label: f.qualityLabel || f.quality ||
                  (f.type?.includes('audio') ? 'audio' : 'unknown'),
              type: f.type || f.mimeType || 'video/mp4',
              ext: getExtensionFromType(f.type || f.mimeType),
              filesize: f.size || f.contentLength || 'unknown'
            })).filter(f => f.url);

            if (items.length > 0) {
              console.log(`✅ Public API found ${items.length} formats`);
              return {
                title,
                cover,
                duration,
                items
              };
            }
          }
        }
      } catch (apiError) {
        console.log(`⚠️ API failed: ${endpoint.split('/')[2]} - ${apiError.message}`);
        continue;
      }
    }

    throw new Error("All public APIs failed");
  } catch (error) {
    console.error("❌ Public API fallback error:", error.message);
    throw error;
  }
}

// Helper function to parse ISO 8601 duration
function parseDuration(duration) {
  const match = duration.match(/PT(\d+H)?(\d+M)?(\d+S)?/);
  if (!match) return 0;

  const hours = (match[1] || '').replace('H', '') || 0;
  const minutes = (match[2] || '').replace('M', '') || 0;
  const seconds = (match[3] || '').replace('S', '') || 0;

  return parseInt(hours) * 3600 + parseInt(minutes) * 60 + parseInt(seconds);
}

/**
 * Primary API implementation using vidfly.ai
 */
async function fetchWithVidFlyApi(url, attemptNum) {
  try {
    const timeout = 30000 + ((attemptNum - 1) * 10000);

    const res = await axios.get(
        "https://api.vidfly.ai/api/media/youtube/download",
        {
          params: { url },
          headers: {
            accept: "*/*",
            "content-type": "application/json",
            "x-app-name": "vidfly-web",
            "x-app-version": "1.0.0",
            Referer: "https://vidfly.ai/",
            "User-Agent": getRandomUserAgent(),
          },
          timeout: timeout,
        }
    );

    const data = res.data?.data;
    if (!data || !data.items || !data.title) {
      const peek = typeof res.data === "string"
          ? res.data.slice(0, 200)
          : JSON.stringify(res.data).slice(0, 200);
      throw new Error(`Invalid VidFly response. Peek: ${peek}`);
    }

    return processYouTubeData(data, url);
  } catch (err) {
    console.error(`❌ VidFly API error on attempt ${attemptNum}:`, err.message);

    if (err.response) {
      console.error(`📡 Response status: ${err.response.status}`);
      if (err.response.data) {
        console.error(`📡 Response data:`,
            typeof err.response.data === 'object'
                ? JSON.stringify(err.response.data).substring(0, 200) + '...'
                : String(err.response.data).substring(0, 200) + '...'
        );
      }
    }

    throw new Error(`VidFly API request failed: ${err.message}`);
  }
}

/**
 * Fetches YouTube video data with multiple fallback methods
 */
async function fetchYouTubeData(url) {
  const normalizedUrl = normalizeYouTubeUrl(url);
  const isShorts = normalizedUrl.includes('/shorts/');
  console.log(`🔍 Fetching YouTube data for: ${normalizedUrl} ${isShorts ? '(SHORTS)' : ''}`);

  const strategies = [
    { name: 'youtubei.js (WEB)', fn: () => fetchWithYouTubeJs(normalizedUrl, 'WEB') },
    { name: 'youtubei.js (ANDROID)', fn: () => fetchWithYouTubeJs(normalizedUrl, 'ANDROID') },
    { name: 'Public APIs', fn: () => fetchWithPublicAPI(normalizedUrl) },
    { name: 'VidFly API', fn: () => {
        // VidFly with retries
        return new Promise((resolve, reject) => {
          const maxAttempts = 3;
          let attempts = 0;

          const tryVidFly = async () => {
            attempts++;
            try {
              const result = await fetchWithVidFlyApi(normalizedUrl, attempts);
              resolve(result);
            } catch (err) {
              if (attempts < maxAttempts) {
                const backoffMs = Math.min(1000 * Math.pow(2, attempts - 1), 8000);
                console.log(`⏱️ VidFly attempt ${attempts} failed, retrying in ${backoffMs/1000}s...`);
                setTimeout(tryVidFly, backoffMs);
              } else {
                reject(err);
              }
            }
          };

          tryVidFly();
        });
      }}
  ];

  let lastError = null;

  for (const strategy of strategies) {
    try {
      console.log(`🔄 Trying strategy: ${strategy.name}`);
      const startTime = Date.now();
      const result = await Promise.race([
        strategy.fn(),
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Strategy timeout')), 45000)
        )
      ]);
      const elapsed = Date.now() - startTime;
      console.log(`✅ Strategy ${strategy.name} succeeded in ${elapsed}ms`);
      return result;
    } catch (error) {
      lastError = error;
      console.warn(`⚠️ Strategy ${strategy.name} failed: ${error.message}`);

      // Add a small delay between strategies
      if (strategy !== strategies[strategies.length - 1]) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  throw new Error(`All YouTube fetching strategies failed. Last error: ${lastError?.message || 'Unknown'}`);
}

// ---------------------------
// Keep all your existing helper functions below
// ---------------------------

/**
 * Normalizes various YouTube URL formats
 */
function normalizeYouTubeUrl(url) {
  if (url.includes('youtu.be/')) {
    const videoId = url.split('youtu.be/')[1].split('?')[0].split('&')[0];
    return `https://www.youtube.com/watch?v=${videoId}`;
  }

  if (url.includes('m.youtube.com')) {
    return url.replace('m.youtube.com', 'www.youtube.com');
  }

  if (url.includes('/shorts/')) {
    // Keep as is, but ensure it's www
    return url.replace('youtube.com', 'www.youtube.com')
        .replace('m.youtube.com', 'www.youtube.com');
  }

  if (url.includes('youtube.com/watch') && !url.includes('www.youtube.com')) {
    return url.replace('youtube.com', 'www.youtube.com');
  }

  return url;
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
function processYouTubeData(data, url) {
  const isShorts = url.includes('/shorts/');
  console.log(`📊 YouTube: Found ${data.items.length} total formats (${isShorts ? 'SHORTS' : 'REGULAR'})`);

  // Get ALL formats that have a valid URL
  let availableFormats = data.items.filter(item => {
    return item.url && item.url.length > 0;
  });

  console.log(`✅ Found ${availableFormats.length} total formats with URLs`);

  // If no formats, try to provide at least basic info
  if (availableFormats.length === 0) {
    console.log('⚠️ No downloadable formats found, returning basic info only');
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

  // Detect audio presence for metadata
  const formatWithAudioInfo = availableFormats.map(item => {
    const label = (item.label || '').toLowerCase();
    const type = (item.type || '').toLowerCase();

    const isVideoOnly = label.includes('video only') ||
        label.includes('vid only') ||
        label.includes('without audio') ||
        type.includes('video only');

    const isAudioOnly = label.includes('audio only') ||
        type.includes('audio only') ||
        label.includes('audio') && !label.includes('video');

    return {
      ...item,
      hasAudio: !isVideoOnly && !isAudioOnly,
      isVideoOnly: isVideoOnly,
      isAudioOnly: isAudioOnly
    };
  });

  availableFormats = formatWithAudioInfo;

  // ========================================
  // DEDUPLICATE FORMATS + PREPARE FOR MERGING
  // ========================================

  const seenVideoQualities = new Map();
  const deduplicatedFormats = [];
  const audioFormats = [];

  // First pass: separate audio formats and deduplicate video formats
  availableFormats.forEach(format => {
    if (format.isAudioOnly) {
      audioFormats.push(format);
      deduplicatedFormats.push(format);
    } else {
      const qualityNum = extractQualityNumber(format.label || '');
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
              !f.isAudioOnly && extractQualityNumber(f.label || '') === qualityNum
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

  // ========================================
  // AUTOMATIC AUDIO MERGING FOR VIDEO-ONLY FORMATS
  // ========================================

  const mergedFormats = [];

  availableFormats.forEach(format => {
    if (format.isVideoOnly && audioFormats.length > 0) {
      // Find compatible audio for this video format
      const compatibleAudio = audioMergerService.findCompatibleAudio(format, audioFormats);

      if (compatibleAudio) {
        console.log(`🎵 Found audio for ${format.label}: ${compatibleAudio.label}`);

        // Create merged format entry using the new merge token
        const mergedFormat = {
          ...format,
          // Use the new merge token format
          url: buildMergeToken(format.url, compatibleAudio.url),
          hasAudio: true, // Mark as having audio now
          isVideoOnly: false, // No longer video-only
          isMergedFormat: true, // Flag as merged format
          originalVideoUrl: format.url,
          audioUrl: compatibleAudio.url,
          audioQuality: compatibleAudio.label
        };

        mergedFormats.push(mergedFormat);
        console.log(`✅ Created merged format: ${format.label} + ${compatibleAudio.label}`);
      } else {
        // Keep original video-only format if no audio found
        mergedFormats.push(format);
      }
    } else {
      // Keep original format (already has audio or is audio-only)
      mergedFormats.push(format);
    }
  });

  availableFormats = mergedFormats;

  console.log(`🎬 After audio merging: ${availableFormats.length} total formats`);

  // Log final formats
  console.log('🎬 Final available formats:');
  availableFormats.forEach((format, index) => {
    const audioStatus = format.isAudioOnly ? '🎵 Audio Only' :
        format.isVideoOnly ? '📹 Video Only' :
            format.isMergedFormat ? '🎬 Merged Video+Audio' :
                format.hasAudio ? '🎬 Video+Audio' : '❓ Unknown';
    console.log(`  ${index + 1}. ${format.label} - ${audioStatus}`);
  });

  // ========================================
  // CREATE QUALITY OPTIONS WITH PREMIUM FLAGS
  // ========================================

  const qualityOptions = availableFormats.map(format => {
    const quality = format.label || 'unknown';
    const qualityNum = extractQualityNumber(quality);

    // Mark as premium: 360p and below are free, above 360p requires premium
    // Audio-only formats are always free
    const isPremium = !format.isAudioOnly && qualityNum > 360;

    return {
      quality: quality,
      qualityNum: qualityNum,
      url: format.url, // This may be a MERGE:: URL for merged formats
      type: format.type || 'video/mp4',
      extension: format.ext || format.extension || getExtensionFromType(format.type),
      filesize: format.filesize || 'unknown',
      isPremium: isPremium,
      hasAudio: format.hasAudio,
      isVideoOnly: format.isVideoOnly,
      isAudioOnly: format.isAudioOnly,
      // Additional fields for merged formats
      isMergedFormat: format.isMergedFormat || false,
      originalVideoUrl: format.originalVideoUrl,
      audioUrl: format.audioUrl
    };
  });

  // Sort by quality number (ascending), but keep audio-only formats at the end
  qualityOptions.sort((a, b) => {
    if (a.isAudioOnly && !b.isAudioOnly) return 1;
    if (!a.isAudioOnly && b.isAudioOnly) return -1;
    return a.qualityNum - b.qualityNum;
  });

  // Select default format (360p for free users, or highest available if premium)
  let selectedFormat = qualityOptions.find(opt => !opt.isAudioOnly && opt.qualityNum === 360) ||
      qualityOptions.find(opt => !opt.isAudioOnly) ||
      qualityOptions[0];

  // Build result with all quality options
  const result = {
    title: data.title || "YouTube Video",
    thumbnail: data.cover,
    duration: data.duration || 0,
    isShorts: isShorts,
    formats: qualityOptions,
    allFormats: qualityOptions,
    url: selectedFormat ? selectedFormat.url : null,
    selectedQuality: selectedFormat,
    audioGuaranteed: selectedFormat ? selectedFormat.hasAudio : false
  };

  console.log(`✅ YouTube service completed with ${qualityOptions.length} quality options`);

  if (qualityOptions.length > 0) {
    console.log(`📋 Sending formats:`, qualityOptions.map(f => {
      const type = f.isAudioOnly ? '🎵 Audio' :
          f.isMergedFormat ? '🎬 Merged' :
              f.isVideoOnly ? '📹 Video' : '🎬 Video+Audio';
      return `${f.quality} (${type}, premium: ${f.isPremium})`;
    }));
  }

  return result;
}

/**
 * Extract quality number from quality label
 */
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

/**
 * Helper to get file extension from MIME type
 */
function getExtensionFromType(mimeType) {
  if (!mimeType) return 'mp4';

  const typeMap = {
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/x-flv': 'flv',
    'audio/mp4': 'm4a',
    'audio/mpeg': 'mp3',
    'audio/webm': 'webm',
    'audio/ogg': 'ogg'
  };

  for (const [type, ext] of Object.entries(typeMap)) {
    if (mimeType.includes(type)) return ext;
  }

  return 'mp4';
}

/**
 * Get a random user agent to avoid rate limiting
 */
function getRandomUserAgent() {
  const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.210 Mobile Safari/537.36'
  ];

  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

module.exports = { fetchYouTubeData };