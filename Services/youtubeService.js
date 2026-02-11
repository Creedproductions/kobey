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
  // Environment-based configuration for Koyeb
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
    // METHOD 1: yt-dlp with cookies & proxy (Best for Koyeb)
    // ========================================
    try {
      await createCookiesFile();
      const result = await fetchWithYtDlp(normalizedUrl, videoId);
      if (result && result.formats && result.formats.length > 0) {
        console.log(`✅ yt-dlp successful with ${result.formats.length} formats`);
        return processYouTubeData(result, url, videoId);
      }
    } catch (ytdlpError) {
      console.log(`⚠️ yt-dlp failed: ${ytdlpError.message.substring(0, 100)}...`);
    }

    // ========================================
    // METHOD 2: yt-dlp with different client (Web)
    // ========================================
    try {
      const result = await fetchWithYtDlpWebClient(normalizedUrl, videoId);
      if (result && result.formats && result.formats.length > 0) {
        console.log(`✅ yt-dlp (web) successful with ${result.formats.length} formats`);
        return processYouTubeData(result, url, videoId);
      }
    } catch (ytdlpWebError) {
      console.log(`⚠️ yt-dlp web client failed: ${ytdlpWebError.message.substring(0, 100)}...`);
    }

    // ========================================
    // METHOD 3: Invidious API (Best public fallback)
    // ========================================
    try {
      const result = await fetchFromInvidious(videoId);
      if (result && result.formats && result.formats.length > 0) {
        console.log(`✅ Invidious successful with ${result.formats.length} formats`);
        return processYouTubeData(result, url, videoId);
      }
    } catch (invidiousError) {
      console.log(`⚠️ Invidious failed: ${invidiousError.message.substring(0, 100)}...`);
    }

    // ========================================
    // METHOD 4: YouTube8ths Proxy
    // ========================================
    try {
      const result = await fetchFromYouTube8ths(videoId);
      if (result && result.formats && result.formats.length > 0) {
        console.log(`✅ YouTube8ths successful with ${result.formats.length} formats`);
        return processYouTubeData(result, url, videoId);
      }
    } catch (y8Error) {
      console.log(`⚠️ YouTube8ths failed: ${y8Error.message.substring(0, 100)}...`);
    }

    // ========================================
    // METHOD 5: RapidAPI (If key is available)
    // ========================================
    if (CONFIG.RAPIDAPI_KEY) {
      try {
        const result = await fetchFromRapidAPI(videoId);
        if (result && result.formats && result.formats.length > 0) {
          console.log(`✅ RapidAPI successful with ${result.formats.length} formats`);
          return processYouTubeData(result, url, videoId);
        }
      } catch (rapidError) {
        console.log(`⚠️ RapidAPI failed: ${rapidError.message.substring(0, 100)}...`);
      }
    }

    // ========================================
    // METHOD 6: Piped API (Another Invidious alternative)
    // ========================================
    try {
      const result = await fetchFromPiped(videoId);
      if (result && result.formats && result.formats.length > 0) {
        console.log(`✅ Piped successful with ${result.formats.length} formats`);
        return processYouTubeData(result, url, videoId);
      }
    } catch (pipedError) {
      console.log(`⚠️ Piped failed: ${pipedError.message.substring(0, 100)}...`);
    }

    // ========================================
    // METHOD 7: Direct video URL generation
    // ========================================
    try {
      const result = await fetchDirectVideo(videoId);
      if (result && result.formats && result.formats.length > 0) {
        console.log(`✅ Direct video successful with ${result.formats.length} formats`);
        return processYouTubeData(result, url, videoId);
      }
    } catch (directError) {
      console.log(`⚠️ Direct video failed: ${directError.message.substring(0, 100)}...`);
    }

    // ========================================
    // FINAL FALLBACK - Return error response (NO THUMBNAIL AS VIDEO)
    // ========================================
    console.log('⚠️ All methods failed, returning error response');
    return {
      success: false,
      platform: 'youtube',
      error: 'No video formats available. YouTube is currently blocking this server.',
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
// METHOD 1: YT-DLP WITH ANDROID CLIENT + PROXY
// ========================================
async function createCookiesFile() {
  try {
    await fs.access(CONFIG.COOKIES_PATH);
    console.log('✅ Cookies file already exists');
    return;
  } catch {
    // Generate random CONSENT cookie to avoid bot detection
    const randomCB = Math.floor(Math.random() * 1000);
    const cookieContent = `# Netscape HTTP Cookie File
.youtube.com	TRUE	/	TRUE	1767225600	CONSENT	YES+cb.20250305-11-p0.en+FX+${randomCB}
.youtube.com	TRUE	/	FALSE	1767225600	VISITOR_INFO1_LIVE	${crypto.randomBytes(11).toString('base64').replace(/[^a-zA-Z0-9_-]/g, '')}
.youtube.com	TRUE	/	FALSE	1767225600	YSC	${crypto.randomBytes(8).toString('base64').replace(/[^a-zA-Z0-9_-]/g, '')}
.youtube.com	TRUE	/	FALSE	1767225600	GPS	1
`;
    await fs.writeFile(CONFIG.COOKIES_PATH, cookieContent, 'utf8');
    console.log(`✅ Created cookies file at: ${CONFIG.COOKIES_PATH}`);
  }
}

async function fetchWithYtDlp(url, videoId) {
  console.log(`📥 Running yt-dlp (android client) for: ${videoId}`);
  await createCookiesFile();

  let proxyArg = '';
  if (CONFIG.USE_PROXY && CONFIG.PROXY) {
    if (CONFIG.PROXY_USER && CONFIG.PROXY_PASS) {
      proxyArg = `--proxy http://${CONFIG.PROXY_USER}:${CONFIG.PROXY_PASS}@${CONFIG.PROXY}`;
    } else {
      proxyArg = `--proxy ${CONFIG.PROXY}`;
    }
    console.log(`🔒 Using proxy: ${CONFIG.PROXY}`);
  }

  const userAgent = CONFIG.USER_AGENTS[Math.floor(Math.random() * CONFIG.USER_AGENTS.length)];

  const command = `yt-dlp \
    --no-playlist \
    --no-warnings \
    --no-check-certificate \
    --extractor-args "youtube:player_client=android" \
    --cookies "${CONFIG.COOKIES_PATH}" \
    --geo-bypass \
    --user-agent "${userAgent}" \
    --add-header "Accept-Language: en-US,en;q=0.9" \
    --format "best[height<=720][ext=mp4]/best[ext=mp4]/best" \
    --get-url \
    --print-json \
    "${url}"`;

  const { stdout } = await execPromise(command, {
    timeout: 20000,
    maxBuffer: 10 * 1024 * 1024,
    shell: '/bin/bash'
  });

  const info = JSON.parse(stdout);
  const videoUrl = info.url;

  if (!videoUrl) {
    throw new Error('No video URL obtained from yt-dlp');
  }

  console.log(`✅ Got video URL: ${videoUrl.substring(0, 50)}...`);

  const formats = [];
  const qualities = [
    { height: 720, label: '720p' },
    { height: 480, label: '480p' },
    { height: 360, label: '360p' },
    { height: 240, label: '240p' },
    { height: 144, label: '144p' }
  ];

  qualities.forEach(q => {
    formats.push({
      url: videoUrl,
      label: q.label,
      quality: q.label,
      qualityNum: q.height,
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
    formats: formats
  };
}

// ========================================
// METHOD 2: YT-DLP WITH WEB CLIENT
// ========================================
async function fetchWithYtDlpWebClient(url, videoId) {
  console.log(`📥 Running yt-dlp (web client) for: ${videoId}`);
  await createCookiesFile();

  const command = `yt-dlp \
    --no-playlist \
    --no-warnings \
    --no-check-certificate \
    --extractor-args "youtube:player_client=web" \
    --cookies "${CONFIG.COOKIES_PATH}" \
    --geo-bypass \
    --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" \
    --format "best[height<=720][ext=mp4]/best[ext=mp4]/best" \
    --get-url \
    --print-json \
    "${url}"`;

  const { stdout } = await execPromise(command, {
    timeout: 20000,
    maxBuffer: 10 * 1024 * 1024,
    shell: '/bin/bash'
  });

  const info = JSON.parse(stdout);
  const videoUrl = info.url;

  if (!videoUrl) {
    throw new Error('No video URL obtained from yt-dlp');
  }

  const formats = [];
  [720, 480, 360, 240, 144].forEach(height => {
    formats.push({
      url: videoUrl,
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

  return {
    title: info.title || `YouTube Video ${videoId}`,
    thumbnail: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
    duration: info.duration || 0,
    uploader: info.uploader || 'YouTube',
    formats: formats
  };
}

// ========================================
// METHOD 3: INVIDIOUS API (Most Reliable on Koyeb)
// ========================================
async function fetchFromInvidious(videoId) {
  console.log(`📥 Fetching from Invidious: ${videoId}`);

  const invidiousInstances = [
    'https://invidious.snopyta.org',
    'https://yewtu.be',
    'https://invidious.kavin.rocks',
    'https://inv.riverside.rocks',
    'https://invidious.flokinet.to',
    'https://invidious.esmailelbob.xyz',
    'https://invidious.nerdvpn.de',
    'https://invidious.privacydev.net',
    'https://vid.puffyan.us'
  ];

  // Shuffle instances for load balancing
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

      // Add video formats
      if (data.formatStreams) {
        data.formatStreams.forEach(stream => {
          if (stream.url && stream.encoding) {
            formats.push({
              url: stream.url,
              label: `${stream.qualityLabel || stream.quality || 'Unknown'}`,
              quality: `${stream.qualityLabel || stream.quality || 'Unknown'}`,
              qualityNum: parseInt(stream.quality) || 360,
              type: stream.type || 'video/mp4',
              ext: 'mp4',
              filesize: 0,
              hasVideo: true,
              hasAudio: stream.encoding.includes('audio'),
              isVideoOnly: !stream.encoding.includes('audio'),
              isAudioOnly: false
            });
          }
        });
      }

      // Add adaptive formats
      if (data.adaptiveFormats) {
        data.adaptiveFormats.forEach(stream => {
          if (stream.url) {
            const isVideo = stream.type.includes('video');
            const isAudio = stream.type.includes('audio');

            formats.push({
              url: stream.url,
              label: isVideo ? `${stream.qualityLabel || stream.quality || 'Video'}` : `${stream.bitrate || 128}kbps`,
              quality: isVideo ? `${stream.qualityLabel || stream.quality || 'Video'}` : `${stream.bitrate || 128}kbps`,
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
          formats: formats
        };
      }
    } catch (e) {
      console.log(`⚠️ Invidious instance ${instance} failed: ${e.message.substring(0, 50)}...`);
      continue;
    }
  }

  throw new Error('All Invidious instances failed');
}

// ========================================
// METHOD 4: YOUTUBE8THS PROXY
// ========================================
async function fetchFromYouTube8ths(videoId) {
  console.log(`📥 Fetching from YouTube8ths: ${videoId}`);

  try {
    const response = await axios.get(`https://youtube8ths.herokuapp.com/api/info?url=https://www.youtube.com/watch?v=${videoId}`, {
      timeout: 10000,
      headers: {
        'User-Agent': CONFIG.USER_AGENTS[Math.floor(Math.random() * CONFIG.USER_AGENTS.length)]
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

    if (formats.length > 0) {
      return {
        title: data.title || `Video ${videoId}`,
        thumbnail: data.thumbnail || `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
        duration: data.duration || 0,
        uploader: data.author || 'YouTube',
        formats: formats
      };
    }
    throw new Error('No formats from YouTube8ths');
  } catch (error) {
    throw new Error(`YouTube8ths failed: ${error.message}`);
  }
}

// ========================================
// METHOD 5: RAPIDAPI
// ========================================
async function fetchFromRapidAPI(videoId) {
  console.log(`📥 Fetching from RapidAPI: ${videoId}`);

  try {
    const response = await axios.get('https://youtube-media-downloader.p.rapidapi.com/v2/video/details', {
      params: { videoId: videoId },
      headers: {
        'X-RapidAPI-Key': CONFIG.RAPIDAPI_KEY,
        'X-RapidAPI-Host': 'youtube-media-downloader.p.rapidapi.com'
      },
      timeout: 10000
    });

    const data = response.data;
    const formats = [];

    if (data && data.videos && data.videos.items) {
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
            hasAudio: !item.quality.includes('1080') && !item.quality.includes('noaudio'),
            isVideoOnly: item.quality.includes('1080') || item.quality.includes('noaudio'),
            isAudioOnly: false
          });
        }
      });
    }

    if (data && data.audios && data.audios.items) {
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

    if (formats.length > 0) {
      return {
        title: data.title || `Video ${videoId}`,
        thumbnail: data.thumbnail || `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
        duration: data.duration || 0,
        uploader: data.author || 'YouTube',
        formats: formats
      };
    }
    throw new Error('No formats from RapidAPI');
  } catch (error) {
    throw new Error(`RapidAPI failed: ${error.message}`);
  }
}

// ========================================
// METHOD 6: PIPED API
// ========================================
async function fetchFromPiped(videoId) {
  console.log(`📥 Fetching from Piped: ${videoId}`);

  const pipedInstances = [
    'https://piped.video',
    'https://piped.kavin.rocks',
    'https://piped.syncpundit.com',
    'https://piped.tokhmi.xyz'
  ];

  for (const instance of pipedInstances) {
    try {
      const response = await axios.get(`${instance}/api/v1/streams/${videoId}`, {
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
              type: 'video/mp4',
              ext: 'mp4',
              filesize: 0,
              hasVideo: true,
              hasAudio: !stream.quality.includes('1080'),
              isVideoOnly: stream.quality.includes('1080'),
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
              type: 'audio/webm',
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
          formats: formats
        };
      }
    } catch (e) {
      continue;
    }
  }
  throw new Error('All Piped instances failed');
}

// ========================================
// METHOD 7: DIRECT VIDEO URL GENERATION
// ========================================
async function fetchDirectVideo(videoId) {
  console.log(`📥 Fetching direct video: ${videoId}`);

  const formats = [];

  try {
    const response = await axios.get(`https://www.youtube.com/watch?v=${videoId}`, {
      timeout: 5000,
      headers: {
        'User-Agent': CONFIG.USER_AGENTS[Math.floor(Math.random() * CONFIG.USER_AGENTS.length)],
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });

    const titleMatch = response.data.match(/<title>(.*?)<\/title>/);
    const title = titleMatch ? titleMatch[1].replace(' - YouTube', '') : `Video ${videoId}`;

    const qualities = [
      { itag: 18, label: '360p', height: 360, hasAudio: true },
      { itag: 22, label: '720p', height: 720, hasAudio: true },
      { itag: 137, label: '1080p', height: 1080, hasAudio: false },
      { itag: 140, label: '128kbps', height: 0, isAudio: true }
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

  // Filter out invalid formats
  let validFormats = data.formats.filter(f => f && f.url &&
    !f.url.includes('img.youtube.com') &&
    !f.url.includes('youtube.com/watch'));

  if (validFormats.length === 0) {
    validFormats = data.formats.filter(f => f && f.url);
  }

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
    .filter(f => CONFIG.STANDARD_RESOLUTIONS.includes(f.qualityNum) || f.qualityNum > 0)
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
  ) || qualityOptions.find(f => !f.isAudioOnly) || qualityOptions[0] || null;

  // Build response
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
  }

  return result;
}

// ========================================
// EXPORTS
// ========================================
module.exports = { fetchYouTubeData };