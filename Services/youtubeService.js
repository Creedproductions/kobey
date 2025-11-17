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
 * FIXED: Now properly handles video-only formats for high quality
 */
function processYouTubeData(data, url) {
  const isShorts = url.includes('/shorts/');
  console.log(`📊 YouTube: Found ${data.items.length} total formats (${isShorts ? 'SHORTS' : 'REGULAR'})`);
  
  // ========================================
  // IMPROVED FORMAT CATEGORIZATION
  // ========================================
  
  // Categorize all formats
  const videoWithAudio = [];
  const videoOnly = [];
  const audioOnly = [];
  
  data.items.forEach(item => {
    const label = (item.label || '').toLowerCase();
    const type = (item.type || '').toLowerCase();
    const hasUrl = item.url && item.url.length > 0;
    
    if (!hasUrl) return; // Skip formats without URLs
    
    // Detect format type
    const isVideoOnlyFormat = label.includes('video only') || 
                              label.includes('vid only') ||
                              label.includes('without audio') ||
                              type.includes('video only');
    
    const isAudioOnlyFormat = label.includes('audio only') || 
                              type.includes('audio only') ||
                              label.includes('m4a') ||
                              label.includes('opus') ||
                              type.includes('audio/');
    
    if (isAudioOnlyFormat) {
      audioOnly.push(item);
    } else if (isVideoOnlyFormat) {
      videoOnly.push(item);
    } else {
      // Has both video and audio
      videoWithAudio.push(item);
    }
  });
  
  console.log(`📊 Format breakdown:`);
  console.log(`   🎥+🔊 Video with audio: ${videoWithAudio.length}`);
  console.log(`   🎥 Video only: ${videoOnly.length}`);
  console.log(`   🔊 Audio only: ${audioOnly.length}`);
  
  // ========================================
  // CREATE QUALITY OPTIONS
  // ========================================
  
  const qualityOptions = [];
  
  // 1. Add video formats WITH audio (these work immediately - FREE)
  videoWithAudio.forEach(format => {
    const quality = format.label || 'unknown';
    const qualityNum = extractQualityNumber(quality);
    
    qualityOptions.push({
      quality: quality,
      qualityNum: qualityNum,
      url: format.url,
      type: format.type || 'video/mp4',
      extension: format.ext || format.extension || getExtensionFromType(format.type),
      filesize: format.filesize || 'unknown',
      isPremium: false, // These work without merging
      hasAudio: true,
      requiresAudioMerge: false
    });
  });
  
  // 2. Add video-only formats (these need audio merging - PREMIUM)
  videoOnly.forEach(format => {
    const quality = format.label || 'unknown';
    const qualityNum = extractQualityNumber(quality);
    
    // Only add if quality is above 360p (360p should already be in videoWithAudio)
    if (qualityNum > 360) {
      qualityOptions.push({
        quality: quality,
        qualityNum: qualityNum,
        url: format.url,
        type: format.type || 'video/mp4',
        extension: format.ext || format.extension || getExtensionFromType(format.type),
        filesize: format.filesize || 'unknown',
        isPremium: true, // Requires audio merging
        hasAudio: false,
        requiresAudioMerge: true,
        audioUrl: audioOnly.length > 0 ? audioOnly[audioOnly.length - 1].url : null // Best audio
      });
    }
  });
  
  // 3. Add audio-only formats separately (for audio extraction - PREMIUM)
  audioOnly.forEach(format => {
    const quality = format.label || 'unknown';
    
    qualityOptions.push({
      quality: quality,
      qualityNum: extractBitrateNumber(quality),
      url: format.url,
      type: format.type || 'audio/mp4',
      extension: format.ext || format.extension || getExtensionFromType(format.type),
      filesize: format.filesize || 'unknown',
      isPremium: true, // Audio extraction is premium
      hasAudio: true,
      isAudioOnly: true,
      requiresAudioMerge: false
    });
  });
  
  // Sort by quality number (ascending)
  qualityOptions.sort((a, b) => a.qualityNum - b.qualityNum);
  
  console.log(`✅ Created ${qualityOptions.length} quality options`);
  
  // ========================================
  // SELECT DEFAULT FORMAT
  // ========================================
  
  // Default to 360p with audio (free), or highest available with audio
  let selectedFormat = qualityOptions.find(opt => 
    opt.qualityNum === 360 && opt.hasAudio && !opt.requiresAudioMerge
  );
  
  if (!selectedFormat) {
    // Fallback: Find any format with audio that doesn't require merging
    selectedFormat = qualityOptions.find(opt => 
      opt.hasAudio && !opt.requiresAudioMerge
    );
  }
  
  if (!selectedFormat) {
    // Last resort: use first available
    selectedFormat = qualityOptions[0];
  }
  
  // ========================================
  // BUILD RESULT
  // ========================================
  
  const result = {
    title: data.title,
    thumbnail: data.cover,
    duration: data.duration,
    isShorts: isShorts,
    formats: qualityOptions,
    allFormats: qualityOptions,
    url: selectedFormat.url,
    selectedQuality: selectedFormat,
    audioGuaranteed: selectedFormat.hasAudio && !selectedFormat.requiresAudioMerge,
    
    // Metadata for client
    hasHighQualityOptions: qualityOptions.some(f => f.qualityNum > 360),
    requiresAudioMerging: qualityOptions.some(f => f.requiresAudioMerge),
    bestAudioUrl: audioOnly.length > 0 ? audioOnly[audioOnly.length - 1].url : null
  };
  
  console.log(`✅ YouTube service completed`);
  console.log(`   📋 Total options: ${qualityOptions.length}`);
  console.log(`   🎯 Default: ${selectedFormat.quality} (requires merge: ${selectedFormat.requiresAudioMerge})`);
  console.log(`   🔊 Audio merging needed for HD: ${result.requiresAudioMerging}`);
  
  return result;
}

/**
 * Extract quality number from quality label (for video)
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
 * Extract bitrate number from audio quality label
 */
function extractBitrateNumber(qualityLabel) {
  if (!qualityLabel) return 0;
  
  const match = qualityLabel.match(/(\d+)kb\/s/);
  if (match) return parseInt(match[1]);
  
  // Default audio bitrates if not specified
  if (qualityLabel.includes('opus')) return 128;
  if (qualityLabel.includes('m4a')) return 128;
  
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
