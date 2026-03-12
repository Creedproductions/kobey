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

/**
 * Score a quality string so we can always pick the best available.
 * Higher score = better quality.
 */
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
  return 0; // 'Original Quality' etc — treated as lowest so explicit quality wins
};

/**
 * When a library returns `item.url` as an array (e.g. [hdUrl, sdUrl]),
 * this picks the best single URL from it.
 */
const pickBestUrl = (rawUrl) => {
  if (Array.isArray(rawUrl)) {
    // Some libraries put HD first, SD second — just take index 0
    return rawUrl.find(u => typeof u === 'string' && u.startsWith('http')) || rawUrl[0] || '';
  }
  return rawUrl || '';
};

/**
 * Deduplicate a flat array of media items that may contain HD+SD variants of
 * the same asset (identified by matching thumbnail URL).
 * Returns one item per unique thumbnail, always the highest-quality URL.
 *
 * Example input (5-image Instagram carousel via igdl):
 *   [ {url: img1_hd, thumbnail: t1, quality:'HD'},
 *     {url: img1_sd, thumbnail: t1, quality:'SD'},   ← duplicate of t1
 *     {url: img2_hd, thumbnail: t2, quality:'HD'},
 *     {url: img2_sd, thumbnail: t2, quality:'SD'},   ← duplicate of t2
 *     ... ]
 * Output:
 *   [ {url: img1_hd, thumbnail: t1, ...},
 *     {url: img2_hd, thumbnail: t2, ...}, ... ]
 */
const deduplicateByBestQuality = (items) => {
  // Build a map keyed by a composite identity:
  //   primary   → thumbnail URL  (same asset always shares a thumbnail)
  //   secondary → URL path without query string (catches cases where thumbnail
  //               is missing or identical across all items in a post)
  //
  // We only group two items together when BOTH their thumbnail AND their
  // stripped URL path agree — this prevents false-positive collapsing of
  // distinct carousel items that happen to share a post-level thumbnail.
  const groups = new Map();

  items.forEach((item, rawIndex) => {
    // Resolve url array → best single string
    const resolvedUrl = pickBestUrl(item.url || item.download || item.src || '');
    const thumb       = item.thumbnail || item.cover || item.image || '';

    // Strip query params from URL to get a stable path-level identity
    let urlPath = '';
    try { urlPath = new URL(resolvedUrl).pathname; } catch (_) {
      urlPath = resolvedUrl.split('?')[0];
    }

    // Composite key: thumbnail + url path  (both must match to be "the same asset")
    // If thumbnail is empty, fall back to url-only key so we still deduplicate HD/SD.
    const key = thumb ? `${thumb}::${urlPath}` : urlPath;
    if (!key) return;

    const score = qualityScore(item.quality || item.resolution || '');
    const existing = groups.get(key);

    if (!existing || score > existing._score) {
      groups.set(key, { ...item, url: resolvedUrl, _score: score });
    }
  });

  const result = Array.from(groups.values()).map(({ _score, ...item }, index) => ({
    ...item,
    index,
  }));

  console.log(`🔑 dedup: ${items.length} raw → ${result.length} unique`);
  result.forEach((it, i) =>
    console.log(`  [${i}] url=${String(it.url).slice(0,80)} thumb=${String(it.thumbnail).slice(0,60)} type=${it.type}`)
  );

  return result;
};

