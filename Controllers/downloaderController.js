// ===== DEPENDENCIES =====
const { ttdl, twitter } = require('btch-downloader');
const { igdl } = require('btch-downloader');
const { pinterest } = require('ironman-api');
const { BitlyClient } = require('bitly');
const axios = require('axios');
const { ytdl, pindl } = require('jer-api');
const fetch = require('node-fetch');
const config = require('../Config/config');
const { advancedThreadsDownloader } = require('../Services/advancedThreadsService');
const fetchLinkedinData = require('../Services/linkedinService');
const facebookInsta = require('../Services/facebookInstaService');
const { downloadTwmateData } = require('../Services/twitterService');
const { fetchYouTubeData } = require('../Services/youtubeService');
const { downloadTikTok } = require('../Services/tiktokService');
const telegram = require('../Services/telegramService');

const bitly = new BitlyClient(config.BITLY_ACCESS_TOKEN);

// ===== CONSTANTS =====
const SUPPORTED_PLATFORMS = [
  'instagram', 'tiktok', 'facebook', 'twitter',
  'youtube', 'pinterest', 'threads', 'linkedin'
];

const PLACEHOLDER_THUMBNAIL = 'https://via.placeholder.com/300x150';
const DOWNLOAD_TIMEOUT = 45000;
const MAX_CAROUSEL_ITEMS = 20; // safety cap after dedup

// ===== UTILITY FUNCTIONS =====

const shortenUrl = async (url) => {
  if (!url || url.length < 200) return url;
  try {
    const tinyResponse = await axios.post('https://tinyurl.com/api-create.php', null, {
      params: { url }, timeout: 5000
    });
    if (tinyResponse.data && tinyResponse.data.startsWith('https://tinyurl.com/')) return tinyResponse.data;
  } catch (error) { console.warn('TinyURL shortening failed:', error.message); }
  try {
    const isgdResponse = await axios.get('https://is.gd/create.php', {
      params: { format: 'simple', url }, timeout: 5000
    });
    if (isgdResponse.data && isgdResponse.data.startsWith('https://is.gd/')) return isgdResponse.data;
  } catch (error) { console.warn('is.gd shortening failed:', error.message); }
  if (config.BITLY_ACCESS_TOKEN) {
    try {
      const bitlyResponse = await bitly.shorten(url);
      if (bitlyResponse && bitlyResponse.link) return bitlyResponse.link;
    } catch (error) { console.warn('Bitly shortening failed:', error.message); }
  }
  return url;
};

const identifyPlatform = (url) => {
  const platformMap = {
    'instagram.com': 'instagram',
    'tiktok.com':    'tiktok',
    'facebook.com':  'facebook',
    'fb.watch':      'facebook',
    'x.com':         'twitter',
    'twitter.com':   'twitter',
    'youtube.com':   'youtube',
    'youtu.be':      'youtube',
    'pinterest.com': 'pinterest',
    'pin.it':        'pinterest',
    'threads.net':   'threads',
    'threads.com':   'threads',
    'linkedin.com':  'linkedin'
  };
  for (const [domain, platform] of Object.entries(platformMap)) {
    if (url.includes(domain)) return platform;
  }
  console.warn('Platform Identification: Unable to identify the platform.');
  return null;
};

const normalizeYouTubeUrl = (url) => {
  let cleanUrl = url.split('#')[0];
  const shortsMatch = cleanUrl.match(/youtube\.com\/shorts\/([a-zA-Z0-9_-]+)/);
  if (shortsMatch) return `https://www.youtube.com/shorts/${shortsMatch[1]}`;
  const shortMatch = cleanUrl.match(/youtu\.be\/([a-zA-Z0-9_-]+)/);
  if (shortMatch) return `https://www.youtube.com/watch?v=${shortMatch[1]}`;
  return cleanUrl;
};

const validateUrl = (url) => {
  if (!url) return { isValid: false, error: 'No URL provided' };
  if (typeof url !== 'string' || url.trim().length === 0)
    return { isValid: false, error: 'Invalid URL format' };
  const cleanedUrl = url.trim();
  try { new URL(cleanedUrl); } catch (e) { return { isValid: false, error: 'Invalid URL format' }; }
  return { isValid: true, cleanedUrl };
};

const downloadWithTimeout = (downloadFunction, timeout = DOWNLOAD_TIMEOUT) => {
  return Promise.race([
    downloadFunction(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Download timeout - operation took too long')), timeout)
    )
  ]);
};

function getServerBaseUrl(req) {
  const host     = req.get('host');
  const protocol = req.secure ? 'https' : 'http';
  return process.env.SERVER_BASE_URL || `${protocol}://${host}`;
}

