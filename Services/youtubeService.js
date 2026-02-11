// Controllers/youtubeService.js - PRODUCTION READY FOR KOYEB
const { exec } = require('child_process');
const util = require('util');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const execPromise = util.promisify(exec);
const axios = require('axios');

// ========================================
// CONFIGURATION
// ========================================
const CONFIG = {
  FREE_TIER_MAX: 360,
  STANDARD_RESOLUTIONS: [144, 240, 360, 480, 720, 1080, 1440, 2160],
  COOKIES_PATH: path.join(os.tmpdir(), 'youtube-cookies.txt'),
  PROXY: process.env.YT_PROXY || null,
  PROXY_USER: process.env.YT_PROXY_USER || null,
  PROXY_PASS: process.env.YT_PROXY_PASS || null,
  RAPIDAPI_KEY: process.env.RAPIDAPI_KEY || null,
  USE_PROXY: process.env.USE_PROXY === 'true' || false,
  USER_AGENTS: [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/119.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'
  ]
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
    console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🖥️ Platform: ${process.platform}`);

    // ========================================
    // METHOD 1: yt-dlp with tv_embedded client
    // Most reliable on datacenter IPs — bypasses many restrictions
    // ========================================
    try {
      await createCookiesFile();
      const result = await fetchWithYtDlpTvClient(normalizedUrl, videoId);
      if (result && result.formats && result.formats.length > 0) {
        console.log(`✅ yt-dlp (tv_embedded) successful with ${result.formats.length} formats`);
        return processYouTubeData(result, url, videoId);
      }
    } catch (e) {
      console.log(`⚠️ yt-dlp (tv_embedded) failed: ${e.message.substring(0, 120)}`);
    }

    // ========================================
    // METHOD 2: yt-dlp with ios client
    // ========================================
    try {
      const result = await fetchWithYtDlpIosClient(normalizedUrl, videoId);
      if (result && result.formats && result.formats.length > 0) {
        console.log(`✅ yt-dlp (ios) successful with ${result.formats.length} formats`);
        return processYouTubeData(result, url, videoId);
      }
    } catch (e) {
      console.log(`⚠️ yt-dlp (ios) failed: ${e.message.substring(0, 120)}`);
    }

    // ========================================
    // METHOD 3: yt-dlp with android client (original)
    // ========================================
    try {
      const result = await fetchWithYtDlpAndroidClient(normalizedUrl, videoId);
      if (result && result.formats && result.formats.length > 0) {
        console.log(`✅ yt-dlp (android) successful with ${result.formats.length} formats`);
        return processYouTubeData(result, url, videoId);
      }
    } catch (e) {
      console.log(`⚠️ yt-dlp (android) failed: ${e.message.substring(0, 120)}`);
    }

    // ========================================
    // METHOD 4: yt-dlp with web client
    // ========================================
    try {
      const result = await fetchWithYtDlpWebClient(normalizedUrl, videoId);
      if (result && result.formats && result.formats.length > 0) {
        console.log(`✅ yt-dlp (web) successful with ${result.formats.length} formats`);
        return processYouTubeData(result, url, videoId);
      }
    } catch (e) {
      console.log(`⚠️ yt-dlp (web) failed: ${e.message.substring(0, 120)}`);
    }

    // ========================================
    // METHOD 5: cobalt.tools API
    // Free, no key needed, works on datacenter IPs
    // ========================================
    try {
      const result = await fetchFromCobalt(normalizedUrl, videoId);
      if (result && result.formats && result.formats.length > 0) {
        console.log(`✅ cobalt.tools successful with ${result.formats.length} formats`);
        return processYouTubeData(result, url, videoId);
      }
    } catch (e) {
      console.log(`⚠️ cobalt.tools failed: ${e.message.substring(0, 120)}`);
    }

    // ========================================
    // METHOD 6: Invidious API
    // ========================================
    try {
      const result = await fetchFromInvidious(videoId);
      if (result && result.formats && result.formats.length > 0) {
        console.log(`✅ Invidious successful with ${result.formats.length} formats`);
        return processYouTubeData(result, url, videoId);
      }
    } catch (e) {
      console.log(`⚠️ Invidious failed: ${e.message.substring(0, 120)}`);
    }

    // ========================================
    // METHOD 7: Piped API
    // ========================================
    try {
      const result = await fetchFromPiped(videoId);
      if (result && result.formats && result.formats.length > 0) {
        console.log(`✅ Piped successful with ${result.formats.length} formats`);
        return processYouTubeData(result, url, videoId);
      }
    } catch (e) {
      console.log(`⚠️ Piped failed: ${e.message.substring(0, 120)}`);
    }

    // ========================================
    // METHOD 8: RapidAPI (if key is available)
    // ========================================
    if (CONFIG.RAPIDAPI_KEY) {
      try {
        const result = await fetchFromRapidAPI(videoId);
        if (result && result.formats && result.formats.length > 0) {
          console.log(`✅ RapidAPI successful with ${result.formats.length} formats`);
          return processYouTubeData(result, url, videoId);
        }
      } catch (e) {
        console.log(`⚠️ RapidAPI failed: ${e.message.substring(0, 120)}`);
      }
    }

    // ========================================
    // FINAL FALLBACK - Return error (no fake URLs)
    // ========================================
    console.log('❌ All methods failed - returning error response');
    return {
      success: false,
      platform: 'youtube',
      error: 'No video formats available. YouTube is currently blocking this server. Please try again later.',
      title: `YouTube Video ${videoId}`,
      thumbnail: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
      duration: 0,
      uploader: 'YouTube',
      isShorts: url.includes('/shorts/'),
      url: null,
      formats: [],
      allFormats: [],
      selectedQuality: null,
      audioGuaranteed: false
    };

  } catch (error) {
    console.error('❌ YouTube service failed:', error.message);
    throw error;
  }
}

// ========================================
// YT-DLP SHARED HELPER
// Parses yt-dlp JSON output and builds formats array
// ========================================
function buildFormatsFromYtDlpInfo(info, videoId) {
  const videoUrl = info.url;
  if (!videoUrl || videoUrl.includes('youtube.com/watch')) {
    throw new Error('No real stream URL from yt-dlp');
  }

  const formats = [];
  const qualities = [720, 480, 360, 240, 144];

  qualities.forEach(height => {
    formats.push({
      url: videoUrl,
      label: `${height}p`,
      quality: `${height}p`,
      qualityNum: height,
      type: 'video/mp4',
      ext: 'mp4',
      filesize: info.filesize || 0,
      hasVideo: true,
      hasAudio: true,
      isVideoOnly: false,
      isAudioOnly: false
    });
  });

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
    title: info.title || `YouTube Video ${videoId}`,
    thumbnail: info.thumbnail || `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
    duration: info.duration || 0,
    uploader: info.uploader || 'YouTube',
    formats
  };
}

