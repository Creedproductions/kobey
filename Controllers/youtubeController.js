const axios = require("axios");

/**
 * Enhanced YouTube downloader with better URL validation
 */
async function fetchYouTubeData(url) {
  try {
    // Validate URL before making any API calls
    if (!isValidVideoUrl(url)) {
      throw new Error("Not a valid YouTube video URL. Please provide a direct video link.");
    }
    
    // Normalize URL
    const normalizedUrl = normalizeYouTubeUrl(url);
    console.log(`🔍 Fetching YouTube data for: ${normalizedUrl}`);
    
    // Try primary API with retries
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const result = await fetchWithApi(normalizedUrl, attempt);
        return result;
      } catch (err) {
        lastError = err;
        console.error(`❌ API attempt ${attempt}/3 failed: ${err.message}`);
        
        if (attempt < 3) {
          const delay = attempt * 1000; // Increase delay with each attempt
          console.log(`⏱️ Retrying in ${delay/1000} seconds...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    
    throw new Error(`YouTube download failed after 3 attempts: ${lastError?.message}`);
  } catch (err) {
    throw new Error(`YouTube downloader request failed: ${err.message}`);
  }
}

/**
 * Check if URL is a valid YouTube video URL
 */
function isValidVideoUrl(url) {
  // Reject homepage URLs
  if (url === "https://www.youtube.com/" || 
      url === "https://m.youtube.com/" || 
      url === "https://youtube.com/") {
    return false;
  }
  
  // Reject channel URLs
  if (url.includes("youtube.com/@") || url.includes("youtube.com/channel/")) {
    return false;
  }
  
  // Must be a watch URL, shorts URL, or youtu.be URL
  const isWatchUrl = url.includes("youtube.com/watch");
  const isShortsUrl = url.includes("youtube.com/shorts");
  const isYoutuBeUrl = url.includes("youtu.be/");
  
  return isWatchUrl || isShortsUrl || isYoutuBeUrl;
}

/**
 * Normalize YouTube URL to standard format
 */
function normalizeYouTubeUrl(url) {
  // Convert mobile to desktop
  if (url.includes('m.youtube.com')) {
    url = url.replace('m.youtube.com', 'www.youtube.com');
  }
  
  // Handle short youtu.be links
  if (url.includes('youtu.be/')) {
    const videoId = url.split('youtu.be/')[1].split('?')[0].split('&')[0];
    return `https://www.youtube.com/watch?v=${videoId}`;
  }
  
  // Add www if missing
  if (url.includes('youtube.com/') && !url.includes('www.youtube.com')) {
    url = url.replace('youtube.com', 'www.youtube.com');
  }
  
  return url;
}

/**
 * Fetch YouTube data from API
 */
async function fetchWithApi(url, attempt) {
  // Use different user agents and increased timeouts for later attempts
  const timeout = 15000 + (attempt * 5000); // 15-30s timeout
  
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
        timeout: timeout,
      }
    );
    
    const data = res.data?.data;
    if (!data || !data.items || !data.title) {
      throw new Error("Invalid or empty response from YouTube downloader API");
    }
    
    return processYouTubeData(data, url);
  } catch (err) {
    // Add more specific error messages
    if (err.code === 'ECONNABORTED') {
      throw new Error(`Connection timeout (${timeout}ms exceeded)`);
    } else if (err.response) {
      throw new Error(`API error: ${err.response.status} - ${err.response.statusText}`);
    } else {
      throw err;
    }
  }
}

/**
 * Process YouTube data to select formats
 */
function processYouTubeData(data, url) {
  const isShorts = url.includes('/shorts/');
  console.log(`📊 YouTube: Found ${data.items.length} total formats (${isShorts ? 'SHORTS' : 'REGULAR'})`);
  
  // Step 1: Filter for formats with URLs
  let availableFormats = data.items.filter(item => item.url && item.url.length > 0);
  
  // Step 2: Filter for formats with audio
  let formatsWithAudio = availableFormats.filter(item => {
    const label = (item.label || '').toLowerCase();
    const type = (item.type || '').toLowerCase();
    
    const isVideoOnly = label.includes('video only') || 
                        label.includes('vid only') ||
                        label.includes('without audio') ||
                        type.includes('video only');
    
    return !isVideoOnly;
  });
  
  console.log(`✅ Found ${formatsWithAudio.length} formats with audio after filtering`);
  
  // If no formats with audio found, use all formats
  if (formatsWithAudio.length === 0) {
    console.log('⚠️ No formats with audio found, using all available formats');
    formatsWithAudio = availableFormats;
  }
  
  // Step 3: Sort formats for optimal selection
  let preferredFormats = sortFormats(formatsWithAudio, isShorts);
  
  console.log('📊 Preferred formats:');
  preferredFormats.slice(0, 5).forEach((format, index) => {
    console.log(`  ${index + 1}. ${format.label || 'unknown'}`);
  });
  
  // Step 4: Select best format
  let selectedFormat = preferredFormats[0];
  if (!selectedFormat) {
    throw new Error("No suitable format found");
  }
  
  // Step 5: Create quality options
  const qualityOptions = formatsWithAudio.map(format => {
    return {
      quality: format.label || 'unknown',
      url: format.url,
      type: format.type || 'video/mp4',
      extension: format.ext || format.extension || 'mp4',
      filesize: format.filesize || 'unknown',
      hasAudio: true
    };
  });
  
  // Step 6: Build and return result
  const result = {
    title: data.title,
    thumbnail: data.cover,
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
 * Sort formats based on video type (shorts vs regular)
 */
function sortFormats(formats, isShorts) {
  return formats.sort((a, b) => {
    const getQuality = (format) => {
      const label = (format.label || '').toLowerCase();
      
      // Extract quality value from label
      const match = label.match(/(\d+)p/);
      if (match) return parseInt(match[1]);
      
      if (label.includes('1080')) return 1080;
      if (label.includes('720')) return 720;
      if (label.includes('480')) return 480;
      if (label.includes('360')) return 360;
      if (label.includes('240')) return 240;
      if (label.includes('144')) return 144;
      
      return 0;
    };
    
    // Give MP4 formats higher priority
    const isMP4A = (a.type || '').includes('mp4') || (a.label || '').includes('mp4');
    const isMP4B = (b.type || '').includes('mp4') || (b.label || '').includes('mp4');
    
    if (isMP4A && !isMP4B) return -1;
    if (!isMP4A && isMP4B) return 1;
    
    // Get quality values
    const qualityA = getQuality(a);
    const qualityB = getQuality(b);
    
    // For Shorts: prefer lower quality (better compatibility)
    if (isShorts) {
      // Prefer 360p for Shorts (best compatibility)
      if (qualityA === 360) return -1;
      if (qualityB === 360) return 1;
      
      // Otherwise prefer lower quality
      return qualityA - qualityB;
    } else {
      // For regular videos: prefer 720p (good balance)
      if (qualityA === 720) return -1;
      if (qualityB === 720) return 1;
      
      // Otherwise prefer higher quality but cap at 1080p
      if (qualityA <= 1080 && qualityB > 1080) return -1;
      if (qualityA > 1080 && qualityB <= 1080) return 1;
      
      return qualityB - qualityA;
    }
  });
}

/**
 * Get random user agent to avoid rate limiting
 */
function getRandomUserAgent() {
  const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.75 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.4 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/112.0',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.4 Mobile/15E148 Safari/604.1'
  ];
  
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

module.exports = { fetchYouTubeData };
