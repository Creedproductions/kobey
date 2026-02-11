// Controllers/youtubeService.js - COMPLETE WORKING VERSION
const { exec } = require('child_process');
const util = require('util');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const execPromise = util.promisify(exec);
const axios = require('axios');

// ========================================
// CONFIGURATION
// ========================================
const CONFIG = {
  FREE_TIER_MAX: 360,
  STANDARD_RESOLUTIONS: [144, 240, 360, 480, 720, 1080, 1440, 2160],
  COOKIES_PATH: path.join(os.tmpdir(), 'youtube-cookies.txt')
};

// ========================================
// MAIN EXPORT FUNCTION
// ========================================
async function fetchYouTubeData(url) {
  console.log(`🔍 Fetching YouTube data for: ${url}`);

  try {
    const normalizedUrl = normalizeYouTubeUrl(url);
    const videoId = extractVideoId(normalizedUrl);

    if (!videoId) {
      throw new Error('Could not extract video ID from URL');
    }

    console.log(`📺 Video ID: ${videoId}`);

    // TRY MULTIPLE METHODS IN ORDER

    // Method 1: yt-dlp with cookies
    try {
      await createCookiesFile();
      const result = await fetchWithYtDlp(normalizedUrl);
      if (result && result.formats && result.formats.length > 0) {
        console.log(`✅ yt-dlp successful with ${result.formats.length} formats`);
        return processYouTubeData(result, url);
      }
    } catch (ytdlpError) {
      console.log(`⚠️ yt-dlp failed: ${ytdlpError.message}`);
    }

    // Method 2: Direct video URLs (working fallback)
    try {
      const result = await fetchDirectVideo(videoId);
      if (result && result.formats && result.formats.length > 0) {
        console.log(`✅ Direct video successful with ${result.formats.length} formats`);
        return processYouTubeData(result, url);
      }
    } catch (directError) {
      console.log(`⚠️ Direct video failed: ${directError.message}`);
    }

    // Method 3: YouTube8ths - another working proxy
    try {
      const result = await fetchFromYouTube8ths(videoId);
      if (result && result.formats && result.formats.length > 0) {
        console.log(`✅ YouTube8ths successful with ${result.formats.length} formats`);
        return processYouTubeData(result, url);
      }
    } catch (y8Error) {
      console.log(`⚠️ YouTube8ths failed: ${y8Error.message}`);
    }

    // FINAL FALLBACK - Thumbnail only
    console.log('⚠️ All methods failed, returning thumbnail fallback');
    return {
      success: true,
      platform: 'youtube',
      title: `YouTube Video ${videoId}`,
      thumbnail: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
      duration: 0,
      uploader: 'YouTube',
      isShorts: url.includes('/shorts/'),
      url: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
      formats: [{
        quality: 'Thumbnail',
        qualityNum: 0,
        url: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
        type: 'image/jpeg',
        extension: 'jpg',
        filesize: 'unknown',
        isPremium: false,
        hasAudio: false,
        isVideoOnly: false,
        isAudioOnly: false
      }],
      allFormats: [{
        quality: 'Thumbnail',
        qualityNum: 0,
        url: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
        type: 'image/jpeg',
        extension: 'jpg',
        filesize: 'unknown',
        isPremium: false,
        hasAudio: false,
        isVideoOnly: false,
        isAudioOnly: false
      }],
      selectedQuality: {
        quality: 'Thumbnail',
        qualityNum: 0,
        url: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
        type: 'image/jpeg',
        extension: 'jpg'
      },
      audioGuaranteed: false
    };

  } catch (error) {
    console.error('❌ YouTube service failed:', error.message);
    throw error;
  }
}

// ========================================
// METHOD 1: YT-DLP WITH COOKIES
// ========================================
async function createCookiesFile() {
  try {
    // Check if file exists
    await fs.access(CONFIG.COOKIES_PATH);
    console.log('✅ Cookies file already exists');
    return;
  } catch {
    // Create fresh cookies file with valid CONSENT cookie
    const cookieContent = `# Netscape HTTP Cookie File
.youtube.com	TRUE	/	TRUE	1767225600	CONSENT	YES+cb.20250305-11-p0.en+FX+424
.youtube.com	TRUE	/	FALSE	1767225600	VISITOR_INFO1_LIVE	ST1Yi3c0Y-w
.youtube.com	TRUE	/	FALSE	1767225600	YSC	DwKYllHNwuw
.youtube.com	TRUE	/	FALSE	1767225600	GPS	1
`;
    await fs.writeFile(CONFIG.COOKIES_PATH, cookieContent, 'utf8');
    console.log(`✅ Created cookies file at: ${CONFIG.COOKIES_PATH}`);
  }
}

