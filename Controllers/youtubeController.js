const axios = require("axios");
const querystring = require("querystring");

/**
 * Enhanced YouTube downloader with multiple API fallbacks and robust error handling
 * @param {string} url YouTube video URL
 * @returns {Promise<object>} Processed video data
 */
async function fetchYouTubeData(url) {
  // Normalize YouTube URL format
  const normalizedUrl = normalizeYouTubeUrl(url);
  console.log(`🔍 Fetching YouTube data for: ${normalizedUrl}`);
  
  // Configure request timeouts and retries
  const maxRetries = 3;
  const timeout = 15000; // 15 seconds
  
  // Configure API endpoints (multiple services)
  const apiServices = [
    {
      name: "vidfly",
      fn: async () => await fetchWithVidFlyApi(normalizedUrl, timeout)
    },
    {
      name: "rapidsave",
      fn: async () => await fetchWithRapidSaveApi(normalizedUrl, timeout)
    },
    {
      name: "y2mate",
      fn: async () => await fetchWithY2MateApi(normalizedUrl, timeout) 
    },
    {
      name: "ytdl",
      fn: async () => await fetchWithGenericYTDLApi(normalizedUrl, timeout)
    }
  ];
  
  // Try each API service with retries
  for (const service of apiServices) {
    console.log(`🔄 Trying ${service.name} API service...`);
    
    let lastError = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await service.fn();
        console.log(`✅ Successfully fetched data using ${service.name} API service`);
        return result;
      } catch (err) {
        lastError = err;
        console.error(`❌ ${service.name} API attempt ${attempt}/${maxRetries} failed: ${err.message}`);
        
        if (attempt < maxRetries) {
          const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
          console.log(`⏱️ Retrying in ${backoffMs/1000} seconds...`);
          await new Promise(resolve => setTimeout(resolve, backoffMs));
        }
      }
    }
    
    console.error(`❌ All attempts with ${service.name} API failed. Trying next service...`);
  }
  
  // If we get here, all services failed
  throw new Error("Failed to fetch YouTube data from all available services");
}

/**
 * Normalizes various YouTube URL formats
 */
function normalizeYouTubeUrl(url) {
  // Convert mobile links to desktop
  if (url.includes('m.youtube.com')) {
    url = url.replace('m.youtube.com', 'www.youtube.com');
  }
  
  // Convert shortened youtu.be links
  if (url.includes('youtu.be/')) {
    const videoId = url.split('youtu.be/')[1].split('?')[0].split('&')[0];
    return `https://www.youtube.com/watch?v=${videoId}`;
  }
  
  // Handle YouTube shorts
  if (url.includes('youtube.com/shorts/')) {
    const videoId = url.match(/shorts\/([^/?&]+)/)[1];
    if (videoId) {
      // Keep as shorts link for proper detection
      return `https://www.youtube.com/shorts/${videoId}`;
    }
  }
  
  // Handle YouTube music
  if (url.includes('music.youtube.com')) {
    return url.replace('music.youtube.com', 'www.youtube.com');
  }
  
  // Handle YouTube watch links without www
  if (url.includes('youtube.com/watch') && !url.includes('www.youtube.com')) {
    url = url.replace('youtube.com', 'www.youtube.com');
  }

  // Handle empty paths or homepage
  if (url === 'https://www.youtube.com/' || url === 'https://m.youtube.com/') {
    throw new Error("Please provide a specific YouTube video URL, not the homepage");
  }
  
  // Ensure https protocol
  if (!url.startsWith('https://') && !url.startsWith('http://')) {
    url = 'https://' + url;
  }
  
  return url;
}

/**
 * Primary API implementation using vidfly.ai
 */
async function fetchWithVidFlyApi(url, timeout) {
  try {
    console.log(`🔍 Fetching with VidFly API: ${url}`);
    
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
      throw new Error("Invalid or empty response from VidFly API");
    }

    console.log(`📊 YouTube: Found ${data.items.length} total formats`);
    return processYouTubeFormats(data, url);
  } catch (err) {
    if (err.response) {
      console.error(`📡 Response status: ${err.response.status}`);
      if (err.response.data) {
        const responsePreview = typeof err.response.data === 'object' 
          ? JSON.stringify(err.response.data).substring(0, 200) 
          : err.response.data.substring(0, 200);
        console.error(`📡 Response data preview: ${responsePreview}...`);
      }
    }
    
    throw new Error(`VidFly API request failed: ${err.message}`);
  }
}

