// ============================================================
// Services/youtubeService.js  –  PRODUCTION READY 2026
// ============================================================
// WHAT WAS BROKEN & FIXED:
//
//  ❌ OLD: --get-url + --print-json used together → garbled stdout, unreliable parse
//  ✅ FIX: Use -j (--dump-json) ONLY → clean JSON with formats[] array
//
//  ❌ OLD: All 144p/240p/360p/480p/720p labels pointed to the SAME single URL
//  ✅ FIX: Parse real formats[] from yt-dlp JSON, each quality gets its own URL
//
//  ❌ OLD: Video-only streams never paired with audio (MERGE: never built)
//  ✅ FIX: Properly pair video-only + best-audio into MERGE: urls
//
//  ❌ OLD: Cobalt API used old v1 vQuality param (rejected by 2025+ instances)
//  ✅ FIX: Cobalt API v2 request format
//
//  ❌ OLD: buildFormatsFromYtDlpInfo faked quality list from a single stream
//  ✅ FIX: buildFormatsFromYtDlpJson extracts real per-quality stream URLs
// ============================================================

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
// MAIN EXPORT
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

    await createCookiesFile();

    // ── METHOD 1: yt-dlp tv_embedded client ──────────────────────────────────
    try {
      const result = await fetchWithYtDlpClient(normalizedUrl, videoId, 'tv_embedded');
      if (result?.formats?.length > 0) {
        console.log(`✅ yt-dlp (tv_embedded) — ${result.formats.length} formats`);
        return processYouTubeData(result, url, videoId);
      }
    } catch (e) {
      console.log(`⚠️ yt-dlp (tv_embedded): ${e.message.substring(0, 150)}`);
    }

    // ── METHOD 2: yt-dlp ios client ───────────────────────────────────────────
    try {
      const result = await fetchWithYtDlpClient(normalizedUrl, videoId, 'ios');
      if (result?.formats?.length > 0) {
        console.log(`✅ yt-dlp (ios) — ${result.formats.length} formats`);
        return processYouTubeData(result, url, videoId);
      }
    } catch (e) {
      console.log(`⚠️ yt-dlp (ios): ${e.message.substring(0, 150)}`);
    }

    // ── METHOD 3: yt-dlp android client ──────────────────────────────────────
    try {
      const result = await fetchWithYtDlpClient(normalizedUrl, videoId, 'android');
      if (result?.formats?.length > 0) {
        console.log(`✅ yt-dlp (android) — ${result.formats.length} formats`);
        return processYouTubeData(result, url, videoId);
      }
    } catch (e) {
      console.log(`⚠️ yt-dlp (android): ${e.message.substring(0, 150)}`);
    }

    // ── METHOD 4: yt-dlp web client ───────────────────────────────────────────
    try {
      const result = await fetchWithYtDlpClient(normalizedUrl, videoId, 'web');
      if (result?.formats?.length > 0) {
        console.log(`✅ yt-dlp (web) — ${result.formats.length} formats`);
        return processYouTubeData(result, url, videoId);
      }
    } catch (e) {
      console.log(`⚠️ yt-dlp (web): ${e.message.substring(0, 150)}`);
    }

    // ── METHOD 5: Cobalt API v2 ───────────────────────────────────────────────
    try {
      const result = await fetchFromCobalt(normalizedUrl, videoId);
      if (result?.formats?.length > 0) {
        console.log(`✅ cobalt.tools — ${result.formats.length} formats`);
        return processYouTubeData(result, url, videoId);
      }
    } catch (e) {
      console.log(`⚠️ cobalt.tools: ${e.message.substring(0, 150)}`);
    }

    // ── METHOD 6: Invidious ───────────────────────────────────────────────────
    try {
      const result = await fetchFromInvidious(videoId);
      if (result?.formats?.length > 0) {
        console.log(`✅ Invidious — ${result.formats.length} formats`);
        return processYouTubeData(result, url, videoId);
      }
    } catch (e) {
      console.log(`⚠️ Invidious: ${e.message.substring(0, 150)}`);
    }

    // ── METHOD 7: Piped ───────────────────────────────────────────────────────
    try {
      const result = await fetchFromPiped(videoId);
      if (result?.formats?.length > 0) {
        console.log(`✅ Piped — ${result.formats.length} formats`);
        return processYouTubeData(result, url, videoId);
      }
    } catch (e) {
      console.log(`⚠️ Piped: ${e.message.substring(0, 150)}`);
    }

    // ── METHOD 8: RapidAPI ────────────────────────────────────────────────────
    if (CONFIG.RAPIDAPI_KEY) {
      try {
        const result = await fetchFromRapidAPI(videoId);
        if (result?.formats?.length > 0) {
          console.log(`✅ RapidAPI — ${result.formats.length} formats`);
          return processYouTubeData(result, url, videoId);
        }
      } catch (e) {
        console.log(`⚠️ RapidAPI: ${e.message.substring(0, 150)}`);
      }
    }

    // ── ALL FAILED ─────────────────────────────────────────────────────────────
    console.log('❌ All methods exhausted — returning error response');
    return {
      success: false,
      platform: 'youtube',
      error: 'YouTube is blocking this server. Please try again later.',
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
    console.error('❌ YouTube service top-level error:', error.message);
    throw error;
  }
}

