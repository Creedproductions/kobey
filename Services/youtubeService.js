const axios = require("axios");
const audioMergerService = require("./audioMergerService");

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
        await new Promise(resolve => setTimeout(resolve, backoffMs));
      }
    }
  }
  
  throw new Error(`YouTube download failed after ${maxAttempts} attempts: ${lastError.message}`);
}

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
    throw new Error(`YouTube downloader API request failed: ${err.message}`);
  }
}

function processYouTubeData(data, url) {
  const isShorts = url.includes('/shorts/');
  console.log(`📊 YouTube: Found ${data.items.length} total formats`);
  
  let availableFormats = data.items.filter(item => item.url && item.url.length > 0);
  console.log(`✅ Found ${availableFormats.length} formats with URLs`);
  
  // Separate by type
  const videoFormats = [];
  const audioFormats = [];
  
  availableFormats.forEach(item => {
    const label = (item.label || '').toLowerCase();
    const type = (item.type || '').toLowerCase();
    
    // Audio formats
    if (type.includes('audio/') || label.match(/^\d+kb\/s/) || label.includes('m4a') || label.includes('opus')) {
      audioFormats.push(item);
    } 
    // Video formats
    else if (type.includes('video/') || label.match(/\d+p/)) {
      videoFormats.push(item);
    }
  });
  
  console.log(`📹 Video formats: ${videoFormats.length}`);
  console.log(`🎵 Audio formats: ${audioFormats.length}`);
  
  // Build quality options - FORCE MERGE for all videos
  const qualityOptions = [];
  
  // Add video formats with merge URLs
  videoFormats.forEach(video => {
    const quality = video.label || 'unknown';
    const qualityNum = extractQualityNumber(quality);
    
    // Get best audio
    const bestAudio = audioFormats.length > 0 ? audioFormats[audioFormats.length - 1] : null;
    
    if (bestAudio) {
      // Create MERGE URL
      const videoB64 = Buffer.from(video.url).toString('base64');
      const audioB64 = Buffer.from(bestAudio.url).toString('base64');
      
      qualityOptions.push({
        quality: quality,
        qualityNum: qualityNum,
        url: `MERGE_V2|${videoB64}|${audioB64}`,
        type: video.type || 'video/mp4',
        extension: video.ext || 'mp4',
        isPremium: qualityNum > 360,
        hasAudio: true,
        isMergedFormat: true
      });
    } else {
      // No audio available - use video only
      qualityOptions.push({
        quality: quality,
        qualityNum: qualityNum,
        url: video.url,
        type: video.type || 'video/mp4',
        extension: video.ext || 'mp4',
        isPremium: qualityNum > 360,
        hasAudio: false
      });
    }
  });
  
  // Add audio formats
  audioFormats.forEach(audio => {
    const label = audio.label || 'audio';
    qualityOptions.push({
      quality: label,
      qualityNum: 0,
      url: audio.url,
      type: audio.type || 'audio/mp4',
      extension: audio.ext || 'm4a',
      isPremium: false,
      hasAudio: true,
      isAudioOnly: true
    });
  });
  
  // Sort
  qualityOptions.sort((a, b) => a.qualityNum - b.qualityNum);
  
  // Select default
  const selectedFormat = qualityOptions.find(opt => opt.qualityNum === 360) || qualityOptions[0];
  
  console.log(`✅ Created ${qualityOptions.length} quality options`);
  console.log(`🎵 Formats with merge: ${qualityOptions.filter(f => f.isMergedFormat).length}`);
  
  return {
    title: data.title,
    thumbnail: data.cover,
    duration: data.duration,
    isShorts: isShorts,
    formats: qualityOptions,
    allFormats: qualityOptions,
    url: selectedFormat.url,
    selectedQuality: selectedFormat,
    audioGuaranteed: true
  };
}

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

function getRandomUserAgent() {
  const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.1 Safari/605.1.15',
  ];
  
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

module.exports = { fetchYouTubeData };
