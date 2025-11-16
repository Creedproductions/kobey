const axios = require("axios");
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');
const execPromise = promisify(exec);

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

async function downloadFile(url, outputPath) {
  const writer = require('fs').createWriteStream(outputPath);
  
  const response = await axios({
    url,
    method: 'GET',
    responseType: 'stream',
    timeout: 300000,
  });

  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

async function mergeVideoAudio(videoPath, audioPath, outputPath) {
  console.log('🎬 Starting FFmpeg merge...');
  
  const command = `ffmpeg -i "${videoPath}" -i "${audioPath}" -c:v copy -c:a aac -b:a 192k -movflags +faststart "${outputPath}"`;
  
  try {
    const { stdout, stderr } = await execPromise(command, {
      maxBuffer: 1024 * 1024 * 10,
    });
    
    console.log('✅ FFmpeg merge completed successfully');
    return true;
  } catch (error) {
    console.error('❌ FFmpeg merge failed:', error.message);
    throw new Error(`Video merge failed: ${error.message}`);
  }
}

function processYouTubeData(data, url) {
  const isShorts = url.includes('/shorts/');
  console.log(`📊 YouTube: Found ${data.items.length} total formats (${isShorts ? 'SHORTS' : 'REGULAR'})`);
  
  const videoFormats = [];
  const audioFormats = [];
  
  data.items.forEach(item => {
    const label = (item.label || '').toLowerCase();
    const type = (item.type || '').toLowerCase();
    const hasUrl = item.url && item.url.length > 0;
    
    if (!hasUrl) return;
    
    // FIXED: Better audio detection
    const isAudioOnly = 
      type.includes('audio/') ||
      type === 'audio/mp4' ||
      type === 'audio/webm' ||
      type === 'audio/m4a' ||
      label.includes('audio only') ||
      label.includes('only audio') ||
      label.includes('m4a') ||
      label.includes('opus') ||
      (label.match(/\d+kb\/s/i) && !label.includes('p')); // Bitrate without resolution = audio
    
    const isVideoOnly = 
      label.includes('video only') || 
      label.includes('only video') ||
      label.includes('vid only') ||
      label.includes('without audio');
    
    const isCombined = !isAudioOnly && !isVideoOnly && 
                      (type.includes('video') || label.includes('p'));
    
    if (isAudioOnly) {
      audioFormats.push(item);
      console.log(`🔊 Audio format detected: ${label} (${type})`);
    } else if (isVideoOnly || isCombined) {
      videoFormats.push(item);
    }
  });
  
  console.log(`✅ Found ${videoFormats.length} video formats and ${audioFormats.length} audio formats`);
  
  // Process video formats
  const videoOptions = videoFormats.map(format => {
    const quality = format.label || 'unknown';
    const qualityNum = extractQualityNumber(quality);
    const isPremium = qualityNum > 360;
    
    const label = quality.toLowerCase();
    const type = (format.type || '').toLowerCase();
    const hasAudio = !label.includes('video only') && 
                     !label.includes('without audio') &&
                     !type.includes('video only');
    
    return {
      quality: quality,
      qualityNum: qualityNum,
      url: format.url,
      type: format.type || 'video/mp4',
      extension: format.ext || format.extension || getExtensionFromType(format.type),
      filesize: format.filesize || 'unknown',
      isPremium: isPremium,
      hasAudio: hasAudio,
      isVideoOnly: !hasAudio,
      needsMerge: !hasAudio && audioFormats.length > 0
    };
  });
  
  // Process audio formats
  const audioOptions = audioFormats.map(format => {
    const quality = format.label || 'unknown';
    const bitrateMatch = quality.match(/(\d+)\s*kb\/s/i);
    const bitrate = bitrateMatch ? parseInt(bitrateMatch[1]) : 128;
    const isPremium = bitrate > 128;
    
    return {
      quality: quality,
      qualityNum: bitrate,
      url: format.url,
      type: format.type || 'audio/mp4',
      extension: format.ext || format.extension || getExtensionFromType(format.type),
      filesize: format.filesize || 'unknown',
      isPremium: isPremium,
      hasAudio: true,
      isAudioOnly: true
    };
  });
  
  const allQualityOptions = [...videoOptions, ...audioOptions];
  allQualityOptions.sort((a, b) => a.qualityNum - b.qualityNum);
  
  console.log(`✅ Total quality options: ${allQualityOptions.length} (${videoOptions.length} video + ${audioOptions.length} audio)`);
  
  // Get best audio for merging
  const bestAudio = audioOptions.length > 0 ? audioOptions[audioOptions.length - 1] : null;
  
  let selectedFormat = videoOptions.find(opt => opt.qualityNum === 360 && opt.hasAudio) ||
                      videoOptions.find(opt => opt.hasAudio) ||
                      videoOptions[0] ||
                      allQualityOptions[0];
  
  const result = {
    title: data.title,
    thumbnail: data.cover,
    duration: data.duration,
    isShorts: isShorts,
    formats: allQualityOptions,
    videoFormats: videoOptions,
    audioFormats: audioOptions,
    allFormats: allQualityOptions,
    url: selectedFormat.url,
    selectedQuality: selectedFormat,
    audioGuaranteed: selectedFormat.hasAudio,
    bestAudioUrl: bestAudio?.url,
    supportsMerge: bestAudio !== null
  };
  
  console.log(`✅ YouTube service completed with ${allQualityOptions.length} quality options`);
  console.log(`🎯 Best audio for merge: ${bestAudio?.quality || 'None'}`);
  
  return result;
}

async function mergeQualityWithAudio(videoUrl, audioUrl, outputFileName) {
  const tempDir = path.join('/tmp', 'video-merges');
  
  try {
    await fs.mkdir(tempDir, { recursive: true });
  } catch (err) {
    console.error('Failed to create temp directory:', err);
  }
  
  const videoPath = path.join(tempDir, `video_${Date.now()}.mp4`);
  const audioPath = path.join(tempDir, `audio_${Date.now()}.m4a`);
  const outputPath = path.join(tempDir, outputFileName || `merged_${Date.now()}.mp4`);
  
  try {
    console.log('📥 Downloading video stream...');
    await downloadFile(videoUrl, videoPath);
    console.log('✅ Video downloaded');
    
    console.log('📥 Downloading audio stream...');
    await downloadFile(audioUrl, audioPath);
    console.log('✅ Audio downloaded');
    
    console.log('🎬 Merging video and audio...');
    await mergeVideoAudio(videoPath, audioPath, outputPath);
    console.log('✅ Merge completed');
    
    await fs.unlink(videoPath).catch(() => {});
    await fs.unlink(audioPath).catch(() => {});
    
    return outputPath;
  } catch (error) {
    await fs.unlink(videoPath).catch(() => {});
    await fs.unlink(audioPath).catch(() => {});
    await fs.unlink(outputPath).catch(() => {});
    
    throw error;
  }
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

function getRandomUserAgent() {
  const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.1 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:94.0) Gecko/20100101 Firefox/94.0',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 15_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.1 Mobile/15E148 Safari/604.1'
  ];
  
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

module.exports = { 
  fetchYouTubeData,
  mergeQualityWithAudio
};
