
const axios = require('axios');

const TIKTOK_DOWNLOAD_HEADERS = {
  'Referer': 'https://www.tiktok.com/',
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  'Accept': 'video/mp4,video/*;q=0.9,*/*;q=0.8',
};

function isValidVideoUrl(url) {
  return !!(url && typeof url === 'string' && url.startsWith('http') && url.length >= 20);
}

function extractVideoId(url) {
  try {
    const match = url.match(/\/video\/(\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// SOURCE 1: tikwm API (returns HD CDN URL + proxy URL)
// Timeout: 8s — if tikwm can respond it does so in <3s
// ─────────────────────────────────────────────────────────────
async function tryTikwm(url) {
  const endpoints = ['https://www.tikwm.com/api/', 'https://tikwm.com/api/'];

  for (const endpoint of endpoints) {
    try {
      const response = await axios.get(endpoint, {
        params: { url, hd: 1 },
        timeout: 8000, // tight timeout — fail fast, don't block the race
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
          'Referer': 'https://www.tikwm.com/',
        },
      });

      const data = response.data;
      if (!data || data.code !== 0 || !data.data) continue;

      const d = data.data;
      const cdnUrl = d.hdplay || d.play || '';
      if (!isValidVideoUrl(cdnUrl)) continue;

      const videoId = d.id || extractVideoId(url);
      const proxyUrl = videoId
        ? `https://www.tikwm.com/video/media/play/${videoId}.mp4`
        : null;

      const videoUrls = proxyUrl ? [cdnUrl, proxyUrl] : [cdnUrl];

      console.log(`TikTok [tikwm ✓] CDN=${cdnUrl.length}chars proxy=${proxyUrl ? 'yes' : 'no'}`);

      return {
        title: d.title || 'TikTok Video',
        video: videoUrls,
        thumbnail: d.cover || d.origin_cover || '',
        audio: d.music || d.music_info?.play ? [d.music || d.music_info?.play] : [],
        duration: d.duration ? String(d.duration) : 'unknown',
        _source: 'tikwm',
        _downloadHeaders: TIKTOK_DOWNLOAD_HEADERS,
      };

    } catch (e) {
      console.log(`TikTok [tikwm] ${endpoint}: ${(e.message || '').substring(0, 60)}`);
    }
  }
  throw new Error('tikwm: all endpoints failed');
}

// ─────────────────────────────────────────────────────────────
// SOURCE 2: btch-downloader (wraps tikwm + other sources)
// Timeout: 10s
// ─────────────────────────────────────────────────────────────
async function tryBtch(url) {
  const { ttdl } = require('btch-downloader');

  // btch doesn't have a built-in timeout — wrap it
  const result = await Promise.race([
    ttdl(url),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('btch timeout after 10s')), 10000)
    ),
  ]);

  if (!result || !result.video) throw new Error('btch: no video field');

  const videoUrl = Array.isArray(result.video) ? result.video[0] : result.video;
  if (!isValidVideoUrl(videoUrl)) throw new Error(`btch: invalid URL (${videoUrl?.length || 0} chars)`);

  // If btch returned a tikwm proxy URL, build the CDN URL from the video ID in it
  // e.g. https://www.tikwm.com/video/media/play/7570323164522089750.mp4
  const idMatch = videoUrl.match(/\/play\/(\d+)\.mp4/);
  const videoUrls = idMatch
    ? [videoUrl] // proxy only — CDN URL not available from btch
    : [videoUrl];

  console.log(`TikTok [btch ✓] URL=${videoUrl.length}chars`);

  return {
    title: result.title || 'TikTok Video',
    video: videoUrls,
    thumbnail: result.thumbnail || '',
    audio: result.audio
      ? (Array.isArray(result.audio) ? result.audio : [result.audio])
      : [],
    duration: 'unknown',
    _source: 'btch',
    _downloadHeaders: TIKTOK_DOWNLOAD_HEADERS,
  };
}

// ─────────────────────────────────────────────────────────────
// MAIN: race all sources in parallel
// First valid response wins. Slower/failed ones are ignored.
// ─────────────────────────────────────────────────────────────
async function robustTikTokDownload(url) {
  console.log(`TikTok: Racing sources for: ${url}`);

  // Wrap each source so it resolves with { ok, result } or { ok: false, error }
  // This lets Promise.allSettled-style logic pick the first success
  function attempt(name, fn) {
    return fn().then(
      result => ({ ok: true, name, result }),
      error => ({ ok: false, name, error: error.message })
    );
  }

  // Fire all sources at the same time
  const race = [
    attempt('tikwm', () => tryTikwm(url)),
    attempt('btch',  () => tryBtch(url)),
  ];

  // Process results as they come in — resolve on first success
  return new Promise((resolve, reject) => {
    let settled = 0;
    const errors = [];

    for (const promise of race) {
      promise.then(({ ok, name, result, error }) => {
        settled++;

        if (ok) {
          console.log(`TikTok: Won by [${name}]`);
          resolve(result);
          return;
        }

        errors.push(`[${name}]: ${error}`);
        console.log(`TikTok [${name}] failed: ${error?.substring(0, 80)}`);

        if (settled === race.length) {
          reject(new Error(`TikTok all sources failed:\n${errors.join('\n')}`));
        }
      });
    }
  });
}

module.exports = { robustTikTokDownload };