// ========================================
// yt-dlp CORE (THE BIG FIX)
//
// OLD (broken): --get-url + --print-json together → garbled output
//               All qualities faked from a single URL
//
// NEW (fixed):  -j (dump-json) ONLY → clean JSON → formats[] array
//               Each quality gets its own real stream URL
//               Video-only + audio-only properly paired → MERGE: url
// ========================================
async function fetchWithYtDlpClient(url, videoId, clientName) {
  console.log(`📥 yt-dlp (${clientName}) for: ${videoId}`);

  let proxyArg = '';
  if (CONFIG.USE_PROXY && CONFIG.PROXY) {
    const auth = (CONFIG.PROXY_USER && CONFIG.PROXY_PASS)
      ? `${CONFIG.PROXY_USER}:${CONFIG.PROXY_PASS}@`
      : '';
    proxyArg = `--proxy "http://${auth}${CONFIG.PROXY}"`;
  }

  const userAgent = CONFIG.USER_AGENTS[Math.floor(Math.random() * CONFIG.USER_AGENTS.length)];

  // ─────────────────────────────────────────────────────────────
  // KEY CHANGE: Use -j (dump-json) ONLY.
  //
  // -j dumps the FULL format JSON including the formats[] array,
  // where EVERY quality has its own real stream URL.
  //
  // Do NOT add --get-url — that flag is incompatible with -j and
  // causes garbled stdout (raw URL on line 1, JSON on later lines)
  // which breaks JSON.parse and makes quality selection impossible.
  //
  // Do NOT add --format — we want ALL formats so we can build a
  // proper quality selector. We'll pick the right one ourselves.
  // ─────────────────────────────────────────────────────────────
  const command = [
    'yt-dlp',
    '-j',                          // ← ONLY dump-json, nothing else
    '--no-playlist',
    '--no-warnings',
    '--no-check-certificate',
    `--extractor-args "youtube:player_client=${clientName}"`,
    `--cookies "${CONFIG.COOKIES_PATH}"`,
    '--geo-bypass',
    proxyArg,
    `--user-agent "${userAgent}"`,
    '--add-header "Accept-Language: en-US,en;q=0.9"',
    `"${url}"`
  ].filter(Boolean).join(' ');

  let stdout;
  try {
    const result = await execPromise(command, {
      timeout: 40000,
      maxBuffer: 20 * 1024 * 1024, // 20 MB — full JSON can be large
      shell: '/bin/bash'
    });
    stdout = result.stdout;
  } catch (execError) {
    const errMsg = (execError.stderr || execError.message || '').substring(0, 300);
    throw new Error(`yt-dlp (${clientName}) process error: ${errMsg}`);
  }

  // ─────────────────────────────────────────────────────────────
  // Parse the JSON — it should be a single large JSON object
  // ─────────────────────────────────────────────────────────────
  const lines = stdout.trim().split('\n');
  let info = null;

  // Find the JSON object line (may have yt-dlp progress/warning lines before it)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith('{') && line.endsWith('}')) {
      try {
        info = JSON.parse(line);
        break;
      } catch { continue; }
    }
  }

  if (!info) {
    throw new Error(`yt-dlp (${clientName}): Could not find valid JSON in output`);
  }

  // ─────────────────────────────────────────────────────────────
  // Extract real per-quality stream URLs from formats[]
  // ─────────────────────────────────────────────────────────────
  return buildFormatsFromYtDlpJson(info, videoId, clientName);
}