async function runYtDlp(url, extraArgs, videoId) {
  await createCookiesFile();

  let proxyArg = '';
  if (CONFIG.USE_PROXY && CONFIG.PROXY) {
    const auth = (CONFIG.PROXY_USER && CONFIG.PROXY_PASS)
      ? `${CONFIG.PROXY_USER}:${CONFIG.PROXY_PASS}@`
      : '';
    proxyArg = `--proxy http://${auth}${CONFIG.PROXY}`;
  }

  const userAgent = CONFIG.USER_AGENTS[Math.floor(Math.random() * CONFIG.USER_AGENTS.length)];

  const command = `yt-dlp \
    --no-playlist \
    --no-warnings \
    --no-check-certificate \
    ${extraArgs} \
    --cookies "${CONFIG.COOKIES_PATH}" \
    --geo-bypass \
    ${proxyArg} \
    --user-agent "${userAgent}" \
    --add-header "Accept-Language: en-US,en;q=0.9" \
    --format "best[height<=720][ext=mp4]/best[ext=mp4]/bestvideo[height<=720]+bestaudio/best" \
    --get-url \
    --print-json \
    "${url}"`;

  const { stdout } = await execPromise(command, {
    timeout: 30000,
    maxBuffer: 10 * 1024 * 1024,
    shell: '/bin/bash'
  });

  // yt-dlp with --get-url AND --print-json may print URL on first line, JSON on second
  // Handle both cases
  const lines = stdout.trim().split('\n');
  let info;

  // Try last non-empty line as JSON first (most reliable)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith('{')) {
      try {
        info = JSON.parse(line);
        break;
      } catch { continue; }
    }
  }

  if (!info) {
    throw new Error('Could not parse yt-dlp JSON output');
  }

  return buildFormatsFromYtDlpInfo(info, videoId);
}

