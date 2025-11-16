const axios = require("axios");

/**
 * Fetches YouTube video data with improved reliability
 * @param {string} url YouTube URL
 * @returns {Promise<object>} Processed video data
 */
async function fetchYouTubeData(url) {
  // Normalize YouTube URL format
  const normalizedUrl = normalizeYouTubeUrl(url);
  console.log(`🔍 Fetching YouTube data for: ${normalizedUrl}`);
  
  // Add retry mechanism
  let attempts = 0;
  const maxAttempts = 3;
  let lastError = null;
  
  while (attempts < maxAttempts) {
    attempts++;
    try {
      // Try primary API
      return await fetchWithVidFlyApi(normalizedUrl, attempts);
    } catch (err) {
      lastError = err;
      console.error(`❌ Attempt ${attempts}/${maxAttempts} failed: ${err.message}`);
      
      // Add exponential backoff
      if (attempts < maxAttempts) {
        const backoffMs = Math.min(1000 * Math.pow(2, attempts - 1), 8000);
        console.log(`⏱️ Retrying in ${backoffMs/1000} seconds...`);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
      }
    }
  }
  
  // All attempts failed, throw the last error
  throw new Error(`YouTube download failed after ${maxAttempts} attempts: ${lastError.message}`);
}

/**
 * Normalizes various YouTube URL formats
 */
function normalizeYouTubeUrl(url) {
  // Handle youtu.be short links
  if (url.includes('youtu.be/')) {
    const videoId = url.split('youtu.be/')[1].split('?')[0].split('&')[0];
    return `https://www.youtube.com/watch?v=${videoId}`;
  }
  
  // Handle m.youtube.com links
  if (url.includes('m.youtube.com')) {
    return url.replace('m.youtube.com', 'www.youtube.com');
  }
  
  // Handle youtube.com/shorts/ links (maintain shorts path)
  if (url.includes('/shorts/')) {
    // Keep as shorts link for proper detection
    return url;
  }
  
  // Handle YouTube watch links that might be missing www
  if (url.includes('youtube.com/watch') && !url.includes('www.youtube.com')) {
    return url.replace('youtube.com', 'www.youtube.com');
  }
  
  return url;
}

/**
 * Primary API implementation using vidfly.ai
 */
async function fetchWithVidFlyApi(url, attemptNum) {
  try {
    // Increase timeout for higher attempt numbers
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
          // Add a random user agent to prevent blocking
          "User-Agent": getRandomUserAgent(),
        },
        timeout: timeout,
      }
    );
    
    // Validate response
    const data = res.data?.data;
    if (!data || !data.items || !data.title) {
      throw new Error("Invalid or empty response from YouTube downloader API");
    }
    
    return processYouTubeData(data, url);
  } catch (err) {
    console.error(`❌ YouTube API error on attempt ${attemptNum}:`, err.message);
    
    if (err.response) {
      console.error(`📡 Response status: ${err.response.status}`);
      // Log only a portion of response data to avoid console flood
      if (err.response.data) {
        console.error(`📡 Response data:`, 
          typeof err.response.data === 'object' 
            ? JSON.stringify(err.response.data).substring(0, 200) + '...' 
            : String(err.response.data).substring(0, 200) + '...'
        );
      }
    }
    
    throw new Error(`YouTube downloader API request failed: ${err.message}`);
  }
}

/**
 * Process YouTube data and select the best format
 */