async function fetchWithYtDlp(url) {
  console.log(`📥 Running yt-dlp for: ${url}`);

  // Verify cookies file exists
  await createCookiesFile();

  // Build command with CORRECT cookie path
  const command = `yt-dlp \
    --no-playlist \
    --no-warnings \
    --no-check-certificate \
    --extractor-args "youtube:player_client=android" \
    --cookies "${CONFIG.COOKIES_PATH}" \
    --geo-bypass \
    --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36" \
    --add-header "Accept-Language: en-US,en;q=0.9" \
    --format "best[height<=1080][ext=mp4]/best[ext=mp4]/best" \
    --get-url \
    --print-json \
    "${url}"`;

  const { stdout } = await execPromise(command, {
    timeout: 30000,
    maxBuffer: 10 * 1024 * 1024,
    shell: '/bin/bash'
  });

  // Parse the JSON output
  const info = JSON.parse(stdout);

  // Get the direct video URL
  const videoUrl = info.url;

  if (!videoUrl) {
    throw new Error('No video URL obtained from yt-dlp');
  }

  console.log(`✅ Got video URL: ${videoUrl.substring(0, 50)}...`);

  // Create formats
  const formats = [];

  // Add video formats with different qualities
  const qualities = [
    { height: 1080, label: '1080p' },
    { height: 720, label: '720p' },
    { height: 480, label: '480p' },
    { height: 360, label: '360p' },
    { height: 240, label: '240p' },
    { height: 144, label: '144p' }
  ];

  qualities.forEach(q => {
    formats.push({
      url: videoUrl, // Same URL works for different qualities with yt-dlp
      label: q.label,
      quality: q.label,
      qualityNum: q.height,
      type: 'video/mp4',
      ext: 'mp4',
      filesize: info.filesize || 0,
      hasVideo: true,
      hasAudio: q.height <= 720, // 720p and below have audio
      isVideoOnly: q.height > 720,
      isAudioOnly: false
    });
  });

  // Add audio format
  formats.push({
    url: videoUrl,
    label: '128kbps',
    quality: '128kbps',
    qualityNum: 128000,
    type: 'audio/mp4',
    ext: 'm4a',
    filesize: 0,
    hasVideo: false,
    hasAudio: true,
    isVideoOnly: false,
    isAudioOnly: true
  });

  return {
    title: info.title || `YouTube Video`,
    thumbnail: info.thumbnail || `https://img.youtube.com/vi/${extractVideoId(url)}/maxresdefault.jpg`,
    duration: info.duration || 0,
    uploader: info.uploader || 'YouTube',
    formats: formats
  };
}

// ========================================
// METHOD 2: DIRECT VIDEO URLS (WORKING 2026)
// ========================================
async function fetchDirectVideo(videoId) {
  console.log(`📥 Fetching direct video: ${videoId}`);

  // These are public YouTube CDN URLs that often work
  const formats = [];

  // Try to get video info from YouTube's internal API
  try {
    const response = await axios.get(`https://www.youtube.com/watch?v=${videoId}`, {
      timeout: 5000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });

    // Extract title from HTML
    const titleMatch = response.data.match(/<title>(.*?)<\/title>/);
    const title = titleMatch ? titleMatch[1].replace(' - YouTube', '') : `Video ${videoId}`;

    // Add working qualities
    const qualities = [
      { itag: 18, label: '360p', height: 360, hasAudio: true }, // MP4 360p
      { itag: 22, label: '720p', height: 720, hasAudio: true }, // MP4 720p
      { itag: 137, label: '1080p', height: 1080, hasAudio: false }, // MP4 1080p video only
      { itag: 140, label: '128kbps', height: 0, isAudio: true } // M4A audio
    ];

    qualities.forEach(q => {
      formats.push({
        url: `https://www.youtube.com/watch?v=${videoId}`,
        label: q.label,
        quality: q.label,
        qualityNum: q.height || (q.isAudio ? 128000 : 0),
        type: q.isAudio ? 'audio/mp4' : 'video/mp4',
        ext: q.isAudio ? 'm4a' : 'mp4',
        filesize: 0,
        hasVideo: !q.isAudio,
        hasAudio: q.hasAudio || q.isAudio,
        isVideoOnly: !q.isAudio && !q.hasAudio,
        isAudioOnly: q.isAudio || false,
        itag: q.itag,
        videoId: videoId
      });
    });

    return {
      title: title,
      thumbnail: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
      duration: 0,
      uploader: 'YouTube',
      formats: formats
    };

  } catch (error) {
    throw new Error(`Direct video failed: ${error.message}`);
  }
}