// ========================================
// METHOD 1: TV EMBEDDED CLIENT
// Often bypasses bot detection on datacenter IPs
// ========================================
async function fetchWithYtDlpTvClient(url, videoId) {
  console.log(`📥 yt-dlp (tv_embedded) for: ${videoId}`);
  return runYtDlp(url, '--extractor-args "youtube:player_client=tv_embedded"', videoId);
}

// ========================================
// METHOD 2: IOS CLIENT
// ========================================
async function fetchWithYtDlpIosClient(url, videoId) {
  console.log(`📥 yt-dlp (ios) for: ${videoId}`);
  return runYtDlp(url, '--extractor-args "youtube:player_client=ios"', videoId);
}

// ========================================
// METHOD 3: ANDROID CLIENT
// ========================================
async function fetchWithYtDlpAndroidClient(url, videoId) {
  console.log(`📥 yt-dlp (android) for: ${videoId}`);
  return runYtDlp(url, '--extractor-args "youtube:player_client=android"', videoId);
}

// ========================================
// METHOD 4: WEB CLIENT
// ========================================
async function fetchWithYtDlpWebClient(url, videoId) {
  console.log(`📥 yt-dlp (web) for: ${videoId}`);
  return runYtDlp(url, '--extractor-args "youtube:player_client=web"', videoId);
}

// ========================================
// METHOD 5: COBALT.TOOLS API
// Free public API, no key needed
// https://github.com/imputnet/cobalt
// ========================================
async function fetchFromCobalt(url, videoId) {
  console.log(`📥 Fetching from cobalt.tools: ${videoId}`);

  const cobaltInstances = [
    'https://api.cobalt.tools',
    'https://cobalt.api.timelessnesses.me',
    'https://co.wuk.sh'
  ];

  for (const instance of cobaltInstances) {
    try {
      const response = await axios.post(
        instance,
        { url, vQuality: '720' },
        {
          timeout: 15000,
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'User-Agent': CONFIG.USER_AGENTS[0]
          }
        }
      );

      const data = response.data;

      // cobalt returns { status: 'stream'|'redirect'|'picker', url, ... }
      if (!data || data.status === 'error') {
        console.log(`⚠️ cobalt instance ${instance}: ${data?.error?.code || 'unknown error'}`);
        continue;
      }

      const formats = [];

      if (data.status === 'picker' && data.picker) {
        // Multiple streams available (e.g. separate video/audio)
        data.picker.forEach(item => {
          if (item.url) {
            formats.push({
              url: item.url,
              label: item.quality || '720p',
              quality: item.quality || '720p',
              qualityNum: parseInt(item.quality) || 720,
              type: 'video/mp4',
              ext: 'mp4',
              filesize: 0,
              hasVideo: true,
              hasAudio: true,
              isVideoOnly: false,
              isAudioOnly: false
            });
          }
        });
      } else if (data.url) {
        // Single stream — create multiple quality labels pointing to same URL
        // (cobalt transcodes on the fly or redirects to best available)
        [720, 480, 360].forEach(height => {
          formats.push({
            url: data.url,
            label: `${height}p`,
            quality: `${height}p`,
            qualityNum: height,
            type: 'video/mp4',
            ext: 'mp4',
            filesize: 0,
            hasVideo: true,
            hasAudio: true,
            isVideoOnly: false,
            isAudioOnly: false
          });
        });

        // Request audio-only from cobalt
        try {
          const audioResponse = await axios.post(
            instance,
            { url, isAudioOnly: true, aFormat: 'm4a' },
            {
              timeout: 10000,
              headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
              }
            }
          );
          if (audioResponse.data?.url) {
            formats.push({
              url: audioResponse.data.url,
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
          }
        } catch { /* audio optional */ }
      }

      if (formats.length > 0) {
        // Get title from Invidious metadata (lightweight call)
        let title = `YouTube Video ${videoId}`;
        let duration = 0;
        let uploader = 'YouTube';
        try {
          const meta = await axios.get(
            `https://invidious.kavin.rocks/api/v1/videos/${videoId}?fields=title,lengthSeconds,author`,
            { timeout: 5000 }
          );
          title = meta.data.title || title;
          duration = meta.data.lengthSeconds || 0;
          uploader = meta.data.author || uploader;
        } catch { /* metadata optional */ }

        return {
          title,
          thumbnail: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
          duration,
          uploader,
          formats
        };
      }
    } catch (e) {
      console.log(`⚠️ cobalt ${instance}: ${e.message.substring(0, 80)}`);
      continue;
    }
  }

  throw new Error('All cobalt instances failed');
}

