// Controllers/downloaderController.js
const { ttdl, twitter, igdl } = require('btch-downloader');
const { pindl } = require('jer-api');
const { BitlyClient } = require('bitly');
const config = require('../Config/config');

const threadsDownloader = require('../Services/threadsService');
const fetchLinkedinData = require('../Services/linkedinService');
const facebookInsta = require('../Services/facebookInstaService');
const { downloadTwmateData } = require('../Services/twitterService');
const { fetchYouTubeData } = require('../Services/youtubeService');

const bitly = new BitlyClient(config.BITLY_ACCESS_TOKEN);

const placeholderThumbnail = 'https://via.placeholder.com/300x150';

// ---------- helpers ----------
function log(...args) { console.log('[DL]', ...args); }
function warn(...args) { console.warn('[DL]', ...args); }
function err(...args) { console.error('[DL]', ...args); }

function sanitizeUrl(u) {
  if (!u || typeof u !== 'string') return '';
  let x = u.trim();
  const i = x.indexOf('#');
  if (i !== -1) x = x.slice(0, i);
  return x;
}
function identifyPlatform(url) {
  if (url.includes('instagram.com')) return 'instagram';
  if (url.includes('tiktok.com')) return 'tiktok';
  if (url.includes('facebook.com') || url.includes('fb.watch')) return 'facebook';
  if (url.includes('x.com') || url.includes('twitter.com')) return 'twitter';
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube';
  if (url.includes('pinterest.com') || url.includes('pin.it')) return 'pinterest';
  if (url.includes('threads.net') || url.includes('threads.com')) return 'threads';
  if (url.includes('linkedin.com')) return 'linkedin';
  return null;
}
function normalizeYouTubeUrl(url) {
  const m = url.match(/youtube\.com\/shorts\/([a-zA-Z0-9_-]+)/);
  return m ? `https://www.youtube.com/watch?v=${m[1]}` : url;
}
function normalizeThreadsUrl(url) {
  let u = sanitizeUrl(url);
  try {
    const p = new URL(u);
    if (p.hostname === 'threads.com') { p.hostname = 'threads.net'; u = p.toString(); }
  } catch {}
  return u;
}
function toProxyUrl(req, rawUrl) {
  const base = `${req.protocol}://${req.get('host')}`;
  return `${base}/api/proxy?u=${encodeURIComponent(rawUrl)}`;
}
function chooseBestTwitter(variants = []) {
  if (!Array.isArray(variants) || variants.length === 0) return null;
  const pick = (arr, q) => arr.find(v => (v.quality || '').includes(q));
  return pick(variants, '1280x720') || pick(variants, '720x1280') ||
         pick(variants, '640x360') || pick(variants, '360x640') ||
         variants[0];
}

