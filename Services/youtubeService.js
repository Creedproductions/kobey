// Services/youtubeService.js

const axios = require('axios');
const fs = require('fs');
const { execFile } = require('child_process');

const FREE_MAX = 360;
const COBALT_API_URL = (process.env.COBALT_API_URL || '').replace(/\/+$/, '');

// Resolve yt-dlp once at boot. The previous `execFile('yt-dlp', …)` relied on
// PATH lookup, which silently failed in Koyeb's containerized runtime
// (PATH at exec time differs from PATH at build time, especially when a
// venv is involved). We now probe a list of well-known absolute locations
// the Dockerfile installs to and fall back to the PATH-only name only as
// a last resort.
const YT_DLP_CANDIDATES = [
  process.env.YT_DLP_BIN,
  '/opt/yt/bin/yt-dlp',
  '/usr/local/bin/yt-dlp',
  '/usr/bin/yt-dlp',
].filter(Boolean);

let RESOLVED_YT_DLP = null;
function resolveYtDlpPath() {
  if (RESOLVED_YT_DLP !== null) return RESOLVED_YT_DLP;
  for (const p of YT_DLP_CANDIDATES) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      RESOLVED_YT_DLP = p;
      console.log(`[yt] yt-dlp resolved at ${p}`);
      return p;
    } catch (_) { /* try next */ }
  }
  // Fallback: leave the bare name. This is what was failing in production
  // ("spawn yt-dlp ENOENT") but we keep it so local dev still works when
  // the user has yt-dlp on PATH.
  RESOLVED_YT_DLP = 'yt-dlp';
  console.warn('[yt] yt-dlp not found at any absolute path; falling back to PATH lookup');
  return RESOLVED_YT_DLP;
}
// Resolve eagerly so the warning shows up at startup, not on first request.
resolveYtDlpPath();

// youtubei.js v17 is ESM-only — require() throws ERR_REQUIRE_ESM. Load
// asynchronously via dynamic import() and cache the module-level reference
// once resolved. tryInnertube() awaits this lazy import.
let Innertube = null;
let _innertubeImport = null;
async function loadInnertube() {
  if (Innertube) return Innertube;
  if (!_innertubeImport) {
    _innertubeImport = import('youtubei.js')
      .then(mod => { Innertube = mod.Innertube; console.log('[yt] youtubei.js loaded'); return Innertube; })
      .catch(e => { console.warn(`[yt] youtubei.js import failed: ${e.message}`); return null; });
  }
  return _innertubeImport;
}
// Kick off the import at startup so the first request doesn't pay the
// full ESM cold-start cost.
loadInnertube();

// vreden removed (dead dependency). Use ytdl-core if available.
let ytdl = null;
try {
  ytdl = require('@distube/ytdl-core');
} catch (_) {
  try {
    ytdl = require('ytdl-core'); // fallback
  } catch (__) {
    console.warn('[yt] ytdl-core not installed (optional)');
  }
}

const UA_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

let _yt = null;
let _ytExpiresAt = 0;

async function getInnertube() {
  // Wait for the lazy ESM import to resolve. After the first call this is a
  // hot no-op because the import promise has already settled.
  if (!Innertube) {
    await loadInnertube();
    if (!Innertube) throw new Error('youtubei.js not available');
  }

  const now = Date.now();
  if (!_yt || now > _ytExpiresAt) {
    _yt = await Innertube.create({ retrieve_player: true });
    _ytExpiresAt = now + 60 * 60 * 1000;
  }
  return _yt;
}