// ========================================
// METHOD 6: INVIDIOUS API
// ========================================
async function fetchFromInvidious(videoId) {
  console.log(`📥 Fetching from Invidious: ${videoId}`);

  const invidiousInstances = [
    'https://invidious.kavin.rocks',
    'https://inv.riverside.rocks',
    'https://invidious.flokinet.to',
    'https://invidious.privacydev.net',
    'https://yewtu.be',
    'https://invidious.snopyta.org',
    'https://vid.puffyan.us',
    'https://invidious.nerdvpn.de',
    'https://invidious.esmailelbob.xyz'
  ];

  const shuffled = invidiousInstances.sort(() => 0.5 - Math.random());

  for (const instance of shuffled.slice(0, 5)) {
    try {
      const response = await axios.get(`${instance}/api/v1/videos/${videoId}`, {
        timeout: 8000,
        headers: {
          'User-Agent': CONFIG.USER_AGENTS[Math.floor(Math.random() * CONFIG.USER_AGENTS.length)]
        }
      });

      const data = response.data;
      const formats = [];

      if (data.formatStreams) {
        data.formatStreams.forEach(stream => {
          if (stream.url && stream.encoding) {
            formats.push({
              url: stream.url,
              label: stream.qualityLabel || stream.quality || 'Unknown',
              quality: stream.qualityLabel || stream.quality || 'Unknown',
              qualityNum: parseInt(stream.quality) || 360,
              type: stream.type || 'video/mp4',
              ext: 'mp4',
              filesize: 0,
              hasVideo: true,
              hasAudio: true, // formatStreams are muxed
              isVideoOnly: false,
              isAudioOnly: false
            });
          }
        });
      }

      if (data.adaptiveFormats) {
        data.adaptiveFormats.forEach(stream => {
          if (stream.url) {
            const isVideo = stream.type.includes('video');
            const isAudio = stream.type.includes('audio');
            formats.push({
              url: stream.url,
              label: isVideo ? (stream.qualityLabel || stream.quality || 'Video') : `${stream.bitrate || 128}kbps`,
              quality: isVideo ? (stream.qualityLabel || stream.quality || 'Video') : `${stream.bitrate || 128}kbps`,
              qualityNum: isVideo ? (parseInt(stream.quality) || 360) : (stream.bitrate || 128000),
              type: stream.type,
              ext: isVideo ? 'mp4' : 'm4a',
              filesize: stream.clen || 0,
              hasVideo: isVideo,
              hasAudio: isAudio,
              isVideoOnly: isVideo && !isAudio,
              isAudioOnly: isAudio && !isVideo
            });
          }
        });
      }

      if (formats.length > 0) {
        return {
          title: data.title || `Video ${videoId}`,
          thumbnail: data.videoThumbnails?.[0]?.url || `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
          duration: data.lengthSeconds || 0,
          uploader: data.author || 'YouTube',
          formats
        };
      }
    } catch (e) {
      console.log(`⚠️ Invidious ${instance}: ${e.message.substring(0, 60)}`);
      continue;
    }
  }

  throw new Error('All Invidious instances failed');
}

// ========================================
// METHOD 7: PIPED API
// ========================================
async function fetchFromPiped(videoId) {
  console.log(`📥 Fetching from Piped: ${videoId}`);

  const pipedInstances = [
    'https://pipedapi.kavin.rocks',
    'https://piped-api.garudalinux.org',
    'https://api.piped.projectsegfau.lt',
    'https://piped.tokhmi.xyz'
  ];

  for (const instance of pipedInstances) {
    try {
      const response = await axios.get(`${instance}/streams/${videoId}`, {
        timeout: 8000,
        headers: {
          'User-Agent': CONFIG.USER_AGENTS[Math.floor(Math.random() * CONFIG.USER_AGENTS.length)]
        }
      });

      const data = response.data;
      const formats = [];

      if (data.videoStreams) {
        data.videoStreams.forEach(stream => {
          if (stream.url) {
            formats.push({
              url: stream.url,
              label: stream.quality,
              quality: stream.quality,
              qualityNum: parseInt(stream.quality) || 360,
              type: stream.mimeType || 'video/mp4',
              ext: 'mp4',
              filesize: 0,
              hasVideo: true,
              hasAudio: false,
              isVideoOnly: true,
              isAudioOnly: false
            });
          }
        });
      }

      if (data.audioStreams) {
        data.audioStreams.forEach(stream => {
          if (stream.url) {
            formats.push({
              url: stream.url,
              label: `${stream.bitrate || 128}kbps`,
              quality: `${stream.bitrate || 128}kbps`,
              qualityNum: (stream.bitrate || 128) * 1000,
              type: stream.mimeType || 'audio/webm',
              ext: 'webm',
              filesize: 0,
              hasVideo: false,
              hasAudio: true,
              isVideoOnly: false,
              isAudioOnly: true
            });
          }
        });
      }

      if (formats.length > 0) {
        return {
          title: data.title || `Video ${videoId}`,
          thumbnail: data.thumbnailUrl || `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
          duration: data.duration || 0,
          uploader: data.uploader || 'YouTube',
          formats
        };
      }
    } catch (e) {
      console.log(`⚠️ Piped ${instance}: ${e.message.substring(0, 60)}`);
      continue;
    }
  }
  throw new Error('All Piped instances failed');
}

