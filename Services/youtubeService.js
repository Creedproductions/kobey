// Services/youtubeService.js
//
// 2026 working YouTube fetcher — three sources raced in parallel, first win.
//
// Why this rewrite:
//   The old chain (Invidious + yt-dlp) is fully broken on the current host.
//   Invidious public instances 403 from datacenter IPs since the May 2024
//   takedowns, and yt-dlp isn't installed on this host (and adding binary
//   dependencies on managed hosts like Render/Koyeb is fragile).
//
// New chain:
//   1. youtubei.js (Innertube)    — direct YouTube private API. Most reliable
//                                   in 2026; same protocol the YouTube app
//                                   uses. Requires `npm i youtubei.js`.
//   2. vidfly.ai                  — third-party scraper API; the same one
//                                   the project's youtubeController.js uses.
//   3. @vreden/youtube_scraper    — npm package fallback; already in deps.
//
// Each source is tried in parallel; first to return usable formats wins.
// If a source's package isn't installed, it's silently skipped.

const axios = require('axios');

const FREE_MAX = 360; // free tier max quality

// ─── Optional dependency: youtubei.js ────────────────────────────────────────
let Innertube = null;
try {
  ({ Innertube } = require('youtubei.js'));
} catch (_) {
  console.warn(
    '[yt] youtubei.js not installed — primary source disabled. ' +
    'Run: npm install youtubei.js'
  );
}

// ─── Optional dependency: @vreden/youtube_scraper ────────────────────────────
let vreden = null;
try {
  vreden = require('@vreden/youtube_scraper');
} catch (_) {
  console.warn('[yt] @vreden/youtube_scraper not installed');
}

// ─── Innertube singleton ─────────────────────────────────────────────────────
// Creating an Innertube client takes 2-5s (it fetches the JS player). One
// shared instance handles all requests. We refresh hourly so YouTube's
// rotating player JS doesn't make the cached one go stale.
let _yt = null;
let _ytExpiresAt = 0;
async function getInnertube() {
  if (!Innertube) throw new Error('youtubei.js not available');
  const now = Date.now();
  if (!_yt || now > _ytExpiresAt) {
    _yt = await Innertube.create({ retrieve_player: true });
    _ytExpiresAt = now + 60 * 60 * 1000; // 1h
  }
  return _yt;
}

// ─── Strategy 1: youtubei.js ─────────────────────────────────────────────────
//
// IOS client typically returns muxed (audio+video) formats up to 720p.
// ANDROID is similar. WEB returns adaptive only. We try IOS → ANDROID → WEB
// so we always have a chance at muxed streams the client can play directly.

async function tryInnertube(videoId) {
  const yt      = await getInnertube();
  const clients = ['IOS', 'ANDROID', 'WEB'];
  let info      = null;
  let usedClient = '';

  for (const client of clients) {
    try {
      info = await yt.getBasicInfo(videoId, client);
      if (info?.streaming_data) { usedClient = client; break; }
    } catch (e) {
      console.log(`[yt/innertube] ${client} client failed: ${(e.message || '').slice(0, 80)}`);
    }
  }
  if (!info?.streaming_data) throw new Error('innertube: no streaming_data from any client');

  const sd      = info.streaming_data;
  const formats = [];

  // Muxed (audio+video together) — preferred for free tier
  for (const f of (sd.formats || [])) {
    const url = f.url || (typeof f.decipher === 'function' ? f.decipher(yt.session.player) : null);
    if (!url) continue;
    const h = f.height || parseInt(f.quality_label || '0') || 0;
    formats.push({
      url, quality: `${h}p`, qualityNum: h,
      isAudioOnly: false, hasAudio: true,
    });
  }

  // Audio-only (best bitrate)
  const audios = (sd.adaptive_formats || [])
    .filter(f => f.has_audio && !f.has_video && (f.url || f.decipher))
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  if (audios[0]) {
    const a   = audios[0];
    const url = a.url || (typeof a.decipher === 'function' ? a.decipher(yt.session.player) : null);
    if (url) {
      const kbps = Math.round((a.bitrate || 128000) / 1000);
      formats.push({
        url, quality: `${kbps}kbps`, qualityNum: kbps * 1000,
        isAudioOnly: true, hasAudio: true,
      });
    }
  }

  if (!formats.length) throw new Error('innertube: no usable formats');

  console.log(`[yt/innertube] ${usedClient} → ${formats.length} formats`);
  const bi = info.basic_info || {};
  return {
    title:     bi.title || `YouTube ${videoId}`,
    thumbnail: bi.thumbnail?.[0]?.url || null,
    duration:  bi.duration || 0,
    uploader:  bi.author || 'YouTube',
    formats,
  };
}