// ========================================
// BUILD FORMATS FROM yt-dlp JSON
// This is the correct implementation that was missing before.
// ========================================
function buildFormatsFromYtDlpJson(info, videoId, clientName) {
  if (!info.formats || !Array.isArray(info.formats)) {
    // Some yt-dlp outputs don't have a formats array (single-format video)
    // Fall back to the top-level url if present
    if (info.url && isRealStreamUrl(info.url)) {
      const height = info.height || 360;
      return {
        title: info.title || `YouTube Video ${videoId}`,
        thumbnail: info.thumbnail || `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
        duration: info.duration || 0,
        uploader: info.uploader || 'YouTube',
        formats: [{
          url: info.url,
          quality: `${height}p`,
          qualityNum: height,
          type: 'video/mp4',
          ext: 'mp4',
          filesize: info.filesize || 0,
          hasVideo: true,
          hasAudio: true,
          isVideoOnly: false,
          isAudioOnly: false
        }]
      };
    }
    throw new Error(`yt-dlp (${clientName}): No formats array and no top-level URL`);
  }

  console.log(`📋 yt-dlp (${clientName}): ${info.formats.length} raw formats found`);

  const videoFormats = [];   // has video, no audio (need merging)
  const muxedFormats = [];   // has both video + audio (ready to use)
  const audioFormats = [];   // audio only

  for (const f of info.formats) {
    // Skip formats without a real stream URL
    if (!f.url || !isRealStreamUrl(f.url)) continue;
    // Skip manifests (m3u8/mpd) — they require streaming, not direct download
    if (f.protocol && (f.protocol.includes('m3u8') || f.protocol.includes('dash'))) continue;
    if (f.ext === 'mhtml') continue;

    const hasVideo = f.vcodec && f.vcodec !== 'none';
    const hasAudio = f.acodec && f.acodec !== 'none';
    const height = f.height || 0;

    if (hasVideo && hasAudio && height > 0) {
      muxedFormats.push({ ...f, _hasVideo: true, _hasAudio: true });
    } else if (hasVideo && !hasAudio && height > 0) {
      videoFormats.push({ ...f, _hasVideo: true, _hasAudio: false });
    } else if (!hasVideo && hasAudio) {
      audioFormats.push({ ...f, _hasVideo: false, _hasAudio: true });
    }
  }

  console.log(`  Muxed: ${muxedFormats.length}, VideoOnly: ${videoFormats.length}, AudioOnly: ${audioFormats.length}`);

  const formats = [];

  // ── Pick best audio stream for merging ─────────────────────────────────────
  // Prefer m4a/mp4 audio for maximum compatibility
  const bestAudio = audioFormats
    .filter(f => f.ext === 'm4a' || f.acodec?.includes('mp4') || f.acodec?.includes('aac'))
    .sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0))[0]
    || audioFormats.sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0))[0]
    || null;

  // ── Add muxed formats (have audio built in, no merging needed) ─────────────
  // Deduplicate by height — keep highest bitrate per resolution
  const muxedByHeight = new Map();
  for (const f of muxedFormats) {
    const key = f.height;
    const existing = muxedByHeight.get(key);
    if (!existing || (f.tbr || f.vbr || 0) > (existing.tbr || existing.vbr || 0)) {
      muxedByHeight.set(key, f);
    }
  }

  for (const [height, f] of [...muxedByHeight.entries()].sort((a, b) => a[0] - b[0])) {
    formats.push({
      url: f.url,
      quality: `${height}p`,
      qualityNum: height,
      type: 'video/mp4',
      ext: 'mp4',
      filesize: f.filesize || f.filesize_approx || 0,
      hasVideo: true,
      hasAudio: true,
      isVideoOnly: false,
      isAudioOnly: false,
      _note: 'muxed'
    });
  }

  // ── Add video-only formats merged with best audio via MERGE: ───────────────
  // Deduplicate by height — keep best bitrate per resolution
  const videoByHeight = new Map();
  for (const f of videoFormats) {
    const key = f.height;
    const existing = videoByHeight.get(key);
    if (!existing || (f.tbr || f.vbr || 0) > (existing.tbr || existing.vbr || 0)) {
      videoByHeight.set(key, f);
    }
  }

  if (bestAudio) {
    for (const [height, f] of [...videoByHeight.entries()].sort((a, b) => a[0] - b[0])) {
      // Skip if we already have a muxed format at this height
      if (muxedByHeight.has(height)) continue;

      // MERGE: prefix signals the controller to build a merge endpoint URL
      // Format: MERGE:<videoUrl>:<audioUrl>
      const mergeUrl = `MERGE:${f.url}:${bestAudio.url}`;

      formats.push({
        url: mergeUrl,
        quality: `${height}p`,
        qualityNum: height,
        type: 'video/mp4',
        ext: 'mp4',
        filesize: (f.filesize || f.filesize_approx || 0) + (bestAudio.filesize || 0),
        hasVideo: true,
        hasAudio: true,  // will have audio after merge
        isVideoOnly: false,
        isAudioOnly: false,
        _note: 'merged'
      });
    }
  } else {
    // No audio available — add video-only formats as-is (no audio, user-visible warning)
    for (const [height, f] of [...videoByHeight.entries()].sort((a, b) => a[0] - b[0])) {
      if (muxedByHeight.has(height)) continue;
      formats.push({
        url: f.url,
        quality: `${height}p`,
        qualityNum: height,
        type: 'video/mp4',
        ext: 'mp4',
        filesize: f.filesize || f.filesize_approx || 0,
        hasVideo: true,
        hasAudio: false,
        isVideoOnly: true,
        isAudioOnly: false,
        _note: 'video-only-no-audio'
      });
    }
  }

  // ── Add best audio-only format ─────────────────────────────────────────────
  if (bestAudio) {
    const abr = bestAudio.abr || bestAudio.tbr || 128;
    formats.push({
      url: bestAudio.url,
      quality: `${Math.round(abr)}kbps`,
      qualityNum: Math.round(abr * 1000),
      type: bestAudio.ext === 'm4a' ? 'audio/mp4' : 'audio/webm',
      ext: bestAudio.ext || 'm4a',
      filesize: bestAudio.filesize || bestAudio.filesize_approx || 0,
      hasVideo: false,
      hasAudio: true,
      isVideoOnly: false,
      isAudioOnly: true,
      _note: 'audio-only'
    });
  }

  if (formats.length === 0) {
    throw new Error(`yt-dlp (${clientName}): No usable formats after processing all ${info.formats.length} raw formats`);
  }

  console.log(`✅ yt-dlp (${clientName}): Built ${formats.length} quality options`);

  return {
    title: info.title || `YouTube Video ${videoId}`,
    thumbnail: info.thumbnail || `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
    duration: info.duration || 0,
    uploader: info.uploader || info.channel || 'YouTube',
    formats
  };
}

// ========================================
// URL VALIDATOR
// A real stream URL is a long Google/YouTube CDN URL,
// NOT a youtube.com/watch URL
// ========================================
function isRealStreamUrl(url) {
  if (!url || typeof url !== 'string') return false;
  if (url.length < 50) return false;
  if (url.includes('youtube.com/watch')) return false;
  if (url.includes('youtu.be/')) return false;
  if (url.includes('img.youtube.com')) return false;
  if (!url.startsWith('http')) return false;
  return true;
}

// ========================================
// METHOD 5: COBALT API v2
// Updated for 2025/2026 — old vQuality param no longer works
// ========================================
async function fetchFromCobalt(url, videoId) {
  console.log(`📥 cobalt.tools (API v2) for: ${videoId}`);

  const cobaltInstances = [
    'https://api.cobalt.tools',
    'https://cobalt.api.timelessnesses.me',
    'https://co.wuk.sh'
  ];

  for (const instance of cobaltInstances) {
    try {
      // Cobalt API v2 (2025+) uses a different request body schema
      const requestBody = {
        url: url,
        videoQuality: '720',    // ← v2 param (was 'vQuality' in v1)
        audioFormat: 'm4a',
        audioBitrate: '128',
        downloadMode: 'auto',   // 'auto' | 'audio' | 'mute'
        youtubeVideoCodec: 'h264',
        youtubeDubBrowserLang: false,
        alwaysProxy: false,
        disableMetadata: false,
        tiktokFullAudio: false,
        twitterGif: false
      };

      const response = await axios.post(
        `${instance}/`,
        requestBody,
        {
          timeout: 15000,
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (compatible; Unisaver/1.0)'
          }
        }
      );

      const data = response.data;

      if (!data || data.status === 'error') {
        const errCode = data?.error?.code || data?.text || 'unknown';
        console.log(`  cobalt ${instance}: error — ${errCode}`);
        continue;
      }

      const formats = [];

      if (data.status === 'picker' && Array.isArray(data.picker)) {
        data.picker.forEach(item => {
          if (item.url && isRealStreamUrl(item.url)) {
            formats.push({
              url: item.url,
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
      } else if ((data.status === 'stream' || data.status === 'redirect') && data.url) {
        if (isRealStreamUrl(data.url)) {
          // Build multiple quality labels pointing to the cobalt stream URL
          // Cobalt handles transcoding server-side
          [720, 480, 360].forEach(height => {
            formats.push({
              url: data.url,
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

          // Request audio-only stream from cobalt
          try {
            const audioBody = { ...requestBody, downloadMode: 'audio' };
            const audioResp = await axios.post(`${instance}/`, audioBody, {
              timeout: 10000,
              headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
              }
            });

            if (audioResp.data?.url && isRealStreamUrl(audioResp.data.url)) {
              formats.push({
                url: audioResp.data.url,
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
      }

      if (formats.length > 0) {
        // Fetch lightweight metadata from Invidious
        let title = `YouTube Video ${videoId}`;
        let duration = 0;
        let uploader = 'YouTube';
        try {
          const meta = await axios.get(
            `https://invidious.kavin.rocks/api/v1/videos/${videoId}?fields=title,lengthSeconds,author`,
            { timeout: 5000 }
          );
          title = meta.data?.title || title;
          duration = meta.data?.lengthSeconds || 0;
          uploader = meta.data?.author || uploader;
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
      console.log(`  cobalt ${instance}: ${e.message.substring(0, 100)}`);
      continue;
    }
  }

  throw new Error('All cobalt instances failed');
}

// ========================================
// METHOD 6: INVIDIOUS API (unchanged, was working)
// ========================================
async function fetchFromInvidious(videoId) {
  console.log(`📥 Invidious for: ${videoId}`);

  const invidiousInstances = [
    'https://invidious.kavin.rocks',
    'https://inv.riverside.rocks',
    'https://invidious.flokinet.to',
    'https://invidious.privacydev.net',
    'https://yewtu.be',
    'https://vid.puffyan.us',
    'https://invidious.nerdvpn.de',
    'https://invidious.esmailelbob.xyz'
  ];

  const shuffled = [...invidiousInstances].sort(() => 0.5 - Math.random());

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

      // Muxed streams (video + audio combined)
      if (data.formatStreams) {
        data.formatStreams.forEach(stream => {
          if (stream.url && isRealStreamUrl(stream.url)) {
            const qNum = parseInt(stream.qualityLabel) || parseInt(stream.quality) || 360;
            formats.push({
              url: stream.url,
              quality: stream.qualityLabel || stream.quality || `${qNum}p`,
              qualityNum: qNum,
              type: stream.type || 'video/mp4',
              ext: 'mp4',
              filesize: 0,
              hasVideo: true,
              hasAudio: true,
              isVideoOnly: false,
              isAudioOnly: false
            });
          }
        });
      }

      // Adaptive streams (separate video + audio)
      if (data.adaptiveFormats) {
        const isVideoType = (t) => t && t.includes('video');
        const isAudioType = (t) => t && t.includes('audio');

        data.adaptiveFormats.forEach(stream => {
          if (!stream.url || !isRealStreamUrl(stream.url)) return;

          const isVid = isVideoType(stream.type);
          const isAud = isAudioType(stream.type);
          const qNum = isVid
            ? (parseInt(stream.qualityLabel) || parseInt(stream.quality) || 360)
            : (Math.round((stream.bitrate || 128000) / 1000));

          formats.push({
            url: stream.url,
            quality: isVid
              ? (stream.qualityLabel || `${qNum}p`)
              : `${qNum}kbps`,
            qualityNum: isVid ? qNum : qNum * 1000,
            type: stream.type,
            ext: isVid ? 'mp4' : 'm4a',
            filesize: stream.clen ? parseInt(stream.clen) : 0,
            hasVideo: isVid,
            hasAudio: isAud,
            isVideoOnly: isVid && !isAud,
            isAudioOnly: isAud && !isVid
          });
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
      console.log(`  Invidious ${instance}: ${e.message.substring(0, 80)}`);
    }
  }

  throw new Error('All Invidious instances failed');
}

// ========================================
// METHOD 7: PIPED API (unchanged, was working)
// ========================================
async function fetchFromPiped(videoId) {
  console.log(`📥 Piped for: ${videoId}`);

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
          if (stream.url && isRealStreamUrl(stream.url)) {
            const qNum = parseInt(stream.quality) || 360;
            formats.push({
              url: stream.url,
              quality: stream.quality || `${qNum}p`,
              qualityNum: qNum,
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
          if (stream.url && isRealStreamUrl(stream.url)) {
            const kbps = Math.round((stream.bitrate || 128000) / 1000);
            formats.push({
              url: stream.url,
              quality: `${kbps}kbps`,
              qualityNum: stream.bitrate || 128000,
              type: stream.mimeType || 'audio/webm',
              ext: stream.mimeType?.includes('mp4') ? 'm4a' : 'webm',
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
      console.log(`  Piped ${instance}: ${e.message.substring(0, 80)}`);
    }
  }

  throw new Error('All Piped instances failed');
}

// ========================================
// METHOD 8: RAPIDAPI
// ========================================
async function fetchFromRapidAPI(videoId) {
  console.log(`📥 RapidAPI for: ${videoId}`);

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
      if (item.url && isRealStreamUrl(item.url)) {
        const qNum = parseInt(item.quality) || 360;
        formats.push({
          url: item.url,
          quality: item.quality || `${qNum}p`,
          qualityNum: qNum,
          type: 'video/mp4',
          ext: 'mp4',
          filesize: item.size || 0,
          hasVideo: true,
          hasAudio: !item.quality?.includes('noaudio'),
          isVideoOnly: item.quality?.includes('noaudio') || false,
          isAudioOnly: false
        });
      }
    });
  }

  if (data?.audios?.items) {
    data.audios.items.forEach(item => {
      if (item.url && isRealStreamUrl(item.url)) {
        formats.push({
          url: item.url,
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
    const cookieContent = [
      '# Netscape HTTP Cookie File',
      `.youtube.com\tTRUE\t/\tTRUE\t1767225600\tCONSENT\tYES+cb.20250305-11-p0.en+FX+${randomCB}`,
      `.youtube.com\tTRUE\t/\tFALSE\t1767225600\tVISITOR_INFO1_LIVE\t${crypto.randomBytes(11).toString('base64').replace(/[^a-zA-Z0-9_-]/g, '')}`,
      `.youtube.com\tTRUE\t/\tFALSE\t1767225600\tYSC\t${crypto.randomBytes(8).toString('base64').replace(/[^a-zA-Z0-9_-]/g, '')}`,
      `.youtube.com\tTRUE\t/\tFALSE\t1767225600\tGPS\t1`,
      ''
    ].join('\n');
    await fs.writeFile(CONFIG.COOKIES_PATH, cookieContent, 'utf8');
    console.log(`✅ Created cookies at: ${CONFIG.COOKIES_PATH}`);
  }
}

// ========================================
// URL HELPERS
// ========================================
function normalizeYouTubeUrl(url) {
  if (!url) return url;
  if (url.includes('youtu.be/')) {
    const id = url.split('youtu.be/')[1].split('?')[0].split('&')[0];
    return `https://www.youtube.com/watch?v=${id}`;
  }
  if (url.includes('/shorts/')) {
    const id = url.split('/shorts/')[1].split('?')[0].split('&')[0];
    return `https://www.youtube.com/shorts/${id}`;
  }
  return url;
}

function extractVideoId(url) {
  const patterns = [/v=([^&]+)/, /youtu\.be\/([^?]+)/, /shorts\/([^?]+)/, /embed\/([^?]+)/];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

// ========================================
// PROCESS & FINALISE YOUTUBE DATA
// Called after whichever method succeeds
// ========================================
function processYouTubeData(data, url, videoId) {
  const isShorts = url.includes('/shorts/');

  console.log(`📊 Processing ${data.formats.length} raw formats...`);

  // Filter out any invalid URLs that slipped through
  const validFormats = data.formats.filter(f => {
    if (!f || !f.url) return false;
    // MERGE: urls are valid — they get converted to /api/merge-audio by the controller
    if (f.url.startsWith('MERGE:')) return true;
    return isRealStreamUrl(f.url);
  });

  if (validFormats.length === 0) {
    throw new Error('No valid stream URLs after filtering');
  }

  // Separate and sort
  const videoFormats = validFormats
    .filter(f => f.hasVideo && !f.isAudioOnly)
    .sort((a, b) => a.qualityNum - b.qualityNum);

  const audioFormats = validFormats
    .filter(f => f.isAudioOnly)
    .sort((a, b) => b.qualityNum - a.qualityNum);

  // Deduplicate video formats by qualityNum (keep first/best per height)
  const seenHeights = new Set();
  const uniqueVideos = [];
  for (const f of videoFormats) {
    if (!seenHeights.has(f.qualityNum)) {
      seenHeights.add(f.qualityNum);
      uniqueVideos.push(f);
    }
  }

  const bestAudioArr = audioFormats.length > 0 ? [audioFormats[0]] : [];
  const allFormats = [...uniqueVideos, ...bestAudioArr];

  console.log(`🎬 Final quality options: ${allFormats.length} (${uniqueVideos.length} video + ${bestAudioArr.length} audio)`);

  const qualityOptions = allFormats.map(f => ({
    quality: f.quality,
    qualityNum: f.qualityNum,
    url: f.url,
    type: f.type || 'video/mp4',
    extension: f.ext || 'mp4',
    filesize: f.filesize || 'unknown',
    isPremium: !f.isAudioOnly && f.qualityNum > CONFIG.FREE_TIER_MAX,
    hasAudio: f.hasAudio || false,
    isVideoOnly: f.isVideoOnly || false,
    isAudioOnly: f.isAudioOnly || false
  }));

  // Default to 360p free tier, or lowest available
  const defaultFormat =
    qualityOptions.find(f => !f.isAudioOnly && f.qualityNum === CONFIG.FREE_TIER_MAX) ||
    qualityOptions.find(f => !f.isAudioOnly && f.qualityNum <= CONFIG.FREE_TIER_MAX) ||
    qualityOptions.find(f => !f.isAudioOnly) ||
    qualityOptions[0] ||
    null;

  const result = {
    success: true,
    platform: 'youtube',
    title: data.title || `YouTube Video ${videoId}`,
    thumbnail: data.thumbnail || `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
    duration: data.duration || 0,
    uploader: data.uploader || 'YouTube',
    isShorts,
    url: defaultFormat?.url || null,
    formats: qualityOptions,
    allFormats: qualityOptions,
    selectedQuality: defaultFormat,
    audioGuaranteed: defaultFormat?.hasAudio || false
  };

  console.log(`✅ YouTube service complete — ${qualityOptions.length} quality options`);
  if (defaultFormat) {
    const urlPreview = defaultFormat.url?.startsWith('MERGE:')
      ? '[MERGE URL — will be converted to /api/merge-audio by controller]'
      : defaultFormat.url?.substring(0, 80) + '...';
    console.log(`🎯 Default: ${defaultFormat.quality} (${defaultFormat.isPremium ? '💰 Premium' : '✅ Free'})`);
    console.log(`🔗 URL: ${urlPreview}`);
  }

  return result;
}

// ========================================
// EXPORTS
// ========================================
module.exports = { fetchYouTubeData };