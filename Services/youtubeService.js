// Controllers/youtubeService.js
const axios = require('axios');
const audioMergerService = require('./audioMergerService');

// ========================================
// CONFIGURATION
// ========================================
const CONFIG = {
  PIPED_INSTANCES: [
    'https://pipedapi.kavin.rocks',
    'https://pipedapi.smnz.de',
    'https://api.piped.video',
    'https://pipedapi.usepiped.com',
    'https://pipedapi.r4fo.com',
    'https://piped.moomoo.me'
  ],
  REQUEST_TIMEOUT: 10000,
  USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  STANDARD_RESOLUTIONS: [144, 240, 360, 480, 720, 1080, 1440, 2160],
  FREE_TIER_MAX: 360,
  MAX_AUDIO_BITRATE: 128000
};

// ========================================
// MAIN EXPORT FUNCTION
// ========================================
async function fetchYouTubeData(url) {
  console.log(`🔍 Fetching YouTube data for: ${url}`);

  try {
    const normalizedUrl = normalizeYouTubeUrl(url);
    const videoId = extractVideoId(normalizedUrl);

    if (!videoId) {
      throw new Error('Could not extract video ID from URL');
    }

    console.log(`📺 Video ID: ${videoId}`);

    // Try Piped API first (currently working)
    try {
      return await fetchFromPiped(videoId, normalizedUrl);
    } catch (pipedError) {
      console.log(`⚠️ Piped API failed: ${pipedError.message}`);

      // Fallback to alternative API
      return await fetchFromInvidious(videoId, normalizedUrl);
    }

  } catch (error) {
    console.error('❌ All YouTube services failed:', error.message);
    throw new Error(`YouTube download failed: ${error.message}`);
  }
}

// ========================================
// PIPED API IMPLEMENTATION (PRIMARY)
// ========================================
async function fetchFromPiped(videoId, originalUrl) {
  console.log(`📥 Fetching from Piped API: ${videoId}`);

  let lastError = null;

  // Try each Piped instance until one works
  for (const instance of CONFIG.PIPED_INSTANCES) {
    try {
      const response = await axios.get(`${instance}/streams/${videoId}`, {
        timeout: CONFIG.REQUEST_TIMEOUT,
        headers: {
          'User-Agent': CONFIG.USER_AGENT,
          'Accept': 'application/json'
        }
      });

      const data = response.data;

      if (!data || !data.videoStreams) {
        throw new Error('Invalid response from Piped API');
      }

      console.log(`✅ Piped instance working: ${instance}`);
      console.log(`📹 Video: ${data.title}`);

      // Transform Piped data to our format
      const formats = transformPipedFormats(data);

      const videoData = {
        title: data.title,
        thumbnail: data.thumbnailUrl || `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
        duration: data.duration || 0,
        uploader: data.uploader || 'Unknown',
        uploaderUrl: data.uploaderUrl,
        uploaderAvatar: data.uploaderAvatar,
        uploadDate: data.uploadDate,
        description: data.description,
        views: data.views,
        likes: data.likes,
        formats: formats
      };

      return processYouTubeData(videoData, originalUrl);

    } catch (error) {
      lastError = error;
      console.log(`⚠️ Instance ${instance} failed: ${error.message}`);
      continue;
    }
  }

  throw new Error(`All Piped instances failed: ${lastError?.message}`);
}

// ========================================
// INVIDIOUS API IMPLEMENTATION (FALLBACK)
// ========================================
async function fetchFromInvidious(videoId, originalUrl) {
  console.log(`📥 Fetching from Invidious API: ${videoId}`);

  const instances = [
    'https://invidious.projectsegfau.lt',
    'https://inv.riverside.rocks',
    'https://yewtu.be',
    'https://invidious.jing.rocks',
    'https://invidious.snopyta.org'
  ];

  for (const instance of instances) {
    try {
      const response = await axios.get(`${instance}/api/v1/videos/${videoId}`, {
        timeout: 8000,
        headers: { 'User-Agent': CONFIG.USER_AGENT }
      });

      const data = response.data;

      console.log(`✅ Invidious instance working: ${instance}`);

      const formats = transformInvidiousFormats(data);

      const videoData = {
        title: data.title,
        thumbnail: data.videoThumbnails?.find(t => t.quality === 'maxres')?.url ||
                   data.videoThumbnails?.[0]?.url ||
                   `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
        duration: data.lengthSeconds || 0,
        uploader: data.author || 'Unknown',
        uploaderUrl: data.authorUrl,
        uploaderAvatar: data.authorThumbnails?.slice(-1)[0]?.url,
        uploadDate: data.published,
        description: data.description,
        views: data.viewCount,
        likes: data.likeCount,
        formats: formats
      };

      return processYouTubeData(videoData, originalUrl);

    } catch (error) {
      console.log(`⚠️ Invidious instance ${instance} failed: ${error.message}`);
      continue;
    }
  }

  throw new Error('All Invidious instances failed');
}

