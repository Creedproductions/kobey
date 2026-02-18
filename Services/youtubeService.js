// Services/youtubeService.js — Simple & Fast
// Two sources raced in parallel. First win returned immediately.

const { exec } = require('child_process');
const util = require('util');
const axios = require('axios');
const execPromise = util.promisify(exec);

const FREE_MAX = 360;

const INVIDIOUS = [
  'https://invidious.kavin.rocks',
  'https://inv.riverside.rocks',
  'https://yewtu.be',
  'https://invidious.flokinet.to',
];

// SOURCE 1: Invidious public API — 1-4s when healthy
async function tryInvidious(videoId) {
  const instances = [...INVIDIOUS].sort(() => 0.5 - Math.random());
  for (const base of instances) {
    try {
      const { data } = await axios.get(`${base}/api/v1/videos/${videoId}`, {
        timeout: 7000,
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });

      const formats = [];

      for (const s of (data.formatStreams || [])) {
        if (!validUrl(s.url)) continue;
        const q = parseInt(s.qualityLabel) || 360;
        formats.push({ url: s.url, quality: `${q}p`, qualityNum: q, isAudioOnly: false, hasAudio: true });
      }

      const audioStreams = (data.adaptiveFormats || [])
        .filter(s => s.type && s.type.includes('audio') && validUrl(s.url))
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

      if (audioStreams[0]) {
        const kbps = Math.round((audioStreams[0].bitrate || 128000) / 1000);
        formats.push({ url: audioStreams[0].url, quality: `${kbps}kbps`, qualityNum: kbps * 1000, isAudioOnly: true, hasAudio: true });
      }

      if (!formats.length) continue;

      console.log(`YouTube [invidious] ${base} — ${formats.length} formats`);
      return {
        title: data.title,
        thumbnail: data.videoThumbnails && data.videoThumbnails[0] ? data.videoThumbnails[0].url : null,
        duration: data.lengthSeconds,
        uploader: data.author,
        formats,
      };

    } catch (e) {
      console.log(`YouTube [invidious] ${base}: ${(e.message || '').substring(0, 60)}`);
    }
  }
  throw new Error('Invidious: all instances failed');
}

// SOURCE 2: yt-dlp tv_embedded — 5-15s, works on datacenter IPs
async function tryYtDlp(url, videoId) {
  const { stdout } = await execPromise(
    `yt-dlp -j --no-playlist --no-warnings --no-check-certificate --extractor-args "youtube:player_client=tv_embedded" --geo-bypass "${url}"`,
    { timeout: 30000, maxBuffer: 20 * 1024 * 1024 }
  );

  let info = null;
  for (const line of stdout.trim().split('\n').reverse()) {
    if (line.startsWith('{')) {
      try { info = JSON.parse(line); break; } catch (_) {}
    }
  }
  if (!info) throw new Error('yt-dlp: no JSON output');

  const muxed = [], audioOnly = [];
  for (const f of (info.formats || [])) {
    if (!validUrl(f.url)) continue;
    if (f.protocol && f.protocol.includes('m3u8')) continue;
    if (f.ext === 'mhtml') continue;
    const hasV = f.vcodec && f.vcodec !== 'none';
    const hasA = f.acodec && f.acodec !== 'none';
    if (hasV && hasA && f.height) muxed.push(f);
    else if (!hasV && hasA) audioOnly.push(f);
  }

  const formats = [];
  const seen = new Set();

  for (const f of muxed.sort((a, b) => (b.tbr || 0) - (a.tbr || 0))) {
    if (seen.has(f.height)) continue;
    seen.add(f.height);
    formats.push({ url: f.url, quality: `${f.height}p`, qualityNum: f.height, isAudioOnly: false, hasAudio: true });
  }

  const bestAudio = audioOnly.sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0))[0];
  if (bestAudio) {
    const kbps = Math.round(bestAudio.abr || bestAudio.tbr || 128);
    formats.push({ url: bestAudio.url, quality: `${kbps}kbps`, qualityNum: kbps * 1000, isAudioOnly: true, hasAudio: true });
  }

  if (!formats.length) throw new Error('yt-dlp: no usable muxed formats');

  console.log(`YouTube [yt-dlp] — ${formats.length} formats`);
  return {
    title: info.title,
    thumbnail: info.thumbnail,
    duration: info.duration,
    uploader: info.uploader || info.channel,
    formats,
  };
}

// MAIN — race both, first success wins
async function fetchYouTubeData(url) {
  const videoId = extractVideoId(url);
  if (!videoId) throw new Error('Could not extract YouTube video ID');
  const normUrl = normalizeUrl(url);
  console.log(`YouTube: Racing for ${videoId}`);

  const race = [
    wrap('invidious', tryInvidious(videoId)),
    wrap('yt-dlp',    tryYtDlp(normUrl, videoId)),
  ];

  const data = await firstSuccess(race);
  return finalise(data, url, videoId);
}

function wrap(name, promise) {
  return promise.then(
    r => ({ ok: true, name, r }),
    e => ({ ok: false, name, e: e.message })
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
          console.log(`YouTube: Won by [${name}]`);
          resolve(r);
          return;
        }
        if (!ok) {
          errors.push(`[${name}]: ${e}`);
          console.log(`YouTube [${name}] failed: ${(e || '').substring(0, 80)}`);
        }
        if (settled === wrapped.length && !done) {
          reject(new Error('YouTube all sources failed:\n' + errors.join('\n')));
        }
      });
    }
  });
}

function finalise(data, url, videoId) {
  const isShorts = url.includes('/shorts/');
  const seen = new Set();
  const qualityOptions = data.formats
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

  const defaultFormat =
    qualityOptions.find(f => !f.isAudioOnly && f.qualityNum === FREE_MAX) ||
    qualityOptions.find(f => !f.isAudioOnly && f.qualityNum <= FREE_MAX) ||
    qualityOptions.find(f => !f.isAudioOnly) ||
    qualityOptions[0] || null;

  console.log(`YouTube: ${qualityOptions.length} options, default=${defaultFormat ? defaultFormat.quality : 'none'}`);

  return {
    success:         true,
    platform:        'youtube',
    title:           data.title || `YouTube Video ${videoId}`,
    thumbnail:       data.thumbnail || `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
    duration:        data.duration || 0,
    uploader:        data.uploader || 'YouTube',
    isShorts,
    videoId,
    url:             defaultFormat ? defaultFormat.url : null,
    formats:         qualityOptions,
    allFormats:      qualityOptions,
    selectedQuality: defaultFormat,
    audioGuaranteed: defaultFormat ? defaultFormat.hasAudio : false,
  };
}

function validUrl(url) {
  return !!(url && typeof url === 'string' && url.startsWith('http') && url.length > 50
    && !url.includes('youtube.com/watch') && !url.includes('youtu.be/'));
}

function normalizeUrl(url) {
  if (url.includes('youtu.be/')) {
    return `https://www.youtube.com/watch?v=${url.split('youtu.be/')[1].split('?')[0]}`;
  }
  if (url.includes('/shorts/')) {
    return `https://www.youtube.com/shorts/${url.split('/shorts/')[1].split('?')[0]}`;
  }
  return url;
}

function extractVideoId(url) {
  const patterns = [/[?&]v=([^&]+)/, /youtu\.be\/([^?]+)/, /\/shorts\/([^?]+)/, /\/embed\/([^?]+)/];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

module.exports = { fetchYouTubeData };