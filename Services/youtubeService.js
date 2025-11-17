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
  
  // Filter formats with URLs only
  let availableFormats = data.items.filter(item => item.url && item.url.length > 0);
  
  console.log(`✅ Found ${availableFormats.length} formats with valid URLs`);
  
  // ========================================
  // CREATE QUALITY OPTIONS - ONE PER RESOLUTION
  // ========================================
  
  const qualityMap = new Map(); // Use Map to avoid duplicates
  
  availableFormats.forEach(format => {
    const label = (format.label || '').toLowerCase();
    const type = (format.type || '').toLowerCase();
    
    // Detect if it has audio
    const isVideoOnly = label.includes('video only') || 
                       label.includes('vid only') ||
                       label.includes('without audio') ||
                       type.includes('video only');
    
    const isAudioOnly = label.includes('audio only') || 
                       type.includes('audio only') ||
                       label.includes('m4a') ||
                       label.includes('opus');
    
    // Skip audio-only formats (for now)
    if (isAudioOnly) return;
    
    const quality = format.label || 'unknown';
    const qualityNum = extractQualityNumber(quality);
    
    // Skip if no valid quality detected
    if (qualityNum === 0) return;
    
    // Check if we already have this quality
    if (qualityMap.has(qualityNum)) {
      // Keep the one WITH audio if available
      const existing = qualityMap.get(qualityNum);
      if (existing.hasAudio) return; // Already have one with audio
      if (!isVideoOnly) {
        // Replace with one that has audio
        qualityMap.set(qualityNum, {
          quality: quality,
          qualityNum: qualityNum,
          url: format.url,
          type: format.type || 'video/mp4',
          extension: format.ext || format.extension || getExtensionFromType(format.type),
          filesize: format.filesize || 'unknown',
          isPremium: qualityNum > 360,
          hasAudio: true
        });
      }
      return;
    }
    
    // Add new quality
    qualityMap.set(qualityNum, {
      quality: quality,
      qualityNum: qualityNum,
      url: format.url,
      type: format.type || 'video/mp4',
      extension: format.ext || format.extension || getExtensionFromType(format.type),
      filesize: format.filesize || 'unknown',
      isPremium: qualityNum > 360,
      hasAudio: !isVideoOnly
    });
  });
  
  // Convert Map to Array and sort
  const qualityOptions = Array.from(qualityMap.values()).sort((a, b) => a.qualityNum - b.qualityNum);
  
  console.log(`✅ Created ${qualityOptions.length} unique quality options:`);
  qualityOptions.forEach(q => {
    console.log(`   ${q.quality} - Audio: ${q.hasAudio ? '✅' : '❌'} - Premium: ${q.isPremium}`);
  });
  
  // ========================================
  // SELECT DEFAULT FORMAT (360p with audio)
  // ========================================
  
  let selectedFormat = qualityOptions.find(opt => opt.qualityNum === 360 && opt.hasAudio);
  
  if (!selectedFormat) {
    selectedFormat = qualityOptions.find(opt => opt.hasAudio);
  }
  
  if (!selectedFormat) {
    selectedFormat = qualityOptions[0];
  }
  
  // ========================================
  // BUILD RESULT (SAME STRUCTURE AS BEFORE)
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
    audioGuaranteed: selectedFormat.hasAudio
  };
  
  console.log(`✅ YouTube service completed with ${qualityOptions.length} quality options`);
  console.log(`🎯 Selected default: ${selectedFormat.quality}`);
  
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
