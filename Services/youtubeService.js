// Controllers/youtubeService.js - COBALT API VERSION
const axios = require('axios');

// ========================================
// CONFIGURATION
// ========================================
const CONFIG = {
  COBALT_INSTANCES: [
    'https://co.wuk.sh',
    'https://cobalt.tfkem.xyz',
    'https://api.cobalt.toys',
    'https://cobalt.uptech.team',
    'https://c.bluesmods.com'
  ],
  REQUEST_TIMEOUT: 15000,
  FREE_TIER_MAX: 360,
  STANDARD_RESOLUTIONS: [144, 240, 360, 480, 720, 1080]
};

// ========================================
// MAIN EXPORT FUNCTION
// ========================================
async function fetchYouTubeData(url) {
  console.log(`🔍 Fetching YouTube data for: ${url}`);

  try {
    const normalizedUrl = normalizeYouTubeUrl(url);
    console.log(`📺 Normalized URL: ${normalizedUrl}`);

    // Try Cobalt API first (most reliable right now)
    try {
      return await fetchFromCobalt(normalizedUrl);
    } catch (cobaltError) {
      console.log(`⚠️ Cobalt API failed: ${cobaltError.message}`);

      // Final fallback - direct video info extraction
      return await fetchFromVideoInfo(normalizedUrl);
    }

  } catch (error) {
    console.error('❌ All YouTube services failed:', error.message);
    throw new Error(`YouTube download failed: ${error.message}`);
  }
}