// ========================================
// FORMAT TRANSFORMERS
// ========================================
function transformPipedFormats(data) {
  const formats = [];

  // Add video formats (with audio)
  if (data.videoStreams) {
    data.videoStreams.forEach(stream => {
      if (!stream.videoOnly) {
        formats.push({
          url: stream.url,
          label: `${stream.quality}`,
          type: 'video/mp4',
          ext: 'mp4',
          filesize: stream.contentLength || 0,
          quality: parseInt(stream.quality) || 0,
          hasVideo: true,
          hasAudio: true,
          isVideoOnly: false,
          isAudioOnly: false
        });
      }
    });
  }

  // Add video-only formats (for premium/merging)
  if (data.videoStreams) {
    data.videoStreams.forEach(stream => {
      if (stream.videoOnly) {
        formats.push({
          url: stream.url,
          label: `${stream.quality} (video only)`,
          type: 'video/mp4',
          ext: 'mp4',
          filesize: stream.contentLength || 0,
          quality: parseInt(stream.quality) || 0,
          hasVideo: true,
          hasAudio: false,
          isVideoOnly: true,
          isAudioOnly: false
        });
      }
    });
  }

  // Add audio formats
  if (data.audioStreams) {
    data.audioStreams.forEach(stream => {
      const bitrate = stream.bitrate || 128000;
      formats.push({
        url: stream.url,
        label: `${Math.round(bitrate / 1000)}kbps`,
        type: 'audio/mp4',
        ext: 'm4a',
        filesize: stream.contentLength || 0,
        quality: bitrate,
        hasVideo: false,
        hasAudio: true,
        isVideoOnly: false,
        isAudioOnly: true
      });
    });
  }

  return formats;
}

function transformInvidiousFormats(data) {
  const formats = [];

  // Add regular video formats (with audio)
  if (data.formatStreams) {
    data.formatStreams.forEach(stream => {
      formats.push({
        url: stream.url,
        label: stream.qualityLabel,
        type: 'video/mp4',
        ext: 'mp4',
        filesize: stream.clen || 0,
        quality: parseInt(stream.qualityLabel) || 0,
        hasVideo: true,
        hasAudio: true,
        isVideoOnly: false,
        isAudioOnly: false
      });
    });
  }

  // Add adaptive video formats (video only)
  if (data.adaptiveFormats) {
    data.adaptiveFormats.forEach(stream => {
      if (stream.type?.includes('video')) {
        formats.push({
          url: stream.url,
          label: `${stream.qualityLabel} (video only)`,
          type: 'video/mp4',
          ext: 'mp4',
          filesize: stream.clen || 0,
          quality: parseInt(stream.qualityLabel) || 0,
          hasVideo: true,
          hasAudio: false,
          isVideoOnly: true,
          isAudioOnly: false
        });
      }

      if (stream.type?.includes('audio')) {
        formats.push({
          url: stream.url,
          label: `${Math.round(stream.bitrate / 1000)}kbps`,
          type: 'audio/mp4',
          ext: 'm4a',
          filesize: stream.clen || 0,
          quality: stream.bitrate || 128000,
          hasVideo: false,
          hasAudio: true,
          isVideoOnly: false,
          isAudioOnly: true
        });
      }
    });
  }

  return formats;
}