async function tryInnertube(videoId) {
  const yt = await getInnertube();
  // 2026 client chain. TV_EMBEDDED was removed upstream; MWEB +
  // WEB_EMBEDDED still serve HLS without a PO Token. ANDROID_VR is yt-dlp's
  // current default fallback. We try them in order until one returns
  // streaming_data with usable URLs.
  const clients = [
    'MWEB',           // mobile web — most forgiving on bot checks
    'WEB_EMBEDDED',   // embed player — works for embeddable videos
    'ANDROID_VR',     // yt-dlp's 2026 default fallback
    'IOS',            // legacy fallback
    'WEB',            // last resort
  ];

  let info = null;
  let usedClient = '';

  for (const client of clients) {
    try {
      info = await yt.getBasicInfo(videoId, client);
      if (info?.streaming_data) {
        // Verify at least one stream has a URL or decipher fn — some clients
        // return a streaming_data envelope with no usable formats.
        const hasUrl =
          (info.streaming_data.formats || []).some(f => f.url || typeof f.decipher === 'function') ||
          (info.streaming_data.adaptive_formats || []).some(f => f.url || typeof f.decipher === 'function');
        if (hasUrl) {
          usedClient = client;
          break;
        }
        info = null;
      }
    } catch (e) {
      console.log(`[yt/innertube] ${client} failed: ${e.message}`);
    }
  }

  if (!info?.streaming_data) {
    throw new Error('innertube: no streaming_data from any client');
  }

  // Decipher can throw PlayerError("No valid URL to decipher") synchronously
  // OR return a Promise that rejects when YT requires a JS evaluator we
  // don't ship. Wrap both paths so one broken format doesn't tank the
  // whole strategy AND doesn't leak unhandled rejections to the process.
  const safeDecipher = (f) => {
    try {
      if (typeof f.url === 'string' && f.url.startsWith('http')) return f.url;
      if (typeof f.decipher === 'function') {
        const v = f.decipher(yt.session.player);
        // If decipher unexpectedly returns a Promise, attach a no-op
        // catch so an inevitable rejection doesn't surface as an
        // "Unhandled Rejection" warning. We can't await here because
        // the caller is sync — the format is simply unusable in that case.
        if (v && typeof v.then === 'function') {
          v.catch(() => {});
          return null;
        }
        if (typeof v === 'string' && v.startsWith('http')) return v;
      }
    } catch (e) {
      // Swallow — format is unusable, fall through to next.
      console.log(`[yt/innertube] decipher failed: ${e.message?.slice(0, 80)}`);
    }
    return null;
  };

  const formats = [];
  for (const f of info.streaming_data.formats || []) {
    const url = safeDecipher(f);
    if (!url) continue;
    const h = f.height || parseInt(f.quality_label || '0') || 0;
    formats.push({
      url,
      quality: `${h}p`,
      qualityNum: h,
      isAudioOnly: false,
      hasAudio: true,
    });
  }

  const audios = (info.streaming_data.adaptive_formats || [])
    .filter(f => f.has_audio && !f.has_video && (f.url || f.decipher))
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  if (audios[0]) {
    const a = audios[0];
    const url = safeDecipher(a);
    if (url) {
      const kbps = Math.round((a.bitrate || 128000) / 1000);
      formats.push({
        url,
        quality: `${kbps}kbps`,
        qualityNum: kbps * 1000,
        isAudioOnly: true,
        hasAudio: true,
      });
    }
  }

  if (!formats.length) throw new Error('innertube: no usable formats (decipher failed)');

  const infoBasic = info.basic_info || {};
  console.log(`[yt/innertube] ${usedClient} succeeded`);
  return {
    title: infoBasic.title || `YouTube ${videoId}`,
    thumbnail: infoBasic.thumbnail?.[0]?.url || null,
    duration: infoBasic.duration || 0,
    uploader: infoBasic.author || 'YouTube',
    formats,
  };
}

async function tryVidfly(url) {
  const r = await axios.get(
    'https://api.vidfly.ai/api/media/youtube/download',
    {
      params: { url },
      timeout: 30000,
      headers: {
        accept: '*/*',
        'content-type': 'application/json',
        'x-app-name': 'vidfly-web',
        'x-app-version': '1.0.0',
        Referer: 'https://vidfly.ai/',
        'User-Agent': UA_DESKTOP,
      },
    }
  );

  const data = r.data?.data;
  if (!data?.items?.length) throw new Error('vidfly: empty response');

  const formats = [];
  const seen = new Set();
  for (const it of data.items) {
    const label = String(it.label || '').toLowerCase();
    if (!it.url) continue;
    if (label.includes('video only') || label.includes('vid only') || label.includes('without audio')) continue;
    const isAudio = label.includes('audio') || String(it.type || '').includes('audio');
    const match = label.match(/(\d+)/);
    const qNum = isAudio ? 128 : match ? parseInt(match[1]) : 0;
    const key = `${isAudio ? 'a' : 'v'}:${qNum}`;
    if (seen.has(key)) continue;
    seen.add(key);
    formats.push({
      url: it.url,
      quality: it.label || (isAudio ? '128kbps' : `${qNum}p`),
      qualityNum: isAudio ? qNum * 1000 : qNum,
      isAudioOnly: isAudio,
      hasAudio: true,
    });
  }

  if (!formats.length) throw new Error('vidfly: no usable formats');
  console.log(`[yt/vidfly] ${formats.length} formats`);
  return {
    title: data.title || 'YouTube Video',
    thumbnail: data.cover || null,
    duration: data.duration || 0,
    uploader: data.author || 'YouTube',
    formats,
  };
}

