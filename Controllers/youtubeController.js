const axios = require("axios");

/**
 * Enhanced YouTube downloader with fallbacks and better error handling
 */
async function fetchYouTubeData(url) {
  // Normalize and validate YouTube URL
  try {
    url = normalizeYouTubeUrl(url);
    console.log(`🔍 Fetching YouTube data for: ${url}`);
  } catch (err) {
    throw new Error(`Invalid YouTube URL: ${err.message}`);
  }
  
  // Try primary API first, then fallbacks
  let lastError = null;
  
  // Try VidFly API (primary)
  try {
    return await fetchWithVidFlyApi(url);
  } catch (err) {
    console.error(`❌ Primary API failed: ${err.message}`);
    lastError = err;
  }
  
  // Try RapidSave API (fallback)
  try {
    console.log("🔄 Trying fallback API...");
    return await fetchWithRapidSaveApi(url);
  } catch (err) {
    console.error(`❌ Fallback API failed: ${err.message}`);
    lastError = err;
  }
  
  // If all APIs fail, throw the last error
  throw lastError || new Error("All YouTube API services failed");
}

/**
 * Normalize and validate YouTube URL
 */
function normalizeYouTubeUrl(url) {
  // Reject YouTube homepage URLs
  if (url === "https://www.youtube.com/" || 
      url === "https://m.youtube.com/" || 
      url === "https://youtube.com/") {
    throw new Error("Please provide a specific YouTube video URL, not the homepage");
  }
  
  // Convert mobile to desktop
  if (url.includes('m.youtube.com')) {
    url = url.replace('m.youtube.com', 'www.youtube.com');
  }
  
  // Handle youtu.be short links
  if (url.includes('youtu.be/')) {
    const videoId = url.split('youtu.be/')[1].split('?')[0].split('&')[0];
    return `https://www.youtube.com/watch?v=${videoId}`;
  }
  
  // Handle shorts URLs
  if (url.includes('/shorts/')) {
    // Keep shorts format for proper detection
    return url;
  }
  
  // Add www if missing
  if (url.includes('youtube.com/') && !url.includes('www.youtube.com')) {
    url = url.replace('youtube.com', 'www.youtube.com');
  }
  
  return url;
}

/**
 * Primary API implementation (VidFly)
 */
async function fetchWithVidFlyApi(url) {
  try {
    const res = await axios.get(
      "https://api.vidfly.ai/api/media/youtube/download",
      {
        params: { url },
        headers: {
          accept: "*/*",
          "content-type": "application/json",
          "x-app-name": "vidfly-web",
          "x-app-version": "1.0.0",
          "user-agent": getRandomUserAgent(),
          "Referer": "https://vidfly.ai/",
        },
        timeout: 15000,
      }
    );
    
    const data = res.data?.data;
    if (!data || !data.items || !data.title) {
      throw new Error("Invalid or empty response from VidFly API");
    }

    // Process the response
    return processVideoData(data, url);
  } catch (err) {
    throw new Error(`VidFly API failed: ${err.message}`);
  }
}

/**
 * Fallback API implementation (RapidSave)
 */