function wrapForProxy(cdnUrl, platform, title, serverBaseUrl) {
  if (!cdnUrl) return cdnUrl;
  const encoded  = encodeURIComponent(cdnUrl);
  const safeName = encodeURIComponent((title || 'video').replace(/[^a-zA-Z0-9_\- ]/g, '').trim() || 'video');
  return `${serverBaseUrl}/api/proxy-download?url=${encoded}&filename=${safeName}&platform=${platform}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// QUALITY + URL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const qualityScore = (q = '') => {
  const s = String(q).toLowerCase();
  if (s.includes('4k')   || s.includes('2160')) return 7;
  if (s.includes('1440') || s.includes('2k'))   return 6;
  if (s.includes('1080') || s.includes('fhd'))  return 5;
  if (s.includes('720')  || s === 'hd')         return 4;
  if (s.includes('480'))                         return 3;
  if (s.includes('360'))                         return 2;
  if (s.includes('240')  || s.includes('144'))  return 1;
  if (s === 'sd')                                return 1;
  return 0;
};

const pickBestUrl = (rawUrl) => {
  if (Array.isArray(rawUrl))
    return rawUrl.find(u => typeof u === 'string' && u.startsWith('http')) || rawUrl[0] || '';
  return rawUrl || '';
};

const decodeCdnUrl = (href) => {
  if (!href) return '';
  try {
    const u = new URL(href);
    for (const param of ['url', 'u', 'src', 'link', 'media']) {
      const val = u.searchParams.get(param);
      if (val && val.startsWith('http')) {
        const decoded = decodeURIComponent(val);
        if (decoded.includes('%3A')) return decodeCdnUrl(decoded);
        return decoded;
      }
    }
  } catch (_) {}
  return href;
};

const detectTypeFromUrl = (url) => {
  if (!url) return null;
  try {
    const u   = new URL(url);
    const ext = (u.searchParams.get('ext') || '').toLowerCase();
    if (['mp4', 'mov', 'webm', 'mkv', 'avi', 'ts'].includes(ext))             return 'video';
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'avif'].includes(ext))  return 'image';
  } catch (_) {}
  const pathOnly = url.toLowerCase().split('?')[0];
  if (pathOnly.match(/\.(mp4|mov|webm|mkv|avi|ts)$/))         return 'video';
  if (pathOnly.match(/\.(jpg|jpeg|png|gif|webp|heic|avif)$/))  return 'image';
  if (pathOnly.includes('/t50.'))   return 'video';
  if (pathOnly.includes('/t51.'))   return 'image';
  if (pathOnly.includes('/video/')) return 'video';
  const decoded = decodeCdnUrl(url);
  if (decoded !== url) return detectTypeFromUrl(decoded);
  return null;
};

// ─────────────────────────────────────────────────────────────────────────────
// INSTAGRAM EMBED SCRAPER
// Works from any IP — no credentials, no third-party service needed.
// Handles single images, single videos, reels, and mixed carousels.
// ─────────────────────────────────────────────────────────────────────────────

const unescape = (s) =>
  s.replace(/\\u0026/gi, '&')
   .replace(/\\u003[cC]/g, '<').replace(/\\u003[eE]/g, '>')
   .replace(/\\\//g, '/')
   .replace(/\\"/g, '"');

async function scrapeInstaEmbed(igUrl) {
  const match = igUrl.match(/instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/);
  if (!match) throw new Error('instaEmbed: cannot extract shortcode');
  const shortcode = match[1];

  // Multiple URL variants — collab posts, sponsored posts, and newer carousel formats
  // often only serve usable HTML on the bare post URL or non-captioned embed.
  const embedUrls = [
    `https://www.instagram.com/p/${shortcode}/embed/captioned/`,
    `https://www.instagram.com/p/${shortcode}/embed/`,
    `https://www.instagram.com/reel/${shortcode}/embed/captioned/`,
    `https://www.instagram.com/reel/${shortcode}/embed/`,
    `https://www.instagram.com/p/${shortcode}/`,
    `https://www.instagram.com/reel/${shortcode}/`,
  ];

  const userAgents = [
    // Mobile Safari — works for most public posts
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    // Desktop Chrome — some collab/sponsored posts serve richer HTML to desktop
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    // Googlebot — sometimes bypasses soft login walls on public posts
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  ];

  let bestHtml   = '';
  let bestLength = 0;

  const addItem = (url, type, thumbnail) => {
    const clean = unescape(url).replace(/&amp;/g, '&');
    if (!clean || !clean.startsWith('http') || seen.has(clean)) return;
    seen.add(clean);
    const thumb = thumbnail
      ? unescape(thumbnail).replace(/&amp;/g, '&')
      : (type === 'image' ? clean : '');
    items.push({ url: clean, type, thumbnail: thumb });
  };

  const items = [];
  const seen  = new Set();

  // ── Fetch: iterate URL/UA combos, stop as soon as we find media-rich HTML ─
  outerLoop:
  for (const embedUrl of embedUrls) {
    for (const ua of userAgents) {
      try {
        const resp = await axios.get(embedUrl, {
          timeout: 15000,
          maxRedirects: 5,
          validateStatus: (s) => s < 500,
          headers: {
            'User-Agent':      ua,
            Accept:            'text/html,application/xhtml+xml,*/*;q=0.9',
            'Accept-Language': 'en-US,en;q=0.9',
            Referer:           'https://www.instagram.com/',
            'Cache-Control':   'no-cache',
            'Sec-Fetch-Dest':  'document',
            'Sec-Fetch-Mode':  'navigate',
            'Sec-Fetch-Site':  'none',
          },
        });

        const html = typeof resp.data === 'string' ? resp.data : '';
        const slug = embedUrl.replace('https://www.instagram.com', '');
        console.log(`📸 instaEmbed: ${html.length} chars [${slug}] ua=${ua.slice(0, 30)}...`);

        // Keep the largest/richest response seen so far
        if (html.length > bestLength) {
          bestLength = html.length;
          bestHtml   = html;
        }

        // If this page has actual media JSON, use it immediately
        if (
          html.includes('video_url')    ||
          html.includes('display_url')  ||
          html.includes('edge_sidecar') ||
          html.includes('playable_url')
        ) {
          bestHtml = html;
          break outerLoop;
        }
      } catch (e) {
        const slug = embedUrl.replace('https://www.instagram.com', '');
        console.warn(`📸 instaEmbed fetch failed [${slug}]: ${e.message}`);
      }
    }
  }

  const html = bestHtml;
  if (!html || html.length < 200) {
    throw new Error(`instaEmbed: all fetch attempts returned empty HTML for ${shortcode}`);
  }

  // ── Method 1: full carousel (edge_sidecar_to_children JSON blob) ──────────
  const sidecarRe = /"edge_sidecar_to_children"\s*:\s*\{"edges"\s*:\s*(\[[\s\S]*?\])\}/;
  const sidecarM  = html.match(sidecarRe);
  if (sidecarM) {
    try {
      const edges = JSON.parse(unescape(sidecarM[1]));
      edges.forEach((edge) => {
        const node = edge.node || edge || {};
        if (node.is_video && node.video_url) {
          addItem(node.video_url, 'video', node.display_url || '');
        } else if (node.display_url) {
          addItem(node.display_url, 'image', node.display_url);
        }
      });
      console.log(`📸 instaEmbed sidecar: ${items.length} items`);
    } catch (e) {
      console.warn('📸 instaEmbed sidecar parse error:', e.message);
    }
  }

  // ── Method 2: video_url JSON key (single video / reel) ────────────────────
  if (items.length === 0) {
    const vidRe   = /"video_url"\s*:\s*"([^"]+)"/g;
    const thumbRe = /"display_url"\s*:\s*"([^"]+)"/;
    const thumbM  = html.match(thumbRe);
    const thumb   = thumbM ? thumbM[1] : '';
    let vm;
    while ((vm = vidRe.exec(html)) !== null) addItem(vm[1], 'video', thumb);
  }

  // ── Method 3: playable_url JSON key (alternate video key) ─────────────────
  if (items.length === 0) {
    const playRe  = /"playable_url"\s*:\s*"([^"]+)"/g;
    const thumbRe = /"display_url"\s*:\s*"([^"]+)"/;
    const thumbM  = html.match(thumbRe);
    const thumb   = thumbM ? thumbM[1] : '';
    let pm;
    while ((pm = playRe.exec(html)) !== null) addItem(pm[1], 'video', thumb);
  }

  // ── Method 4: display_url JSON key (single image) ─────────────────────────
  if (items.length === 0) {
    const imgRe = /"display_url"\s*:\s*"([^"]+)"/g;
    let im;
    while ((im = imgRe.exec(html)) !== null) addItem(im[1], 'image', im[1]);
  }

  // ── Method 5: <video src="..."> HTML tag ──────────────────────────────────
  if (items.length === 0) {
    const vTagRe = /<video[^>]+src="([^"]+)"/gi;
    let vt;
    while ((vt = vTagRe.exec(html)) !== null) addItem(vt[1], 'video', '');
  }

  // ── Method 6: og:video meta tag ───────────────────────────────────────────
  // Even completely stripped embed pages include og: tags in <head>.
  // This is the reliable floor for any public post including sponsored ones.
  if (items.length === 0) {
    const ogVid =
      html.match(/<meta[^>]+property="og:video(?::url)?"\s+content="([^"]+)"/i) ||
      html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:video(?::url)?"/i);
    if (ogVid) {
      const u = ogVid[1].replace(/&amp;/g, '&');
      if (u.startsWith('http')) addItem(u, 'video', '');
    }
  }

  // ── Method 7: og:image meta tag ───────────────────────────────────────────
  // Collab posts, sponsored posts, and some reels only expose og:image.
  if (items.length === 0) {
    const ogImg =
      html.match(/<meta[^>]+property="og:image"\s+content="([^"]+)"/i) ||
      html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:image"/i);
    if (ogImg) {
      const u = ogImg[1].replace(/&amp;/g, '&');
      if (
        u.startsWith('http') &&
        (u.includes('cdninstagram') || u.includes('fbcdn') || u.includes('scontent'))
      ) {
        addItem(u, 'image', u);
      }
    }
  }

  // ── Method 8: Instagram/Facebook CDN <img> tags ───────────────────────────
  if (items.length === 0) {
    const imgTagRe =
      /<img[^>]+src="(https?:\/\/[^"]*(?:cdninstagram\.com|fbcdn\.net)[^"]+)"/gi;
    let it;
    while ((it = imgTagRe.exec(html)) !== null) {
      const u = it[1].replace(/&amp;/g, '&');
      if (u.includes('s150x150') || u.includes('s32x32') || u.includes('emoji')) continue;
      addItem(u, 'image', u);
    }
  }

  // ── Method 9: any CDN URL with media extension anywhere in the HTML ────────
  if (items.length === 0) {
    const cdnRe =
      /["'](https?:\/\/[^"']*(?:cdninstagram\.com|fbcdn\.net)[^"']+\.(?:mp4|jpg|jpeg|png|webp)[^"'?]*(?:\?[^"']*)?)['"]/gi;
    let cm;
    while ((cm = cdnRe.exec(html)) !== null) {
      const u    = cm[1].replace(/&amp;/g, '&');
      const type = u.toLowerCase().split('?')[0].endsWith('.mp4') ? 'video' : 'image';
      addItem(u, type, type === 'image' ? u : '');
    }
  }

  if (items.length === 0) {
    // Debug: log what Instagram actually returned so we can extend methods later
    console.error(`📸 instaEmbed DEBUG [${shortcode}] html preview:\n${html.slice(0, 3000)}`);
    throw new Error(`instaEmbed: no media found for ${shortcode}`);
  }

  console.log(`📸 instaEmbed: ${items.length} item(s) for ${shortcode}`);
  return items;
}