// ─── Strategy 2: vidfly.ai ───────────────────────────────────────────────────

const UA_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function tryVidfly(url) {
  const r = await axios.get(
    'https://api.vidfly.ai/api/media/youtube/download',
    {
      params:  { url },
      timeout: 30000,
      headers: {
        accept:           '*/*',
        'content-type':   'application/json',
        'x-app-name':     'vidfly-web',
        'x-app-version':  '1.0.0',
        Referer:          'https://vidfly.ai/',
        'User-Agent':     UA_DESKTOP,
      },
    }
  );
  const data = r.data?.data;
  if (!data?.items?.length) throw new Error('vidfly: empty response');

  const formats = [];
  const seen    = new Set();
  for (const it of data.items) {
    const label = (it.label || '').toLowerCase();
    if (!it.url) continue;
    if (label.includes('video only') || label.includes('vid only') || label.includes('without audio')) continue;

    const isAudio = label.includes('audio') || (it.type || '').includes('audio');
    const m       = label.match(/(\d+)/);
    const qNum    = isAudio ? 128 : (m ? parseInt(m[1]) : 0);
    const key     = `${isAudio ? 'a' : 'v'}:${qNum}`;
    if (seen.has(key)) continue;
    seen.add(key);

    formats.push({
      url:         it.url,
      quality:     it.label || (isAudio ? '128kbps' : `${qNum}p`),
      qualityNum:  isAudio ? qNum * 1000 : qNum,
      isAudioOnly: isAudio,
      hasAudio:    true,
    });
  }
  if (!formats.length) throw new Error('vidfly: no usable formats');

  console.log(`[yt/vidfly] ${formats.length} formats`);
  return {
    title:     data.title,
    thumbnail: data.cover,
    duration:  data.duration,
    uploader:  data.author || 'YouTube',
    formats,
  };
}

// ─── Strategy 3: @vreden/youtube_scraper ─────────────────────────────────────

async function tryVreden(url) {
  if (!vreden) throw new Error('vreden: package not available');

  const meta      = await vreden.metadata(url);
  const qualities = [1080, 720, 480, 360];

  const results = await Promise.all(qualities.map(async q => {
    try {
      const r = await vreden.ytmp4(url, q);
      return r?.download?.url ? { url: r.download.url, qualityNum: q } : null;
    } catch (_) { return null; }
  }));

  const formats = results.filter(Boolean).map(r => ({
    url:         r.url,
    quality:     `${r.qualityNum}p`,
    qualityNum:  r.qualityNum,
    isAudioOnly: false,
    hasAudio:    true,
  }));

  // Audio
  try {
    const a = await vreden.ytmp3(url, 128);
    if (a?.download?.url) {
      formats.push({
        url:         a.download.url,
        quality:     '128kbps',
        qualityNum:  128000,
        isAudioOnly: true,
        hasAudio:    true,
      });
    }
  } catch (_) {}

  if (!formats.length) throw new Error('vreden: no formats');
  console.log(`[yt/vreden] ${formats.length} formats`);

  return {
    title:     meta?.title || 'YouTube Video',
    thumbnail: meta?.image || meta?.thumbnail || null,
    duration:  meta?.duration?.seconds || 0,
    uploader:  meta?.channel_title || meta?.author || 'YouTube',
    formats,
  };
}