async function tryYtdlCore(url) {
  if (!ytdl) throw new Error('ytdl-core not available');

  const info = await ytdl.getInfo(url);
  const formats = [];

  // Group by itag to avoid duplicates
  const itagMap = new Map();
  for (const f of info.formats) {
    if (f.hasVideo && f.hasAudio) {
      const h = f.height || 0;
      const key = `muxed_${h}`;
      if (!itagMap.has(key)) itagMap.set(key, f);
    }
    // Get best audio-only
    if (f.hasAudio && !f.hasVideo && f.audioBitrate) {
      const key = 'audio_best';
      if (!itagMap.has(key) || f.audioBitrate > itagMap.get(key).audioBitrate) {
        itagMap.set(key, f);
      }
    }
  }

  for (const f of itagMap.values()) {
    const h = f.height || 0;
    const isAudio = !f.hasVideo && f.hasAudio;
    formats.push({
      url: f.url,
      quality: isAudio ? `${Math.round(f.audioBitrate / 1000)}kbps` : `${h}p`,
      qualityNum: isAudio ? (f.audioBitrate || 128000) : h,
      isAudioOnly: isAudio,
      hasAudio: f.hasAudio,
    });
  }

  if (!formats.length) throw new Error('ytdl-core: no formats');
  console.log(`[yt/ytdl-core] ${formats.length} formats`);
  return {
    title: info.videoDetails.title || 'YouTube Video',
    thumbnail: info.videoDetails.thumbnails?.[0]?.url || null,
    duration: parseInt(info.videoDetails.lengthSeconds) || 0,
    uploader: info.videoDetails.author?.name || 'YouTube',
    formats,
  };
}

async function tryCobalt(url) {
  if (!COBALT_API_URL) throw new Error('cobalt: COBALT_API_URL not configured');

  const r = await axios.post(
    `${COBALT_API_URL}/`,
    {
      url,
      videoQuality: '360',
      filenameStyle: 'classic',
      disableMetadata: false,
    },
    {
      timeout: 30000,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': UA_DESKTOP,
      },
      validateStatus: () => true,
    }
  );

  if (r.status >= 400) throw new Error(`cobalt: HTTP ${r.status}`);

  const data = r.data || {};
  const finalUrl = data.url || data.download || data.file || '';
  if (!finalUrl || !String(finalUrl).startsWith('http')) throw new Error('cobalt: no download url');

  return {
    title: data.filename || 'YouTube Video',
    thumbnail: null,
    duration: 0,
    uploader: 'YouTube',
    formats: [{
      url: finalUrl,
      quality: '360p',
      qualityNum: 360,
      isAudioOnly: false,
      hasAudio: true,
    }],
  };
}

async function tryYtDlp(url) {
  return new Promise((resolve, reject) => {
    const bin = resolveYtDlpPath();
    // 2026 client priority: android_vr → ios → web → web_safari. tv_embedded
    // and web_embedded_player were removed for being broken upstream. Bot
    // detection on YouTube has tightened; android_vr is currently the most
    // forgiving mainstream client.
    execFile(bin, [
      '-f', 'best[height<=?1080][vcodec!=?vp9]+bestaudio[ext=m4a]/best/best',
      '--no-playlist',
      '--no-warnings',
      '--no-check-certificate',
      '--geo-bypass',
      '--extractor-args', 'youtube:player_client=android_vr,ios,web,web_safari',
      // Larger socket timeout helps when YT throttles initial player JS
      '--socket-timeout', '15',
      '--dump-json', url,
    ], { timeout: 30000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message || '').slice(0, 200);
        return reject(new Error(`yt-dlp: ${msg}`));
      }
      try {
        const info = JSON.parse(stdout);
        const formats = [];
        if (info.url) {
          formats.push({
            url: info.url,
            quality: `${info.height || 720}p`,
            qualityNum: info.height || 720,
            isAudioOnly: false,
            hasAudio: true,
          });
        }
        // Also surface the alternate formats array when info.formats is present
        if (Array.isArray(info.formats)) {
          for (const f of info.formats) {
            if (!f.url) continue;
            const isAudio = f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none');
            const isVideo = f.vcodec && f.vcodec !== 'none';
            if (!isAudio && !isVideo) continue;
            formats.push({
              url: f.url,
              quality: isAudio ? `${Math.round((f.abr || 128))}kbps` : `${f.height || 0}p`,
              qualityNum: isAudio ? Math.round(f.abr || 128) * 1000 : (f.height || 0),
              isAudioOnly: isAudio,
              hasAudio: !isVideo || (f.acodec && f.acodec !== 'none'),
            });
          }
        }
        if (!formats.length) throw new Error('yt-dlp: no URL extracted');
        resolve({
          title: info.title || 'YouTube Video',
          thumbnail: info.thumbnail || null,
          duration: info.duration || 0,
          uploader: info.uploader || 'YouTube',
          formats,
        });
      } catch (parseErr) {
        reject(new Error(`yt-dlp: parse error - ${parseErr.message}`));
      }
    });
  });
}

