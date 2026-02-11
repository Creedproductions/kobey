// Controllers/youtubeService.js
const { exec } = require('child_process');
const util = require('util');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const execPromise = util.promisify(exec);
const audioMergerService = require("./audioMergerService");

// Path for cookies file
const COOKIES_PATH = path.join(os.tmpdir(), 'youtube-cookies.txt');

/**
 * Fetches YouTube video data using yt-dlp with cookie support
 */
async function fetchYouTubeData(url) {
  const normalizedUrl = normalizeYouTubeUrl(url);
  console.log(`🔍 Fetching YouTube data with yt-dlp for: ${normalizedUrl}`);

  try {
    // Try with cookies first
    return await fetchWithYtDlp(normalizedUrl, true);
  } catch (err) {
    console.error('❌ yt-dlp with cookies error:', err.message);

    // Try without cookies as fallback
    try {
      console.log('⚠️ Trying without cookies...');
      return await fetchWithYtDlp(normalizedUrl, false);
    } catch (err2) {
      console.error('❌ yt-dlp without cookies error:', err2.message);

      // Final fallback to vidfly.ai
      console.log('⚠️ Falling back to vidfly.ai...');
      return fetchWithVidFlyApi(normalizedUrl, 1);
    }
  }
}

/**
 * Create a basic cookies file for YouTube
 * This helps with the "Sign in to confirm you're not a bot" error
 */
async function createBasicCookiesFile() {
  try {
    // Check if cookies file already exists
    await fs.access(COOKIES_PATH);
    return COOKIES_PATH;
  } catch {
    // Create basic cookies file with CONSENT cookie
    // This often helps with the bot detection
    const cookieContent = `# Netscape HTTP Cookie File
.youtube.com	TRUE	/	FALSE	1735689600	CONSENT	YES+cb.20250305-11-p0.en+FX+424
`;
    await fs.writeFile(COOKIES_PATH, cookieContent);
    console.log('✅ Created basic cookies file');
    return COOKIES_PATH;
  }
}

/**
 * Primary API implementation using yt-dlp
 */
