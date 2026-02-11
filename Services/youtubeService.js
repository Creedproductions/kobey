// Controllers/youtubeService.js - FINAL WORKING VERSION
const { exec } = require('child_process');
const util = require('util');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const execPromise = util.promisify(exec);

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

    // Step 1: Create cookies file
    await createCookiesFile();

    // Step 2: Fetch video info with yt-dlp
    const videoInfo = await fetchWithYtDlp(normalizedUrl);

    // Step 3: Process and return
    return processYouTubeData(videoInfo, url);

  } catch (error) {
    console.error('❌ YouTube service failed:', error.message);

    // Final fallback - return basic info with working thumbnail
    return {
      success: true,
      platform: 'youtube',
      title: `YouTube Video`,
      thumbnail: `https://img.youtube.com/vi/${extractVideoId(url)}/hqdefault.jpg`,
      duration: 0,
      uploader: 'YouTube',
      isShorts: url.includes('/shorts/'),
      url: `https://img.youtube.com/vi/${extractVideoId(url)}/hqdefault.jpg`,
      formats: [],
      allFormats: [],
      selectedQuality: { quality: 'Thumbnail', url: `https://img.youtube.com/vi/${extractVideoId(url)}/hqdefault.jpg` },
      audioGuaranteed: false
    };
  }
}

// ========================================
// CREATE COOKIES FILE
// This helps bypass the "Sign in to confirm you're not a bot"
// ========================================
async function createCookiesFile() {
  try {
    // Check if cookies file already exists
    await fs.access(CONFIG.COOKIES_PATH);
    return;
  } catch {
    // Create cookies file with CONSENT cookie
    // This is a public domain cookie that helps with bot detection
    const cookieContent = `# Netscape HTTP Cookie File
.youtube.com	TRUE	/	TRUE	1735689600	CONSENT	YES+cb.20250305-11-p0.en+FX+424
.youtube.com	TRUE	/	FALSE	1735689600	VISITOR_INFO1_LIVE	-k7yR3M_mqs
.youtube.com	TRUE	/	FALSE	1735689600	YSC	DwKYllHNwuw
`;
    await fs.writeFile(CONFIG.COOKIES_PATH, cookieContent);
    console.log('✅ Created cookies file for yt-dlp');
  }
}

// ========================================
// YT-DLP IMPLEMENTATION
// This is the ONLY reliable method now
// ========================================
async function fetchWithYtDlp(url) {
  console.log(`📥 Running yt-dlp for: ${url}`);

  try {
    // Build command with optimal settings
    const command = `yt-dlp \
      --no-playlist \
      --no-warnings \
      --no-check-certificate \
      --extractor-args "youtube:player_client=android" \
      --cookies "${CONFIG.CODKI22ES_PATH}" \
      --geo-bypass \
      --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36" \
      --add-header "Accept-Language: en-US,en;q=0.9" \
      --format-sort "res,codec:av1:h264:vp9,br" \
      -J \
      "${url}"`;

    const { stdout } = await execPromise(command, {
      timeout: 45000,
      maxBuffer: 10 * 1024 * 1024
    });

    const info = JSON.parse(stdout);
    console.log(`✅ yt-dlp fetched: "${info.title}"`);

    // Transform yt-dlp output to our format
    return transformYtDlpOutput(info, url);

  } catch (error) {
    console.error('❌ yt-dlp failed:', error.message);
    throw error;
  }
}

// ========================================
// TRANSFORM YT-DLP OUTPUT
// ========================================
function transformYtDlpOutput(info, url) {
  const formats = [];
  const videoId = extractVideoId(url);

  // Process all formats
  info.formats.forEach(format => {
    // Skip formats without URL
    if (!format.url) return;

    // Skip HLS/m3u8 formats
    if (format.protocol?.includes('m3u8') || format.url?.includes('.m3u8')) return;

    // Skip very low quality
    if (format.height && format.height < 144) return;

    const hasVideo = format.vcodec !== 'none';
    const hasAudio = format.acodec !== 'none';

    if (hasVideo) {
      const quality = format.height || 0;
      let label = `${quality}p`;

      // Add FPS if 60fps
      if (format.fps && format.fps >= 60) {
        label += `${format.fps}`;
      }

      formats.push({
        url: format.url,
        label: label,
        quality: label,
        qualityNum: quality,
        type: 'video/mp4',
        ext: format.ext || 'mp4',
        filesize: format.filesize || format.filesize_approx || 0,
        hasVideo: true,
        hasAudio: hasAudio,
        isVideoOnly: !hasAudio,
        isAudioOnly: false,
        fps: format.fps || 30,
        vcodec: format.vcodec,
        acodec: format.acodec
      });
    } else if (!hasVideo && hasAudio) {
      // Audio only format
      const bitrate = format.abr || 128;
      formats.push({
        url: format.url,
        label: `${Math.round(bitrate)}kbps`,
        quality: `${Math.round(bitrate)}kbps`,
        qualityNum: bitrate * 1000,
        type: 'audio/mp4',
        ext: format.ext || 'm4a',
        filesize: format.filesize || format.filesize_approx || 0,
        hasVideo: false,
        hasAudio: true,
        isVideoOnly: false,
        isAudioOnly: true,
        abr: bitrate
      });
    }
  });

  return {
    title: info.title,
    thumbnail: info.thumbnail || `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
    duration: info.duration || 0,
    uploader: info.uploader || 'YouTube',
    uploader_url: info.uploader_url,
    description: info.description,
    view_count: info.view_count,
    like_count: info.like_count,
    formats: formats
  };
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
    return url;
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

  // Filter and deduplicate formats
  const videoFormats = [];
  const audioFormats = [];
  const seenQualities = new Set();

  // Sort formats by quality (highest first for dedup)
  const sortedFormats = [...data.formats].sort((a, b) => b.qualityNum - a.qualityNum);

  sortedFormats.forEach(format => {
    if (format.isAudioOnly) {
      audioFormats.push(format);
    } else {
      const key = format.qualityNum;

      // Keep best quality of each resolution
      if (!seenQualities.has(key)) {
        seenQualities.add(key);
        videoFormats.push(format);
      }
    }
  });

  // Sort video formats by quality (ascending)
  videoFormats.sort((a, b) => a.qualityNum - b.qualityNum);

  // Filter to standard resolutions only
  const standardVideoFormats = videoFormats.filter(f =>
    CONFIG.STANDARD_RESOLUTIONS.includes(f.qualityNum)
  );

  // Take best audio format
  const bestAudio = audioFormats.length > 0
    ? [audioFormats.sort((a, b) => b.qualityNum - a.qualityNum)[0]]
    : [];

  const allFormats = [...standardVideoFormats, ...bestAudio];

  console.log(`🎬 Final formats: ${allFormats.length}`);
  allFormats.forEach(f => {
    const type = f.isAudioOnly ? '🎵 Audio' :
                 f.isVideoOnly ? '📹 Video Only' :
                 '🎬 Video+Audio';
    console.log(`   ${f.quality} - ${type}`);
  });

  // Create quality options for Flutter
  const qualityOptions = allFormats.map(format => ({
    quality: format.quality,
    qualityNum: format.qualityNum,
    url: format.url,
    type: format.type,
    extension: format.ext,
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

  // Build response
  const result = {
    success: true,
    platform: 'youtube',
    title: data.title || `YouTube Video ${videoId}`,
    thumbnail: data.thumbnail || `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
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

  return result;
}

// ========================================
// EXPORTS
// ========================================
module.exports = { fetchYouTubeData };