function processYouTubeData(data, url) {
  const isShorts = url.includes('/shorts/');
  console.log(`📊 YouTube: Found ${data.items.length} total formats (${isShorts ? 'SHORTS' : 'REGULAR'})`);
  
  // ========================================
  // IMPROVED FORMAT HANDLING - KEEP ALL QUALITIES
  // ========================================
  
  // Separate video and audio formats
  const videoFormats = [];
  const audioFormats = [];
  
  data.items.forEach(item => {
    const label = (item.label || '').toLowerCase();
    const type = (item.type || '').toLowerCase();
    const hasUrl = item.url && item.url.length > 0;
    
    if (!hasUrl) return; // Skip items without URLs
    
    const isAudioOnly = label.includes('audio only') || 
                       type.includes('audio only') ||
                       label.includes('m4a') ||
                       label.includes('opus');
    
    const isVideoOnly = label.includes('video only') || 
                       label.includes('vid only') ||
                       label.includes('without audio');
    
    // Has both video and audio
    const hasAudioTrack = !isVideoOnly && !isAudioOnly;
    
    if (isAudioOnly) {
      audioFormats.push({
        ...item,
        hasAudio: true,
        hasVideo: false,
        needsAudioMerge: false
      });
    } else {
      // Video format (may or may not have audio)
      videoFormats.push({
        ...item,
        hasAudio: hasAudioTrack,
        hasVideo: true,
        needsAudioMerge: !hasAudioTrack // Flag if needs audio merge
      });
    }
  });
  
  console.log(`✅ Found ${videoFormats.length} video formats, ${audioFormats.length} audio formats`);
  
  // Get best audio format for merging
  const bestAudio = audioFormats.length > 0 
    ? audioFormats.reduce((best, curr) => {
        const currBitrate = extractAudioBitrate(curr.label);
        const bestBitrate = extractAudioBitrate(best.label);
        return currBitrate > bestBitrate ? curr : best;
      })
    : null;
  
  console.log(`🎵 Best audio format: ${bestAudio?.label || 'none'}`);
  
  // Use video formats as primary (they include formats with and without audio)
  let availableFormats = videoFormats;
  
  // Log all formats for debugging
  console.log('🎬 Video formats:');
  videoFormats.forEach((format, index) => {
    console.log(`  ${index + 1}. ${format.label} - Audio: ${format.hasAudio ? '✅' : '❌ (needs merge)'}`);
  });
  
  console.log('🎵 Audio formats:');
  audioFormats.forEach((format, index) => {
    console.log(`  ${index + 1}. ${format.label}`);
  });
  
  // ========================================
  // CREATE QUALITY OPTIONS WITH PREMIUM FLAGS AND AUDIO MERGE INFO
  // ========================================
  
  const qualityOptions = availableFormats.map(format => {
    const quality = format.label || 'unknown';
    const qualityNum = extractQualityNumber(quality);
    
    // Mark as premium: 360p and below are free, above 360p requires premium
    const isPremium = qualityNum > 360;
    
    return {
      quality: quality,
      qualityNum: qualityNum,
      url: format.url,
      type: format.type || 'video/mp4',
      extension: format.ext || format.extension || getExtensionFromType(format.type),
      filesize: format.filesize || 'unknown',
      isPremium: isPremium,
      hasAudio: format.hasAudio,
      needsAudioMerge: format.needsAudioMerge,
      // Include audio URL for merging if needed
      audioUrl: format.needsAudioMerge && bestAudio ? bestAudio.url : null,
      audioFormat: format.needsAudioMerge && bestAudio ? bestAudio.label : null
    };
  });
  
  // Sort by quality number (ascending)
  qualityOptions.sort((a, b) => a.qualityNum - b.qualityNum);
  
  // Select default format (360p with audio, or highest available with audio if premium)
  let selectedFormat = qualityOptions.find(opt => opt.qualityNum === 360 && opt.hasAudio) || 
                       qualityOptions.find(opt => opt.hasAudio) ||
                       qualityOptions[0];
  
  // Build result with all quality options
  const result = {
    title: data.title,
    thumbnail: data.cover,
    duration: data.duration,
    isShorts: isShorts,
    formats: qualityOptions, // All video quality options
    allFormats: qualityOptions, // Also include allFormats for backward compatibility
    audioFormats: audioFormats.map(format => ({
      quality: format.label || 'unknown',
      url: format.url,
      type: format.type || 'audio/mp4',
      extension: format.ext || format.extension || 'm4a',
      filesize: format.filesize || 'unknown',
      isPremium: false, // Audio formats are free
      hasAudio: true,
      hasVideo: false
    })),
    url: selectedFormat.url,
    selectedQuality: selectedFormat,
    audioGuaranteed: selectedFormat.hasAudio,
    needsMerge: selectedFormat.needsAudioMerge
  };
  
  console.log(`✅ YouTube service completed with ${qualityOptions.length} video quality options`);
  console.log(`📋 Video qualities:`, qualityOptions.map(f => `${f.quality} (premium: ${f.isPremium}, hasAudio: ${f.hasAudio})`));
  console.log(`🎵 Audio qualities: ${audioFormats.length} formats`);
  
  return result;
}

/**
 * Extract audio bitrate from label
 */
function extractAudioBitrate(label) {
  if (!label) return 0;
  const match = label.match(/(\d+)kb\/s/i);
  return match ? parseInt(match[1]) : 0;
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
  
  return 'mp4'; // Default
}

/**
 * Get a random user agent to avoid rate limiting
 */
function getRandomUserAgent() {
  const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.1 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:94.0) Gecko/20100101 Firefox/94.0',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 15_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.1 Mobile/15E148 Safari/604.1'
  ];
  
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

module.exports = { fetchYouTubeData };
