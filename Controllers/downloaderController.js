const { ttdl, twitter } = require('btch-downloader');
const { igdl } = require('btch-downloader');
const { pindl } = require('jer-api');
const { BitlyClient } = require('bitly');
const config = require('../Config/config');

const threadsDownloader = require('../Services/threadsService');          // direct parser (below)
const fetchLinkedinData = require('../Services/linkedinService');         // unchanged
const facebookInsta = require('../Services/facebookInstaService');        // unchanged
const { downloadTwmateData } = require('../Services/twitterService');     // your parser
const { fetchYouTubeData } = require('../Services/youtubeService');       // vidfly or ytdl-core

const bitly = new BitlyClient(config.BITLY_ACCESS_TOKEN);

const placeholderThumbnail = 'https://via.placeholder.com/300x150';

// ---------- helpers ----------
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
  if (!url) return res.status(400).json({ error: 'Invalid or missing URL', success: false });

  const platform = identifyPlatform(url);
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

  try {
    const withTimeout = (fn) =>
      Promise.race([ fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('Download timeout')), 30000)) ]);

    let data;
    switch (platform) {
      case 'instagram':
        try {
          data = await withTimeout(() => igdl(processedUrl));
          if (!data || (Array.isArray(data) && data.length === 0)) throw new Error('Instagram primary empty');
        } catch {
          data = await withTimeout(() => facebookInsta(processedUrl));
          if (!data || !data.media) throw new Error('Instagram fallback empty');
        }
        break;

      case 'tiktok':
        data = await withTimeout(() => ttdl(processedUrl));
        if (!data || !data.video) throw new Error('TikTok invalid');
        break;

      case 'facebook':
        data = await withTimeout(() => facebookInsta(processedUrl));
        if (!data || (!data.media && !data.data)) throw new Error('Facebook invalid');
        break;

      case 'twitter':
        try {
          data = await withTimeout(() => twitter(processedUrl));
          const ok = data?.data && (data.data.HD || data.data.SD);
          const variants = Array.isArray(data?.url) && data.url.some(v => v?.url);
          if (!ok && !variants) throw new Error('Primary unusable');
        } catch {
          data = await withTimeout(() => downloadTwmateData(processedUrl));
          if (!data || (!Array.isArray(data) && !data.data)) throw new Error('Custom invalid');
        }
        break;

      case 'youtube':
        data = await withTimeout(() => fetchYouTubeData(processedUrl));
        if (!data || !data.title || !Array.isArray(data.formats)) throw new Error('YouTube invalid');
        break;

      case 'pinterest':
        data = await withTimeout(() => pindl(processedUrl));
        if (!data || (!data.result && !data.url)) throw new Error('Pinterest invalid');
        break;

      case 'threads':
        data = await withTimeout(() => threadsDownloader(processedUrl)); // NEW direct parser (no third-party)
        if (!data || !data.download) throw new Error('Threads invalid');
        break;

      case 'linkedin':
        data = await withTimeout(() => fetchLinkedinData(processedUrl));
        if (!data || !data.data || !data.data.videos) throw new Error('LinkedIn invalid');
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
      return res.status(500).json({
        success: false,
        error: 'Invalid media data - no download URL found',
        platform
      });
    }

    // CRITICAL: always proxy (fixes YouTube & Twitter issues)
    const proxied = toProxyUrl(req, finalRawUrl);

    return res.status(200).json({
      success: true,
      platform,
      timestamp: new Date().toISOString(),
      data: {
        title,
        url: proxied,
        thumbnail,
        duration,
        source: platform,
        sizes: ['Best']
      },
      debug: {
        originalUrl: url,
        processedUrl,
        chosenRawUrlHost: (() => { try { return new URL(finalRawUrl).host; } catch { return 'n/a'; } })(),
        proxied: true
      }
    });
  } catch (error) {
    console.error(`Download Media: Error - ${error.message}`);
    return res.status(500).json({
      error: 'Failed to download media',
      success: false,
      details: error.message,
      platform,
      timestamp: new Date().toISOString()
    });
  }
};