// ─────────────────────────────────────────────────────────────────────────────
// INSTAGRAM DEDUPLICATION HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Extract the real Instagram CDN URL from a rapidcdn JWT token URL. */
const extractJwtCdnUrl = (tokenUrl) => {
  try {
    const m = tokenUrl.match(/[?&]token=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]*)/);
    if (!m) return null;
    const payload = JSON.parse(Buffer.from(m[2], 'base64url').toString('utf8'));
    const cdnUrl  = payload.url || payload.u || payload.src || '';
    return cdnUrl.startsWith('http') ? cdnUrl : null;
  } catch (_) { return null; }
};

/**
 * Extract the stable Instagram asset ID from any CDN pathname.
 * - Images: .../NNN_NNN_NNN_n.jpg  → "img:NNN_NNN_NNN"
 * - Videos: .../o1/v/t16/f2/m84/LONGHASH... → "vid:LONGHASH"
 */
const extractInstagramAssetId = (pathname) => {
  // Image filenames: digits_digits_digits(_n)?.ext
  const imgM = pathname.match(/\/(\d{6,}_\d+_\d+)(?:_n)?\.(?:jpg|jpeg|png|webp|gif)/i);
  if (imgM) return `img:${imgM[1]}`;

  // Video hash segment — first path segment ≥ 20 chars of hex/base64url chars
  const segs = pathname.split('/').filter(Boolean);
  const long = segs.find(s => s.length >= 20 && /^[a-zA-Z0-9_-]+$/.test(s));
  if (long) return `vid:${long}`;

  // Fallback: strip size/crop decorators
  return pathname
    .replace(/\/[sp]\d{2,4}x\d{2,4}\//g, '/')
    .replace(/\/c[\d.]+\//g, '/')
    .replace(/\/e\d+\//g, '/')
    .replace(/\/\/+/g, '/');
};

const buildDedupKey = (rawUrl, thumb) => {
  // JWT proxy URL — decode to get real CDN URL
  if (rawUrl.includes('token=')) {
    const cdnUrl = extractJwtCdnUrl(rawUrl);
    if (cdnUrl) {
      try {
        const assetId = extractInstagramAssetId(new URL(cdnUrl).pathname);
        console.log(`🔑 dedupKey (jwt): ${assetId}`);
        return assetId;
      } catch (_) {}
    }
  }

  // Direct CDN URL or decoded proxy URL
  const decoded = decodeCdnUrl(rawUrl);
  const target  = (decoded && decoded !== rawUrl && decoded.startsWith('http')) ? decoded : rawUrl;
  try {
    const assetId = extractInstagramAssetId(new URL(target).pathname);
    if (assetId && assetId.length > 5) {
      console.log(`🔑 dedupKey (cdn): ${assetId}`);
      return assetId;
    }
  } catch (_) {}

  return thumb ? `${thumb}::${rawUrl}` : rawUrl;
};

const deduplicateByBestQuality = (items) => {
  const groups = new Map();
  items.forEach((item) => {
    const rawUrl = pickBestUrl(item.url || item.download || item.src || '');
    const thumb  = item.thumbnail || item.cover || item.image || '';
    if (!rawUrl) return;
    const key   = buildDedupKey(rawUrl, thumb);
    const score = qualityScore(item.quality || item.resolution || '');
    const existing = groups.get(key);
    if (!existing || score > existing._score) {
      groups.set(key, { ...item, url: rawUrl, _score: score });
    }
  });
  const result = Array.from(groups.values()).map(({ _score, ...item }, index) => ({
    ...item, index,
  }));
  console.log(`🔑 dedup: ${items.length} raw → ${result.length} unique`);
  return result;
};

// ─────────────────────────────────────────────────────────────────────────────
// JWT TYPE DETECTION
// ─────────────────────────────────────────────────────────────────────────────

const detectTypeFromJwtUrl = (tokenUrl) => {
  try {
    const m = tokenUrl.match(/[?&]token=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]*)/);
    if (!m) return null;
    const payload = JSON.parse(Buffer.from(m[2], 'base64url').toString('utf8'));
    const origUrl  = (payload.url || payload.u || payload.src || '').toLowerCase();
    if (!origUrl) return null;
    if (origUrl.match(/\.(mp4|mov|webm|mkv|avi|ts)(\?|#|$)/))        return 'video';
    if (origUrl.match(/\.(jpg|jpeg|png|gif|webp|heic|avif)(\?|#|$)/)) return 'image';
    if (origUrl.includes('scontent') || origUrl.includes('cdninstagram')) {
      if (origUrl.match(/\/t50\./)) return 'video';
      if (origUrl.match(/\/t51\./)) return 'image';
      // o1/v/ pattern is always video
      if (origUrl.includes('/o1/v/') || origUrl.includes('/t16/')) return 'video';
    }
  } catch (e) { console.warn('🔑 JWT decode error:', e.message); }
  return null;
};

// ─────────────────────────────────────────────────────────────────────────────
// THUMBNAIL VALIDATION
// ─────────────────────────────────────────────────────────────────────────────

const decodeThumbnailJwtUrl = (thumbUrl) => {
  if (!thumbUrl || !thumbUrl.includes('token=')) return null;
  return extractJwtCdnUrl(thumbUrl);
};

const isThumbnailValidForType = (thumbUrl, mediaType) => {
  if (!thumbUrl || mediaType !== 'video') return true;
  const cdnUrl = decodeThumbnailJwtUrl(thumbUrl);
  if (!cdnUrl) return true;
  const lower = cdnUrl.toLowerCase();
  if (lower.includes('/t51.')) {
    console.log('🖼 Thumbnail mismatch: video item has image thumbnail (t51) → clearing');
    return false;
  }
  if (lower.match(/\.(jpg|jpeg|png|gif|webp)(\?|$)/) && !lower.includes('/t50.')) {
    if (!lower.includes('cdninstagram') && !lower.includes('scontent')) return true;
    console.log('🖼 Thumbnail mismatch: video item has .jpg thumbnail from image CDN → clearing');
    return false;
  }
  return true;
};

// ─────────────────────────────────────────────────────────────────────────────
// NORMALIZE MEDIA ITEM
// Key fix: image items use their own URL as thumbnail (always correct).
//          video items use scraper-supplied thumbnail only if it passes validation.
// ─────────────────────────────────────────────────────────────────────────────

const normalizeMediaItem = (item, index, fallbackThumbnail = PLACEHOLDER_THUMBNAIL) => {
  const rawUrl = pickBestUrl(item.url || item.download || item.src || '');
  const url    = rawUrl;
  const cdnUrl = decodeCdnUrl(rawUrl) || rawUrl;

  // ── type detection ─────────────────────────────────────────────────────────
  let type = '';
  const rawType = (item.type || '').toString().toLowerCase();
  if (rawType === 'video' || rawType === 'image') {
    type = rawType;
  } else {
    type = detectTypeFromUrl(cdnUrl) || detectTypeFromJwtUrl(rawUrl) || 'video';
  }

  // ── thumbnail ──────────────────────────────────────────────────────────────
  // Image items: ALWAYS use the download URL as the thumbnail.
  // Never trust scraper-provided thumbnails for image items — igdl sets the
  // same post cover /thumb token on every carousel item, so all previews would
  // show item[0]'s image.  The download URL IS the image, so it is always the
  // correct per-item preview.
  //
  // Video items: use scraper-supplied thumbnail only if it actually points to a
  // video thumbnail; otherwise fall back to placeholder.
  let thumbnail;
  if (type === 'image') {
    thumbnail = url;
  } else {
    const rawThumb = item.thumbnail || item.cover || item.image || '';
    thumbnail = isThumbnailValidForType(rawThumb, 'video')
      ? (rawThumb || fallbackThumbnail)
      : fallbackThumbnail;
  }

  return { url, thumbnail, type, quality: item.quality || item.resolution || 'Original Quality', index };
};

// ===== FACEBOOK DATA NORMALISER =====

const normaliseFacebookData = (raw) => {
  console.log('📘 FB normalise — keys:', Object.keys(raw || {}));
  if (raw && Array.isArray(raw.data)  && raw.data.length  > 0) return raw;
  if (raw && Array.isArray(raw.media) && raw.media.length > 0) return raw;
  if (Array.isArray(raw) && raw.length > 0 && (raw[0]?.url || raw[0]?.resolution)) {
    return { data: raw, title: 'Facebook Video', thumbnail: raw[0]?.thumbnail || '' };
  }
  const sdUrl = raw?.sd || raw?.SD || '';
  const hdUrl = raw?.hd || raw?.HD || '';
  if (sdUrl || hdUrl) {
    const variants = [];
    if (hdUrl) variants.push({ resolution: '720p (HD)', url: hdUrl, thumbnail: raw?.thumbnail || '' });
    if (sdUrl) variants.push({ resolution: '360p (SD)', url: sdUrl, thumbnail: raw?.thumbnail || '' });
    return { data: variants, title: raw?.title || 'Facebook Video', thumbnail: raw?.thumbnail || '' };
  }
  const directUrl = raw?.url || raw?.download || raw?.video || raw?.videoUrl || '';
  if (directUrl) {
    return {
      data:      [{ resolution: 'Best Quality', url: directUrl, thumbnail: raw?.thumbnail || '' }],
      title:     raw?.title || 'Facebook Video',
      thumbnail: raw?.thumbnail || '',
    };
  }
  return raw;
};

// ===== PLATFORM-SPECIFIC DOWNLOADERS =====

const platformDownloaders = {

  // ─── INSTAGRAM ───────────────────────────────────────────────────────────
  // Three parallel scrapers:
  //   1. facebookInstaService (snapsave → snapinsta)  — best quality when available
  //   2. igdl (btch-downloader)                        — reliable but duplicates
  //   3. scrapeInstaEmbed (Instagram embed page)       — always works from any IP
  //
  // Priority: snapsave > igdl > embed
  // If snapsave/igdl both fail we fall through to embed which is the reliable floor.
  async instagram(url) {
    let snapsResult = null, igdlResult  = null, embedResult = null;
    let snapsErr    = null, igdlErr     = null, embedErr    = null;

    await Promise.allSettled([
      downloadWithTimeout(() => facebookInsta(url), 35000)
        .then(d  => { snapsResult = d; })
        .catch(e => {
          snapsErr = e instanceof Error ? e : new Error(String(e));
          console.warn('⚠️ snapsave error:', snapsErr.message);
        }),

      downloadWithTimeout(() => igdl(url), 30000)
        .then(d  => {
          if (!d) {
            igdlErr = new Error('igdl resolved with null/undefined');
          } else {
            igdlResult = d;
          }
        })
        .catch(e => {
          igdlErr = e instanceof Error ? e : new Error(String(e));
          console.warn('⚠️ igdl error:', igdlErr.message);
        }),

      downloadWithTimeout(() => scrapeInstaEmbed(url), 20000)
        .then(d  => { embedResult = d; })
        .catch(e => {
          embedErr = e instanceof Error ? e : new Error(String(e));
          console.warn('⚠️ instaEmbed error:', embedErr.message);
        }),
    ]);

    // ── normalise each scraper's raw output to an array of items ──────────
    const extractItems = (res) => {
      if (!res) return null;
      if (Array.isArray(res))           return res.length > 0 ? res        : null;
      if (Array.isArray(res.data))      return res.data.length   > 0 ? res.data   : null;
      if (Array.isArray(res.result))    return res.result.length > 0 ? res.result : null;
      if (Array.isArray(res.media))     return res.media.length  > 0 ? res.media  : null;
      if (res.status === true && Array.isArray(res.data))
        return res.data.length > 0 ? res.data : null;
      if (res.url || res.download)      return [res];
      return null;
    };

    const snapsItems = extractItems(snapsResult);
    const igdlItems  = extractItems(igdlResult);
    // embed already returns an array or null
    const embedItems = Array.isArray(embedResult) && embedResult.length > 0 ? embedResult : null;

    console.log(
      `📸 Instagram scrapers: snapsave=${snapsItems?.length ?? 'null'}` +
      `  igdl=${igdlItems?.length ?? 'null'}` +
      `  embed=${embedItems?.length ?? 'null'}`
    );

    if (!snapsItems && !igdlItems && !embedItems) {
      throw new Error(
        'Instagram: all scrapers failed. ' +
        `snapsave: ${snapsErr?.message ?? 'null'}  ` +
        `igdl: ${igdlErr?.message ?? 'null'}  ` +
        `embed: ${embedErr?.message ?? 'null'}`
      );
    }

    // Prefer snapsave (richest metadata), then igdl, then embed
    if (snapsItems?.length > 0) {
      console.log('📸 Using snapsave');
      return { _items: snapsItems, _source: 'snapsave' };
    }
    if (igdlItems?.length > 0) {
      console.log('📸 Using igdl');
      return { _items: igdlItems, _source: 'igdl' };
    }
    console.log('📸 Using instaEmbed fallback');
    return { _items: embedItems, _source: 'embed' };
  },

  // ─── TIKTOK ───────────────────────────────────────────────────────────────
  // Layered chain: tikwm (with retry) → ssstik → musicaldown → ttdl.
  // See Services/tiktokService.js for details.
  //
  // NOTE: req is stashed on the data object so the formatter can wrap CDN URLs
  // in the proxy. TikTok CDN URLs are IP/region-bound and reject direct client
  // requests — the server has to fetch them and stream to the app.
  async tiktok(url, req) {
    const data = await downloadWithTimeout(() => downloadTikTok(url), 35000);
    data._req = req;
    return data;
  },

  // ─── FACEBOOK ─────────────────────────────────────────────────────────────
  async facebook(url, req) {
    const raw = await downloadWithTimeout(() => facebookInsta(url), 60000);
    if (!raw) throw new Error('Facebook: no data returned');
    const data = normaliseFacebookData(raw);
    data._req  = req;
    const hasUrl =
      (Array.isArray(data?.data)  && data.data.some(v  => v?.url)) ||
      (Array.isArray(data?.media) && data.media.some(v => v?.url)) ||
      data?.url || data?.sd || data?.hd;
    if (!hasUrl) {
      console.error('📘 Facebook: no URL in normalised data:', JSON.stringify(data).slice(0, 300));
      throw new Error('Facebook: could not extract a download URL');
    }
    return data;
  },

  async twitter(url) {
    try {
      const data = await downloadWithTimeout(() => twitter(url));
      const hasValidData = data.data && (data.data.HD || data.data.SD);
      const hasValidUrls = Array.isArray(data.url) &&
        data.url.some(item => item && Object.keys(item).length > 0 && item.url);
      if (!hasValidData && !hasValidUrls)
        throw new Error('Twitter primary service returned unusable data');
      return data;
    } catch (error) {
      console.warn('Twitter: Primary service failed, trying custom service...', error.message);
      const fallbackData = await downloadWithTimeout(() => downloadTwmateData(url));
      if (!fallbackData || (!Array.isArray(fallbackData) && !fallbackData.data))
        throw new Error('Twitter download failed - both primary and fallback methods failed');
      return fallbackData;
    }
  },

  async youtube(url, req) {
    console.log('YouTube: Processing URL:', url);
    try {
      const timeout = url.includes('/shorts/') ? 30000 : 60000;
      const data    = await downloadWithTimeout(() => fetchYouTubeData(url), timeout);
      if (!data || !data.title) throw new Error('YouTube service returned invalid data');
      console.log('YouTube: Successfully fetched data, formats count:', data.formats?.length || 0);
      if (data.formats) {
        const serverBaseUrl = getServerBaseUrl(req);
        data.formats.forEach(format => {
          if (format.url && format.url.startsWith('MERGE:')) {
            const parts = format.url.split(':');
            if (parts.length >= 3) {
              format.url = `${serverBaseUrl}/api/merge-audio?videoUrl=${encodeURIComponent(parts[1])}&audioUrl=${encodeURIComponent(parts[2])}`;
            }
          }
        });
        if (data.url && data.url.startsWith('MERGE:')) {
          const parts = data.url.split(':');
          if (parts.length >= 3)
            data.url = `${serverBaseUrl}/api/merge-audio?videoUrl=${encodeURIComponent(parts[1])}&audioUrl=${encodeURIComponent(parts[2])}`;
        }
      }
      return data;
    } catch (error) {
      if (error.message.includes('Status code: 410'))
        throw new Error('YouTube video not available (removed or private)');
      if (error.message.includes('Status code: 403'))
        throw new Error('YouTube video access forbidden (age-restricted or region-locked)');
      if (error.message.includes('Status code: 404'))
        throw new Error('YouTube video not found (invalid URL or removed)');
      if (error.message.includes('timeout'))
        throw new Error('YouTube download timed out - video processing may be slow, please try again');
      throw new Error(`YouTube download failed: ${error.message}`);
    }
  },

  async pinterest(url) {
    try {
      const data = await downloadWithTimeout(() => pindl(url));
      if (!data || (!data.data && !data.result && !data.url))
        throw new Error('Pinterest service returned invalid data');
      return data;
    } catch (error) {
      console.warn('Pinterest primary downloader failed, trying fallback...', error.message);
      const fallbackData = await downloadWithTimeout(() => pinterest(url));
      if (!fallbackData || (!fallbackData.data && !fallbackData.result))
        throw new Error('Pinterest download failed - both primary and fallback methods failed');
      return fallbackData;
    }
  },

  async threads(url) {
    console.log('🧵 Threads: Starting download with advanced service');
    try {
      const data = await downloadWithTimeout(() => advancedThreadsDownloader(url), 60000);
      const hasMedia = data && (
        data.download || data.url ||
        (Array.isArray(data.items) && data.items.length > 0)
      );
      if (!hasMedia) {
        console.error('🧵 Threads raw data:', JSON.stringify(data).slice(0, 500));
        throw new Error('Threads service returned invalid data');
      }
      console.log('✅ Threads: data ok — items:', data.items?.length ?? 'none',
                  'download:', !!data.download, 'url:', !!data.url);
      return data;
    } catch (error) {
      console.error(`❌ Threads download failed: ${error.message}`);
      throw new Error(`Threads download failed: ${error.message}`);
    }
  },

  async linkedin(url) {
    const data = await downloadWithTimeout(() => fetchLinkedinData(url));
    if (!data || !data.data) throw new Error('LinkedIn service returned invalid data');
    return data;
  }
};

// ===== DATA FORMATTERS =====

const dataFormatters = {

  // ─── INSTAGRAM ────────────────────────────────────────────────────────────
  instagram(data) {
    console.log('📸 Instagram formatter: keys=', Object.keys(data || {}));

    let rawItems  = null;
    let postTitle = 'Instagram Post';

    if (data._items && Array.isArray(data._items)) {
      rawItems  = data._items;
      postTitle = data._title || postTitle;
    } else if (Array.isArray(data)) {
      rawItems  = data;
      postTitle = data[0]?.title || postTitle;
    } else if (Array.isArray(data.result)) {
      rawItems  = data.result;
    } else if (Array.isArray(data.data)) {
      rawItems  = data.data;
      postTitle = data.title || postTitle;
    } else if (Array.isArray(data.media)) {
      rawItems  = data.media;
      postTitle = data.title || postTitle;
    } else {
      const resolvedUrl = decodeCdnUrl(pickBestUrl(data.url || ''));
      console.log('📸 Instagram: single item fallback, url=', resolvedUrl.slice(0, 80));
      return {
        title:     data.title || postTitle,
        url:       resolvedUrl,
        thumbnail: data.thumbnail || PLACEHOLDER_THUMBNAIL,
        sizes:     ['Best Quality'],
        source:    'instagram',
      };
    }

    console.log(`📸 Instagram raw items (${rawItems.length}):`);
    rawItems.slice(0, 5).forEach((item, i) => {
      const u = item?.url || item?.download || '';
      const t = item?.thumbnail || '';
      console.log(`  raw[${i}] type=${item?.type ?? 'none'} url=${String(u).slice(0, 100)} thumb=${String(t).slice(0, 70)}`);
    });
    if (rawItems.length > 5) console.log(`  ... (${rawItems.length - 5} more)`);

    const validItems  = rawItems.filter(item => item && (item.url || item.download));
    const uniqueItems = deduplicateByBestQuality(validItems);

    // Safety cap — if dedup still gives us more than MAX_CAROUSEL_ITEMS
    // something is wrong; cap and log.
    const cappedItems = uniqueItems.length > MAX_CAROUSEL_ITEMS
      ? (console.warn(`📸 Capping ${uniqueItems.length} items to ${MAX_CAROUSEL_ITEMS}`), uniqueItems.slice(0, MAX_CAROUSEL_ITEMS))
      : uniqueItems;

    const mediaItems = cappedItems.map((item, index) =>
      normalizeMediaItem(item, index, item.thumbnail || PLACEHOLDER_THUMBNAIL)
    );

    console.log(`📸 Instagram: ${rawItems.length} raw → ${mediaItems.length} final`);
    mediaItems.forEach((it, i) =>
      console.log(`  [${i}] type=${it.type} url=${String(it.url).slice(0, 100)}`)
    );

    if (mediaItems.length === 0) throw new Error('Instagram returned no usable media items');

    const first = mediaItems[0];
    return {
      title:     postTitle,
      url:       first.url,
      thumbnail: first.thumbnail,
      sizes:     ['Best Quality'],
      source:    'instagram',
      ...(mediaItems.length > 1 && { mediaItems }),
    };
  },

  // ─── TIKTOK ───────────────────────────────────────────────────────────────
  // Every TikTok CDN URL is wrapped in the server's /api/proxy-download route.
  // Direct downloads from tiktokcdn-us.com fail on mobile clients because the
  // CDN checks IP/region and often expects a Referer header — the proxy
  // bypasses all of that by having the server fetch and stream the file.
  tiktok(data) {
    console.log('🎵 TikTok: keys=', Object.keys(data || {}),
                'images len=', data.images?.length ?? 0,
                'has video=', !!(data.video), 'has audio=', !!(data.audio));

    const req        = data._req || null;
    const serverBase = req ? getServerBaseUrl(req) : '';
    const title      = data.title || 'TikTok Post';

    // Wrap any CDN URL in the proxy so the SERVER fetches it (not the client).
    // No-op when the URL is already proxied or when we can't compute serverBase
    // (e.g. unit tests with no req).
    const proxy = (cdnUrl) => {
      if (!cdnUrl) return '';
      if (cdnUrl.includes('/api/proxy-download')) return cdnUrl;
      if (!serverBase) return cdnUrl;
      return wrapForProxy(cdnUrl, 'tiktok', title, serverBase);
    };

    if (data.images && Array.isArray(data.images) && data.images.length > 0) {
      console.log(`🎵 TikTok: slideshow ${data.images.length} item(s)`);

      const extractUrl = (entry) => {
        if (typeof entry === 'string') return entry;
        if (entry && typeof entry === 'object')
          return entry.url || entry.download || entry.src || entry.image_url || entry.display_url || '';
        return '';
      };

      const mediaItems = data.images
        .map(extractUrl)
        .filter(u => u && u.startsWith('http'))
        .map((imgUrl, index) => ({
          url:       proxy(imgUrl),
          thumbnail: imgUrl, // raw CDN URL is fine for thumbnails (just for display)
          type:      'image',
          quality:   'Original Quality',
          index,
        }));

      console.log(`🎵 TikTok: ${mediaItems.length} valid image URL(s) extracted`);

      if (mediaItems.length > 0) {
        const first = mediaItems[0];
        return {
          title,
          url:              first.url,
          thumbnail:        data.thumbnail || first.thumbnail || PLACEHOLDER_THUMBNAIL,
          sizes:            ['Original Quality'],
          audio:            proxy(pickBestUrl(data.audio) || ''),
          source:           'tiktok',
          isImageSlideshow: true,
          ...(mediaItems.length > 1 && { mediaItems }),
        };
      }
      console.warn('🎵 TikTok: images array had no valid URLs, falling through to video');
    }

    const bestVideoUrl = pickBestUrl(data.video);
    console.log('🎵 TikTok: video post url=', String(bestVideoUrl).slice(0, 80));
    return {
      title,
      url:       proxy(bestVideoUrl),
      thumbnail: data.thumbnail || PLACEHOLDER_THUMBNAIL,
      sizes:     ['Best Quality'],
      audio:     proxy(pickBestUrl(data.audio) || ''),
      source:    'tiktok',
    };
  },

  // ─── FACEBOOK ─────────────────────────────────────────────────────────────
  facebook(data) {
    console.log('📘 FB formatter — keys:', Object.keys(data || {}));

    const req        = data._req || null;
    const serverBase = req ? getServerBaseUrl(req) : '';
    const title      = data.title || 'Facebook Video';

    const resolveMetaUrl = (raw) => {
      if (!raw) return '';

      // Always attempt JWT decode first. Both relative (/render.php?token=…)
      // and absolute (https://d.rapidcdn.app/v2?token=…) URLs can wrap a real
      // fbcdn URL inside a JWT — the proxy works much better against the
      // inner fbcdn URL directly than against the rapidcdn middleman, which
      // adds its own IP/UA checks on top of Facebook's.
      try {
        const m = raw.match(/[?&]token=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]*)/);
        if (m) {
          const b64     = m[2].replace(/-/g, '+').replace(/_/g, '/');
          const pad     = b64 + '='.repeat((4 - b64.length % 4) % 4);
          const payload = JSON.parse(Buffer.from(pad, 'base64').toString('utf8'));
          const realUrl = payload.video_url || payload.url || payload.u || '';
          if (realUrl && realUrl.startsWith('http')) {
            console.log(`📘 FB JWT decoded → ${realUrl.slice(0, 80)}…`);
            return realUrl;
          }
        }
      } catch (e) { console.warn(`📘 FB JWT decode failed: ${e.message}`); }

      // No JWT (or decode failed) — return absolute URLs as-is, prefix
      // relative ones onto metadownloader.
      if (raw.startsWith('http')) return raw;
      return `https://metadownloader.com${raw.startsWith('/') ? raw : '/' + raw}`;
    };

    const fbQualityScore = (r = '') => {
      const s = r.toLowerCase();
      if (s.includes('1080'))                    return 5;
      if (s.includes('720') || s.includes('hd')) return 4;
      if (s.includes('480'))                     return 3;
      if (s.includes('360') || s.includes('sd')) return 2;
      return 1;
    };

    const proxy = (cdnUrl) => {
      if (!cdnUrl) return '';
      if (cdnUrl.includes('/api/proxy-download')) return cdnUrl;
      const realUrl = resolveMetaUrl(cdnUrl);
      if (!realUrl) return '';
      if (serverBase) return wrapForProxy(realUrl, 'facebook', title, serverBase);
      return realUrl;
    };

    if (data && Array.isArray(data.media) && data.media.length > 0) {
      const valid = data.media.filter(i => i?.url);
      if (!valid.length) throw new Error('Facebook media array has no valid URLs');
      const best = valid.find(i => i.type === 'video') || valid[0];
      return {
        title,
        url:       proxy(best.url),
        thumbnail: data.thumbnail || best.thumbnail || PLACEHOLDER_THUMBNAIL,
        sizes:     valid.map(i => i.quality || i.resolution || 'Original Quality'),
        source:    'facebook',
        type:      'video',
      };
    }

    const fbData = data?.data || [];
    if (Array.isArray(fbData) && fbData.length > 0) {
      const sorted = [...fbData].sort((a, b) =>
        fbQualityScore(b.resolution || b.quality || '') -
        fbQualityScore(a.resolution || a.quality || '')
      );
      const best   = sorted[0];
      const rawUrl = best?.url || '';
      console.log(`📘 FB data-array: best resolution=${best?.resolution} url=${rawUrl.slice(0, 80)}`);
      return {
        title,
        url:       proxy(rawUrl),
        thumbnail: best?.thumbnail || data.thumbnail || PLACEHOLDER_THUMBNAIL,
        sizes:     fbData.map(v => v.resolution || v.quality || 'Unknown'),
        source:    'facebook',
        type:      'video',
      };
    }

    const fallback = data?.url || data?.download || data?.video || data?.videoUrl || '';
    if (fallback) {
      return {
        title,
        url:       proxy(fallback),
        thumbnail: data?.thumbnail || PLACEHOLDER_THUMBNAIL,
        sizes:     ['Best Quality'],
        source:    'facebook',
        type:      'video',
      };
    }

    throw new Error('Facebook formatter: no usable URL found in data');
  },

  twitter(data) {
    if (data.data && (data.data.HD || data.data.SD)) {
      return {
        title:     'Twitter Video',
        url:       data.data.HD || data.data.SD || '',
        thumbnail: PLACEHOLDER_THUMBNAIL,
        sizes:     data.data.HD ? ['HD', 'SD'] : ['SD'],
        source:    'twitter',
      };
    }
    if (data.url && Array.isArray(data.url)) {
      const videoArray  = data.url.filter(item => item && item.url);
      const bestQuality = videoArray.find(item => item.quality?.includes('1280x720')) ||
                          videoArray.find(item => item.quality?.includes('640x360'))  ||
                          videoArray[0];
      return {
        title:     'Twitter Video',
        url:       bestQuality.url || '',
        thumbnail: PLACEHOLDER_THUMBNAIL,
        sizes:     videoArray.map(item => item.quality),
        source:    'twitter',
      };
    }
    if (Array.isArray(data) && data.length > 0) {
      const bestQuality = data.find(item => item.quality.includes('1280x720')) ||
                          data.find(item => item.quality.includes('640x360'))  ||
                          data[0];
      return {
        title:     'Twitter Video',
        url:       bestQuality.url || '',
        thumbnail: PLACEHOLDER_THUMBNAIL,
        sizes:     data.map(item => item.quality),
        source:    'twitter',
      };
    }
    throw new Error('Twitter video data is incomplete or improperly formatted.');
  },

  youtube(data, req) {
    console.log('🎬 Formatting YouTube data...');
    if (!data || !data.title) throw new Error('Invalid YouTube data received');

    const hasFormats    = data.formats    && data.formats.length    > 0;
    const hasAllFormats = data.allFormats && data.allFormats.length > 0;

    let qualityOptions  = [];
    let selectedQuality = null;
    let defaultUrl      = data.url;

    if (hasFormats || hasAllFormats) {
      qualityOptions  = data.formats || data.allFormats;
      selectedQuality = qualityOptions.find(opt => opt.quality?.includes('360p')) || qualityOptions[0];
      defaultUrl      = selectedQuality?.url || data.url;

      const serverBaseUrl = getServerBaseUrl(req);
      qualityOptions.forEach(format => {
        if (format.url && format.url.startsWith('MERGE:')) {
          const parts = format.url.split(':');
          if (parts.length >= 3)
            format.url = `${serverBaseUrl}/api/merge-audio?videoUrl=${encodeURIComponent(parts[1])}&audioUrl=${encodeURIComponent(parts[2])}`;
        }
      });
      if (selectedQuality?.url?.startsWith('MERGE:')) {
        const parts = selectedQuality.url.split(':');
        if (parts.length >= 3) {
          selectedQuality.url = `${serverBaseUrl}/api/merge-audio?videoUrl=${encodeURIComponent(parts[1])}&audioUrl=${encodeURIComponent(parts[2])}`;
          defaultUrl = selectedQuality.url;
        }
      }
    } else {
      qualityOptions = [{
        quality: '360p', qualityNum: 360, url: data.url,
        type: 'video/mp4', extension: 'mp4', isPremium: false, hasAudio: true
      }];
      selectedQuality = qualityOptions[0];
    }

    return {
      title:           data.title,
      url:             defaultUrl,
      thumbnail:       data.thumbnail || PLACEHOLDER_THUMBNAIL,
      sizes:           qualityOptions.map(f => f.quality),
      duration:        data.duration || 'unknown',
      source:          'youtube',
      formats:         qualityOptions,
      allFormats:      qualityOptions,
      selectedQuality: selectedQuality
    };
  },

  threads(data) {
    console.log('🧵 Processing Threads data, keys:', Object.keys(data || {}));

    if (data.items && Array.isArray(data.items) && data.items.length > 0) {
      const mediaItems = data.items
        .filter(item => item && (item.download || item.url || item.video_url || item.image_url ||
                                  item.display_url || item.image_versions))
        .map((item, index) => {
          const itemUrl =
            item.download || item.url || item.video_url || item.image_url ||
            item.display_url ||
            item.image_versions?.candidates?.[0]?.url ||
            item.image_versions?.[0]?.url || '';
          const itemThumb =
            item.thumbnail || item.cover || item.image_url || item.display_url ||
            item.image_versions?.candidates?.[0]?.url ||
            item.image_versions?.[0]?.url || data.thumbnail || PLACEHOLDER_THUMBNAIL;
          const isVideo  = !!(item.video_url || item.download?.includes('.mp4'));
          const itemType = item.type ||
            (item.media_type === 2 || item.media_type === '2' ? 'video' :
             item.media_type === 1 || item.media_type === '1' ? 'image' :
             isVideo ? 'video' : 'image');
          return { url: itemUrl, thumbnail: itemThumb, type: itemType,
                   quality: item.quality || 'Best Available', index };
        })
        .filter(item => item.url);

      if (mediaItems.length > 0) {
        const first = mediaItems[0];
        return {
          title:     data.title || 'Threads Post',
          url:       first.url,
          thumbnail: data.thumbnail || first.thumbnail || PLACEHOLDER_THUMBNAIL,
          sizes:     ['Best Available'],
          source:    'threads',
          metadata:  data.metadata || {},
          ...(mediaItems.length > 1 && { mediaItems }),
        };
      }
    }

    return {
      title:     data.title || 'Threads Post',
      url:       data.download || data.url || '',
      thumbnail: data.thumbnail || PLACEHOLDER_THUMBNAIL,
      sizes:     [data.quality || 'Best Available'],
      source:    'threads',
      metadata:  data.metadata || {}
    };
  },

  pinterest(data) {
    const pinterestData = data?.data || data;
    return {
      title:     'Pinterest Image',
      url:       pinterestData.result || pinterestData.url || '',
      thumbnail: pinterestData.result || pinterestData.url || PLACEHOLDER_THUMBNAIL,
      sizes:     ['Original Quality'],
      source:    'pinterest',
    };
  },

  linkedin(data) {
    const videoUrl = Array.isArray(data?.data?.videos) && data.data.videos.length > 0
      ? data.data.videos[0] : '';
    return {
      title:     'LinkedIn Video',
      url:       videoUrl,
      thumbnail: videoUrl ? PLACEHOLDER_THUMBNAIL : 'Error',
      sizes:     ['Original Quality'],
      source:    'linkedin',
    };
  }
};

const formatData = async (platform, data, req) => {
  const formatter = dataFormatters[platform];
  if (!formatter) {
    return {
      title:     data.title     || 'Untitled Media',
      url:       data.url       || '',
      thumbnail: data.thumbnail || PLACEHOLDER_THUMBNAIL,
      sizes:     data.sizes?.length > 0 ? data.sizes : ['Original Quality'],
      source:    platform,
    };
  }
  if (platform === 'youtube') return formatter(data, req);
  return formatter(data);
};

// ===== MAIN CONTROLLER =====

const downloadMedia = async (req, res) => {
  const { url } = req.body;
  console.log('Received URL:', url);

  try {
    const urlValidation = validateUrl(url);
    if (!urlValidation.isValid) {
      return res.status(400).json({ error: urlValidation.error, success: false });
    }

    const cleanedUrl = urlValidation.cleanedUrl;
    const platform   = identifyPlatform(cleanedUrl);

    if (!platform) {
      return res.status(400).json({
        error: 'Unsupported platform', success: false,
        supportedPlatforms: SUPPORTED_PLATFORMS
      });
    }

    let processedUrl = cleanedUrl;
    if (platform === 'youtube') {
      processedUrl = normalizeYouTubeUrl(cleanedUrl);
      console.log(`YouTube URL processed: ${cleanedUrl} -> ${processedUrl}`);
    }

    console.log(`Platform Identification: Determining the platform for the given URL.`);
    console.log(`Download Media: Fetching data for platform '${platform}'.`);

    const downloader = platformDownloaders[platform];
    if (!downloader) throw new Error(`No downloader available for platform: ${platform}`);

    const data = (platform === 'youtube' || platform === 'facebook' || platform === 'tiktok')
      ? await downloader(processedUrl, req)
      : await downloader(processedUrl);

    if (!data) {
      return res.status(404).json({ error: 'No data found for this URL', success: false, platform });
    }

    console.log(`Data Formatting: Formatting data for platform '${platform}'.`);

    let formattedData;
    try {
      formattedData = await formatData(platform, data, req);
    } catch (formatError) {
      console.error(`Download Media: Data formatting failed - ${formatError.message}`);
      return res.status(500).json({
        error: 'Failed to format media data', success: false,
        details: formatError.message, platform
      });
    }

    if (!formattedData || !formattedData.url) {
      return res.status(500).json({
        error: 'Invalid media data - no download URL found', success: false, platform
      });
    }

    const hasMultiple = formattedData.mediaItems && formattedData.mediaItems.length > 1;
    console.log(`Final ${platform} URL length:`, formattedData.url.length);
    console.log(`Media items: ${formattedData.mediaItems?.length || 1}`);
    if (platform === 'youtube') {
      const mergeFormats = formattedData.formats?.filter(f => f.url?.includes('/api/merge-audio')) || [];
      console.log(`🎵 Merge formats available: ${mergeFormats.length}`);
    }

    console.log(`Download Media: Media successfully downloaded and formatted.`);

    res.status(200).json({
      success:   true,
      data:      formattedData,
      platform:  platform,
      timestamp: new Date().toISOString(),
      debug: {
        originalUrl:      url,
        cleanedUrl:       cleanedUrl,
        processedUrl:     processedUrl,
        hasValidUrl:      !!formattedData.url,
        finalUrlLength:   formattedData.url ? formattedData.url.length : 0,
        hasMultipleItems: hasMultiple,
        mediaItemsCount:  formattedData.mediaItems?.length || 1,
        hasFormats:       !!formattedData.formats,
        formatsCount:     formattedData.formats?.length || 0,
      }
    });

  } catch (error) {
    console.error(`Download Media: Error occurred - ${error.message}`);
    console.error('Error stack:', error.stack);

    const failedPlatform = identifyPlatform(url) || 'unknown';

    // Fire-and-forget Telegram alert. The service handles dedup + rate-limit
    // internally and will never throw, so we don't await or try/catch here.
    telegram.notifyDownloadFailure(failedPlatform, url, error).catch(() => {});

    let statusCode = 500;
    if (error.message.includes('not available') || error.message.includes('not found')) statusCode = 404;
    else if (error.message.includes('forbidden') || error.message.includes('access'))   statusCode = 403;
    else if (error.message.includes('timeout'))                                           statusCode = 408;

    res.status(statusCode).json({
      error:       'Failed to download media',
      success:     false,
      details:     error.message,
      platform:    failedPlatform,
      timestamp:   new Date().toISOString(),
      suggestions: getErrorSuggestions(error.message, failedPlatform)
    });
  }
};

const getErrorSuggestions = (errorMessage, platform) => {
  const suggestions = [];
  if (platform === 'instagram') {
    suggestions.push('Ensure the post is public and not from a private account');
    suggestions.push('Stories and highlights are not supported — only posts and reels');
    suggestions.push('Some sponsored/ad posts cannot be downloaded');
  }
  if (platform === 'threads') {
    suggestions.push('Ensure the Threads post contains video content (not just images or text)');
    suggestions.push('Check if the post is public and not deleted');
  }
  if (platform === 'youtube' && errorMessage.includes('timeout')) {
    suggestions.push('YouTube videos may take longer to process — please try again');
    suggestions.push('Check your frontend code to ensure it waits for the full response');
  }
  return suggestions;
};

module.exports = { downloadMedia };