async function fetchYouTubeData(url) {
  const videoId = extractVideoId(url);
  if (!videoId) throw new Error('Could not extract YouTube video ID');

  const normUrl = normalizeUrl(url);
  console.log(`YouTube: racing for ${videoId}`);

  // Always include innertube — the loader waits for the lazy import, then
  // either succeeds or throws "youtubei.js not available". Filtering it out
  // up front meant a slow ESM cold-start dropped the strategy entirely.
  const strategies = [
    wrap('innertube', tryInnertube(videoId)),
    wrap('yt-dlp',    tryYtDlp(normUrl)),
    ytdl && wrap('ytdl-core', tryYtdlCore(normUrl)),
    COBALT_API_URL && wrap('cobalt', tryCobalt(normUrl)),
    wrap('vidfly', tryVidfly(normUrl)),
  ].filter(Boolean);

  if (!strategies.length) {
    throw new Error('YouTube: no strategies available');
  }

  const data = await firstSuccess(strategies);
  return finalise(data, url, videoId);
}

function wrap(name, promise) {
  return promise.then(
    r => ({ ok: true, name, r }),
    e => ({ ok: false, name, e: e.message || String(e) })
  );
}

function firstSuccess(wrapped) {
  return new Promise((resolve, reject) => {
    let done = false;
    let settled = 0;
    const errors = [];

    for (const p of wrapped) {
      p.then(({ ok, name, r, e }) => {
        settled++;
        if (ok && !done) {
          done = true;
          console.log(`YouTube: won by [${name}]`);
          resolve(r);
          return;
        }
        if (!ok) {
          errors.push(`[${name}]: ${e}`);
          console.log(`YouTube [${name}] failed: ${String(e).slice(0, 100)}`);
        }
        if (settled === wrapped.length && !done) {
          reject(new Error('YouTube all sources failed: ' + errors.join(' | ')));
        }
      });
    }
  });
}

function finalise(data, url, videoId) {
  const isShorts = url.includes('/shorts/');
  const seen = new Set();

  const options = (data.formats || [])
    .sort((a, b) => a.qualityNum - b.qualityNum)
    .filter(f => {
      const key = `${f.isAudioOnly ? 'a' : 'v'}:${f.qualityNum}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(f => ({
      quality: f.quality,
      qualityNum: f.qualityNum,
      url: f.url,
      type: f.isAudioOnly ? 'audio/mp4' : 'video/mp4',
      extension: f.isAudioOnly ? 'm4a' : 'mp4',
      filesize: 'unknown',
      isPremium: !f.isAudioOnly && f.qualityNum > FREE_MAX,
      hasAudio: f.hasAudio,
      isVideoOnly: false,
      isAudioOnly: f.isAudioOnly || false,
      streamType: f.isAudioOnly ? 'audioOnly' : 'muxed',
    }));

  const def =
    options.find(f => !f.isAudioOnly && f.qualityNum === FREE_MAX) ||
    options.find(f => !f.isAudioOnly && f.qualityNum <= FREE_MAX) ||
    options.find(f => !f.isAudioOnly) ||
    options[0] ||
    null;

  if (!def) throw new Error('YouTube: no final usable format');

  return {
    success: true,
    platform: 'youtube',
    title: data.title || `YouTube Video ${videoId}`,
    thumbnail:
      data.thumbnail || `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
    duration: data.duration || 0,
    uploader: data.uploader || 'YouTube',
    isShorts,
    videoId,
    url: def.url,
    formats: options,
    allFormats: options,
    selectedQuality: def,
    audioGuaranteed: def.hasAudio,
  };
}

function normalizeUrl(url) {
  if (url.includes('youtu.be/')) {
    const id = url.split('youtu.be/')[1].split('?')[0].split('&')[0];
    return `https://www.youtube.com/watch?v=${id}`;
  }
  if (url.includes('m.youtube.com')) {
    return url.replace('m.youtube.com', 'www.youtube.com');
  }
  if (url.includes('/shorts/')) {
    const id = url.split('/shorts/')[1].split('?')[0].split('&')[0];
    return `https://www.youtube.com/watch?v=${id}`;
  }
  return url;
}

function extractVideoId(url) {
  const patterns = [
    /[?&]v=([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /\/shorts\/([a-zA-Z0-9_-]{11})/,
    /\/embed\/([a-zA-Z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

module.exports = { fetchYouTubeData };