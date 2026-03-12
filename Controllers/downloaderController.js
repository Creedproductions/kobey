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

const bitly = new BitlyClient(config.BITLY_ACCESS_TOKEN);

// ===== CONSTANTS =====
const SUPPORTED_PLATFORMS = [
  'instagram', 'tiktok', 'facebook', 'twitter',
  'youtube', 'pinterest', 'threads', 'linkedin'
];

const PLACEHOLDER_THUMBNAIL = 'https://via.placeholder.com/300x150';
const DOWNLOAD_TIMEOUT = 45000;

// ===== UTILITY FUNCTIONS =====

const shortenUrl = async (url) => {
  if (!url || url.length < 200) {
    return url;
  }

  try {
    const tinyResponse = await axios.post('https://tinyurl.com/api-create.php', null, {
      params: { url },
      timeout: 5000
    });

    if (tinyResponse.data && tinyResponse.data.startsWith('https://tinyurl.com/')) {
      console.log('URL shortened with TinyURL');
      return tinyResponse.data;
    }
  } catch (error) {
    console.warn('TinyURL shortening failed:', error.message);
  }

  try {
    const isgdResponse = await axios.get('https://is.gd/create.php', {
      params: {
        format: 'simple',
        url: url
      },
      timeout: 5000
    });

    if (isgdResponse.data && isgdResponse.data.startsWith('https://is.gd/')) {
      console.log('URL shortened with is.gd');
      return isgdResponse.data;
    }
  } catch (error) {
    console.warn('is.gd shortening failed:', error.message);
  }

  if (config.BITLY_ACCESS_TOKEN) {
    try {
      const bitlyResponse = await bitly.shorten(url);
      if (bitlyResponse && bitlyResponse.link) {
        console.log('URL shortened with Bitly');
        return bitlyResponse.link;
      }
    } catch (error) {
      console.warn('Bitly shortening failed:', error.message);
    }
  }

  console.log('URL shortening failed, using original URL');
  return url;
};

const identifyPlatform = (url) => {
  console.info("Platform Identification: Determining the platform for the given URL.");

  const platformMap = {
    'instagram.com': 'instagram',
    'tiktok.com': 'tiktok',
    'facebook.com': 'facebook',
    'fb.watch': 'facebook',
    'x.com': 'twitter',
    'twitter.com': 'twitter',
    'youtube.com': 'youtube',
    'youtu.be': 'youtube',
    'pinterest.com': 'pinterest',
    'pin.it': 'pinterest',
    'threads.net': 'threads',
    'threads.com': 'threads',
    'linkedin.com': 'linkedin'
  };

  for (const [domain, platform] of Object.entries(platformMap)) {
    if (url.includes(domain)) {
      return platform;
    }
  }

  console.warn("Platform Identification: Unable to identify the platform.");
  return null;
};

const normalizeYouTubeUrl = (url) => {
  let cleanUrl = url.split('#')[0];

  const shortsRegex = /youtube\.com\/shorts\/([a-zA-Z0-9_-]+)/;
  const shortsMatch = cleanUrl.match(shortsRegex);
  if (shortsMatch) {
    return `https://www.youtube.com/shorts/${shortsMatch[1]}`;
  }

  const shortRegex = /youtu\.be\/([a-zA-Z0-9_-]+)/;
  const shortMatch = cleanUrl.match(shortRegex);
  if (shortMatch) {
    return `https://www.youtube.com/watch?v=${shortMatch[1]}`;
  }

  return cleanUrl;
};