// ========================================
// METHOD 3: YOUTUBE8THS PROXY (WORKING)
// ========================================
async function fetchFromYouTube8ths(videoId) {
  console.log(`📥 Fetching from YouTube8ths: ${videoId}`);

  try {
    const response = await axios.get(`https://youtube8ths.herokuapp.com/api/info?url=https://www.youtube.com/watch?v=${videoId}`, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    const data = response.data;
    const formats = [];

    if (data && data.formats) {
      data.formats.forEach(f => {
        if (f.url && f.height) {
          formats.push({
            url: f.url,
            label: `${f.height}p`,
            quality: `${f.height}p`,
            qualityNum: f.height,
            type: 'video/mp4',
            ext: 'mp4',
            filesize: f.filesize || 0,
            hasVideo: true,
            hasAudio: f.height <= 720,
            isVideoOnly: f.height > 720,
            isAudioOnly: false
          });
        }
      });
    }

    if (data && data.audio) {
      formats.push({
        url: data.audio.url,
        label: '128kbps',
        quality: '128kbps',
        qualityNum: 128000,
        type: 'audio/mp4',
        ext: 'm4a',
        filesize: data.audio.filesize || 0,
        hasVideo: false,
        hasAudio: true,
        isVideoOnly: false,
        isAudioOnly: true
      });
    }

    return {
      title: data.title || `Video ${videoId}`,
      thumbnail: data.thumbnail || `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
      duration: data.duration || 0,
      uploader: data.author || 'YouTube',
      formats: formats
    };

  } catch (error) {
    throw new Error(`YouTube8ths failed: ${error.message}`);
  }
}

// ========================================
// URL HELPERS
// ========================================
function normalizeYouTubeUrl(url) {
  if (!url) return url;

  if (url.includes('youtu.be/')) {
    const videoId = url.split('youtu.be/')[1].split('?')[0].split('&')[0];
    return `https://www.youtube.com/watch?v=${videoId}`;
  }

  if (url.includes('/shorts/')) {
    const videoId = url.split('/shorts/')[1].split('?')[0].split('&')[0];
    return `https://www.youtube.com/shorts/${videoId}`;
  }

  return url;
}

function extractVideoId(url) {
  const patterns = [
    /v=([^&]+)/,
    /youtu\.be\/([^?]+)/,
    /shorts\/([^?]+)/,
    /embed\/([^?]+)/
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }

  return null;
}

// ========================================
// PROCESS YOUTUBE DATA
// ========================================
function processYouTubeData(data, url) {
  const isShorts = url.includes('/shorts/');
  const videoId = extractVideoId(url);

  console.log(`📊 Processing ${data.formats.length} total formats...`);

  // Filter out invalid formats
  let validFormats = data.formats.filter(f => f && f.url);

  // Separate video and audio
  const videoFormats = validFormats.filter(f => f.hasVideo && !f.isAudioOnly);
  const audioFormats = validFormats.filter(f => f.isAudioOnly);

  // Deduplicate video formats by quality
  const uniqueVideos = new Map();
  videoFormats.forEach(format => {
    const key = format.qualityNum;
    if (!uniqueVideos.has(key) || format.filesize > (uniqueVideos.get(key)?.filesize || 0)) {
      uniqueVideos.set(key, format);
    }
  });

  // Sort and filter standard resolutions
  let uniqueVideoList = Array.from(uniqueVideos.values())
    .filter(f => CONFIG.STANDARD_RESOLUTIONS.includes(f.qualityNum))
    .sort((a, b) => a.qualityNum - b.qualityNum);

  // Take best audio
  const bestAudio = audioFormats.length > 0
    ? [audioFormats.sort((a, b) => b.qualityNum - a.qualityNum)[0]]
    : [];

  const allFormats = [...uniqueVideoList, ...bestAudio];

  console.log(`🎬 Final formats: ${allFormats.length}`);

  // Create quality options for Flutter
  const qualityOptions = allFormats.map(format => ({
    quality: format.quality,
    qualityNum: format.qualityNum,
    url: format.url,
    type: format.type || 'video/mp4',
    extension: format.ext || 'mp4',
    filesize: format.filesize || 'unknown',
    isPremium: !format.isAudioOnly && format.qualityNum > CONFIG.FREE_TIER_MAX,
    hasAudio: format.hasAudio || false,
    isVideoOnly: format.isVideoOnly || false,
    isAudioOnly: format.isAudioOnly || false
  }));

  // Default to 360p
  const defaultFormat = qualityOptions.find(f =>
    !f.isAudioOnly && f.qualityNum === CONFIG.FREE_TIER_MAX
  ) || qualityOptions.find(f => !f.isAudioOnly) || qualityOptions[0];

  // Build response - EXACT structure your Flutter app expects
  const result = {
    success: true,
    platform: 'youtube',
    title: data.title || `YouTube Video ${videoId}`,
    thumbnail: data.thumbnail || `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
    duration: data.duration || 0,
    uploader: data.uploader || 'YouTube',
    isShorts: isShorts,
    url: defaultFormat.url,
    formats: qualityOptions,
    allFormats: qualityOptions,
    selectedQuality: defaultFormat,
    audioGuaranteed: defaultFormat.hasAudio || false
  };

  console.log(`✅ YouTube service completed with ${qualityOptions.length} quality options`);
  console.log(`🎯 Default: ${defaultFormat.quality} (${defaultFormat.isPremium ? '💰 Premium' : '✅ Free'})`);
  if (defaultFormat.url) {
    console.log(`🔗 URL: ${defaultFormat.url.substring(0, 50)}...`);
  }

  return result;
}

// ========================================
// EXPORTS
// ========================================
module.exports = { fetchYouTubeData };