// ========================================
// URL HELPERS
// ========================================
function normalizeYouTubeUrl(url) {
  if (!url) return url;

  // Convert youtu.be to youtube.com
  if (url.includes('youtu.be/')) {
    const videoId = url.split('youtu.be/')[1].split('?')[0].split('&')[0];
    return `https://www.youtube.com/watch?v=${videoId}`;
  }

  // Convert m.youtube to www.youtube
  if (url.includes('m.youtube.com')) {
    return url.replace('m.youtube.com', 'www.youtube.com');
  }

  // Handle shorts
  if (url.includes('/shorts/')) {
    return url;
  }

  // Ensure www prefix
  if (url.includes('youtube.com/watch') && !url.includes('www.youtube.com')) {
    return url.replace('youtube.com', 'www.youtube.com');
  }

  return url;
}

function extractVideoId(url) {
  const patterns = [
    /v=([^&]+)/,
    /youtu\.be\/([^?]+)/,
    /shorts\/([^?]+)/,
    /embed\/([^?]+)/
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }

  return null;
}

// ========================================
// QUALITY PROCESSING
// ========================================
function processYouTubeData(data, url) {
  const isShorts = url.includes('/shorts/');
  console.log(`📊 Processing ${data.formats.length} total formats...`);

  // ========================================
  // STEP 1: FILTER VALID FORMATS
  // ========================================
  let validFormats = data.formats
    .filter(f => f && f.url)
    .filter(f => {
      // Skip very low quality video
      if (f.quality && f.quality < 144 && !f.isAudioOnly) return false;
      return true;
    });

  console.log(`✅ After filtering: ${validFormats.length} valid formats`);

  // ========================================
  // STEP 2: DEDUPLICATE BY QUALITY
  // ========================================
  const uniqueVideos = new Map();
  const audioFormats = [];

  validFormats.forEach(format => {
    if (format.isAudioOnly) {
      audioFormats.push(format);
    } else {
      const qualityNum = format.quality || extractQualityNumber(format.label);
      const key = `${qualityNum}_${format.hasAudio}`;

      if (!uniqueVideos.has(key)) {
        uniqueVideos.set(key, { ...format, qualityNum });
      } else {
        // Keep higher bitrate/fps
        const existing = uniqueVideos.get(key);
        if (format.filesize > existing.filesize) {
          uniqueVideos.set(key, { ...format, qualityNum });
        }
      }
    }
  });

  let dedupedFormats = Array.from(uniqueVideos.values());
  console.log(`🔄 After deduplication: ${dedupedFormats.length} unique video formats`);

  // ========================================
  // STEP 3: KEEP ONLY STANDARD RESOLUTIONS
  // ========================================
  dedupedFormats = dedupedFormats
    .filter(f => {
      if (f.isAudioOnly) return true;
      return CONFIG.STANDARD_RESOLUTIONS.includes(f.qualityNum);
    })
    .sort((a, b) => a.qualityNum - b.qualityNum);

  // Keep only best audio format
  const bestAudio = audioFormats
    .sort((a, b) => (b.quality || 0) - (a.quality || 0))
    .slice(0, 1);

  // Combine formats
  let allFormats = [...dedupedFormats, ...bestAudio];

  console.log(`🎬 Final formats: ${allFormats.length}`);
  allFormats.forEach(f => {
    const type = f.isAudioOnly ? '🎵 Audio' :
                 f.isVideoOnly ? '📹 Video Only' :
                 '🎬 Video+Audio';
    console.log(`   ${f.label} - ${type}`);
  });

  // ========================================
  // STEP 4: CREATE QUALITY OPTIONS WITH PREMIUM FLAGS
  // ========================================
  const qualityOptions = allFormats.map(format => {
    const qualityNum = format.qualityNum || extractQualityNumber(format.label);
    const isPremium = !format.isAudioOnly && qualityNum > CONFIG.FREE_TIER_MAX;

    return {
      quality: format.label,
      qualityNum: qualityNum,
      url: format.url,
      type: format.type || 'video/mp4',
      extension: format.ext || 'mp4',
      filesize: format.filesize || 'unknown',
      isPremium: isPremium,
      hasAudio: format.hasAudio || false,
      isVideoOnly: format.isVideoOnly || false,
      isAudioOnly: format.isAudioOnly || false,
      isMergedFormat: false
    };
  });

  // Sort: lower quality first, audio at end
  qualityOptions.sort((a, b) => {
    if (a.isAudioOnly && !b.isAudioOnly) return 1;
    if (!a.isAudioOnly && b.isAudioOnly) return -1;
    return a.qualityNum - b.qualityNum;
  });

  // ========================================
  // STEP 5: AUDIO MERGING FOR VIDEO-ONLY FORMATS
  // ========================================
  const mergedFormats = [];
  const availableAudio = qualityOptions.filter(f => f.isAudioOnly);

  qualityOptions.forEach(format => {
    if (format.isVideoOnly && availableAudio.length > 0) {
      // Find compatible audio
      const compatibleAudio = audioMergerService.findCompatibleAudio(format, availableAudio);

      if (compatibleAudio) {
        console.log(`🎵 Creating merged format for ${format.quality}`);

        const mergedFormat = {
          ...format,
          url: `MERGE:${format.url}:${compatibleAudio.url}`,
          hasAudio: true,
          isVideoOnly: false,
          isMergedFormat: true,
          originalVideoUrl: format.url,
          audioUrl: compatibleAudio.url,
          audioQuality: compatibleAudio.quality,
          isPremium: format.isPremium // Keep premium status
        };

        mergedFormats.push(mergedFormat);
      } else {
        mergedFormats.push(format);
      }
    } else {
      mergedFormats.push(format);
    }
  });

  // ========================================
  // STEP 6: SELECT DEFAULT (360p FREE)
  // ========================================
  const defaultFormat = mergedFormats.find(f =>
    !f.isAudioOnly && f.qualityNum === CONFIG.FREE_TIER_MAX
  ) || mergedFormats.find(f => !f.isAudioOnly) || mergedFormats[0];

  // ========================================
  // STEP 7: BUILD FINAL RESULT
  // ========================================
  const result = {
    success: true,
    platform: 'youtube',
    title: data.title || 'YouTube Video',
    thumbnail: data.thumbnail || `https://img.youtube.com/vi/${extractVideoId(url)}/hqdefault.jpg`,
    duration: data.duration || 0,
    uploader: data.uploader,
    uploaderUrl: data.uploaderUrl,
    uploaderAvatar: data.uploaderAvatar,
    uploadDate: data.uploadDate,
    description: data.description,
    views: data.views,
    likes: data.likes,
    isShorts: isShorts,
    formats: mergedFormats,
    allFormats: mergedFormats,
    url: defaultFormat.url,
    selectedQuality: defaultFormat,
    audioGuaranteed: defaultFormat.hasAudio || defaultFormat.isMergedFormat
  };

  console.log(`✅ YouTube service completed successfully`);
  console.log(`🎯 Default: ${defaultFormat.quality} (${defaultFormat.isPremium ? '💰 Premium' : '✅ Free'})`);

  return result;
}

// ========================================
// HELPER FUNCTIONS
// ========================================
function extractQualityNumber(label) {
  if (!label) return 0;

  // Match patterns like "1080p", "720p60", etc.
  const match = label.match(/(\d{3,4})p/);
  if (match) return parseInt(match[1]);

  // Handle 4K, 2K
  if (label.includes('2160') || label.includes('4K')) return 2160;
  if (label.includes('1440') || label.includes('2K')) return 1440;
  if (label.includes('1080')) return 1080;
  if (label.includes('720')) return 720;
  if (label.includes('480')) return 480;
  if (label.includes('360')) return 360;
  if (label.includes('240')) return 240;
  if (label.includes('144')) return 144;

  // Audio formats
  if (label.includes('kbps') || label.includes('Audio')) {
    const bitrateMatch = label.match(/(\d+)kbps/);
    return bitrateMatch ? parseInt(bitrateMatch[1]) * 1000 : 99999;
  }

  return 0;
}

function getRandomUserAgent() {
  const agents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  ];
  return agents[Math.floor(Math.random() * agents.length)];
}

// ========================================
// EXPORTS
// ========================================
module.exports = {
  fetchYouTubeData,
  // Exported for testing
  extractVideoId,
  normalizeYouTubeUrl
};