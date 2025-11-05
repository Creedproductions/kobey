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
  // IMPROVED AUDIO FILTERING FOR ALL VIDEOS
  // ========================================
  
  let availableFormats = data.items.filter(item => {
    const label = (item.label || '').toLowerCase();
    const type = (item.type || '').toLowerCase();
    const hasUrl = item.url && item.url.length > 0;
    
    // Use stricter audio detection for ALL videos, not just shorts
    const isVideoOnly = label.includes('video only') || 
                       label.includes('vid only') ||
                       label.includes('without audio') ||
                       type.includes('video only') ||
                       (type.includes('video') && !type.includes('audio'));
    
    const isAudioOnly = label.includes('audio only') || 
                       type.includes('audio only');
    
    // Be more conservative - only accept formats we're confident have audio
    if (isShorts) {
      // For shorts: must have URL, not be video-only, and not be audio-only
      return hasUrl && !isVideoOnly && !isAudioOnly;
    } else {
      // For regular videos: must have URL and not be video-only
      // Using same strict filtering as shorts
      return hasUrl && !isVideoOnly;
    }
  });
  
  console.log(`✅ Found ${availableFormats.length} formats with audio after strict filtering`);
  
  // If no formats with audio found, try to find ANY format that might work
  if (availableFormats.length === 0) {
    console.log('🚨 No audio formats found, emergency fallback...');
    
    // Emergency fallback: take any format that has a URL
    availableFormats = data.items.filter(item => {
      const label = (item.label || '').toLowerCase();
      const hasUrl = item.url && item.url.length > 0;
      
      // Still exclude obvious audio-only formats for shorts
      const isAudioOnly = label.includes('audio only');
      
      return hasUrl && (isShorts ? !isAudioOnly : true);
    });
    
    console.log(`🆘 Emergency fallback found ${availableFormats.length} formats`);
  }
  
  // If STILL no formats, use everything that has a URL
  if (availableFormats.length === 0) {
    console.log('💀 Using ALL available formats as last resort');
    availableFormats = data.items.filter(item => item.url && item.url.length > 0);
  }
  
  // Log filtered formats for debugging
  console.log('🔊 Audio-compatible formats:');
  availableFormats.forEach((format, index) => {
    const label = (format.label || '').toLowerCase();
    const hasAudio = !label.includes('video only') && !label.includes('audio only');
    console.log(`  ${index + 1}. ${format.label} - Audio: ${hasAudio ? '✅' : '❌'}`);
  });
  
  // ========================================
  // IMPROVED FORMAT PRIORITIZATION
  // ========================================
  
  // Prefer mp4 formats for better compatibility
  const formatPriority = (format) => {
    const label = (format.label || '').toLowerCase();
    const type = (format.type || '').toLowerCase();
    
    // Give higher priority to mp4 format with audio
    if (type.includes('mp4') && !label.includes('video only')) {
      return 10;
    }
    // Medium priority to other video formats with audio
    else if (type.includes('video') && !label.includes('video only')) {
      return 5;
    }
    // Lower priority to audio-only formats for regular videos
    else if (type.includes('audio') || label.includes('audio only')) {
      return 1;
    }
    return 0;
  };
  
  // Sort formats by quality, with improved priority handling
  availableFormats.sort((a, b) => {
    // First, prioritize by format type
    const priorityA = formatPriority(a);
    const priorityB = formatPriority(b);
    
    if (priorityA !== priorityB) {
      return priorityB - priorityA; // Higher priority first
    }
    
    // Then, handle quality-based sorting
    const getQualityValue = (label) => {
      if (!label) return isShorts ? 9999 : 0;
      
      const labelLower = label.toLowerCase();
      const match = labelLower.match(/(\d+)p/);
      if (match) return parseInt(match[1]);
      
      if (labelLower.includes('1440') || labelLower.includes('2k')) return 1440;
      if (labelLower.includes('2160') || labelLower.includes('4k')) return 2160;
      if (labelLower.includes('1080')) return 1080;
      if (labelLower.includes('720')) return 720;
      if (labelLower.includes('480')) return 480;
      if (labelLower.includes('360')) return 360;
      if (labelLower.includes('240')) return 240;
      if (labelLower.includes('144')) return 144;
      
      return isShorts ? 9999 : 0;
    };
    
    const qualityA = getQualityValue(a.label);
    const qualityB = getQualityValue(b.label);
    
    // For Shorts: prefer lower qualities (better audio compatibility)
    // For regular videos: prefer higher qualities but cap at 720p for better reliability
    if (isShorts) {
      return qualityA - qualityB; // Ascending for shorts
    } else {
      // Prefer 720p or lower for regular videos (more reliable)
      if (qualityA <= 720 && qualityB <= 720) {
        return qualityB - qualityA; // Descending within 720p and below
      } else if (qualityA <= 720) {
        return -1; // Prefer A if it's 720p or below
      } else if (qualityB <= 720) {
        return 1; // Prefer B if it's 720p or below
      } else {
        return qualityB - qualityA; // Otherwise descending
      }
    }
  });
  
  console.log('📊 Sorted formats with improved priorities:');
  availableFormats.forEach((format, index) => {
    console.log(`  ${index + 1}. ${format.label || format.type || 'unknown'}`);
  });
  
  // ========================================
  // IMPROVED QUALITY SELECTION
  // ========================================
  
  const qualityOptions = availableFormats.map(format => {
    const quality = format.label || 'unknown';
    const type = (format.type || '').toLowerCase();
    
    // Mark as premium based on format and type
    const isPremiumOnly = isShorts ? 
      !['360p', '240p', '144p'].some(q => (quality.toLowerCase() || '').includes(q)) :
      !['360p', '480p', '720p'].some(q => (quality.toLowerCase() || '').includes(q));
    
    return {
      quality: quality,
      url: format.url,
      type: format.type || 'video/mp4',
      extension: format.ext || format.extension || getExtensionFromType(type),
      filesize: format.filesize || 'unknown',
      isPremium: isPremiumOnly,
      hasAudio: !(quality.toLowerCase() || '').includes('video only')
    };
  });
  
  // ========================================
  // IMPROVED FORMAT SELECTION LOGIC
  // ========================================
  
  let selectedFormat = availableFormats[0];
  let selectedQualityOption = qualityOptions[0];
  
  if (isShorts) {
    console.log('🎬 SHORTS DETECTED - Using optimized shorts selection');
    
    // SHORTS: Prefer 360p, 240p, or 144p with confirmed audio
    const shortsSafeQualities = ['360p', '240p', '144p'];
    let foundSafeFormat = false;
    
    for (const safeQuality of shortsSafeQualities) {
      const formatIndex = availableFormats.findIndex((format, index) => {
        const quality = (format.label || '').toLowerCase();
        return quality.includes(safeQuality) && qualityOptions[index]?.hasAudio;
      });
      
      if (formatIndex !== -1) {
        selectedFormat = availableFormats[formatIndex];
        selectedQualityOption = qualityOptions[formatIndex];
        foundSafeFormat = true;
        console.log(`✅ Selected Shorts quality: ${selectedQualityOption.quality} (AUDIO SAFE)`);
        break;
      }
    }
    
    // If no safe quality found, use first format with audio
    if (!foundSafeFormat) {
      const audioFormatIndex = availableFormats.findIndex((format, index) => 
        qualityOptions[index]?.hasAudio
      );
      
      if (audioFormatIndex !== -1) {
        selectedFormat = availableFormats[audioFormatIndex];
        selectedQualityOption = qualityOptions[audioFormatIndex];
        console.log(`🔄 Using first audio format for Shorts: ${selectedQualityOption.quality}`);
      } else {
        console.log('⚠️ WARNING: No audio formats found for Shorts!');
      }
    }
  } else {
    // REGULAR VIDEOS: Prefer mp4 format with 720p or lower for reliability
    console.log('🎥 REGULAR VIDEO - Using optimized video selection');
    
    const preferredFormats = ['mp4', 'webm'];
    const preferredQualities = ['720p', '480p', '360p'];
    let foundIdealFormat = false;
    
    // First try: Find mp4 with preferred quality
    for (const format of preferredFormats) {
      if (foundIdealFormat) break;
      
      for (const quality of preferredQualities) {
        const formatIndex = availableFormats.findIndex((item, index) => {
          const itemType = (item.type || '').toLowerCase();
          const itemQuality = (item.label || '').toLowerCase();
          return itemType.includes(format) && 
                 itemQuality.includes(quality) && 
                 qualityOptions[index]?.hasAudio;
        });
        
        if (formatIndex !== -1) {
          selectedFormat = availableFormats[formatIndex];
          selectedQualityOption = qualityOptions[formatIndex];
          foundIdealFormat = true;
          console.log(`✅ Found ideal format: ${format} ${quality} with audio`);
          break;
        }
      }
    }
    
    // If no ideal format, use first mp4 with audio
    if (!foundIdealFormat) {
      const mp4Index = availableFormats.findIndex((item, index) => {
        const itemType = (item.type || '').toLowerCase();
        return itemType.includes('mp4') && qualityOptions[index]?.hasAudio;
      });
      
      if (mp4Index !== -1) {
        selectedFormat = availableFormats[mp4Index];
        selectedQualityOption = qualityOptions[mp4Index];
        console.log(`✅ Using mp4 format: ${selectedQualityOption.quality}`);
      } else {
        console.log(`⚠️ No mp4 with audio found, using first format with audio`);
      }
    }
  }
  
  // Safety check to ensure we have a URL
  if (!selectedFormat?.url) {
    console.log('⚠️ Selected format has no URL! Falling back to first format with URL');
    const firstWithUrl = availableFormats.find(f => f.url && f.url.length > 0);
    if (firstWithUrl) {
      selectedFormat = firstWithUrl;
      const firstIndex = availableFormats.indexOf(firstWithUrl);
      selectedQualityOption = qualityOptions[firstIndex];
    } else {
      throw new Error('No formats with valid URLs found');
    }
  }
  
  // Build result object with consistent selectedQuality property
  const result = {
    title: data.title,
    thumbnail: data.cover,
    duration: data.duration,
    isShorts: isShorts,
    formats: qualityOptions,
    url: selectedFormat.url,
    selectedQuality: selectedQualityOption,
    audioGuaranteed: selectedQualityOption?.hasAudio || false
  };
  
  console.log(`✅ YouTube service completed successfully`);
  console.log(`🎯 Final selection: ${selectedQualityOption.quality}`);
  console.log(`🔊 Audio guaranteed: ${result.audioGuaranteed}`);
  console.log(`📺 Is Shorts: ${isShorts}`);
  console.log(`🔗 URL length: ${selectedFormat.url?.length || 0}`);
  
  // Validate URL before returning
  if (!selectedFormat.url || selectedFormat.url.length < 10) {
    throw new Error(`Invalid URL selected: ${selectedFormat.url}`);
  }
  
  return result;
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