const validateUrl = (url) => {
  if (!url) {
    return { isValid: false, error: 'No URL provided' };
  }

  if (typeof url !== 'string' || url.trim().length === 0) {
    return { isValid: false, error: 'Invalid URL format' };
  }

  const cleanedUrl = url.trim();

  try {
    new URL(cleanedUrl);
  } catch (e) {
    return { isValid: false, error: 'Invalid URL format' };
  }

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

// Helper function to get server base URL
function getServerBaseUrl(req) {
  const host = req.get('host');
  const protocol = req.secure ? 'https' : 'http';
  return process.env.SERVER_BASE_URL || `${protocol}://${host}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// QUALITY HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const qualityScore = (q = '') => {
  const s = String(q).toLowerCase();
  if (s.includes('4k') || s.includes('2160')) return 7;
  if (s.includes('1440') || s.includes('2k'))  return 6;
  if (s.includes('1080') || s.includes('fhd')) return 5;
  if (s.includes('720')  || s === 'hd')        return 4;
  if (s.includes('480'))                        return 3;
  if (s.includes('360'))                        return 2;
  if (s.includes('240') || s.includes('144'))  return 1;
  if (s === 'sd')                               return 1;
  return 0;
};

const pickBestUrl = (rawUrl) => {
  if (Array.isArray(rawUrl)) {
    return rawUrl.find(u => typeof u === 'string' && u.startsWith('http')) || rawUrl[0] || '';
  }
  return rawUrl || '';
};

// ─────────────────────────────────────────────────────────────────────────────
// URL HELPERS — decode proxy links to real CDN URLs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Decode the real CDN URL from scraper proxy links such as:
 *   https://snapsave.app/api/ajaxDownload.php?url=ENCODED&ext=jpg
 *   https://snapinsta.app/api/ajaxDownload.php?url=ENCODED
 *
 * Returns the decoded URL, or the original href if it's already a direct URL.
 */
const decodeCdnUrl = (href) => {
  if (!href) return '';
  try {
    const u = new URL(href);
    for (const param of ['url', 'u', 'src', 'link', 'media']) {
      const val = u.searchParams.get(param);
      if (val && val.startsWith('http')) {
        const decoded = decodeURIComponent(val);
        if (decoded.includes('%3A')) return decodeCdnUrl(decoded); // double-encoded
        return decoded;
      }
    }
  } catch (_) {}
  return href;
};

/**
 * Detect media type from a URL.
 * Works on both direct CDN URLs and proxy URLs (decodes proxy → CDN first).
 */
const detectTypeFromUrl = (url) => {
  if (!url) return null;

  // Try the proxy URL's ext param first (snapsave sets this explicitly)
  try {
    const u   = new URL(url);
    const ext = (u.searchParams.get('ext') || '').toLowerCase();
    if (['mp4', 'mov', 'webm', 'mkv', 'avi', 'ts'].includes(ext)) return 'video';
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'avif'].includes(ext)) return 'image';
  } catch (_) {}

  // Check the URL path extension (strip query string first)
  const pathOnly = url.toLowerCase().split('?')[0];
  if (pathOnly.match(/\.(mp4|mov|webm|mkv|avi|ts)$/))         return 'video';
  if (pathOnly.match(/\.(jpg|jpeg|png|gif|webp|heic|avif)$/))  return 'image';

  // Instagram CDN convention
  if (pathOnly.includes('/t50.'))  return 'video';
  if (pathOnly.includes('/t51.'))  return 'image';
  if (pathOnly.includes('/video/')) return 'video';

  // Decode proxy URL and recurse once
  const decoded = decodeCdnUrl(url);
  if (decoded !== url) return detectTypeFromUrl(decoded);

  return null;
};

// ─────────────────────────────────────────────────────────────────────────────
// DEDUPLICATION
//
// Problem: snapsave returns each carousel asset multiple times as HD/SD/thumb
// variants. Instagram CDN URLs for the same image differ only in the size
// segment embedded in the path, e.g.:
//   HD:    .../v/t51.2885-15/s1080x1080/photo_123.jpg
//   SD:    .../v/t51.2885-15/s640x640/photo_123.jpg
//   Thumb: .../v/t51.2885-15/s320x320/photo_123.jpg
//
// Stripping those size segments leaves the base filename `photo_123.jpg`,
// which is the true identity of the asset. We combine it with the per-item
// thumbnail (which snapsave now provides correctly per row) so that carousel
// slots with different base filenames are kept separate.
//
// This correctly handles both scenarios:
//   A) HD/SD of same asset  → same normalised key → keep highest quality only
//   B) Different carousel items → different filenames → kept as separate entries
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strip Instagram CDN size/crop segments from a URL pathname so that HD, SD,
 * and thumbnail variants of the same asset share the same normalised path.
 *
 * Segments removed (examples):
 *   /s1080x1080/   /s640x640/   /p1080x1350/   /c0.0.1080.1350/   /e35/
 */
const normaliseInstagramPath = (pathname) => {
  return pathname
    // Size segments: /s1080x1080/ or /p640x640/
    .replace(/\/[sp]\d{2,4}x\d{2,4}\//g, '/')
    // Crop segments: /c0.0.1080.1080/
    .replace(/\/c[\d.]+\//g, '/')
    // Encoding hint segments: /e15/ /e35/
    .replace(/\/e\d+\//g, '/')
    // Collapse any double slashes produced above
    .replace(/\/+/g, '/');
};

const deduplicateByBestQuality = (items) => {
  const groups = new Map();

  items.forEach((item) => {
    const rawUrl  = pickBestUrl(item.url || item.download || item.src || '');
    const thumb   = item.thumbnail || item.cover || item.image || '';

    // Decode proxy URL → real CDN URL (snapsave.app/ajaxDownload.php?url=...)
    const realUrl = decodeCdnUrl(rawUrl);

    let key = '';
    try {
      const parsed   = new URL(realUrl);
      const rawPath  = parsed.pathname;

      const isGenericPath = rawPath.length <= 3 ||
        /^\/(v[0-9]?\/?|download\/?|media\/?|proxy\/?|dl\/?|get\/?)$/.test(rawPath);

      if (isGenericPath) {
        // Truly generic proxy path — use thumbnail + full URL so distinct
        // assets don't collapse together
        key = thumb ? `${thumb}::${realUrl}` : realUrl;
      } else {
        // Normalise away Instagram size/crop segments so HD, SD and thumbnail
        // variants of the same file share one key → we keep only the best.
        const normPath = normaliseInstagramPath(rawPath);
        // Include thumbnail as secondary discriminator: two assets with the
        // same base filename (unlikely but possible) won't wrongly collapse
        // if they have different per-item thumbnails.
        key = thumb ? `${thumb}::${normPath}` : normPath;
      }
    } catch (_) {
      key = realUrl || rawUrl;
    }

    if (!key) return;

    const score    = qualityScore(item.quality || item.resolution || '');
    const existing = groups.get(key);
    if (!existing || score > existing._score) {
      groups.set(key, { ...item, url: realUrl, _score: score });
    }
  });

  const result = Array.from(groups.values()).map(({ _score, ...item }, index) => ({
    ...item,
    index,
  }));

  console.log(`🔑 dedup: ${items.length} raw → ${result.length} unique`);
  result.forEach((it, i) =>
    console.log(`  [${i}] normKey used, url=${String(it.url).slice(0, 100)} type=${it.type}`)
  );

  return result;
};

// ─────────────────────────────────────────────────────────────────────────────
// JWT TYPE DETECTION (for rapidcdn / token-proxied URLs)
// ─────────────────────────────────────────────────────────────────────────────
const detectTypeFromJwtUrl = (tokenUrl) => {
  try {
    const m = tokenUrl.match(/[?&]token=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]*)/);
    if (!m) return null;
    const payloadB64 = m[2];
    if (!payloadB64) return null;
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    const origUrl  = (payload.url || payload.u || payload.src || '').toLowerCase();
    if (!origUrl) return null;

    console.log(`🔑 JWT payload url: ${origUrl.slice(0, 120)}`);

    if (origUrl.match(/\.(mp4|mov|webm|mkv|avi|ts)(\?|#|$)/)) return 'video';
    if (origUrl.match(/\.(jpg|jpeg|png|gif|webp|heic|avif)(\?|#|$)/)) return 'image';

    if (origUrl.includes('scontent') || origUrl.includes('cdninstagram')) {
      if (origUrl.match(/\/t50\./)) return 'video';
      if (origUrl.match(/\/t51\./)) return 'image';
    }
  } catch (e) {
    console.warn('🔑 JWT decode error:', e.message);
  }
  return null;
};

// ─────────────────────────────────────────────────────────────────────────────
// NORMALIZE MEDIA ITEM
//
// FIX: Type detection now:
//   1. Trusts explicit type field from scraper (highest priority)
//   2. Checks file extension / path in the URL (after decoding proxy links)
//   3. JWT payload decode for rapidcdn token URLs
//   4. Defaults to 'video'
// ─────────────────────────────────────────────────────────────────────────────
const normalizeMediaItem = (item, index, fallbackThumbnail = PLACEHOLDER_THUMBNAIL) => {
  const rawUrl    = pickBestUrl(item.url || item.download || item.src || '');
  // Decode proxy URL so type detection sees the real CDN URL
  const url       = decodeCdnUrl(rawUrl) || rawUrl;
  const thumbnail = item.thumbnail || item.cover || item.image || fallbackThumbnail;

  let type = '';
  const rawType = (item.type || '').toString().toLowerCase();

  if (rawType === 'video' || rawType === 'image') {
    // Trust explicit type set by the scraper
    type = rawType;
  } else {
    // Try URL-based detection (works on real CDN URLs)
    const fromUrl = detectTypeFromUrl(url);
    if (fromUrl) {
      type = fromUrl;
    } else {
      // Try JWT decode for rapidcdn/token URLs
      const fromJwt = detectTypeFromJwtUrl(rawUrl);
      if (fromJwt) {
        console.log(`🔍 JWT type-decode: ${fromJwt} for ${rawUrl.slice(0, 60)}`);
        type = fromJwt;
      } else {
        type = 'video'; // safe default
      }
    }
  }

  return {
    url,       // ← decoded CDN URL, not the proxy URL
    thumbnail,
    type,
    quality: item.quality || item.resolution || 'Original Quality',
    index,
  };
};

// ===== PLATFORM-SPECIFIC DOWNLOADERS =====

const platformDownloaders = {
  async instagram(url) {
    let snapsResult = null;
    let igdlResult  = null;
    let snapsErr    = null;
    let igdlErr     = null;

    await Promise.allSettled([
      downloadWithTimeout(() => facebookInsta(url), 35000)
        .then(d  => { snapsResult = d; })
        .catch(e => { snapsErr    = e; }),
      downloadWithTimeout(() => igdl(url), 30000)
        .then(d  => { igdlResult  = d; })
        .catch(e => { igdlErr     = e; }),
    ]);

    const extractItems = (res) => {
      if (!res) return null;
      if (Array.isArray(res))            return res.length        > 0 ? res          : null;
      if (Array.isArray(res.data))       return res.data.length   > 0 ? res.data     : null;
      if (Array.isArray(res.result))     return res.result.length > 0 ? res.result   : null;
      if (Array.isArray(res.media))      return res.media.length  > 0 ? res.media    : null;
      return null;
    };

    const snapsItems = extractItems(snapsResult);
    const igdlItems  = extractItems(igdlResult);

    console.log(`📸 Instagram: snapsave items=${snapsItems?.length ?? 'null'}  igdl items=${igdlItems?.length ?? 'null'}`);
    if (snapsErr) console.log('📸 snapsave error:', snapsErr.message);
    if (igdlErr)  console.log('📸 igdl error:',     igdlErr.message);

    if (!snapsItems && !igdlItems) {
      throw new Error(
        `Instagram: all scrapers failed. snapsave: ${snapsErr?.message}  igdl: ${igdlErr?.message}`
      );
    }

    if (snapsItems && snapsItems.length > 0) {
      console.log('📸 Instagram: using snapsave');
      snapsItems.forEach((it, i) => {
        const u = (it.url || '').slice(0, 100);
        const t = (it.thumbnail || '').slice(0, 60);
        console.log(`  snap[${i}] type=${it.type || '?'} url=${u} thumb=${t}`);
      });
      return { _items: snapsItems, _source: 'snapsave' };
    }

    console.log('📸 Instagram: snapsave empty/failed — falling back to igdl');
    igdlItems.forEach((it, i) => {
      const u = (it.url || '').slice(0, 100);
      console.log(`  igdl[${i}] url=${u}`);
    });
    return { _items: igdlItems, _source: 'igdl' };
  },

  async tiktok(url) {
    try {
      const resp = await downloadWithTimeout(async () => {
        const r = await axios.post(
          'https://www.tikwm.com/api/',
          new URLSearchParams({ url, hd: '1' }).toString(),
          {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 20000,
          }
        );
        return r.data;
      }, 25000);

      if (resp && resp.code === 0 && resp.data) {
        const d = resp.data;
        console.log('🎵 tikwm OK — has images:', !!(d.images?.length), 'has play:', !!(d.play));
        return {
          title:     d.title || d.author?.nickname || 'TikTok Post',
          thumbnail: d.cover || d.origin_cover || '',
          video:     d.play ? [d.play]   : (d.wmplay ? [d.wmplay] : []),
          audio:     d.music ? [d.music] : [],
          ...(d.images && d.images.length > 0 && {
            images: d.images.map(img =>
              typeof img === 'string' ? img : (img?.url || img?.download || '')
            ).filter(u => u && u.startsWith('http')),
          }),
        };
      }
      console.warn('🎵 tikwm returned unexpected shape, falling back to ttdl');
    } catch (e) {
      console.warn('🎵 tikwm failed:', e.message, '— falling back to ttdl');
    }

    const data = await downloadWithTimeout(() => ttdl(url));
    if (!data || (!data.video && !data.images)) {
      throw new Error('TikTok: both tikwm and ttdl failed to return usable data');
    }
    return data;
  },

  async facebook(url) {
    const data = await downloadWithTimeout(() => facebookInsta(url));
    if (!data || (!data.media && !data.data)) {
      throw new Error('Facebook service returned invalid data');
    }
    return data;
  },

  async twitter(url) {
    try {
      const data = await downloadWithTimeout(() => twitter(url));
      const hasValidData = data.data && (data.data.HD || data.data.SD);
      const hasValidUrls = Array.isArray(data.url) &&
        data.url.some(item => item && Object.keys(item).length > 0 && item.url);

      if (!hasValidData && !hasValidUrls) {
        throw new Error("Twitter primary service returned unusable data");
      }
      return data;
    } catch (error) {
      console.warn("Twitter: Primary service failed, trying custom service...", error.message);
      const fallbackData = await downloadWithTimeout(() => downloadTwmateData(url));

      if (!fallbackData || (!Array.isArray(fallbackData) && !fallbackData.data)) {
        throw new Error('Twitter download failed - both primary and fallback methods failed');
      }
      return fallbackData;
    }
  },

  async youtube(url, req) {
    console.log('YouTube: Processing URL:', url);

    try {
      const timeout = url.includes('/shorts/') ? 30000 : 60000;
      const data = await downloadWithTimeout(() => fetchYouTubeData(url), timeout);

      if (!data || !data.title) {
        throw new Error('YouTube service returned invalid data');
      }

      console.log('YouTube: Successfully fetched data, formats count:', data.formats?.length || 0);

      if (data.formats) {
        const serverBaseUrl = getServerBaseUrl(req);
        data.formats.forEach(format => {
          if (format.url && format.url.startsWith('MERGE:')) {
            const parts = format.url.split(':');
            if (parts.length >= 3) {
              const videoUrl = parts[1];
              const audioUrl = parts[2];
              format.url = `${serverBaseUrl}/api/merge-audio?videoUrl=${encodeURIComponent(videoUrl)}&audioUrl=${encodeURIComponent(audioUrl)}`;
              console.log(`🔄 Converted merge URL for: ${format.quality}`);
            }
          }
        });

        if (data.url && data.url.startsWith('MERGE:')) {
          const parts = data.url.split(':');
          if (parts.length >= 3) {
            const videoUrl = parts[1];
            const audioUrl = parts[2];
            data.url = `${serverBaseUrl}/api/merge-audio?videoUrl=${encodeURIComponent(videoUrl)}&audioUrl=${encodeURIComponent(audioUrl)}`;
          }
        }
      }

      return data;
    } catch (error) {
      if (error.message.includes('Status code: 410')) {
        throw new Error('YouTube video not available (removed or private)');
      }
      if (error.message.includes('Status code: 403')) {
        throw new Error('YouTube video access forbidden (age-restricted or region-locked)');
      }
      if (error.message.includes('Status code: 404')) {
        throw new Error('YouTube video not found (invalid URL or removed)');
      }
      if (error.message.includes('timeout')) {
        throw new Error('YouTube download timed out - video processing may be slow, please try again');
      }

      throw new Error(`YouTube download failed: ${error.message}`);
    }
  },

  async pinterest(url) {
    try {
      const data = await downloadWithTimeout(() => pindl(url));
      if (!data || (!data.data && !data.result && !data.url)) {
        throw new Error('Pinterest service returned invalid data');
      }
      return data;
    } catch (error) {
      console.warn('Pinterest primary downloader failed, trying fallback...', error.message);
      const fallbackData = await downloadWithTimeout(() => pinterest(url));
      if (!fallbackData || (!fallbackData.data && !fallbackData.result)) {
        throw new Error('Pinterest download failed - both primary and fallback methods failed');
      }
      return fallbackData;
    }
  },

  async threads(url) {
    console.log("🧵 Threads: Starting download with advanced service");
    try {
      const data = await downloadWithTimeout(() => advancedThreadsDownloader(url), 60000);

      const hasMedia = data && (
        data.download ||
        data.url ||
        (Array.isArray(data.items) && data.items.length > 0)
      );
      if (!hasMedia) {
        console.error("🧵 Threads raw data:", JSON.stringify(data).slice(0, 500));
        throw new Error('Threads service returned invalid data');
      }

      console.log("✅ Threads: data ok — items:", data.items?.length ?? 'none',
                  "download:", !!data.download, "url:", !!data.url);
      return data;
    } catch (error) {
      console.error(`❌ Threads download failed: ${error.message}`);
      throw new Error(`Threads download failed: ${error.message}`);
    }
  },

  async linkedin(url) {
    const data = await downloadWithTimeout(() => fetchLinkedinData(url));
    if (!data || !data.data) {
      throw new Error('LinkedIn service returned invalid data');
    }
    return data;
  }
};

// ===== DATA FORMATTERS =====

const dataFormatters = {

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
    rawItems.forEach((item, i) => {
      const u = item?.url || item?.download || '';
      const t = item?.thumbnail || '';
      console.log(`  raw[${i}] type=${item?.type ?? 'none'} quality=${item?.quality ?? '-'} url=${String(u).slice(0,100)} thumb=${String(t).slice(0,70)}`);
    });

    const validItems  = rawItems.filter(item => item && (item.url || item.download));
    const uniqueItems = deduplicateByBestQuality(validItems);
    const mediaItems  = uniqueItems.map((item, index) =>
      normalizeMediaItem(item, index, item.thumbnail || PLACEHOLDER_THUMBNAIL)
    );

    console.log(`📸 Instagram: ${rawItems.length} raw → ${mediaItems.length} unique`);
    mediaItems.forEach((it, i) =>
      console.log(`  [${i}] type=${it.type} url=${String(it.url).slice(0, 100)}`)
    );

    if (mediaItems.length === 0) {
      throw new Error('Instagram returned no usable media items');
    }

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

  tiktok(data) {
    console.log('🎵 TikTok: keys=', Object.keys(data || {}),
                'images len=', data.images?.length ?? 0,
                'has video=', !!(data.video), 'has audio=', !!(data.audio));

    if (data.images && Array.isArray(data.images) && data.images.length > 0) {
      console.log(`🎵 TikTok: slideshow ${data.images.length} item(s), item[0] type=${typeof data.images[0]}`);
      if (data.images[0]) console.log('🎵 sample:', JSON.stringify(data.images[0]).slice(0, 120));

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
          url:       imgUrl,
          thumbnail: imgUrl,
          type:      'image',
          quality:   'Original Quality',
          index,
        }));

      console.log(`🎵 TikTok: ${mediaItems.length} valid image URL(s) extracted`);

      if (mediaItems.length > 0) {
        const first = mediaItems[0];
        return {
          title:            data.title || 'TikTok Post',
          url:              first.url,
          thumbnail:        data.thumbnail || first.url || PLACEHOLDER_THUMBNAIL,
          sizes:            ['Original Quality'],
          audio:            pickBestUrl(data.audio) || '',
          source:           'tiktok',
          isImageSlideshow: true,
          ...(mediaItems.length > 1 && { mediaItems }),
        };
      }
      console.warn('🎵 TikTok: images array had no valid URLs, falling through');
    }

    const bestVideoUrl = pickBestUrl(data.video);
    console.log('🎵 TikTok: video post url=', String(bestVideoUrl).slice(0, 80));
    return {
      title:     data.title || 'Untitled Video',
      url:       bestVideoUrl,
      thumbnail: data.thumbnail || PLACEHOLDER_THUMBNAIL,
      sizes:     ['Best Quality'],
      audio:     pickBestUrl(data.audio) || '',
      source:    'tiktok',
    };
  },

  facebook(data) {
    console.log('📘 Facebook: Formatting data');

    if (data && data.media && Array.isArray(data.media)) {
      const rawCount    = data.media.length;
      const validItems  = data.media.filter(item => item && (item.url || item.download));
      const uniqueItems = deduplicateByBestQuality(validItems);
      const mediaItems  = uniqueItems.map((item, index) =>
        normalizeMediaItem(item, index, data.thumbnail || PLACEHOLDER_THUMBNAIL)
      );

      console.log(`📘 Facebook (media array): ${rawCount} raw → ${mediaItems.length} unique`);

      if (mediaItems.length === 0) {
        throw new Error('Facebook media array contained no valid URLs');
      }

      const first = mediaItems[0];
      return {
        title:     data.title || 'Facebook Post',
        url:       first.url,
        thumbnail: data.thumbnail || first.thumbnail,
        sizes:     ['Best Quality'],
        source:    'facebook',
        ...(mediaItems.length > 1 && { mediaItems }),
      };
    }

    const fbData = data.data || [];
    if (Array.isArray(fbData) && fbData.length > 0) {
      console.log(`📘 Facebook (data array): ${fbData.length} quality variant(s)`);

      const sorted = [...fbData].sort((a, b) =>
        qualityScore(b.resolution || b.quality || '') -
        qualityScore(a.resolution || a.quality || '')
      );
      const best = sorted[0];

      return {
        title:     data.title || 'Facebook Video',
        url:       decodeCdnUrl(pickBestUrl(best?.url || '')),
        thumbnail: best?.thumbnail || PLACEHOLDER_THUMBNAIL,
        sizes:     fbData.map(v => v.resolution || 'Unknown'),
        source:    'facebook',
      };
    }

    return {
      title:     data.title || 'Facebook Video',
      url:       decodeCdnUrl(pickBestUrl(data.url || '')),
      thumbnail: data.thumbnail || PLACEHOLDER_THUMBNAIL,
      sizes:     ['Best Quality'],
      source:    'facebook',
    };
  },

  twitter(data) {
    if (data.data && (data.data.HD || data.data.SD)) {
      return {
        title: 'Twitter Video',
        url: data.data.HD || data.data.SD || '',
        thumbnail: PLACEHOLDER_THUMBNAIL,
        sizes: data.data.HD ? ['HD', 'SD'] : ['SD'],
        source: 'twitter',
      };
    }

    if (data.url && Array.isArray(data.url)) {
      const videoArray = data.url.filter(item => item && item.url);
      const bestQuality = videoArray.find(item => item.quality && item.quality.includes('1280x720')) ||
                         videoArray.find(item => item.quality && item.quality.includes('640x360')) ||
                         videoArray[0];

      return {
        title: 'Twitter Video',
        url: bestQuality.url || '',
        thumbnail: PLACEHOLDER_THUMBNAIL,
        sizes: videoArray.map(item => item.quality),
        source: 'twitter',
      };
    }

    if (Array.isArray(data) && data.length > 0) {
      const bestQuality = data.find(item => item.quality.includes('1280x720')) ||
                         data.find(item => item.quality.includes('640x360')) ||
                         data[0];

      return {
        title: 'Twitter Video',
        url: bestQuality.url || '',
        thumbnail: PLACEHOLDER_THUMBNAIL,
        sizes: data.map(item => item.quality),
        source: 'twitter',
      };
    }

    throw new Error("Twitter video data is incomplete or improperly formatted.");
  },

  youtube(data, req) {
    console.log('🎬 Formatting YouTube data...');

    if (!data || !data.title) {
      throw new Error('Invalid YouTube data received');
    }

    const hasFormats    = data.formats    && data.formats.length > 0;
    const hasAllFormats = data.allFormats && data.allFormats.length > 0;

    console.log(`📊 YouTube data: hasFormats=${hasFormats}, hasAllFormats=${hasAllFormats}`);

    let qualityOptions  = [];
    let selectedQuality = null;
    let defaultUrl      = data.url;

    if (hasFormats || hasAllFormats) {
      qualityOptions = data.formats || data.allFormats;

      selectedQuality = qualityOptions.find(opt =>
        opt.quality && opt.quality.includes('360p')
      ) || qualityOptions[0];

      defaultUrl = selectedQuality?.url || data.url;

      console.log(`✅ YouTube: ${qualityOptions.length} quality options available`);
      console.log(`🎯 Selected quality: ${selectedQuality?.quality}`);

      const serverBaseUrl = getServerBaseUrl(req);
      qualityOptions.forEach(format => {
        if (format.url && format.url.startsWith('MERGE:')) {
          const parts = format.url.split(':');
          if (parts.length >= 3) {
            const videoUrl = parts[1];
            const audioUrl = parts[2];
            format.url = `${serverBaseUrl}/api/merge-audio?videoUrl=${encodeURIComponent(videoUrl)}&audioUrl=${encodeURIComponent(audioUrl)}`;
            console.log(`🔄 Formatter: Converted merge URL for: ${format.quality}`);
          }
        }
      });

      if (selectedQuality && selectedQuality.url && selectedQuality.url.startsWith('MERGE:')) {
        const parts = selectedQuality.url.split(':');
        if (parts.length >= 3) {
          const videoUrl = parts[1];
          const audioUrl = parts[2];
          selectedQuality.url = `${serverBaseUrl}/api/merge-audio?videoUrl=${encodeURIComponent(videoUrl)}&audioUrl=${encodeURIComponent(audioUrl)}`;
          defaultUrl = selectedQuality.url;
        }
      }
    } else {
      console.log('⚠️ No quality formats found, creating fallback');
      qualityOptions = [
        {
          quality: '360p',
          qualityNum: 360,
          url: data.url,
          type: 'video/mp4',
          extension: 'mp4',
          isPremium: false,
          hasAudio: true
        }
      ];
      selectedQuality = qualityOptions[0];
    }

    const result = {
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

    console.log(`✅ YouTube formatting complete`);
    console.log(`📦 Sending to client: ${qualityOptions.length} formats`);

    return result;
  },

  threads(data) {
    console.log("🧵 Processing Threads data, keys:", Object.keys(data || {}));

    if (data.items && Array.isArray(data.items) && data.items.length > 0) {
      console.log(`🧵 Threads: ${data.items.length} item(s) found`);
      console.log("🧵 Threads item[0] keys:", Object.keys(data.items[0] || {}));
      console.log("🧵 Threads item[0] sample:", JSON.stringify(data.items[0]).slice(0, 300));

      const mediaItems = data.items
        .filter(item => item && (item.download || item.url || item.video_url || item.image_url ||
                                  item.display_url || item.image_versions))
        .map((item, index) => {
          const itemUrl =
            item.download ||
            item.url ||
            item.video_url ||
            item.image_url ||
            item.display_url ||
            item.image_versions?.candidates?.[0]?.url ||
            item.image_versions?.[0]?.url ||
            '';

          const itemThumb =
            item.thumbnail ||
            item.cover ||
            item.image_url ||
            item.display_url ||
            item.image_versions?.candidates?.[0]?.url ||
            item.image_versions?.[0]?.url ||
            data.thumbnail ||
            PLACEHOLDER_THUMBNAIL;

          const isVideo = !!(item.video_url || item.download?.includes('.mp4'));
          const itemType = item.type ||
            (item.media_type === 2 || item.media_type === '2' ? 'video' :
             item.media_type === 1 || item.media_type === '1' ? 'image' :
             isVideo ? 'video' : 'image');

          console.log(`🧵 item[${index}] url=${itemUrl.slice(0,60)} thumb=${itemThumb.slice(0,60)} type=${itemType}`);

          return {
            url:       itemUrl,
            thumbnail: itemThumb,
            type:      itemType,
            quality:   item.quality || 'Best Available',
            index,
          };
        })
        .filter(item => item.url);

      if (mediaItems.length === 0) {
        console.warn("🧵 Threads: no valid items after mapping, falling back to single");
      } else {
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
      title: 'Pinterest Image',
      url: pinterestData.result || pinterestData.url || '',
      thumbnail: pinterestData.result || pinterestData.url || PLACEHOLDER_THUMBNAIL,
      sizes: ['Original Quality'],
      source: 'pinterest',
    };
  },

  linkedin(data) {
    const videoUrl = Array.isArray(data?.data?.videos) && data.data.videos.length > 0
      ? data.data.videos[0]
      : '';

    return {
      title: 'LinkedIn Video',
      url: videoUrl,
      thumbnail: videoUrl ? PLACEHOLDER_THUMBNAIL : 'Error',
      sizes: ['Original Quality'],
      source: 'linkedin',
    };
  }
};

const formatData = async (platform, data, req) => {
  console.info(`Data Formatting: Formatting data for platform '${platform}'.`);

  const formatter = dataFormatters[platform];
  if (!formatter) {
    console.warn("Data Formatting: Generic formatting applied.");
    return {
      title: data.title || 'Untitled Media',
      url: data.url || '',
      thumbnail: data.thumbnail || PLACEHOLDER_THUMBNAIL,
      sizes: data.sizes?.length > 0 ? data.sizes : ['Original Quality'],
      source: platform,
    };
  }

  if (platform === 'youtube') {
    return formatter(data, req);
  }

  return formatter(data);
};

// ===== MAIN CONTROLLER =====

const downloadMedia = async (req, res) => {
  const { url } = req.body;
  console.log("Received URL:", url);

  try {
    const urlValidation = validateUrl(url);
    if (!urlValidation.isValid) {
      console.warn(`Download Media: ${urlValidation.error}`);
      return res.status(400).json({
        error: urlValidation.error,
        success: false
      });
    }

    const cleanedUrl = urlValidation.cleanedUrl;
    const platform   = identifyPlatform(cleanedUrl);

    if (!platform) {
      console.warn("Download Media: Unsupported platform for the given URL.");
      return res.status(400).json({
        error: 'Unsupported platform',
        success: false,
        supportedPlatforms: SUPPORTED_PLATFORMS
      });
    }

    let processedUrl = cleanedUrl;
    if (platform === 'youtube') {
      processedUrl = normalizeYouTubeUrl(cleanedUrl);
      console.log(`YouTube URL processed: ${cleanedUrl} -> ${processedUrl}`);
    }

    console.info(`Download Media: Fetching data for platform '${platform}'.`);

    const downloader = platformDownloaders[platform];
    if (!downloader) {
      throw new Error(`No downloader available for platform: ${platform}`);
    }

    const data = platform === 'youtube'
      ? await downloader(processedUrl, req)
      : await downloader(processedUrl);

    if (!data) {
      console.error("Download Media: No data returned for the platform.");
      return res.status(404).json({
        error: 'No data found for this URL',
        success: false,
        platform: platform
      });
    }

    let formattedData;
    try {
      formattedData = await formatData(platform, data, req);
    } catch (formatError) {
      console.error(`Download Media: Data formatting failed - ${formatError.message}`);
      return res.status(500).json({
        error: 'Failed to format media data',
        success: false,
        details: formatError.message,
        platform: platform
      });
    }

    if (!formattedData || !formattedData.url) {
      console.error("Download Media: Formatted data is invalid or missing URL.");
      return res.status(500).json({
        error: 'Invalid media data - no download URL found',
        success: false,
        platform: platform
      });
    }

    const hasMultiple = formattedData.mediaItems && formattedData.mediaItems.length > 1;
    console.log(`Final ${platform} URL length:`, formattedData.url.length);
    console.log(`Media items: ${formattedData.mediaItems?.length || 1}`);
    if (platform === 'youtube') {
      console.log(`Formats count: ${formattedData.formats?.length || 0}`);
      const mergeFormats = formattedData.formats?.filter(f => f.url?.includes('/api/merge-audio')) || [];
      console.log(`🎵 Merge formats available: ${mergeFormats.length}`);
    }

    console.info("Download Media: Media successfully downloaded and formatted.");

    res.status(200).json({
      success: true,
      data: formattedData,
      platform: platform,
      timestamp: new Date().toISOString(),
      debug: {
        originalUrl: url,
        cleanedUrl: cleanedUrl,
        processedUrl: processedUrl,
        hasValidUrl: !!formattedData.url,
        finalUrlLength: formattedData.url ? formattedData.url.length : 0,
        hasMultipleItems: hasMultiple,
        mediaItemsCount: formattedData.mediaItems?.length || 1,
        hasFormats: !!formattedData.formats,
        formatsCount: formattedData.formats?.length || 0,
      }
    });

  } catch (error) {
    console.error(`Download Media: Error occurred - ${error.message}`);
    console.error('Error stack:', error.stack);

    let statusCode = 500;
    if (error.message.includes('not available') || error.message.includes('not found')) {
      statusCode = 404;
    } else if (error.message.includes('forbidden') || error.message.includes('access')) {
      statusCode = 403;
    } else if (error.message.includes('timeout')) {
      statusCode = 408;
    }

    res.status(statusCode).json({
      error: 'Failed to download media',
      success: false,
      details: error.message,
      platform: identifyPlatform(url) || 'unknown',
      timestamp: new Date().toISOString(),
      suggestions: getErrorSuggestions(error.message, identifyPlatform(url))
    });
  }
};

const getErrorSuggestions = (errorMessage, platform) => {
  const suggestions = [];

  if (platform === 'threads') {
    suggestions.push('Ensure the Threads post contains video content (not just images or text)');
    suggestions.push('Check if the post is public and not deleted');
    suggestions.push('Try using a different Threads video post to test');
  }

  if (platform === 'youtube') {
    if (errorMessage.includes('timeout')) {
      suggestions.push('YouTube videos may take longer to process - the API is working but needs time');
      suggestions.push('Check your frontend code to ensure it waits for the full response');
    }
  }

  return suggestions;
};

module.exports = {
  downloadMedia
};