/**
 * Alternative API implementation using RapidSave
 */
async function fetchWithRapidSaveApi(url, timeout) {
  try {
    console.log(`🔍 Fetching with RapidSave API: ${url}`);
    
    const videoId = extractVideoId(url);
    if (!videoId) {
      throw new Error("Could not extract video ID from URL");
    }
    
    const res = await axios.get(
      `https://rapidsave.com/api/info?url=${encodeURIComponent(url)}`,
      {
        headers: {
          "accept": "application/json",
          "user-agent": getRandomUserAgent(),
          "referer": "https://rapidsave.com/",
        },
        timeout: timeout,
      }
    );
    
    const data = res.data;
    if (!data || !data.title || !data.links || data.links.length === 0) {
      throw new Error("Invalid or empty response from RapidSave API");
    }

    console.log(`📊 RapidSave: Found ${data.links.length} total formats`);
    
    // Format RapidSave response to match our standard format
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
    
    return processYouTubeFormats(formattedData, url);
  } catch (err) {
    throw new Error(`RapidSave API request failed: ${err.message}`);
  }
}

/**
 * Alternative API implementation using Y2Mate
 */
async function fetchWithY2MateApi(url, timeout) {
  try {
    console.log(`🔍 Fetching with Y2Mate API: ${url}`);
    
    const videoId = extractVideoId(url);
    if (!videoId) {
      throw new Error("Could not extract video ID from URL");
    }
    
    // First get the k token
    const payload = {
      vid: videoId,
      k_query: url,
      k_page: "home",
      hl: "en",
      q_auto: 0
    };
    
    const res1 = await axios.post(
      "https://www.y2mate.com/mates/analyzeV2/ajax",
      querystring.stringify(payload),
      {
        headers: {
          "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
          "accept": "*/*",
          "user-agent": getRandomUserAgent(),
          "referer": "https://www.y2mate.com/",
        },
        timeout: timeout,
      }
    );
    
    if (!res1.data.status || res1.data.status !== "success" || !res1.data.vid) {
      throw new Error("Failed to analyze video with Y2Mate");
    }
    
    const kToken = res1.data.k;
    const title = res1.data.title;
    const thumbnail = res1.data.thumbnail || `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;
    const duration = res1.data.t || 0;
    
    // Now get conversion links
    const conversionPayload = {
      vid: videoId,
      k: kToken
    };
    
    const res2 = await axios.post(
      "https://www.y2mate.com/mates/convertV2/index",
      querystring.stringify(conversionPayload),
      {
        headers: {
          "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
          "accept": "*/*",
          "user-agent": getRandomUserAgent(),
          "referer": "https://www.y2mate.com/",
        },
        timeout: timeout,
      }
    );
    
    if (!res2.data.status || res2.data.status !== "success" || !res2.data.links || Object.keys(res2.data.links).length === 0) {
      throw new Error("Failed to convert video with Y2Mate");
    }
    
    // Format Y2Mate response to match our standard format
    const items = [];
    
    // Process MP4 formats
    if (res2.data.links.mp4) {
      for (const [quality, data] of Object.entries(res2.data.links.mp4)) {
        if (data.k) {
          items.push({
            label: quality,
            url: data.k,
            type: "video/mp4",
            ext: "mp4",
            filesize: data.size || "unknown"
          });
        }
      }
    }
    
    // Process MP3/Audio formats
    if (res2.data.links.mp3) {
      for (const [quality, data] of Object.entries(res2.data.links.mp3)) {
        if (data.k) {
          items.push({
            label: `Audio ${quality}`,
            url: data.k,
            type: "audio/mp3",
            ext: "mp3",
            filesize: data.size || "unknown"
          });
        }
      }
    }
    
    console.log(`📊 Y2Mate: Found ${items.length} total formats`);
    
    const formattedData = {
      title: title,
      thumbnail: thumbnail,
      duration: duration,
      items: items
    };
    
    return processYouTubeFormats(formattedData, url);
  } catch (err) {
    throw new Error(`Y2Mate API request failed: ${err.message}`);
  }
}

/**
 * Another fallback API implementation - Generic YTDL service
 */
async function fetchWithGenericYTDLApi(url, timeout) {
  try {
    console.log(`🔍 Fetching with Generic YTDL API: ${url}`);
    
    const videoId = extractVideoId(url);
    if (!videoId) {
      throw new Error("Could not extract video ID from URL");
    }
    
    const res = await axios.get(
      `https://yt-api.p.rapidapi.com/dl?id=${videoId}`,
      {
        headers: {
          "X-RapidAPI-Key": "f4eb1e1c29msh77e589a31c26978p1aba4djsn30b8ae80f5fa", // Get a free API key from RapidAPI
          "X-RapidAPI-Host": "yt-api.p.rapidapi.com",
          "user-agent": getRandomUserAgent()
        },
        timeout: timeout,
      }
    );
    
    const data = res.data;
    if (!data || !data.title || !data.formats || data.formats.length === 0) {
      throw new Error("Invalid or empty response from Generic YTDL API");
    }
    
    console.log(`📊 Generic YTDL: Found ${data.formats.length} total formats`);
    
    // Format response to match our standard format
    const items = data.formats.map(format => ({
      label: format.qualityLabel || format.quality || "unknown",
      url: format.url,
      type: format.mimeType || "video/mp4",
      ext: format.container || "mp4",
      filesize: format.contentLength || "unknown",
      hasAudio: format.hasAudio || false
    })).filter(item => item.url); // Filter out items without URLs
    
    const formattedData = {
      title: data.title,
      thumbnail: data.thumbnail?.url || `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
      duration: data.lengthSeconds || 0,
      items: items
    };
    
    return processYouTubeFormats(formattedData, url);
  } catch (err) {
    throw new Error(`Generic YTDL API request failed: ${err.message}`);
  }
}

/**
 * Process YouTube formats and select the best ones
 */
function processYouTubeFormats(data, url) {
  const isShorts = url.includes('/shorts/');
  console.log(`🎥 Processing ${isShorts ? 'SHORTS' : 'REGULAR'} video`);

  // Filter out invalid formats
  let availableFormats = data.items.filter(item => {
    const hasUrl = item.url && item.url.length > 0;
    return hasUrl;
  });

  if (availableFormats.length === 0) {
    throw new Error("No valid formats with URLs found");
  }

  console.log(`✅ Found ${availableFormats.length} formats with valid URLs`);

  // Categorize formats
  const videoFormats = availableFormats.filter(item => {
    const type = (item.type || '').toLowerCase();
    const label = (item.label || '').toLowerCase();
    return (type.includes('video') || label.includes('p')) && !label.includes('audio only');
  });

  const audioFormats = availableFormats.filter(item => {
    const type = (item.type || '').toLowerCase();
    const label = (item.label || '').toLowerCase();
    return type.includes('audio') || label.includes('audio');
  });

  console.log(`📊 Video formats: ${videoFormats.length}, Audio formats: ${audioFormats.length}`);

  // Sort by quality
  const sortedFormats = sortFormatsByQuality(videoFormats, isShorts);
  
  // Log sorted formats
  console.log('📊 Sorted formats:');
  sortedFormats.slice(0, 5).forEach((format, index) => {
    console.log(`  ${index + 1}. ${format.label || format.type || 'unknown'}`);
  });

  // Select best format based on video type
  const selectedFormat = selectBestFormat(sortedFormats, audioFormats, isShorts);
  
  // Create quality options from available formats
  const qualityOptions = createQualityOptions(sortedFormats, audioFormats, isShorts);
  
  const result = {
    title: data.title,
    thumbnail: data.thumbnail,
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
 * Sort formats by quality, considering video type
 */
function sortFormatsByQuality(formats, isShorts) {
  return formats.sort((a, b) => {
    // Helper to extract quality value
    const getQualityValue = (format) => {
      const label = (format.label || '').toLowerCase();
      
      // Extract numeric quality if present (e.g. "720p" -> 720)
      const match = label.match(/(\d+)p/);
      if (match) {
        return parseInt(match[1], 10);
      }
      
      // Handle text-based quality labels
      if (label.includes('2160') || label.includes('4k')) return 2160;
      if (label.includes('1440') || label.includes('2k')) return 1440;
      if (label.includes('1080')) return 1080;
      if (label.includes('720')) return 720;
      if (label.includes('480')) return 480;
      if (label.includes('360')) return 360;
      if (label.includes('240')) return 240;
      if (label.includes('144')) return 144;
      
      // Default to medium quality if unknown
      return 360;
    };
    
    const qualityA = getQualityValue(a);
    const qualityB = getQualityValue(b);
    
    // Shorts: prefer lower quality for better compatibility
    // Regular: prefer higher quality
    if (isShorts) {
      // For shorts, we want lower qualities first
      // Prefer 360p, but cap at 480p
      if (qualityA <= 480 && qualityB > 480) return -1;
      if (qualityA > 480 && qualityB <= 480) return 1;
      return qualityA - qualityB;
    } else {
      // For regular videos, prefer medium-high quality
      // Cap at 1080p for better reliability
      if (qualityA <= 1080 && qualityB > 1080) return -1;
      if (qualityA > 1080 && qualityB <= 1080) return 1;
      return qualityB - qualityA; // Higher first
    }
  });
}

/**
 * Select the best format based on video type and available formats
 */
function selectBestFormat(videoFormats, audioFormats, isShorts) {
  // For Shorts: prefer 360p or lower for best compatibility
  if (isShorts) {
    // Try to find a 360p format first
    const format360p = videoFormats.find(format => 
      (format.label || '').toLowerCase().includes('360p')
    );
    
    if (format360p) {
      console.log('✅ Found optimal 360p format for Shorts');
      return format360p;
    }
    
    // Try 240p or 480p as alternatives
    const formatLowRes = videoFormats.find(format => {
      const label = (format.label || '').toLowerCase();
      return label.includes('240p') || label.includes('480p');
    });
    
    if (formatLowRes) {
      console.log(`✅ Using ${formatLowRes.label} format for Shorts`);
      return formatLowRes;
    }
  }
  
  // For regular videos: prefer 720p for good quality and reliability
  const format720p = videoFormats.find(format => 
    (format.label || '').toLowerCase().includes('720p')
  );
  
  if (format720p) {
    console.log('✅ Found optimal 720p format for regular video');
    return format720p;
  }
  
  // Otherwise use the first available video format
  if (videoFormats.length > 0) {
    console.log(`✅ Using ${videoFormats[0].label} as best available format`);
    return videoFormats[0];
  }
  
  // Last resort: use audio format if no video format available
  if (audioFormats.length > 0) {
    console.log(`⚠️ No video formats found, using audio format`);
    return audioFormats[0];
  }
  
  throw new Error("No suitable formats found");
}

/**
 * Create quality options from available formats
 */
function createQualityOptions(videoFormats, audioFormats, isShorts) {
  // Combine all formats
  const allFormats = [...videoFormats, ...audioFormats];
  
  // Convert to standard format
  return allFormats.map(format => {
    const label = format.label || 'unknown';
    
    // Determine if format requires premium (for UI display)
    const isPremium = isShorts
      ? !['360p', '240p', '144p'].some(q => label.toLowerCase().includes(q))
      : !['360p', '480p', '720p'].some(q => label.toLowerCase().includes(q));
    
    return {
      quality: label,
      url: format.url,
      type: format.type || 'video/mp4',
      extension: format.ext || format.extension || 'mp4',
      filesize: format.filesize || 'unknown',
      isPremium: isPremium,
      hasAudio: true
    };
  });
}

/**
 * Extract video ID from various YouTube URL formats
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
 * Get a random user agent to avoid rate limiting
 */
function getRandomUserAgent() {
  const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.1 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:94.0) Gecko/20100101 Firefox/94.0',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 15_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.1 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4758.102 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.75 Safari/537.36 Edg/100.0.1185.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.60 Safari/537.36',
  ];
  
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

module.exports = { fetchYouTubeData };