// ========================================
// COBALT API IMPLEMENTATION (PRIMARY)
// ========================================
async function fetchFromCobalt(url) {
  console.log(`📥 Fetching from Cobalt API`);

  let lastError = null;

  for (const instance of CONFIG.COBALT_INSTANCES) {
    try {
      const response = await axios.post(`${instance}/api/json`, {
        url: url,
        vCodec: 'h264',      // Best compatibility
        vQuality: 'max',     // Get all qualities
        aFormat: 'mp4',      // Audio format
        isNoTTWatermark: true,
        isTTFullAudio: true,
        disableMetadata: false
      }, {
        timeout: CONFIG.REQUEST_TIMEOUT,
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      const data = response.data;

      if (!data || data.status === 'error' || !data.url) {
        throw new Error(data.text || 'Invalid response from Cobalt');
      }

      console.log(`✅ Cobalt instance working: ${instance}`);

      // Extract video info from response
      const videoData = await extractVideoMetadata(url, data.url);

      // Create formats array
      const formats = [];

      // Add the main format (usually best quality)
      formats.push({
        url: data.url,
        label: determineQualityFromUrl(data.url),
        qualityNum: extractQualityNumber(determineQualityFromUrl(data.url)),
        type: data.type || 'video/mp4',
        ext: 'mp4',
        filesize: data.size || 0,
        hasVideo: true,
        hasAudio: true,
        isVideoOnly: false,
        isAudioOnly: false
      });

      // If we have picker (multiple qualities)
      if (data.picker && Array.isArray(data.picker)) {
        data.picker.forEach(item => {
          if (item.url) {
            formats.push({
              url: item.url,
              label: item.quality || item.label || 'Unknown',
              qualityNum: extractQualityNumber(item.quality || item.label || ''),
              type: 'video/mp4',
              ext: 'mp4',
              filesize: item.size || 0,
              hasVideo: true,
              hasAudio: item.hasAudio !== false,
              isVideoOnly: item.hasAudio === false,
              isAudioOnly: false
            });
          }
        });
      }

      // Add audio only format
      formats.push({
        url: data.audioUrl || data.url,
        label: '128kbps',
        qualityNum: 128000,
        type: 'audio/m4a',
        ext: 'm4a',
        filesize: data.audioSize || 0,
        hasVideo: false,
        hasAudio: true,
        isVideoOnly: false,
        isAudioOnly: true
      });

      return processYouTubeData({
        title: videoData.title,
        thumbnail: videoData.thumbnail,
        duration: videoData.duration,
        uploader: videoData.uploader,
        formats: formats
      }, url);

    } catch (error) {
      lastError = error;
      console.log(`⚠️ Cobalt instance ${instance} failed: ${error.message}`);
      continue;
    }
  }

  throw new Error(`All Cobalt instances failed: ${lastError?.message}`);
}

// ========================================
// FALLBACK: Direct oEmbed + Video Info
// ========================================
async function fetchFromVideoInfo(url) {
  console.log(`📥 Fetching via oEmbed fallback`);

  const videoId = extractVideoId(url);
  if (!videoId) throw new Error('Could not extract video ID');

  try {
    // Get video metadata from oEmbed (not blocked)
    const oembedResponse = await axios.get(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`,
      { timeout: 5000 }
    );

    const metadata = oembedResponse.data;

    // Try different public services for direct URLs
    const directUrls = await fetchDirectUrls(videoId);

    const formats = [];

    // Add formats from direct URLs
    if (directUrls.length > 0) {
      directUrls.forEach((item, index) => {
        formats.push({
          url: item.url,
          label: `${item.quality}p`,
          qualityNum: item.quality,
          type: 'video/mp4',
          ext: 'mp4',
          filesize: 0,
          hasVideo: true,
          hasAudio: item.quality <= 360, // Lower qualities have audio
          isVideoOnly: item.quality > 360,
          isAudioOnly: false
        });
      });
    }

    // Add generic audio format
    formats.push({
      url: `https://www.youtube.com/watch?v=${videoId}`,
      label: '128kbps',
      qualityNum: 128000,
      type: 'audio/m4a',
      ext: 'm4a',
      filesize: 0,
      hasVideo: false,
      hasAudio: true,
      isVideoOnly: false,
      isAudioOnly: true
    });

    return processYouTubeData({
      title: metadata.title,
      thumbnail: metadata.thumbnail_url,
      duration: 0,
      uploader: metadata.author_name,
      formats: formats
    }, url);

  } catch (error) {
    throw new Error(`Fallback failed: ${error.message}`);
  }
}

// ========================================
// DIRECT URL FETCHERS
// ========================================
async function fetchDirectUrls(videoId) {
  const urls = [];

  // Try YouTube's internal API endpoints (sometimes work)
  const apiEndpoints = [
    `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`, // Just for thumbnail
  ];

  // Add standard quality options
  const qualities = [144, 240, 360, 480, 720, 1080];

  qualities.forEach(quality => {
    urls.push({
      quality: quality,
      url: `https://redirect.rutubelist.ru/${videoId}/${quality}` // Sometimes works
    });
  });

  return urls;
}

// ========================================
// HELPER FUNCTIONS
// ========================================
async function extractVideoMetadata(url, videoUrl) {
  try {
    // Try to get metadata from oEmbed
    const response = await axios.get(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`,
      { timeout: 3000 }
    );

    return {
      title: response.data.title,
      thumbnail: response.data.thumbnail_url,
      duration: 0,
      uploader: response.data.author_name
    };
  } catch {
    // Fallback to URL-based metadata
    const videoId = extractVideoId(url);
    return {
      title: `YouTube Video ${videoId}`,
      thumbnail: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
      duration: 0,
      uploader: 'Unknown'
    };
  }
}

function normalizeYouTubeUrl(url) {
  if (url.includes('youtu.be/')) {
    const videoId = url.split('youtu.be/')[1].split('?')[0].split('&')[0];
    return `https://www.youtube.com/watch?v=${videoId}`;
  }
  if (url.includes('/shorts/')) {
    return url;
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

function determineQualityFromUrl(url) {
  if (url.includes('2160') || url.includes('4k')) return '2160p';
  if (url.includes('1440') || url.includes('2k')) return '1440p';
  if (url.includes('1080')) return '1080p';
  if (url.includes('720')) return '720p';
  if (url.includes('480')) return '480p';
  if (url.includes('360')) return '360p';
  if (url.includes('240')) return '240p';
  if (url.includes('144')) return '144p';
  return '360p'; // Default
}

function extractQualityNumber(label) {
  if (!label) return 0;
  const match = label.match(/(\d{3,4})p/);
  if (match) return parseInt(match[1]);
  if (label.includes('kbps')) {
    const bitrateMatch = label.match(/(\d+)kbps/);
    return bitrateMatch ? parseInt(bitrateMatch[1]) * 1000 : 128000;
  }
  return 0;
}

// ========================================
// PROCESS YOUTUBE DATA
// ========================================
function processYouTubeData(data, url) {
  const isShorts = url.includes('/shorts/');

  // Filter valid formats
  let validFormats = data.formats
    .filter(f => f && f.url)
    .filter(f => {
      if (f.qualityNum && f.qualityNum < 144 && !f.isAudioOnly) return false;
      return true;
    });

  // Deduplicate
  const uniqueVideos = new Map();
  const audioFormats = [];

  validFormats.forEach(format => {
    if (format.isAudioOnly) {
      audioFormats.push(format);
    } else {
      const key = `${format.qualityNum}_${format.hasAudio}`;
      if (!uniqueVideos.has(key) || format.filesize > (uniqueVideos.get(key)?.filesize || 0)) {
        uniqueVideos.set(key, format);
      }
    }
  });

  // Filter standard resolutions
  let videoFormats = Array.from(uniqueVideos.values())
    .filter(f => CONFIG.STANDARD_RESOLUTIONS.includes(f.qualityNum))
    .sort((a, b) => a.qualityNum - b.qualityNum);

  // Best audio
  const bestAudio = audioFormats
    .sort((a, b) => b.qualityNum - a.qualityNum)
    .slice(0, 1);

  const allFormats = [...videoFormats, ...bestAudio];

  // Create quality options with premium flags
  const qualityOptions = allFormats.map(format => ({
    quality: format.label,
    qualityNum: format.qualityNum,
    url: format.url,
    type: format.type || 'video/mp4',
    extension: format.ext || 'mp4',
    filesize: format.filesize || 'unknown',
    isPremium: !format.isAudioOnly && format.qualityNum > CONFIG.FREE_TIER_MAX,
    hasAudio: format.hasAudio || false,
    isVideoOnly: format.isVideoOnly || false,
    isAudioOnly: format.isAudioOnly || false
  }));

  // Default to 360p
  const defaultFormat = qualityOptions.find(f =>
    !f.isAudioOnly && f.qualityNum === CONFIG.FREE_TIER_MAX
  ) || qualityOptions.find(f => !f.isAudioOnly) || qualityOptions[0];

  return {
    success: true,
    platform: 'youtube',
    title: data.title || 'YouTube Video',
    thumbnail: data.thumbnail || `https://img.youtube.com/vi/${extractVideoId(url)}/hqdefault.jpg`,
    duration: data.duration || 0,
    uploader: data.uploader || 'Unknown',
    isShorts: isShorts,
    formats: qualityOptions,
    allFormats: qualityOptions,
    url: defaultFormat.url,
    selectedQuality: defaultFormat,
    audioGuaranteed: defaultFormat.hasAudio
  };
}

module.exports = { fetchYouTubeData };