// ─── Race orchestrator ───────────────────────────────────────────────────────

async function fetchYouTubeData(url) {
  const videoId = extractVideoId(url);
  if (!videoId) throw new Error('Could not extract YouTube video ID');
  const normUrl = normalizeUrl(url);
  console.log(`YouTube: racing for ${videoId}`);

  // Build the race lazily — only include strategies whose deps are loaded
  const strategies = [
    Innertube && wrap('innertube', tryInnertube(videoId)),
    wrap('vidfly', tryVidfly(normUrl)),
    vreden    && wrap('vreden',    tryVreden(normUrl)),
  ].filter(Boolean);

  if (!strategies.length) {
    throw new Error('YouTube: no strategies available — install youtubei.js or @vreden/youtube_scraper');
  }

  const data = await firstSuccess(strategies);
  return finalise(data, url, videoId);
}

function wrap(name, promise) {
  return promise.then(
    r => ({ ok: true,  name, r }),
    e => ({ ok: false, name, e: e.message || String(e) })
  );
}

function firstSuccess(wrapped) {
  return new Promise((resolve, reject) => {
    let done = false, settled = 0;
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
          console.log(`YouTube [${name}] failed: ${(e || '').slice(0, 100)}`);
        }
        if (settled === wrapped.length && !done) {
          reject(new Error('YouTube all sources failed:\n' + errors.join('\n')));
        }
      });
    }
  });
}

// ─── Output normalisation ────────────────────────────────────────────────────

function finalise(data, url, videoId) {
  const isShorts = url.includes('/shorts/');
  const seen     = new Set();
  const options  = data.formats
    .sort((a, b) => a.qualityNum - b.qualityNum)
    .filter(f => { if (seen.has(f.qualityNum)) return false; seen.add(f.qualityNum); return true; })
    .map(f => ({
      quality:     f.quality,
      qualityNum:  f.qualityNum,
      url:         f.url,
      type:        f.isAudioOnly ? 'audio/mp4' : 'video/mp4',
      extension:   f.isAudioOnly ? 'm4a' : 'mp4',
      filesize:    'unknown',
      isPremium:   !f.isAudioOnly && f.qualityNum > FREE_MAX,
      hasAudio:    f.hasAudio,
      isVideoOnly: false,
      isAudioOnly: f.isAudioOnly || false,
      streamType:  f.isAudioOnly ? 'audioOnly' : 'muxed',
    }));

  const def =
    options.find(f => !f.isAudioOnly && f.qualityNum === FREE_MAX) ||
    options.find(f => !f.isAudioOnly && f.qualityNum <= FREE_MAX) ||
    options.find(f => !f.isAudioOnly) ||
    options[0] || null;

  console.log(`YouTube: ${options.length} options, default=${def ? def.quality : 'none'}`);

  return {
    success:         true,
    platform:        'youtube',
    title:           data.title || `YouTube Video ${videoId}`,
    thumbnail:       data.thumbnail || `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
    duration:        data.duration || 0,
    uploader:        data.uploader || 'YouTube',
    isShorts,
    videoId,
    url:             def ? def.url : null,
    formats:         options,
    allFormats:      options,
    selectedQuality: def,
    audioGuaranteed: def ? def.hasAudio : false,
  };
}

// ─── URL helpers ─────────────────────────────────────────────────────────────

function normalizeUrl(url) {
  if (url.includes('youtu.be/')) {
    return `https://www.youtube.com/watch?v=${url.split('youtu.be/')[1].split('?')[0].split('&')[0]}`;
  }
  if (url.includes('m.youtube.com')) return url.replace('m.youtube.com', 'www.youtube.com');
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