// ─────────────────────────────────────────────────────────────────────────────
// TYPE DETECTION: Some CDNs (e.g. rapidcdn) proxy URLs behind JWT tokens.
// The original URL with its real extension is in the JWT payload.
// Decode it to determine whether the asset is an image or a video.
// ─────────────────────────────────────────────────────────────────────────────
const detectTypeFromJwtUrl = (tokenUrl) => {
  try {
    // Match any ?token= or &token= query param that looks like a JWT (two dots)
    const m = tokenUrl.match(/[?&]token=([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/);
    if (!m) return null;
    const payloadB64 = m[1].split('.')[1];
    if (!payloadB64) return null;
    // Node's Buffer can handle base64url without padding
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    const origUrl  = (payload.url || payload.u || '').toLowerCase();
    if (!origUrl) return null;
    if (origUrl.match(/\.(mp4|mov|webm|mkv|avi|ts)/)) return 'video';
    if (origUrl.match(/\.(jpg|jpeg|png|gif|webp|heic|avif)/)) return 'image';
  } catch (_) {}
  return null;
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: Normalize a raw media item from any platform into a uniform shape.
// Returns: { url, thumbnail, type ('video'|'image'), quality, index }
// ─────────────────────────────────────────────────────────────────────────────
const normalizeMediaItem = (item, index, fallbackThumbnail = PLACEHOLDER_THUMBNAIL) => {
  // Handle url being an array (some libraries return [hd, sd])
  const url       = pickBestUrl(item.url || item.download || item.src || '');
  const thumbnail = item.thumbnail || item.cover || item.image || fallbackThumbnail;

  // Determine media type — check in order:
  // 1. Explicit type field from the library
  // 2. File extension in the URL
  // 3. JWT payload decode (for rapidcdn / token-proxied URLs)
  // 4. Default to 'video'
  let type = item.type || '';
  if (!type) {
    const lower = url.toLowerCase();
    if      (lower.match(/\.(mp4|mov|webm|mkv|avi|ts)(\?|$)/))      type = 'video';
    else if (lower.match(/\.(jpg|jpeg|png|gif|webp|heic|avif)(\?|$)/)) type = 'image';
    else {
      // Try to decode the JWT token embedded in the URL
      const detected = detectTypeFromJwtUrl(url);
      if (detected) console.log(`🔍 JWT type-decode: ${detected} for ${url.slice(0,60)}`);
      type = detected || 'video'; // final fallback: video
    }
  }

  return {
    url,
    thumbnail,
    type,
    quality: item.quality || item.resolution || 'Original Quality',
    index,
  };
};

// ===== PLATFORM-SPECIFIC DOWNLOADERS =====

const platformDownloaders = {
  async instagram(url) {
    try {
      const data = await downloadWithTimeout(() => igdl(url));
      if (!data || (Array.isArray(data) && data.length === 0)) {
        throw new Error('Instagram primary service returned empty data');
      }
      return data;
    } catch (error) {
      console.warn('Instagram primary downloader failed, trying fallback...', error.message);
      const fallbackData = await downloadWithTimeout(() => facebookInsta(url));
      if (!fallbackData || !fallbackData.media) {
        throw new Error('Instagram download failed - both primary and fallback methods failed');
      }
      return fallbackData;
    }
  },

  async tiktok(url) {
    // ── Primary: tikwm.com API — supports both video and image slideshow posts ──
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
        // Normalise to the same shape ttdl uses so the formatter works unchanged
        return {
          title:     d.title || d.author?.nickname || 'TikTok Post',
          thumbnail: d.cover || d.origin_cover || '',
          video:     d.play ? [d.play]   : (d.wmplay ? [d.wmplay] : []),
          audio:     d.music ? [d.music] : [],
          // images is an array of plain URL strings for slideshows
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

    // ── Fallback: ttdl (video-only, no image slideshow support) ──
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

  // ========================================
  // YOUTUBE - UPDATED FOR AUDIO MERGING
  // ========================================
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

      // Accept: single post (has download/url) OR carousel (has items array)
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

  // ─────────────────────────────────────────────────────────────────────────
  // INSTAGRAM
  // Handles: single video, single image, carousel (multiple videos/images)
  //
  // igdl from btch-downloader returns carousels as a FLAT array where each
  // physical asset appears TWICE — once as 'HD' and once as 'SD':
  //   [ {url: img1_hd, thumbnail: t1, quality:'HD'},
  //     {url: img1_sd, thumbnail: t1, quality:'SD'},   ← same asset, lower q
  //     {url: img2_hd, thumbnail: t2, quality:'HD'}, ... ]
  //
  // deduplicateByBestQuality collapses these into one entry per asset and
  // always keeps the highest-quality URL.
  // ─────────────────────────────────────────────────────────────────────────
  instagram(data) {
    console.log('📸 Instagram: Formatting data, type=', Array.isArray(data) ? 'array' : typeof data);

    // ── Case 1: igdl returns a plain array ──
    if (Array.isArray(data)) {
      const rawCount = data.length;

      // Filter invalid entries, then deduplicate HD/SD variants
      const validItems   = data.filter(item => item && (item.url || item.download));
      const uniqueItems  = deduplicateByBestQuality(validItems);
      const mediaItems   = uniqueItems.map((item, index) =>
        normalizeMediaItem(item, index, item.thumbnail || PLACEHOLDER_THUMBNAIL)
      );

      console.log(`📸 Instagram: ${rawCount} raw → ${mediaItems.length} unique item(s) after dedup`);

      if (mediaItems.length === 0) {
        throw new Error('Instagram returned an empty media array');
      }

      const first = mediaItems[0];
      return {
        title: data[0]?.title || 'Instagram Post',
        url: first.url,
        thumbnail: first.thumbnail,
        sizes: ['Best Quality'],
        source: 'instagram',
        ...(mediaItems.length > 1 && { mediaItems }),
      };
    }

    // ── Case 2: fallback / snapsave returns { media: [], title, thumbnail } ──
    if (data.media && Array.isArray(data.media)) {
      const validItems  = data.media.filter(item => item && (item.url || item.download));
      const uniqueItems = deduplicateByBestQuality(validItems);
      const mediaItems  = uniqueItems.map((item, index) =>
        normalizeMediaItem(item, index, data.thumbnail || PLACEHOLDER_THUMBNAIL)
      );

      console.log(`📸 Instagram (media array): ${data.media.length} raw → ${mediaItems.length} unique`);

      if (mediaItems.length === 0) {
        throw new Error('Instagram media array contained no valid URLs');
      }

      const first = mediaItems[0];
      return {
        title: data.title || 'Instagram Post',
        url: first.url,
        thumbnail: data.thumbnail || first.thumbnail,
        sizes: ['Best Quality'],
        source: 'instagram',
        ...(mediaItems.length > 1 && { mediaItems }),
      };
    }

    // ── Case 3: single media object (url may be an array) ──
    console.log('📸 Instagram: Single item (object)');
    const resolvedUrl = pickBestUrl(data.url || '');
    return {
      title: data.title || 'Instagram Post',
      url: resolvedUrl,
      thumbnail: data.thumbnail || PLACEHOLDER_THUMBNAIL,
      sizes: ['Best Quality'],
      source: 'instagram',
    };
  },

  // ─────────────────────────────────────────────────────────────────────────
  // TIKTOK
  // Handles: single video, image/photo slideshow (data.images array)
  // btch-downloader ttdl returns:
  //   { title, video: [url], audio: [url], thumbnail, images?: [url] }
  //
  // For video posts, `video` is an array of quality variants — we pick the
  // first (highest quality) entry. For slideshows, each image URL is a
  // separate asset so we keep them all as mediaItems.
  // ─────────────────────────────────────────────────────────────────────────
  tiktok(data) {
    console.log('🎵 TikTok: keys=', Object.keys(data || {}),
                'images len=', data.images?.length ?? 0,
                'has video=', !!(data.video), 'has audio=', !!(data.audio));

    // ── Image slideshow post ──
    if (data.images && Array.isArray(data.images) && data.images.length > 0) {
      console.log(`🎵 TikTok: slideshow ${data.images.length} item(s), item[0] type=${typeof data.images[0]}`);
      if (data.images[0]) console.log('🎵 sample:', JSON.stringify(data.images[0]).slice(0, 120));

      // btch-downloader may return plain strings OR objects like {url, width, height}
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
      // No valid URLs extracted from images array — fall through to video path
      console.warn('🎵 TikTok: images array had no valid URLs, falling through');
    }

    // ── Standard video post ──
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

  // ─────────────────────────────────────────────────────────────────────────
  // FACEBOOK
  // Handles: single video, albums / multiple media
  // facebookInsta (snapsave) returns:
  //   { media: [{url, type, quality, thumbnail}], title, thumbnail }
  //   OR  { data: [{url, resolution, thumbnail}], title }   ← quality variants
  //
  // The `media` array for albums can also contain HD+SD pairs per asset, so
  // we run the same dedup pass as for Instagram.
  // ─────────────────────────────────────────────────────────────────────────
  facebook(data) {
    console.log('📘 Facebook: Formatting data');

    // ── Case 1: snapsave-style { media: [] } ──
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

    // ── Case 2: { data: [{url, resolution}] } — these are quality VARIANTS
    //           of the same single video, not separate assets.  Just pick best. ──
    const fbData = data.data || [];
    if (Array.isArray(fbData) && fbData.length > 0) {
      console.log(`📘 Facebook (data array): ${fbData.length} quality variant(s)`);

      // Sort by quality score and pick the winner
      const sorted = [...fbData].sort((a, b) =>
        qualityScore(b.resolution || b.quality || '') -
        qualityScore(a.resolution || a.quality || '')
      );
      const best = sorted[0];

      return {
        title:     data.title || 'Facebook Video',
        url:       pickBestUrl(best?.url || ''),
        thumbnail: best?.thumbnail || PLACEHOLDER_THUMBNAIL,
        sizes:     fbData.map(v => v.resolution || 'Unknown'),
        source:    'facebook',
      };
    }

    // ── Fallback ──
    return {
      title:     data.title || 'Facebook Video',
      url:       pickBestUrl(data.url || ''),
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

  // ========================================
  // YOUTUBE FORMATTER - FIXED TO PASS QUALITY DATA
  // ========================================
  youtube(data, req) {
    console.log('🎬 Formatting YouTube data...');

    if (!data || !data.title) {
      throw new Error('Invalid YouTube data received');
    }

    const hasFormats = data.formats && data.formats.length > 0;
    const hasAllFormats = data.allFormats && data.allFormats.length > 0;

    console.log(`📊 YouTube data: hasFormats=${hasFormats}, hasAllFormats=${hasAllFormats}`);

    let qualityOptions = [];
    let selectedQuality = null;
    let defaultUrl = data.url;

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
      title: data.title,
      url: defaultUrl,
      thumbnail: data.thumbnail || PLACEHOLDER_THUMBNAIL,
      sizes: qualityOptions.map(f => f.quality),
      duration: data.duration || 'unknown',
      source: 'youtube',
      formats: qualityOptions,
      allFormats: qualityOptions,
      selectedQuality: selectedQuality
    };

    console.log(`✅ YouTube formatting complete`);
    console.log(`📦 Sending to client: ${qualityOptions.length} formats`);

    return result;
  },

  // ─────────────────────────────────────────────────────────────────────────
  // THREADS
  // Handles: single video/image, multi-media posts (carousels in threads)
  // advancedThreadsDownloader may return:
  //   { download, title, thumbnail, quality } — single
  //   { items: [{download, thumbnail, type}], title, thumbnail } — multiple
  // ─────────────────────────────────────────────────────────────────────────
  threads(data) {
    console.log("🧵 Processing Threads data, keys:", Object.keys(data || {}));

    // ── Multiple media items ──
    if (data.items && Array.isArray(data.items) && data.items.length > 0) {
      console.log(`🧵 Threads: ${data.items.length} item(s) found`);

      // Log first item so we can see all available fields
      console.log("🧵 Threads item[0] keys:", Object.keys(data.items[0] || {}));
      console.log("🧵 Threads item[0] sample:", JSON.stringify(data.items[0]).slice(0, 300));

      const mediaItems = data.items
        .filter(item => item && (item.download || item.url || item.video_url || item.image_url ||
                                  item.display_url || item.image_versions))
        .map((item, index) => {
          // ── URL: try every field the service might use ──
          const itemUrl =
            item.download ||
            item.url ||
            item.video_url ||
            item.image_url ||
            item.display_url ||
            item.image_versions?.candidates?.[0]?.url ||
            item.image_versions?.[0]?.url ||
            '';

          // ── Thumbnail: prefer per-item image over post-level fallback ──
          const itemThumb =
            item.thumbnail ||
            item.cover ||
            item.image_url ||
            item.display_url ||
            item.image_versions?.candidates?.[0]?.url ||
            item.image_versions?.[0]?.url ||
            data.thumbnail ||
            PLACEHOLDER_THUMBNAIL;

          // ── Type: video if has video_url or media_type==2, else image ──
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
        .filter(item => item.url); // drop any that still have no URL

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

    // ── Single item ──
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
    const platform = identifyPlatform(cleanedUrl);

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