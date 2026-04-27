// Services/youtubeService.js

const axios = require('axios');

const FREE_MAX = 360;
const COBALT_API_URL = (process.env.COBALT_API_URL || '').replace(/\/+$/, '');

let Innertube = null;
try {
  ({ Innertube } = require('youtubei.js'));
} catch (_) {
  console.warn('[yt] youtubei.js not installed');
}

let vreden = null;
try {
  vreden = require('@vreden/youtube_scraper');
} catch (_) {
  console.warn('[yt] @vreden/youtube_scraper not installed');
}

const UA_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

let _yt = null;
let _ytExpiresAt = 0;

async function getInnertube() {
  if (!Innertube) throw new Error('youtubei.js not available');

  const now = Date.now();
  if (!_yt || now > _ytExpiresAt) {
    _yt = await Innertube.create({ retrieve_player: true });
    _ytExpiresAt = now + 60 * 60 * 1000;
  }

  return _yt;
}

async function tryInnertube(videoId) {
  const yt = await getInnertube();
  const clients = ['IOS', 'ANDROID', 'WEB'];

  let info = null;
  let usedClient = '';

  for (const client of clients) {
    try {
      info = await yt.getBasicInfo(videoId, client);
      if (info?.streaming_data) {
        usedClient = client;
        break;
      }
    } catch (e) {
      console.log(`[yt/innertube] ${client} failed: ${e.message}`);
    }
  }

  if (!info?.streaming_data) {
    throw new Error('innertube: no streaming_data from any client');
  }

  const formats = [];

  for (const f of info.streaming_data.formats || []) {
    const url =
      f.url ||
      (typeof f.decipher === 'function'
        ? f.decipher(yt.session.player)
        : null);

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
    const url =
      a.url ||
      (typeof a.decipher === 'function'
        ? a.decipher(yt.session.player)
        : null);

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

  if (!formats.length) throw new Error('innertube: no usable formats');

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
    if (
      label.includes('video only') ||
      label.includes('vid only') ||
      label.includes('without audio')
    ) {
      continue;
    }

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

async function tryVreden(url) {
  if (!vreden) throw new Error('vreden: package not available');

  const meta = await vreden.metadata(url);
  const qualities = [1080, 720, 480, 360];

  const results = await Promise.all(
    qualities.map(async q => {
      try {
        const r = await vreden.ytmp4(url, q);
        return r?.download?.url ? { url: r.download.url, qualityNum: q } : null;
      } catch (_) {
        return null;
      }
    })
  );

  const formats = results.filter(Boolean).map(r => ({
    url: r.url,
    quality: `${r.qualityNum}p`,
    qualityNum: r.qualityNum,
    isAudioOnly: false,
    hasAudio: true,
  }));

  try {
    const a = await vreden.ytmp3(url, 128);
    if (a?.download?.url) {
      formats.push({
        url: a.download.url,
        quality: '128kbps',
        qualityNum: 128000,
        isAudioOnly: true,
        hasAudio: true,
      });
    }
  } catch (_) {}

  if (!formats.length) throw new Error('vreden: no formats');

  console.log(`[yt/vreden] ${formats.length} formats`);

  return {
    title: meta?.title || 'YouTube Video',
    thumbnail: meta?.image || meta?.thumbnail || null,
    duration: meta?.duration?.seconds || 0,
    uploader: meta?.channel_title || meta?.author || 'YouTube',
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

  if (r.status >= 400) {
    throw new Error(`cobalt: HTTP ${r.status}`);
  }

  const data = r.data || {};
  const finalUrl = data.url || data.download || data.file || '';

  if (!finalUrl || !String(finalUrl).startsWith('http')) {
    throw new Error('cobalt: no download url');
  }

  return {
    title: data.filename || 'YouTube Video',
    thumbnail: null,
    duration: 0,
    uploader: 'YouTube',
    formats: [
      {
        url: finalUrl,
        quality: '360p',
        qualityNum: 360,
        isAudioOnly: false,
        hasAudio: true,
      },
    ],
  };
}

async function fetchYouTubeData(url) {
  const videoId = extractVideoId(url);
  if (!videoId) throw new Error('Could not extract YouTube video ID');

  const normUrl = normalizeUrl(url);
  console.log(`YouTube: racing for ${videoId}`);

  const strategies = [
    Innertube && wrap('innertube', tryInnertube(videoId)),
    wrap('vidfly', tryVidfly(normUrl)),
    vreden && wrap('vreden', tryVreden(normUrl)),
    COBALT_API_URL && wrap('cobalt', tryCobalt(normUrl)),
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