// ========================================
// METHOD 8: RAPIDAPI
// ========================================
async function fetchFromRapidAPI(videoId) {
  console.log(`📥 Fetching from RapidAPI: ${videoId}`);

  const response = await axios.get('https://youtube-media-downloader.p.rapidapi.com/v2/video/details', {
    params: { videoId },
    headers: {
      'X-RapidAPI-Key': CONFIG.RAPIDAPI_KEY,
      'X-RapidAPI-Host': 'youtube-media-downloader.p.rapidapi.com'
    },
    timeout: 10000
  });

  const data = response.data;
  const formats = [];

  if (data?.videos?.items) {
    data.videos.items.forEach(item => {
      if (item.url) {
        formats.push({
          url: item.url,
          label: item.quality,
          quality: item.quality,
          qualityNum: parseInt(item.quality) || 360,
          type: 'video/mp4',
          ext: 'mp4',
          filesize: item.size || 0,
          hasVideo: true,
          hasAudio: !item.quality.includes('noaudio'),
          isVideoOnly: item.quality.includes('noaudio'),
          isAudioOnly: false
        });
      }
    });
  }

  if (data?.audios?.items) {
    data.audios.items.forEach(item => {
      if (item.url) {
        formats.push({
          url: item.url,
          label: item.quality || '128kbps',
          quality: item.quality || '128kbps',
          qualityNum: 128000,
          type: 'audio/mp4',
          ext: 'm4a',
          filesize: item.size || 0,
          hasVideo: false,
          hasAudio: true,
          isVideoOnly: false,
          isAudioOnly: true
        });
      }
    });
  }

  if (formats.length === 0) throw new Error('No formats from RapidAPI');

  return {
    title: data.title || `Video ${videoId}`,
    thumbnail: data.thumbnail || `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
    duration: data.duration || 0,
    uploader: data.author || 'YouTube',
    formats
  };
}

// ========================================
// COOKIES FILE
// ========================================
async function createCookiesFile() {
  try {
    await fs.access(CONFIG.COOKIES_PATH);
    return;
  } catch {
    const randomCB = Math.floor(Math.random() * 1000);
    const cookieContent = `# Netscape HTTP Cookie File
.youtube.com\tTRUE\t/\tTRUE\t1767225600\tCONSENT\tYES+cb.20250305-11-p0.en+FX+${randomCB}
.youtube.com\tTRUE\t/\tFALSE\t1767225600\tVISITOR_INFO1_LIVE\t${crypto.randomBytes(11).toString('base64').replace(/[^a-zA-Z0-9_-]/g, '')}
.youtube.com\tTRUE\t/\tFALSE\t1767225600\tYSC\t${crypto.randomBytes(8).toString('base64').replace(/[^a-zA-Z0-9_-]/g, '')}
.youtube.com\tTRUE\t/\tFALSE\t1767225600\tGPS\t1
`;
    await fs.writeFile(CONFIG.COOKIES_PATH, cookieContent, 'utf8');
    console.log(`✅ Created cookies file at: ${CONFIG.COOKIES_PATH}`);
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
function processYouTubeData(data, url, videoId) {
  const isShorts = url.includes('/shorts/');

  console.log(`📊 Processing ${data.formats.length} total formats...`);

  // ⚠️ CRITICAL: Filter out non-stream URLs
  // A real stream URL will be a long signed Google URL, NOT a youtube.com/watch URL
  let validFormats = data.formats.filter(f =>
    f &&
    f.url &&
    !f.url.includes('img.youtube.com') &&
    !f.url.includes('youtube.com/watch') &&
    !f.url.includes('youtu.be/')
  );

  if (validFormats.length === 0) {
    throw new Error('No valid stream URLs after filtering');
  }

  const videoFormats = validFormats.filter(f => f.hasVideo && !f.isAudioOnly);
  const audioFormats = validFormats.filter(f => f.isAudioOnly);

  // Deduplicate by quality
  const uniqueVideos = new Map();
  videoFormats.forEach(format => {
    const key = format.qualityNum;
    if (!uniqueVideos.has(key) || format.filesize > (uniqueVideos.get(key)?.filesize || 0)) {
      uniqueVideos.set(key, format);
    }
  });

  let uniqueVideoList = Array.from(uniqueVideos.values())
    .filter(f => CONFIG.STANDARD_RESOLUTIONS.includes(f.qualityNum) || f.qualityNum > 0)
    .sort((a, b) => a.qualityNum - b.qualityNum);

  const bestAudio = audioFormats.length > 0
    ? [audioFormats.sort((a, b) => b.qualityNum - a.qualityNum)[0]]
    : [];

  const allFormats = [...uniqueVideoList, ...bestAudio];

  console.log(`🎬 Final formats: ${allFormats.length}`);

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

  const defaultFormat = qualityOptions.find(f => !f.isAudioOnly && f.qualityNum === CONFIG.FREE_TIER_MAX)
    || qualityOptions.find(f => !f.isAudioOnly)
    || qualityOptions[0]
    || null;

  const result = {
    success: true,
    platform: 'youtube',
    title: data.title || `YouTube Video ${videoId}`,
    thumbnail: data.thumbnail || `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
    duration: data.duration || 0,
    uploader: data.uploader || 'YouTube',
    isShorts: isShorts,
    url: defaultFormat?.url || null,
    formats: qualityOptions,
    allFormats: qualityOptions,
    selectedQuality: defaultFormat,
    audioGuaranteed: defaultFormat?.hasAudio || false
  };

  console.log(`✅ YouTube service completed with ${qualityOptions.length} quality options`);
  if (defaultFormat) {
    console.log(`🎯 Default: ${defaultFormat.quality} (${defaultFormat.isPremium ? '💰 Premium' : '✅ Free'})`);
    console.log(`🔗 URL preview: ${defaultFormat.url.substring(0, 80)}...`);
  }

  return result;
}

// ========================================
// EXPORTS
// ========================================
module.exports = { fetchYouTubeData };