async function fetchWithYtDlp(url, useCookies = true) {
  try {
    console.log(`📥 Running yt-dlp for: ${url} (cookies: ${useCookies})`);

    let cookiesOption = '';
    if (useCookies) {
      const cookiesPath = await createBasicCookiesFile();
      cookiesOption = `--cookies "${cookiesPath}"`;
    }

    // Build command with multiple fallback clients
    const command = `yt-dlp \
      --no-playlist \
      --no-check-certificate \
      --no-warnings \
      --extractor-args "youtube:player_client=android,mweb" \
      --geo-bypass \
      ${cookiesOption} \
      --add-header "Accept-Language: en-US,en;q=0.9" \
      --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" \
      -J \
      "${url}"`;

    const { stdout } = await execPromise(command, {
      timeout: 60000,
      maxBuffer: 10 * 1024 * 1024
    });

    const info = JSON.parse(stdout);
    console.log(`✅ yt-dlp fetched: "${info.title}"`);

    return processYouTubeData(info, url);

  } catch (err) {
    console.error('❌ yt-dlp execution error:', err.message);
    throw new Error(`yt-dlp failed: ${err.message}`);
  }
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
 * Process YouTube data with clean format organization
 */
function processYouTubeData(info, url) {
  const isShorts = url.includes('/shorts/');
  const formats = info.formats || [];

  console.log(`📊 YouTube: Found ${formats.length} total formats, cleaning...`);

  // ========================================
  // STEP 1: FILTER VALID FORMATS
  // ========================================
  let items = formats
    .filter(f => f.url) // Must have URL
    .filter(f => {
      // Skip HLS/m3u8 formats
      if (f.protocol?.includes('m3u8')) return false;
      if (f.url?.includes('.m3u8')) return false;

      // Skip very low quality video (< 144p)
      if (f.height && f.height < 144) return false;

      // Skip audio bitrates that are too low/high
      if (f.abr && (f.abr < 32 || f.abr > 320)) return false;

      return true;
    });

  console.log(`✅ After filtering: ${items.length} valid formats`);

  // ========================================
  // STEP 2: ORGANIZE BY CATEGORY
  // ========================================
  const videoFormats = [];
  const audioFormats = [];

  items.forEach(format => {
    const hasVideo = format.vcodec !== 'none';
    const hasAudio = format.acodec !== 'none';

    if (!hasVideo && hasAudio) {
      // Audio only
      audioFormats.push({
        url: format.url,
        label: format.abr ? `${Math.round(format.abr)}kbps` : 'Audio',
        type: 'audio/mp4',
        ext: 'm4a',
        filesize: format.filesize || format.filesize_approx || 0,
        quality: format.abr || 128,
        isAudioOnly: true,
        isVideoOnly: false,
        hasAudio: true,
        hasVideo: false
      });
    }
    else if (hasVideo) {
      // Video (with or without audio)
      let quality = format.height || 0;
      let label = `${quality}p`;

      // Add quality indicators
      if (format.fps && format.fps >= 60) label += ` ${format.fps}fps`;
      if (format.vcodec?.includes('av1')) label += ' 🔸';
      else if (format.vcodec?.includes('vp9')) label += ' 🔹';

      videoFormats.push({
        url: format.url,
        label: label,
        type: 'video/mp4',
        ext: 'mp4',
        filesize: format.filesize || format.filesize_approx || 0,
        quality: quality,
        fps: format.fps || 30,
        hasVideo: true,
        hasAudio: hasAudio,
        isVideoOnly: !hasAudio,
        isAudioOnly: false
      });
    }
  });

  // ========================================
  // STEP 3: DEDUPLICATE - KEEP BEST OF EACH QUALITY
  // ========================================
  const uniqueVideos = new Map();

  videoFormats.forEach(format => {
    const key = `${format.quality}_${format.hasAudio}`;

    if (!uniqueVideos.has(key)) {
      uniqueVideos.set(key, format);
    } else {
      // Keep higher FPS
      const existing = uniqueVideos.get(key);
      if (format.fps > existing.fps) {
        uniqueVideos.set(key, format);
      }
    }
  });

  // ========================================
  // STEP 4: KEEP ONLY STANDARD RESOLUTIONS
  // ========================================
  const standardResolutions = [144, 240, 360, 480, 720, 1080, 1440, 2160];
  const finalVideos = Array.from(uniqueVideos.values())
    .filter(f => standardResolutions.includes(f.quality))
    .sort((a, b) => a.quality - b.quality);

  // Keep best audio format only
  const bestAudio = audioFormats.length > 0
    ? [audioFormats.sort((a, b) => b.quality - a.quality)[0]]
    : [];

  // Combine final formats
  const allFormats = [...finalVideos, ...bestAudio];

  console.log(`🎬 Final formats: ${allFormats.length}`);
  allFormats.forEach(f => {
    console.log(`   ${f.label} - ${f.isAudioOnly ? '🎵 Audio' : f.isVideoOnly ? '📹 Video Only' : '🎬 Video+Audio'}`);
  });

  // ========================================
  // STEP 5: CREATE QUALITY OPTIONS WITH PREMIUM FLAGS
  // ========================================
  const qualityOptions = allFormats.map(format => {
    const isPremium = !format.isAudioOnly && format.quality > 360;

    return {
      quality: format.label,
      qualityNum: format.quality,
      url: format.url,
      type: format.type,
      extension: format.ext,
      filesize: format.filesize || 'unknown',
      isPremium: isPremium,
      hasAudio: format.hasAudio || false,
      isVideoOnly: format.isVideoOnly || false,
      isAudioOnly: format.isAudioOnly || false
    };
  });

  // ========================================
  // STEP 6: SET DEFAULT TO 360P (FREE)
  // ========================================
  const defaultFormat = qualityOptions.find(f =>
    !f.isAudioOnly && f.qualityNum === 360
  ) || qualityOptions.find(f => !f.isAudioOnly) || qualityOptions[0];

  // Build result
  const result = {
    title: info.title,
    thumbnail: info.thumbnail,
    duration: info.duration,
    isShorts: isShorts,
    formats: qualityOptions,
    allFormats: qualityOptions,
    url: defaultFormat.url,
    selectedQuality: defaultFormat,
    audioGuaranteed: defaultFormat.hasAudio
  };

  console.log(`✅ YouTube service completed with ${qualityOptions.length} quality options`);
  console.log(`🎯 Default quality: ${defaultFormat.quality} (${defaultFormat.isPremium ? '💰 Premium' : '✅ Free'})`);

  return result;
}

/**
 * Fallback: vidfly.ai API
 */
async function fetchWithVidFlyApi(url, attemptNum) {
  try {
    const axios = require("axios");
    const timeout = 30000;

    const res = await axios.get(
      "https://api.vidfly.ai/api/media/youtube/download",
      {
        params: { url },
        headers: {
          accept: "*/*",
          "content-type": "application/json",
          "x-app-name": "vidfly-web",
          "User-Agent": getRandomUserAgent(),
        },
        timeout: timeout,
      }
    );

    const data = res.data?.data;
    if (!data || !data.items || !data.title) {
      throw new Error("Invalid response from YouTube downloader API");
    }

    // Transform vidfly data to match our structure
    const transformedInfo = {
      title: data.title,
      thumbnail: data.cover,
      duration: data.duration,
      formats: data.items.map(item => ({
        url: item.url,
        height: parseInt(item.label) || 0,
        format_note: item.label,
        ext: item.ext || 'mp4',
        filesize: item.filesize,
        vcodec: item.label?.includes('video only') ? 'avc1' : 'avc1',
        acodec: item.label?.includes('audio only') ? 'none' : 'mp4a'
      }))
    };

    return processYouTubeData(transformedInfo, url);
  } catch (err) {
    console.error(`❌ Vidfly API error:`, err.message);
    throw new Error(`YouTube download failed: ${err.message}`);
  }
}

/**
 * Get random user agent
 */
function getRandomUserAgent() {
  const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
  ];
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

module.exports = { fetchYouTubeData };