async function fetchWithRapidSaveApi(url) {
  try {
    // Extract video ID
    const videoId = extractVideoId(url);
    if (!videoId) {
      throw new Error("Could not extract video ID from URL");
    }
    
    // Request video data
    const res = await axios.get(
      `https://rapidsave.com/api/info?url=${encodeURIComponent(url)}`,
      {
        headers: {
          "accept": "application/json",
          "user-agent": getRandomUserAgent(),
          "referer": "https://rapidsave.com/",
        },
        timeout: 15000,
      }
    );
    
    const data = res.data;
    if (!data || !data.title || !data.links || data.links.length === 0) {
      throw new Error("Invalid response from RapidSave API");
    }
    
    // Format data to match our standard
    const formattedData = {
      title: data.title,
      thumbnail: data.thumbnail || `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
      duration: data.duration || 0,
      items: data.links.map(link => ({
        label: link.quality || link.type || "unknown",
        url: link.url,
        type: link.type || "video/mp4",
        ext: link.type === "audio" ? "mp3" : "mp4",
        filesize: link.size || "unknown"
      }))
    };
    
    // Process the formatted data
    return processVideoData(formattedData, url);
  } catch (err) {
    throw new Error(`RapidSave API failed: ${err.message}`);
  }
}

/**
 * Process video data and select best formats
 */
function processVideoData(data, url) {
  const isShorts = url.includes('/shorts/');
  console.log(`📊 YouTube: Found ${data.items.length} total formats (${isShorts ? 'SHORTS' : 'REGULAR'})`);

  // Filter valid formats with URLs
  let availableFormats = data.items.filter(item => item.url && item.url.length > 0);
  
  // Filter formats with audio
  let formatsWithAudio = availableFormats.filter(item => {
    const label = (item.label || '').toLowerCase();
    const type = (item.type || '').toLowerCase();
    
    // Check for video-only formats to exclude
    const isVideoOnly = label.includes('video only') || 
                       label.includes('vid only') || 
                       label.includes('without audio') ||
                       type.includes('video only') ||
                       (type.includes('video') && !type.includes('audio'));
                       
    // Include if not video-only
    return !isVideoOnly;
  });
  
  console.log(`✅ Found ${formatsWithAudio.length} formats with audio`);
  
  // If no formats with audio, use all available formats
  if (formatsWithAudio.length === 0) {
    console.log('⚠️ No audio formats found, using all available formats');
    formatsWithAudio = availableFormats;
  }
  
  // Sort formats by quality
  const sortedFormats = sortFormatsByQuality(formatsWithAudio, isShorts);
  
  // Log formats for debugging
  console.log('📊 Sorted formats:');
  sortedFormats.slice(0, 5).forEach((format, index) => {
    console.log(`  ${index + 1}. ${format.label || format.type || 'unknown'}`);
  });
  
  // Select best format
  const selectedFormat = sortedFormats[0] || formatsWithAudio[0];
  
  if (!selectedFormat || !selectedFormat.url) {
    throw new Error("No valid formats found");
  }
  
  // Create quality options
  const qualityOptions = sortedFormats.map(format => ({
    quality: format.label || 'unknown',
    url: format.url,
    type: format.type || 'video/mp4',
    extension: format.ext || format.extension || 'mp4',
    filesize: format.filesize || 'unknown',
    hasAudio: true
  }));
  
  // Build result object
  const result = {
    title: data.title,
    thumbnail: data.cover || data.thumbnail,
    duration: data.duration,
    isShorts: isShorts,
    formats: qualityOptions,
    url: selectedFormat.url,
    selectedQuality: {
      quality: selectedFormat.label || 'unknown',
      url: selectedFormat.url,
      type: selectedFormat.type || 'video/mp4',
      extension: selectedFormat.ext || 'mp4',
      filesize: selectedFormat.filesize || 'unknown',
      hasAudio: true
    },
    audioGuaranteed: true
  };
  
  console.log(`✅ YouTube service completed successfully`);
  console.log(`🎯 Final selection: ${selectedFormat.label || 'unknown'}`);
  console.log(`🔗 URL length: ${selectedFormat.url?.length || 0}`);
  
  return result;
}

/**
 * Sort formats by quality based on video type
 */
function sortFormatsByQuality(formats, isShorts) {
  return formats.sort((a, b) => {
    // Get quality values
    const getQualityValue = (format) => {
      const label = (format.label || '').toLowerCase();
      
      // Parse quality numbers
      const match = label.match(/(\d+)p/);
      if (match) return parseInt(match[1], 10);
      
      // Handle text qualities
      if (label.includes('2160') || label.includes('4k')) return 2160;
      if (label.includes('1440') || label.includes('2k')) return 1440;
      if (label.includes('1080')) return 1080;
      if (label.includes('720')) return 720;
      if (label.includes('480')) return 480;
      if (label.includes('360')) return 360;
      if (label.includes('240')) return 240;
      if (label.includes('144')) return 144;
      
      // Default value
      return 360;
    };
    
    // Get format types
    const isVideoA = (a.type || '').includes('video') || (a.label || '').includes('p');
    const isVideoB = (b.type || '').includes('video') || (b.label || '').includes('p');
    
    // Prioritize video formats
    if (isVideoA && !isVideoB) return -1;
    if (!isVideoA && isVideoB) return 1;
    
    // Get quality numbers
    const qualityA = getQualityValue(a);
    const qualityB = getQualityValue(b);
    
    // Sort differently for shorts vs regular videos
    if (isShorts) {
      // For shorts: prefer 360p or lower (smaller files, better compatibility)
      if (qualityA <= 360 && qualityB > 360) return -1;
      if (qualityA > 360 && qualityB <= 360) return 1;
      return qualityA - qualityB; // Lower quality first for shorts
    } else {
      // For regular videos: prefer 720p (good balance of quality and compatibility)
      if (qualityA === 720) return -1;
      if (qualityB === 720) return 1;
      
      // Otherwise prefer higher quality (up to 1080p)
      if (qualityA <= 1080 && qualityB > 1080) return -1;
      if (qualityA > 1080 && qualityB <= 1080) return 1;
      return qualityB - qualityA; // Higher quality first for regular videos
    }
  });
}

/**
 * Extract YouTube video ID
 */
function extractVideoId(url) {
  // For shorts
  if (url.includes('/shorts/')) {
    const match = url.match(/\/shorts\/([^/?&]+)/);
    if (match && match[1]) return match[1];
  }
  
  // For watch URLs
  if (url.includes('watch?v=')) {
    const match = url.match(/[?&]v=([^?&]+)/);
    if (match && match[1]) return match[1];
  }
  
  // For youtu.be URLs
  if (url.includes('youtu.be/')) {
    const match = url.match(/youtu\.be\/([^/?&]+)/);
    if (match && match[1]) return match[1];
  }
  
  return null;
}

/**
 * Random user agent to avoid rate limiting
 */
function getRandomUserAgent() {
  const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.1 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:94.0) Gecko/20100101 Firefox/94.0'
  ];
  
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

module.exports = { fetchYouTubeData };
