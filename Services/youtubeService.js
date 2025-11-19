const axios = require("axios");
const audioMergerService = require("./audioMergerService");

/**
 * Fetches YouTube video data with automatic audio merging
 */
async function fetchYouTubeData(url) {
  const normalizedUrl = normalizeYouTubeUrl(url);
  console.log(`🔍 Fetching YouTube data for: ${normalizedUrl}`);
  
  let attempts = 0;
  const maxAttempts = 3;
  let lastError = null;
  
  while (attempts < maxAttempts) {
    attempts++;
    try {
      return await fetchWithVidFlyApi(normalizedUrl, attempts);
    } catch (err) {
      lastError = err;
      console.error(`❌ Attempt ${attempts}/${maxAttempts} failed: ${err.message}`);
      
      if (attempts < maxAttempts) {
        const backoffMs = Math.min(1000 * Math.pow(2, attempts - 1), 8000);
        console.log(`⏱️ Retrying in ${backoffMs/1000} seconds...`);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
      }
    }
  }
  
  throw new Error(`YouTube download failed after ${maxAttempts} attempts: ${lastError.message}`);
}

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
    return url;
  }
  
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
      throw new Error("Invalid or empty response from YouTube downloader API");
    }
    
    return processYouTubeData(data, url);
  } catch (err) {
    console.error(`❌ YouTube API error on attempt ${attemptNum}:`, err.message);
    
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
    
    throw new Error(`YouTube downloader API request failed: ${err.message}`);
  }
}

/**
 * Process YouTube data with automatic audio merging
 * FIXED: Better MERGE URL encoding to avoid parsing issues
 */
function processYouTubeData(data, url) {
  const isShorts = url.includes('/shorts/');
  console.log(`📊 YouTube: Found ${data.items.length} total formats (${isShorts ? 'SHORTS' : 'REGULAR'})`);
  
  // Get ALL formats that have a valid URL
  let availableFormats = data.items.filter(item => {
    return item.url && item.url.length > 0;
  });
  
  console.log(`✅ Found ${availableFormats.length} total formats with URLs`);
  
// Detect audio presence - STRICT DETECTION
const formatWithAudioInfo = availableFormats.map(item => {
  const label = (item.label || '').toLowerCase();
  const type = (item.type || '').toLowerCase();
  
  // Audio only formats
  const isAudioOnly = type.includes('audio/') ||
                     label.match(/^\d+kb\/s/) ||
                     label.includes('m4a (') ||
                     label.includes('opus (');
  
  // Video formats are video-only UNLESS explicitly marked as having audio
  const isVideoFormat = type.includes('video/') || 
                       label.includes('p)') ||  // "720p)", "480p)"
                       label.includes('webm');
  
  // Only mark as having audio if it's explicitly a merged format from API
  // Otherwise assume video-only (needs merging)
  const hasAudio = !isAudioOnly && !isVideoFormat;
  const isVideoOnly = isVideoFormat && !hasAudio;
  
  return {
    ...item,
    hasAudio: hasAudio,
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
  // FIXED: Use base64 encoding to avoid URL parsing issues
  // ========================================
  
  const mergedFormats = [];
  
  availableFormats.forEach(format => {
    if (format.isVideoOnly && audioFormats.length > 0) {
      // Find compatible audio for this video format
      const compatibleAudio = audioMergerService.findCompatibleAudio(format, audioFormats);
      
      if (compatibleAudio) {
        console.log(`🎵 Found audio for ${format.label}: ${compatibleAudio.label}`);
        
        // FIXED: Use base64 encoding to safely encode URLs
        const videoB64 = Buffer.from(format.url).toString('base64');
        const audioB64 = Buffer.from(compatibleAudio.url).toString('base64');
        
        // Create merged format entry with safe encoding
        const mergedFormat = {
          ...format,
          // Use pipe delimiter and base64 to avoid colon issues in URLs
          url: `MERGE_V2|${videoB64}|${audioB64}`,
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
      url: format.url, // This may be a MERGE_V2 URL for merged formats
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
  console.log(`📋 Sending formats:`, qualityOptions.map(f => {
    const type = f.isAudioOnly ? '🎵 Audio' : 
                 f.isMergedFormat ? '🎬 Merged' :
                 f.isVideoOnly ? '📹 Video' : '🎬 Video+Audio';
    return `${f.quality} (${type}, premium: ${f.isPremium})`;
  }));
  
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
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.1 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:94.0) Gecko/20100101 Firefox/94.0',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 15_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.1 Mobile/15E148 Safari/604.1'
  ];
  
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

module.exports = { fetchYouTubeData };