// ---------- main ----------
exports.downloadMedia = async (req, res) => {
  let { url } = req.body;
  url = sanitizeUrl(url);
  log('Received URL:', url);

  if (!url) return res.status(400).json({ error: 'Invalid or missing URL', success: false });

  const platform = identifyPlatform(url);
  log('Platform Identification:', platform || 'unknown');

  if (!platform) {
    return res.status(400).json({
      error: 'Unsupported platform',
      success: false,
      supportedPlatforms: ['instagram','tiktok','facebook','twitter','youtube','pinterest','threads','linkedin']
    });
  }

  let processedUrl = url;
  if (platform === 'youtube') processedUrl = normalizeYouTubeUrl(processedUrl);
  if (platform === 'threads') processedUrl = normalizeThreadsUrl(processedUrl);
  log('Processed URL:', processedUrl);

  try {
    const withTimeout = (fn) =>
      Promise.race([ fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('Download timeout')), 30000)) ]);

    let data;
    switch (platform) {
      case 'instagram':
        try {
          log('IG: trying btch igdl');
          data = await withTimeout(() => igdl(processedUrl));
          if (!data || (Array.isArray(data) && data.length === 0)) throw new Error('empty');
          log('IG: primary ok');
        } catch {
          log('IG: primary failed, trying facebookInsta fallback');
          data = await withTimeout(() => facebookInsta(processedUrl));
          if (!data || !data.media) throw new Error('fallback empty');
          log('IG: fallback ok');
        }
        break;

      case 'tiktok':
        log('TT: using ttdl');
        data = await withTimeout(() => ttdl(processedUrl));
        if (!data || !data.video) throw new Error('TikTok invalid');
        log('TT: fetch ok');
        break;

      case 'facebook':
        log('FB: using facebookInsta');
        data = await withTimeout(() => facebookInsta(processedUrl));
        if (!data || (!data.media && !data.data)) throw new Error('Facebook invalid');
        log('FB: fetch ok');
        break;

      case 'twitter':
        try {
          log('TW: trying btch twitter');
          data = await withTimeout(() => twitter(processedUrl));
          const ok = data?.data && (data.data.HD || data.data.SD);
          const variants = Array.isArray(data?.url) && data.url.some(v => v?.url);
          if (!ok && !variants) throw new Error('primary unusable');
          log('TW: primary ok');
        } catch {
          log('TW: primary failed, trying TWMate fallback');
          data = await withTimeout(() => downloadTwmateData(processedUrl));
          if (!data || (!Array.isArray(data) && !data.data)) throw new Error('fallback invalid');
          log('TW: fallback ok');
        }
        break;

      case 'youtube':
        log('YT: fetching formats (ytdl-core service)');
        data = await withTimeout(() => fetchYouTubeData(processedUrl));
        if (!data || !data.title || !Array.isArray(data.formats)) throw new Error('YouTube invalid');
        log(`YT: got ${data.formats.length} formats`);
        break;

      case 'pinterest':
        log('PIN: using pindl');
        data = await withTimeout(() => pindl(processedUrl));
        if (!data || (!data.result && !data.url)) throw new Error('Pinterest invalid');
        log('PIN: fetch ok');
        break;

      case 'threads':
        log('THR: fetching page & parsing');
        data = await withTimeout(() => threadsDownloader(processedUrl));
        if (!data || !data.download) throw new Error('Threads invalid');
        log('THR: parse ok');
        break;

      case 'linkedin':
        log('LI: using linkedin service');
        data = await withTimeout(() => fetchLinkedinData(processedUrl));
        if (!data || !data.data || !data.data.videos) throw new Error('LinkedIn invalid');
        log('LI: fetch ok');
        break;
    }

    // ---- pick ONE best URL and PROXY it ----
    let title = 'Untitled Media';
    let finalRawUrl = '';
    let thumbnail = placeholderThumbnail;
    let duration;

    switch (platform) {
      case 'youtube': {
        title = data.title || 'YouTube Video';
        duration = data.duration || undefined;
        const withAudio = data.formats.filter(f => f.type === 'video_with_audio');
        const pref = (arr, q) => arr.find(f => (f.quality || '').includes(q));
        const best = pref(withAudio, '1080p') || pref(withAudio, '720p') || pref(withAudio, '480p') ||
                     withAudio[0] || data.formats[0];
        finalRawUrl = best?.url || '';
        thumbnail = data.thumbnail || placeholderThumbnail;
        log('YT: selected format:', best ? `${best.quality} (${best.extension})` : 'none');
        break;
      }
      case 'instagram': {
        if (data?.media && Array.isArray(data.media)) {
          finalRawUrl = data.media[0]?.url || '';
          title = data.title || 'Instagram Media';
          thumbnail = data.thumbnail || placeholderThumbnail;
        } else if (Array.isArray(data) && data[0]?.url) {
          finalRawUrl = data[0].url;
          title = data[0]?.wm || 'Instagram Media';
          thumbnail = data[0]?.thumbnail || placeholderThumbnail;
        }
        break;
      }
      case 'tiktok': {
        title = data.title || 'TikTok Video';
        finalRawUrl = data.video?.[0] || '';
        thumbnail = data.thumbnail || placeholderThumbnail;
        break;
      }
      case 'facebook': {
        title = data.title || 'Facebook Video';
        if (data?.media && Array.isArray(data.media)) {
          const vid = data.media.find(m => m.type === 'video') || data.media[0];
          finalRawUrl = vid?.url || '';
          thumbnail = data.thumbnail || placeholderThumbnail;
        } else {
          const fbData = data.data || [];
          const hd = fbData.find(v => (v.resolution || '').includes('720p'));
          const sd = fbData.find(v => (v.resolution || '').includes('360p'));
          finalRawUrl = (hd?.url || sd?.url) || '';
          thumbnail = (hd?.thumbnail || sd?.thumbnail || placeholderThumbnail);
        }
        break;
      }
      case 'twitter': {
        title = 'Twitter Video';
        if (data?.data && (data.data.HD || data.data.SD)) {
          finalRawUrl = data.data.HD || data.data.SD || '';
          thumbnail = data.data.thumbnail || placeholderThumbnail;
        } else if (data?.data && Array.isArray(data.data)) {
          const best = chooseBestTwitter(data.data);
          finalRawUrl = best?.url || '';
        } else if (Array.isArray(data)) {
          const best = chooseBestTwitter(data);
          finalRawUrl = best?.url || '';
        }
        break;
      }
      case 'pinterest': {
        const p = data?.data || data;
        finalRawUrl = p.result || p.url || '';
        title = 'Pinterest Image';
        thumbnail = p.result || p.url || placeholderThumbnail;
        break;
      }
      case 'threads': {
        title = data.title || 'Threads Post';
        finalRawUrl = data.download || '';
        thumbnail = data.thumbnail || placeholderThumbnail;
        break;
      }
      case 'linkedin': {
        title = 'LinkedIn Video';
        const v = Array.isArray(data?.data?.videos) && data.data.videos.length > 0 ? data.data.videos[0] : '';
        finalRawUrl = v;
        thumbnail = v ? placeholderThumbnail : 'Error';
        break;
      }
    }

    if (!finalRawUrl) {
      warn('No final URL produced');
      return res.status(500).json({
        success: false,
        error: 'Invalid media data - no download URL found',
        platform
      });
    }

    try {
      const host = new URL(finalRawUrl).host;
      log('Chosen source host:', host);
    } catch {}

    const proxied = toProxyUrl(req, finalRawUrl);
    log('Returning proxied URL.');

    return res.status(200).json({
      success: true,
      platform,
      timestamp: new Date().toISOString(),
      data: { title, url: proxied, thumbnail, duration, source: platform, sizes: ['Best'] },
      debug: { originalUrl: url, processedUrl, proxied: true }
    });
  } catch (error) {
    err('Error:', error.message);
    return res.status(500).json({
      error: 'Failed to download media',
      success: false,
      details: error.message,
      platform,
      timestamp: new Date().toISOString()
    });
  }
};
