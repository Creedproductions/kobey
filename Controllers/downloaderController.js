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
const { downloadGeneric } = require('../Services/genericService');
const telegram = require('../Services/telegramService');
const { classify: classifyError } = require('../Services/errorClassifier');

const bitly = new BitlyClient(config.BITLY_ACCESS_TOKEN);

// ===== CONSTANTS =====
const SUPPORTED_PLATFORMS = [
  // Dedicated extractors (custom scrapers in /Services/*)
  'instagram', 'tiktok', 'facebook', 'twitter',
  'youtube', 'pinterest', 'threads', 'linkedin',
  // Named yt-dlp handlers (better metadata + cleaner platform tagging)
  'reddit', 'bilibili', 'bbc', 'vimeo', 'dailymotion', 'twitch',
  'rumble', 'soundcloud', 'vk', 'streamable', 'odysee',
  // Anything else falls back to 'generic' which uses yt-dlp directly.
  'generic',
];

const PLACEHOLDER_THUMBNAIL = 'https://via.placeholder.com/300x150';
const DOWNLOAD_TIMEOUT = 45000;
const MAX_CAROUSEL_ITEMS = 20; // safety cap after dedup

// In-flight request coalescing (see downloadMedia). Key: `platform:url`.
// TTL is short — just long enough to absorb double-taps and the app's
// preview→download sequence, without serving stale CDN URLs.
const inflightFetches = new Map();
const COALESCE_TTL_MS = 60 * 1000;
// Successful results stay cached this long so repeat downloads of the same
// URL skip the race (avoids re-hitting rate-limited scraper upstreams like
// rapidcdn). 5 min is safely under the CDN signature lifetime (~hours).
const RESULT_CACHE_TTL = 5 * 60 * 1000;

/**
 * Sanitize a string into a filesystem-safe filename. Mirrors the proxy
 * controller's safeFilename() but exposed here so the API response can
 * include a pre-cleaned `filename` field clients can use directly.
 *
 * Removes emojis, hashtags, path separators; collapses whitespace; caps
 * length to a budget that fits inside ext4's 255-byte per-component limit
 * (UTF-8 worst case = 4 bytes/char, so 120 chars × 4 = 480-byte ceiling).
 *
 * @param {string} title    Source string (often a TikTok/IG caption)
 * @param {string} ext      File extension to append, e.g. '.mp4'
 * @param {number} [idx]    Optional 1-based index for carousel items
 */
/**
 * Sanitize a string into a filesystem-safe filename. Mirrors the proxy
 * controller's safeFilename() but exposed here so the API response can
 * include a pre-cleaned `filename` field clients can use directly.
 *
 * WHITELIST APPROACH: only keeps ASCII letters/digits/dashes/dots/underscores
 * /parens. Everything else (emojis, CJK, exotic Unicode, hashtags, shell
 * metachars, control codes) is stripped.
 *
 * Why whitelist not blacklist: TikTok titles contain a wild assortment of
 * Unicode that earlier regexes kept missing — Katakana シ (U+30B7), various
 * dingbats, future emoji blocks. Whitelisting means future platform changes
 * can't sneak past us. The key constraint is ext4's 255-byte per-component
 * filename limit on Android — Dio's download() silently fails (no exception,
 * no progress callback) when the path exceeds that. A clean ASCII filename
 * is one byte per char, so 120 chars × 1 byte fits easily.
 *
 * @param {string} title    Source string (often a TikTok/IG caption)
 * @param {string} ext      File extension to append, e.g. '.mp4'
 * @param {number} [idx]    Optional 1-based index for carousel items
 */
function sanitizeForFilename(title, ext, idx = null) {
  let stem = String(title || 'media').trim();

  // Whitelist: keep only ASCII letters, digits, basic punctuation, whitespace
  stem = stem.replace(/[^\w\s.\-()]/g, '');
  // Collapse whitespace runs to a single underscore
  stem = stem.replace(/\s+/g, '_');
  // Trim leading/trailing junk
  stem = stem.replace(/^[._\s-]+|[._\s-]+$/g, '');

  if (!stem) stem = 'media';
  if (stem.length > 120) stem = stem.slice(0, 120);

  if (idx !== null) stem += `_${idx}`;
  if (!ext.startsWith('.')) ext = '.' + ext;
  return stem + ext;
}

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

// Match host suffix, not substring. Substring matching used to mis-route
// tnaflix.com / 1024terabox.com / ugsnx.com to twitter (because they
// contain "x.com"-like substrings) which then 500'd inside the Twitter
// scraper. Using URL.hostname + endsWith eliminates that whole class of
// bug — only real hosts (or *.host) ever match.
const HOST_PLATFORM = [
  ['instagram.com',  'instagram'],
  ['tiktok.com',     'tiktok'],
  ['facebook.com',   'facebook'],
  ['fb.watch',       'facebook'],
  ['x.com',          'twitter'],
  ['twitter.com',    'twitter'],
  ['youtube.com',    'youtube'],
  ['youtu.be',       'youtube'],
  ['pinterest.com',  'pinterest'],
  ['pin.it',         'pinterest'],
  ['threads.net',    'threads'],
  ['threads.com',    'threads'],
  ['linkedin.com',   'linkedin'],
  // ── Named handlers added in 2026-Q2 ─────────────────────────────────────
  // Each of these resolves to a thin wrapper around downloadGeneric (yt-dlp),
  // but mapping them to a recognised platform name gives:
  //   • cleaner Telegram alerts (platform tag = "reddit", not "generic")
  //   • better filenames (extractor picks up the post title)
  //   • a stable extractor key the Flutter client uses to pick the platform
  //     badge / colour / icon.
  ['reddit.com',     'reddit'],
  ['redd.it',        'reddit'],
  ['bilibili.com',   'bilibili'],
  ['b23.tv',         'bilibili'],
  ['bbc.com',        'bbc'],
  ['bbc.co.uk',      'bbc'],
  ['vimeo.com',      'vimeo'],
  ['dailymotion.com','dailymotion'],
  ['dai.ly',         'dailymotion'],
  ['twitch.tv',      'twitch'],
  ['rumble.com',     'rumble'],
  ['soundcloud.com', 'soundcloud'],
  ['vk.com',         'vk'],
  ['vkvideo.ru',     'vk'],
  ['streamable.com', 'streamable'],
  ['odysee.com',     'odysee'],
];

const identifyPlatform = (url) => {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch (_) { return null; }
  if (!host) return null;
  // Normalise leading "www." / "m." / "mobile." / "mbasic." so matching is
  // host-suffix only (host === domain OR host endsWith ".domain").
  for (const [domain, platform] of HOST_PLATFORM) {
    if (host === domain || host.endsWith('.' + domain)) return platform;
  }
  console.warn(`Platform Identification: unrecognised host: ${host}`);
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
  // Repair any malformed CDN URLs before encoding. tikwm sometimes returns
  // URLs with double ampersands, trailing fragments, and other artifacts
  // that some HTTP clients normalize differently — leading to signature
  // mismatches when the upstream verifies the URL. Clean here once.
  let cleanUrl = String(cdnUrl)
    .replace(/&{2,}/g, '&')
    .replace(/[?&]+$/, '');
  const hashIdx = cleanUrl.indexOf('#');
  if (hashIdx !== -1) cleanUrl = cleanUrl.slice(0, hashIdx);

  const encoded  = encodeURIComponent(cleanUrl);
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

async function scrapeInstaEmbed(igUrl, shouldStop = null) {
  // shouldStop: optional callback checked before each of the up-to-18
  // (6 URLs x 3 UAs) fetches. When the parallel race has already been won
  // by another strategy (usually igdl in ~2s), continuing to hammer
  // Instagram with 15+ pointless requests wastes upstream quota and risks
  // IP rate-limiting. The winner sets the flag; we bail at the next
  // iteration boundary.
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
      if (shouldStop && shouldStop()) {
        console.log('📸 instaEmbed: race already won — aborting remaining fetches');
        throw new Error('embed: aborted (race already won)');
      }
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

  // ── Age-gate detection ─────────────────────────────────────────────────
  // 18+ restricted reels serve a gate page ("People under 18 can't see
  // this content" / "account has set limits on who can see"). Every
  // unauthenticated strategy fails on these — throwing the specific error
  // here lets the classifier report AGE_RESTRICTED instead of a misleading
  // TIMEOUT, and tells the user a sign-in is required rather than "retry".
  if (/under 18 can['\u2019]?t see this content|has set limits on who can see|age[- ]?restricted/i.test(html)) {
    throw new Error(`instaEmbed: content is age-restricted (18+) — Instagram requires a signed-in adult account for ${shortcode}`);
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

  // ── Method 2a: video_versions JSON array (modern IG page JSON) ────────────
  // Sponsored/ad reels and newer post pages embed media under
  // "video_versions":[{"url":"...","width":...}] (the xdt API shape) rather
  // than the legacy "video_url" key. This is the key that unlocks sponsored
  // reels — their embed pages are stripped, but the full post page (the
  // 400-900KB responses) still carries video_versions. First entry is the
  // highest quality.
  if (items.length === 0) {
    const vvRe = /"video_versions"\s*:\s*\[\s*\{[^\]]*?"url"\s*:\s*"([^"]+)"/g;
    const thumbM = html.match(/"display_url"\s*:\s*"([^"]+)"/) ||
                   html.match(/"thumbnail_src"\s*:\s*"([^"]+)"/);
    const thumb  = thumbM ? thumbM[1] : '';
    let vv;
    while ((vv = vvRe.exec(html)) !== null) addItem(vv[1], 'video', thumb);
    if (items.length) console.log(`📸 instaEmbed: ${items.length} item(s) via video_versions`);
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

  // ── Reel safeguard ─────────────────────────────────────────────────────────
  // A /reel/ URL is, by definition, a video. When the dynamic JSON is missing
  // from the embed page (Instagram serves a stripped HTML with no
  // video_url / playable_url / edge_sidecar keys) the fallback methods 7-9
  // pick up t51 thumbnail <img> tags instead — and the user ends up
  // "downloading" three low-res JPEGs that look nothing like the reel.
  //
  // Detection: the original URL contains /reel/ AND every extracted item is
  // an image. We discard the result and throw so the caller (formatter or
  // the multi-scraper race) treats this scraper as failed and either falls
  // back to igdl/snapsave or surfaces a clean error to the user.
  const isReelUrl = /\/reel\//i.test(igUrl);
  const allImages = items.every((it) => it.type === 'image');
  if (isReelUrl && allImages) {
    console.warn(
      `📸 instaEmbed: /reel/ ${shortcode} produced only images ` +
      `(${items.length}) — discarding to avoid serving thumbnails as video`
    );
    throw new Error(
      `instaEmbed: reel ${shortcode} returned no video items ` +
      `(only ${items.length} thumbnail image(s))`
    );
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

  // ── unwrap JWT relay URLs ──────────────────────────────────────────────────
  // igdl returns d.rapidcdn.app/v2?token=<jwt> URLs that wrap the real
  // cdninstagram.com URL inside a base64-encoded JWT payload. d.rapidcdn.app
  // is not resolvable from mobile carriers OR from Koyeb's egress, so we MUST
  // decode the JWT to extract the real CDN URL — the proxy can then fetch it.
  // Falls back to the raw URL when there is no JWT to decode (snapsave/embed
  // already return cdninstagram.com URLs directly).
  const cdnUrl = decodeCdnUrl(rawUrl) || rawUrl;
  const jwtUrl = rawUrl.includes('token=') ? extractJwtCdnUrl(rawUrl) : null;
  const url    = jwtUrl || cdnUrl || rawUrl;

  if (jwtUrl) {
    console.log(`🔓 IG JWT decoded → ${jwtUrl.slice(0, 90)}…`);
  }

  // ── type detection ─────────────────────────────────────────────────────────
  let type = '';
  const rawType = (item.type || '').toString().toLowerCase();
  if (rawType === 'video' || rawType === 'image') {
    type = rawType;
  } else {
    type = detectTypeFromUrl(url) || detectTypeFromJwtUrl(rawUrl) || 'video';
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
    const decodedThumb = rawThumb && rawThumb.includes('token=')
      ? (extractJwtCdnUrl(rawThumb) || rawThumb)
      : rawThumb;
    thumbnail = isThumbnailValidForType(rawThumb, 'video')
      ? (decodedThumb || fallbackThumbnail)
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
  // Strategy lineup (2026-07 rework — fixes the "fails, works on retry"
  // pattern users were hitting):
  //
  //   1. igdl (btch-downloader) — primary; works for /p/ AND /reel/.
  //      NOW WITH INTERNAL AUTO-RETRY: igdl is flaky (rapidcdn upstream),
  //      but a fresh attempt usually succeeds — which is exactly why users'
  //      manual retries worked. We do that retry server-side: 2 attempts ×
  //      12s each instead of one 15s attempt.
  //   2. scrapeInstaEmbed — fallback for ALL post types now, including
  //      /reel/. Previously skipped for reels ("thumbnails-only"), which
  //      left igdl as the ONLY strategy for reels — a single igdl timeout
  //      meant total failure (the "embed: n/a" lines in prod logs). The
  //      embed scraper's og:video / video_url / playable_url paths DO
  //      recover many reels; for reels we simply require at least one
  //      VIDEO item so a thumbnails-only result can't masquerade as a win.
  //
  // RETIRED (default OFF, opt-in via env):
  //   - facebookInsta(url, {…})  (snapsave + snapinsta race) — 0% success
  //     rate as of 2026-05; snapinsta.app DNS is dead from EU regions
  //     (getaddrinfo EAI_AGAIN) and snapsave.app returns 404. Re-enable
  //     with IG_USE_SNAPSAVE=1.
  //
  // Behaviour: FIRST-SUCCESS race (not allSettled). The first strategy to
  // produce usable items resolves the request immediately — we no longer
  // wait for slow losers. If igdl attempt-1 succeeds in 2s, the user gets
  // their media in 2s even while embed is still mid-flight.
  async instagram(url, req) {
    const userCookies = req?.body?.cookies || {};
    const igCookie    = userCookies.instagram || null;

    // ── STORIES: route straight to the story pipeline ────────────────────
    // instagram.com/stories/<user>/<pk> URLs can't be handled by igdl or
    // the embed scraper (no /p|reel|tv/ shortcode → both fail instantly).
    // facebookInstaService has the full story machinery — public mirrors
    // (storiesig.info, anonyig.com, imginn.com) → cookie GraphQL → yt-dlp —
    // but before 2026-07 it was only reachable behind IG_USE_SNAPSAVE=1,
    // which is OFF by default. That meant story URLs NEVER worked. Route
    // them explicitly here, unconditionally.
    if (/instagram\.com\/stories\//i.test(url)) {
      console.log('📸 Instagram story URL → story pipeline');
      const res = await downloadWithTimeout(
        () => facebookInsta(url, { igCookie }),
        40000,
      );
      const items = Array.isArray(res?.data) && res.data.length ? res.data : null;
      if (!items) throw new Error('Instagram story: no items returned');
      console.log(`📸 Instagram story ✓ ${items.length} item(s) via ${res._source || 'stories'}`);
      return { _items: items, _source: res._source || 'stories', _req: req };
    }

    const ENABLE_SNAPSAVE_IG = process.env.IG_USE_SNAPSAVE === '1';
    const isReelUrl = /instagram\.com\/reel\//i.test(url);

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

    // Set to true the moment any strategy wins — checked by runEmbed's
    // scraper between fetches so losers stop hammering Instagram.
    let raceWon = false;

    // ── Strategy 1: igdl with internal auto-retry ────────────────────────
    // Up to 3 attempts, 8s hard cap each (24s worst case, inside the 45s
    // budget). igdl's upstream (rapidcdn) frequently times out on the FIRST
    // call but succeeds within 1-2s on a retry — production logs showed a
    // reel fail the whole race at 12s, then succeed via igdl in 1.5s on the
    // user's manual retry. Tighter per-attempt caps + a third attempt turn
    // that manual retry into an automatic one: 8s → fail fast → retry →
    // usually wins in ~1-2s, so the user gets the video on the first try.
    const runIgdl = async () => {
      let lastErr = null;
      // rapidcdn (igdl's upstream) answers in ~1-2s when alive or hangs
      // otherwise, so a real success is never near the cap. Staggered caps
      // (6/7/8s) fail a dead attempt fast and move to the retry that
      // usually wins — total worst case 21s, inside the 45s budget.
      const caps = [6000, 7000, 8000];
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const d = await downloadWithTimeout(() => igdl(url), caps[attempt - 1]);
          const items = extractItems(d);
          if (items) {
            if (attempt > 1) console.log(`📸 igdl succeeded on retry #${attempt}`);
            return { items, source: 'igdl' };
          }
          lastErr = new Error('igdl: empty/unusable response');
        } catch (e) {
          lastErr = e instanceof Error ? e : new Error(String(e));
          console.warn(`⚠️ igdl attempt ${attempt} failed:`, lastErr.message);
        }
        // Brief backoff before retry: rapidcdn rate-limits by burst, so an
        // immediate retry often hits the same throttle. A short pause lets
        // it clear. Skip after the last attempt.
        if (attempt < 3) await new Promise(r => setTimeout(r, 500));
      }
      throw new Error(`igdl: ${lastErr?.message || 'failed'} (after 3 attempts)`);
    };

    // ── Strategy 2: embed scrape — now for reels too ─────────────────────
    // For reels, only a result containing at least one VIDEO item counts;
    // thumbnails-only responses are rejected so the user never gets a JPG
    // when they asked for a reel.
    const runEmbed = async () => {
      const d = await downloadWithTimeout(() => scrapeInstaEmbed(url, () => raceWon), 15000);
      const items = Array.isArray(d) && d.length > 0 ? d : null;
      if (!items) throw new Error('embed: no items');
      if (isReelUrl && !items.some(it => it && it.type === 'video')) {
        throw new Error('embed: reel URL but only non-video items found');
      }
      return { items, source: 'embed' };
    };

    // ── Strategy 3: snapsave / snapinsta — opt-in only ───────────────────
    const runSnapsave = async () => {
      const d = await downloadWithTimeout(() => facebookInsta(url, { igCookie }), 20000);
      const items = extractItems(d);
      if (!items) throw new Error('snapsave: empty/unusable response');
      return { items, source: 'snapsave' };
    };

    // ── Strategy 3: Instagram GraphQL (IG's own API) ─────────────────────
    // POST /api/graphql with the public doc_id resolves public posts and
    // reels — INCLUDING sponsored/ad reels, whose embed pages are stripped
    // to thumbnails and where igdl's upstream is flakiest. No cookie needed
    // for public content; the X-IG-App-ID header is Instagram's own web
    // app id. Independent of any third-party mirror.
    const runGraphql = async () => {
      const m = url.match(/instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
      if (!m) throw new Error('graphql: cannot extract shortcode');
      const shortcode = m[1];

      const resp = await downloadWithTimeout(() => axios.post(
        'https://www.instagram.com/api/graphql',
        new URLSearchParams({
          variables: JSON.stringify({
            shortcode,
            fetch_tagged_user_count: null,
            hoisted_comment_id: null,
            hoisted_reply_id: null,
          }),
          doc_id: '8845758582119845',
        }).toString(),
        {
          timeout: 12000,
          validateStatus: () => true,
          headers: {
            'Content-Type':     'application/x-www-form-urlencoded',
            'User-Agent':       'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'X-IG-App-ID':      '936619743392459',
            'X-FB-LSD':         'AVqbxe3J_YA',
            'X-ASBD-ID':        '129477',
            Origin:             'https://www.instagram.com',
            Referer:            `https://www.instagram.com/reel/${shortcode}/`,
          },
        }
      ), 13000);

      const media = resp.data?.data?.xdt_shortcode_media;
      if (!media) throw new Error(`graphql: no xdt_shortcode_media (status ${resp.status})`);

      const items = [];
      const push = (node) => {
        if (node.is_video && node.video_url) {
          items.push({ url: node.video_url, type: 'video', thumbnail: node.display_url || '' });
        } else if (node.display_url) {
          items.push({ url: node.display_url, type: 'image', thumbnail: node.display_url });
        }
      };
      const edges = media.edge_sidecar_to_children?.edges;
      if (Array.isArray(edges) && edges.length) edges.forEach(e => push(e.node || {}));
      else push(media);

      if (!items.length) throw new Error('graphql: media object had no usable URLs');
      if (isReelUrl && !items.some(it => it.type === 'video')) {
        throw new Error('graphql: reel URL but no video in media object');
      }
      return { items, source: 'graphql' };
    };

    // ── Strategy 3b: reel page JSON scrape (no rapidcdn, no graphql) ──────
    // igdl (rapidcdn) is flaky and graphql often soft-blocks datacenter IPs
    // (200 with null xdt_shortcode_media). This hits the reel page directly
    // with a real browser fingerprint and mines the embedded media JSON —
    // a different endpoint/fingerprint than graphql, so it frequently
    // succeeds when graphql returns null. Looks for video_versions (modern)
    // then video_url (legacy) in the page's inline JSON.
    const runPageScrape = async () => {
      const m = url.match(/instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
      if (!m) throw new Error('page-scrape: cannot extract shortcode');
      const shortcode = m[1];

      const resp = await downloadWithTimeout(() => axios.get(
        `https://www.instagram.com/reel/${shortcode}/`,
        {
          timeout: 10000,
          validateStatus: () => true,
          headers: {
            'User-Agent':      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
            'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Sec-Fetch-Dest':  'document',
            'Sec-Fetch-Mode':  'navigate',
            'Sec-Fetch-Site':  'none',
            'Cache-Control':   'no-cache',
          },
        }
      ), 11000);

      const html = typeof resp.data === 'string' ? resp.data : '';
      if (!html || html.length < 500) throw new Error(`page-scrape: empty HTML (status ${resp.status})`);

      // Age gate check (same as embed)
      if (/under 18 can['\u2019]?t see this content|has set limits on who can see/i.test(html)) {
        throw new Error('page-scrape: content is age-restricted (18+)');
      }

      const unesc = (s) => s.replace(/\\u0026/gi, '&').replace(/\\\//g, '/').replace(/\\"/g, '"');
      const items = [];
      // Modern: video_versions array
      const vv = html.match(/"video_versions":\s*\[\s*\{[^\]]*?"url":"([^"]+)"/);
      if (vv) {
        items.push({ url: unesc(vv[1]).replace(/&amp;/g, '&'), type: 'video', thumbnail: '' });
      } else {
        // Legacy: video_url key
        const vu = html.match(/"video_url":"([^"]+)"/);
        if (vu) items.push({ url: unesc(vu[1]).replace(/&amp;/g, '&'), type: 'video', thumbnail: '' });
      }

      if (!items.length) throw new Error('page-scrape: no video URL in page JSON');
      return { items, source: 'page-scrape' };
    };

    // ── Strategy 4: cookie-authenticated media API ───────────────────────
    // The ONLY path that works for 18+ age-gated reels (see the "People
    // under 18 can't see this content" gate). Runs only when a session
    // cookie exists — per-request from the app's sign-in flow, or the
    // IG_SESSION_COOKIE env var (use a throwaway ADULT account; cookies
    // expire in ~30-90 days). Uses IG's private media-info endpoint with
    // the shortcode→pk conversion (IG's base64url alphabet).
    const activeIgCookie = igCookie || process.env.IG_SESSION_COOKIE || '';
    const runCookieApi = async () => {
      if (!activeIgCookie) throw new Error('cookie-api: no IG session cookie configured');
      const m = url.match(/instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
      if (!m) throw new Error('cookie-api: cannot extract shortcode');

      const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
      let pk = 0n;
      for (const c of m[1]) {
        const idx = ALPHABET.indexOf(c);
        if (idx === -1) throw new Error('cookie-api: invalid shortcode character');
        pk = pk * 64n + BigInt(idx);
      }

      const resp = await downloadWithTimeout(() => axios.get(
        `https://i.instagram.com/api/v1/media/${pk.toString()}/info/`,
        {
          timeout: 12000,
          validateStatus: () => true,
          headers: {
            'User-Agent':  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'X-IG-App-ID': '936619743392459',
            Accept:        'application/json',
            Cookie:        activeIgCookie,
            Referer:       'https://www.instagram.com/',
          },
        }
      ), 13000);

      if (resp.status === 401 || resp.status === 403) {
        throw new Error('cookie-api: IG cookie appears stale (auth rejected)');
      }
      const item = resp.data?.items?.[0];
      if (!item) throw new Error(`cookie-api: no media item (status ${resp.status})`);

      const items = [];
      const push = (node) => {
        const vid = node.video_versions?.[0]?.url;
        const img = node.image_versions2?.candidates?.[0]?.url;
        if (vid)      items.push({ url: vid, type: 'video', thumbnail: img || '' });
        else if (img) items.push({ url: img, type: 'image', thumbnail: img });
      };
      if (Array.isArray(item.carousel_media) && item.carousel_media.length) {
        item.carousel_media.forEach(push);
      } else {
        push(item);
      }

      if (!items.length) throw new Error('cookie-api: media item had no usable URLs');
      return { items, source: 'cookie-api' };
    };

    const strategies = [runIgdl()];
    strategies.push(runEmbed());
    strategies.push(runGraphql());
    strategies.push(runPageScrape());
    if (activeIgCookie) strategies.push(runCookieApi());
    if (ENABLE_SNAPSAVE_IG) strategies.push(runSnapsave());

    // ── First-success race ───────────────────────────────────────────────
    // Resolve on the first strategy that yields usable items; reject only
    // when every strategy has failed. Losing strategies keep running in the
    // background but their results are ignored (their own timeouts stop
    // them from leaking).
    const startedAt = Date.now();
    const winner = await new Promise((resolve, reject) => {
      let done = false, settled = 0;
      const errors = [];
      strategies.forEach(p => p.then(
        v => {
          if (done) return;
          done = true;
          raceWon = true;
          console.log(`📸 Instagram won by [${v.source}] in ${Date.now() - startedAt}ms (items=${v.items.length})`);
          resolve(v);
        },
        e => {
          errors.push(e?.message || String(e));
          settled++;
          if (settled === strategies.length && !done) {
            done = true;
            console.log(`📸 Instagram: ALL ${strategies.length} scrapers failed in ${Date.now() - startedAt}ms`);
            reject(new Error(`Instagram: all scrapers failed. ${errors.join('  |  ')}`));
          }
        }
      ));
    });

    console.log(`📸 Instagram scrapers: ${winner.source}=${winner.items.length}`);
    console.log(`📸 Using ${winner.source}`);
    return { _items: winner.items, _source: winner.source, _req: req };
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
    // Pull the per-request FB cookie from the request body, if any.
    // facebookInsta() falls back to FB_SESSION_COOKIE env var when null.
    const userCookies = req?.body?.cookies || {};
    const fbCookie    = userCookies.facebook || null;

    const raw = await downloadWithTimeout(
      () => facebookInsta(url, { fbCookie }),
      60000,
    );
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
    // The Twitter service now wraps a 4-strategy chain (fxTwitter →
    // vxTwitter → syndication → btch). It already throws a clean
    // "Invalid Twitter URL" or "All download methods failed" error when
    // every strategy fails — no need for a separate primary/fallback split
    // at this layer.
    const data = await downloadWithTimeout(() => downloadTwmateData(url));
    if (!data || (!Array.isArray(data) && !data.data && !data.url)) {
      throw new Error('Twitter download failed - no usable data returned');
    }
    return data;
  },

  async youtube(url, req) {
    console.log('YouTube: Processing URL:', url);
    try {
      // 22s outer cap. The youtubeService race now imposes per-strategy
      // deadlines (max 18s for yt-dlp, 8-12s for the others) and resolves
      // on the first success — so a healthy fetch lands in 1-6s. The 22s
      // ceiling is the absolute "all sources failed" budget. Old value
      // (75-90s) made users wait 1-2 minutes for a known failure to bubble
      // up; many users gave up before seeing the error.
      const timeout = 22000;
      const data    = await downloadWithTimeout(() => fetchYouTubeData(url), timeout);
      if (!data || !data.title) throw new Error('YouTube service returned invalid data');
      console.log('YouTube: Successfully fetched data, formats count:', data.formats?.length || 0);
      if (data.formats) {
        const serverBaseUrl = getServerBaseUrl(req);
        // Drop entries whose URL isn't a usable string. Innertube can
        // produce undefined/null URLs when YT's signature decipher fails
        // for a single format — without this guard the whole response
        // 500'd with "format.url.startsWith is not a function".
        data.formats = data.formats.filter(f => typeof f?.url === 'string' && f.url);
        data.formats.forEach(format => {
          if (typeof format.url === 'string' && format.url.startsWith('MERGE:')) {
            const parts = format.url.split(':');
            if (parts.length >= 3) {
              format.url = `${serverBaseUrl}/api/merge-audio?videoUrl=${encodeURIComponent(parts[1])}&audioUrl=${encodeURIComponent(parts[2])}`;
            }
          }
        });
        if (typeof data.url === 'string' && data.url.startsWith('MERGE:')) {
          const parts = data.url.split(':');
          if (parts.length >= 3)
            data.url = `${serverBaseUrl}/api/merge-audio?videoUrl=${encodeURIComponent(parts[1])}&audioUrl=${encodeURIComponent(parts[2])}`;
        }
        // If the chosen `data.url` was the same broken format we just dropped,
        // re-aim it at the first surviving format so callers always get a
        // usable downloadable URL.
        if ((!data.url || typeof data.url !== 'string') && data.formats[0]?.url) {
          data.url = data.formats[0].url;
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
      // Keep the real error text in the message — the old generic
      // "timed out" replacement hid bot-detection and other classifiable
      // causes from the error classifier and the Telegram alerts, so
      // every failure looked like a slowness problem.
      if (error.message.includes('timeout') && !/bot|sign in/i.test(error.message))
        throw new Error(`YouTube download timed out — ${error.message}`);
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
  },

  // ─── GENERIC (yt-dlp fallback) ────────────────────────────────────────────
  // Catches every site identifyPlatform() doesn't recognise — vimeo,
  // dailymotion, soundcloud, twitch, vk, rumble, douyin, streamable, kick,
  // plus ~1700 others yt-dlp supports out of the box. Slower than the
  // dedicated services (yt-dlp spawn + extraction) but covers the long
  // tail of "abrupt" platforms users share.
  async generic(url) {
    return downloadWithTimeout(() => downloadGeneric(url), 55000);
  },

  // ─── NAMED yt-dlp HANDLERS ───────────────────────────────────────────────
  // These all wrap downloadGeneric (yt-dlp) but pin the platform name in the
  // response so the client knows which badge / icon to show and so Telegram
  // alerts route to the right tag. yt-dlp's own `extractor_key` is already
  // populated; we use it preferentially in the formatter below.
  //
  // Why explicit named handlers? Two reasons:
  //   1. Naming the platform up-front (in HOST_PLATFORM) means the URL
  //      validation, share-handler routing, and the failure-alert tagging
  //      all see the right name BEFORE yt-dlp runs (otherwise everything
  //      is "generic" until extraction completes 5-15s later).
  //   2. We can override the title / filename per-platform here when yt-dlp's
  //      default extractor leaves something to be desired (e.g. Reddit's
  //      "video_<id>" placeholder when the post title is empty).
  async reddit(url)      { return downloadWithTimeout(() => downloadGeneric(url), 45000); },
  async bilibili(url)    { return downloadWithTimeout(() => downloadGeneric(url), 55000); },
  async bbc(url)         { return downloadWithTimeout(() => downloadGeneric(url), 55000); },
  async vimeo(url)       { return downloadWithTimeout(() => downloadGeneric(url), 45000); },
  async dailymotion(url) { return downloadWithTimeout(() => downloadGeneric(url), 45000); },
  async twitch(url)      { return downloadWithTimeout(() => downloadGeneric(url), 55000); },
  async rumble(url)      { return downloadWithTimeout(() => downloadGeneric(url), 45000); },
  async soundcloud(url)  { return downloadWithTimeout(() => downloadGeneric(url), 45000); },
  async vk(url)          { return downloadWithTimeout(() => downloadGeneric(url), 45000); },
  async streamable(url)  { return downloadWithTimeout(() => downloadGeneric(url), 45000); },
  async odysee(url)      { return downloadWithTimeout(() => downloadGeneric(url), 45000); },
};

// ===== DATA FORMATTERS =====

const dataFormatters = {

  // ─── INSTAGRAM ────────────────────────────────────────────────────────────
  instagram(data) {
    console.log('📸 Instagram formatter: keys=', Object.keys(data || {}));

    // Stashed by the platformDownloaders.instagram() handler so we can
    // build /api/proxy-download URLs here. When req is null (e.g.
    // direct unit-test invocation) we leave URLs untouched.
    const req        = data?._req || null;
    const serverBase = req ? getServerBaseUrl(req) : '';

    // Wraps any Instagram CDN URL in the server's /api/proxy-download
    // route. The server will fetch the upstream and stream it to the
    // app, bypassing two classes of failures on the client:
    //   1. DNS-only-on-server hosts (d.rapidcdn.app, the igdl JWT
    //      relay) — mobile DNS doesn't resolve these.
    //   2. CDN region/IP gating that rejects requests coming from
    //      consumer mobile networks (cdninstagram.com sometimes does
    //      this when the Referer doesn't match).
    // Already-proxied URLs and non-http URLs short-circuit unchanged.
    const proxy = (cdnUrl) => {
      if (!cdnUrl) return cdnUrl;
      const s = String(cdnUrl);
      if (s.includes('/api/proxy-download')) return s;
      if (!serverBase) return s;
      if (!/^https?:\/\//i.test(s)) return s;
      return wrapForProxy(s, 'instagram', 'Instagram Post', serverBase);
    };

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
      const rawSingle   = pickBestUrl(data.url || '');
      const jwtSingle   = rawSingle.includes('token=') ? extractJwtCdnUrl(rawSingle) : null;
      const resolvedUrl = jwtSingle || decodeCdnUrl(rawSingle) || rawSingle;
      if (jwtSingle) {
        console.log(`🔓 IG JWT decoded (single) → ${jwtSingle.slice(0, 90)}…`);
      }
      console.log('📸 Instagram: single item fallback, url=', resolvedUrl.slice(0, 80));
      return {
        title:     data.title || postTitle,
        url:       proxy(resolvedUrl),
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

    const mediaItems = cappedItems
      .map((item, index) =>
        normalizeMediaItem(item, index, item.thumbnail || PLACEHOLDER_THUMBNAIL)
      )
      // Wrap each final URL through the proxy. Done AFTER normalize so
      // type detection (which inspects the original CDN URL pattern)
      // still runs on the raw URL.
      .map((it) => ({ ...it, url: proxy(it.url) }));

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
      // Explicit count + flag so the client never double-saves. The app's
      // download logic should treat a result as a carousel ONLY when
      // mediaItems is present AND has >1 entry; for a single video it must
      // save the top-level `url` exactly once and ignore mediaItems. We
      // therefore only attach mediaItems for true multi-item carousels,
      // and always send mediaCount so the client has an unambiguous signal.
      mediaCount: mediaItems.length,
      isSingle:   mediaItems.length === 1,
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

    // ── Photo posts (from tryFbPhotoPost) ────────────────────────────────
    // Shape: { photos: [url,...], thumbnail, title }. Multi-photo posts
    // become mediaItems so the app renders a carousel; single photo is a
    // plain image response. Proxy-wrap each so fbcdn referer checks pass.
    if (Array.isArray(data.photos) && data.photos.length > 0) {
      const wrap = (u) => serverBase
        ? wrapForProxy(u, 'facebook', title, serverBase)
        : u;
      const photos = data.photos.map((u, i) => ({
        url:       wrap(u),
        type:      'image',
        thumbnail: wrap(u),
        index:     i,
      }));
      console.log(`📘 FB formatter: photo post — ${photos.length} image(s)`);
      return {
        title,
        url:        photos[0].url,
        thumbnail:  photos[0].thumbnail,
        sizes:      ['Original'],
        source:     'facebook',
        type:       'image',
        mediaCount: photos.length,
        isSingle:   photos.length === 1,
        ...(photos.length > 1 && { mediaItems: photos }),
      };
    }

    // lookaside.fbsbx.com/lookaside/crawler/media/?media_id=… is FB's open-
    // graph crawler endpoint — it returns HTML to non-bot UAs, not video
    // bytes. If a strategy upstream returned one (the bot-UA path can leak
    // these into `playable_url` JSON keys) the proxy would stream HTML
    // labelled as .mp4 to the client, producing a non-playable file.
    // Reject these here as a safety net so a single buggy strategy can't
    // corrupt the response.
    const isLookasideCrawlerUrl = (u) =>
      typeof u === 'string' && /lookaside\.fbsbx\.com\/lookaside\/crawler/i.test(u);

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
      const valid = data.media.filter(i => i?.url && !isLookasideCrawlerUrl(i.url));
      if (!valid.length) throw new Error('Facebook media array has no usable video URLs (only crawler links found)');
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

    const fbData = (data?.data || []).filter(v => v?.url && !isLookasideCrawlerUrl(v.url));
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

    const fallbackCandidates = [data?.url, data?.download, data?.video, data?.videoUrl]
      .filter(u => typeof u === 'string' && u && !isLookasideCrawlerUrl(u));
    const fallback = fallbackCandidates[0] || '';
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
    // ── Photo tweets ─────────────────────────────────────────────────────
    // Variants with image/* types come from the /photo/N support in
    // twitterService (fxtwitter media.photos / vxtwitter image mediaURLs).
    // Multi-photo tweets become mediaItems so the app renders them like an
    // Instagram carousel. pbs.twimg.com serves images without referer
    // checks, so no proxy wrap is needed.
    if (Array.isArray(data) && data.length > 0) {
      const isImage = (it) => String(it?.type || '').startsWith('image');
      const photos = data.filter(isImage);
      if (photos.length > 0 && photos.length === data.length) {
        return {
          title:      'Twitter Photo',
          url:        photos[0].url,
          thumbnail:  photos[0].url,
          sizes:      ['Original'],
          source:     'twitter',
          type:       'image',
          mediaItems: photos.map((p, i) => ({
            url:       p.url,
            type:      'image',
            thumbnail: p.url,
            index:     i,
          })),
        };
      }
    }

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
      // Strip formats with non-string URLs (innertube decipher failures)
      // before quality selection — otherwise we may pick a broken format.
      qualityOptions  = (data.formats || data.allFormats)
        .filter(f => typeof f?.url === 'string' && f.url);
      selectedQuality = qualityOptions.find(opt => opt.quality?.includes('360p')) || qualityOptions[0];
      defaultUrl      = selectedQuality?.url || data.url;

      const serverBaseUrl = getServerBaseUrl(req);
      qualityOptions.forEach(format => {
        if (typeof format.url === 'string' && format.url.startsWith('MERGE:')) {
          const parts = format.url.split(':');
          if (parts.length >= 3)
            format.url = `${serverBaseUrl}/api/merge-audio?videoUrl=${encodeURIComponent(parts[1])}&audioUrl=${encodeURIComponent(parts[2])}`;
        }
      });
      if (typeof selectedQuality?.url === 'string' && selectedQuality.url.startsWith('MERGE:')) {
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
  },

  // ─── GENERIC (yt-dlp output) ─────────────────────────────────────────────
  // Output of Services/genericService.js already matches the YouTube shape
  // (title/url/formats/selectedQuality/etc.) so the existing client code
  // can consume it without changes. The `source` field carries yt-dlp's
  // extractor key (e.g. "reddit", "vimeo", "twitch") so the client can
  // tag the download appropriately.
  generic(data) {
    if (!data || !data.url) throw new Error('Generic: no URL returned');
    const formats = Array.isArray(data.formats) ? data.formats : [];
    return {
      title:           data.title || 'Media',
      url:             data.url,
      thumbnail:       data.thumbnail || PLACEHOLDER_THUMBNAIL,
      sizes:           formats.map(f => f.quality),
      duration:        data.duration || 'unknown',
      source:          (data.platform || 'generic').toLowerCase(),
      extractor:       data.extractor || 'generic',
      formats,
      allFormats:      formats,
      selectedQuality: data.selectedQuality || formats[0] || null,
    };
  },

  // ─── NAMED yt-dlp FORMATTERS ─────────────────────────────────────────────
  // Each delegates to the generic formatter, then overrides `source` with the
  // platform's canonical name so the Flutter client picks the right badge,
  // colour, and filename pattern. The override also stabilises the value when
  // yt-dlp's `extractor_key` capitalisation varies between versions
  // ("BiliBili" vs "bilibili", "Reddit" vs "reddit").
  reddit(data)      { return { ...dataFormatters.generic(data), source: 'reddit',      title: data?.title || 'Reddit Post' }; },
  bilibili(data)    { return { ...dataFormatters.generic(data), source: 'bilibili',    title: data?.title || 'Bilibili Video' }; },
  bbc(data)         { return { ...dataFormatters.generic(data), source: 'bbc',         title: data?.title || 'BBC Video' }; },
  vimeo(data)       { return { ...dataFormatters.generic(data), source: 'vimeo',       title: data?.title || 'Vimeo Video' }; },
  dailymotion(data) { return { ...dataFormatters.generic(data), source: 'dailymotion', title: data?.title || 'Dailymotion Video' }; },
  twitch(data)      { return { ...dataFormatters.generic(data), source: 'twitch',      title: data?.title || 'Twitch Clip' }; },
  rumble(data)      { return { ...dataFormatters.generic(data), source: 'rumble',      title: data?.title || 'Rumble Video' }; },
  soundcloud(data)  { return { ...dataFormatters.generic(data), source: 'soundcloud',  title: data?.title || 'SoundCloud Audio' }; },
  vk(data)          { return { ...dataFormatters.generic(data), source: 'vk',          title: data?.title || 'VK Video' }; },
  streamable(data)  { return { ...dataFormatters.generic(data), source: 'streamable',  title: data?.title || 'Streamable Video' }; },
  odysee(data)      { return { ...dataFormatters.generic(data), source: 'odysee',      title: data?.title || 'Odysee Video' }; },
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
    // identifyPlatform() returns one of the 8 dedicated platforms or null.
    // null means we fall back to the generic yt-dlp handler, which covers
    // ~1700 sites (reddit/vimeo/dailymotion/twitch/soundcloud/vk/rumble/
    // bilibili/douyin/streamable/kick/odysee/etc.). The "Unsupported
    // platform" 400 is only useful when there is no fallback at all —
    // since we now have one, we route through it.
    const platform = identifyPlatform(cleanedUrl) || 'generic';

    let processedUrl = cleanedUrl;
    if (platform === 'youtube') {
      processedUrl = normalizeYouTubeUrl(cleanedUrl);
      console.log(`YouTube URL processed: ${cleanedUrl} -> ${processedUrl}`);
    }

    console.log(`Platform Identification: Determining the platform for the given URL.`);
    console.log(`Download Media: Fetching data for platform '${platform}'.`);

    const downloader = platformDownloaders[platform];
    if (!downloader) throw new Error(`No downloader available for platform: ${platform}`);

    // ── In-flight coalescing ─────────────────────────────────────────────
    // The app frequently fires the same URL 2-3× within seconds (double-tap,
    // widget rebuild, preview + download). Production logs showed every
    // share/r URL running the FULL strategy race twice concurrently — double
    // the mirror load, double the yt-dlp spawns, for byte-identical results.
    // Concurrent duplicates share one fetch; SUCCESSFUL results are then
    // cached as resolved data for RESULT_CACHE_TTL so repeat downloads of
    // the same reel within that window skip the race entirely — critical
    // because igdl's upstream (rapidcdn) rate-limits by IP, so re-racing
    // the same URL repeatedly is what causes the intermittent timeouts.
    // Failures are NOT cached and are evicted immediately so a retry gets
    // a fresh attempt.
    const needsReq = ['youtube', 'facebook', 'tiktok', 'instagram'];
    const coalesceKey = `${platform}:${processedUrl}`;
    let entry = inflightFetches.get(coalesceKey);
    if (entry && (entry.resolved || Date.now() - entry.ts < COALESCE_TTL_MS)) {
      const kind = entry.resolved ? 'cached result' : 'in-flight';
      console.log(`♻️ Coalescing duplicate request [${platform}] (${kind}): ${processedUrl.slice(0, 80)}`);
    } else {
      entry = {
        ts: Date.now(),
        resolved: false,
        promise: (needsReq.includes(platform)
          ? downloader(processedUrl, req)
          : downloader(processedUrl)
        ).catch(err => {
          // Failures must not poison retries — evict immediately.
          inflightFetches.delete(coalesceKey);
          throw err;
        }),
      };
      inflightFetches.set(coalesceKey, entry);
      if (inflightFetches.size > 300) {
        const oldest = inflightFetches.keys().next().value;
        inflightFetches.delete(oldest);
      }
      // On success, mark resolved so later duplicates reuse the data, and
      // schedule eviction after the result-cache TTL (CDN signatures in the
      // proxy URLs stay valid well beyond this window).
      entry.promise.then(() => {
        entry.resolved = true;
        setTimeout(() => {
          if (inflightFetches.get(coalesceKey) === entry) inflightFetches.delete(coalesceKey);
        }, RESULT_CACHE_TTL).unref?.();
      }, () => {});
    }
    const data = await entry.promise;

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

    // Cancel any held (retryable) Telegram failure alert for this URL — a
    // previous attempt may have timed out and scheduled an alert; the
    // download working now means that was a false alarm.
    try { telegram.recordSuccess(platform, url); } catch (_) {}

    // ── Filename sanitization ──────────────────────────────────────────────
    // Add a clean `filename` field derived from the title, so clients can use
    // it directly without re-implementing the same emoji/hashtag stripping.
    //
    // Why this matters: TikTok captions often run 400+ chars with emojis like
    // 🔥💯シ and dozens of #hashtags. The Linux ext4 filesystem on Android caps
    // each filename at 255 bytes, and Dio's download() silently fails (no
    // exception, no progress callback) when the path exceeds that. Without
    // this server-side fix every client has to re-do the same sanitization
    // and bugs creep in over time.
    //
    // We sanitize THREE fields:
    //   1. `filename`  — primary clean field for the file write
    //   2. `title`     — also sanitized, because the deployed Dart code falls
    //                    back to title when filename isn't picked correctly.
    //                    UI doesn't display titles for downloads, so this is
    //                    safe. Original raw title preserved as `rawTitle`
    //                    for any client that needs it for display.
    //   3. mediaItems[].filename — same treatment for carousel items
    //
    // ALWAYS sanitize — never skip even if upstream set a filename, because
    // upstream may have set it to the raw title (dirty). Re-sanitizing
    // already-clean input is a safe no-op.
    if (formattedData && typeof formattedData === 'object') {
      const ext = platform === 'tiktok' ? '.mp4' :
                  formattedData.isImageSlideshow ? '.jpg' : '.mp4';

      // Preserve the original rich title in case any client wants it for
      // display (e.g. captions, share text, etc.)
      if (formattedData.title) {
        formattedData.rawTitle = formattedData.title;
      }

      // Source for the filename: prefer existing filename if set, fall back to title
      const source = formattedData.filename || formattedData.title;
      formattedData.filename = sanitizeForFilename(source, ext);

      // Replace the title with the sanitized basename (no extension) so
      // any Dart code that builds `${title}.mp4` for a path will still get
      // a safe ASCII filename. The .mp4 extension gets re-added by the
      // download code based on Content-Type.
      const cleanStem = formattedData.filename.replace(/\.[a-z0-9]{2,5}$/i, '');
      formattedData.title = cleanStem;

      console.log(`🧼 sanitized filename: ${formattedData.filename}`);
      console.log(`🧼 sanitized title:    ${formattedData.title}`);
    }

    // Same treatment for individual mediaItems (carousel posts) — always
    // re-sanitize, even if upstream set a filename.
    if (Array.isArray(formattedData?.mediaItems)) {
      formattedData.mediaItems.forEach((item, i) => {
        if (item) {
          const ext = item.type === 'image' ? '.jpg' : '.mp4';
          // For carousel: use item's own title if set, else parent title, else 'media'
          const source = item.filename || item.title || formattedData.rawTitle || 'media';
          item.filename = sanitizeForFilename(source, ext, i + 1);
          // Sanitize item.title too if it exists
          if (item.title) {
            item.rawTitle = item.title;
            item.title = item.filename.replace(/\.[a-z0-9]{2,5}$/i, '');
          }
        }
      });
    }

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

    // ── Login-wall detection ───────────────────────────────────────────
    // The underlying scrapers throw error strings containing recognizable
    // phrases when they hit a sign-in requirement (FB stories, IG stories,
    // private posts, follower-only reels). When that happens we return a
    // special LOGIN_REQUIRED code so the Flutter app can route the user
    // into the sign-in flow with the platform browser instead of just
    // showing a generic "fetch failed".
    // ── Login-wall detection (STRICT) ──────────────────────────────────
    // Only match phrases that specifically mean "the user needs to sign
    // in". Earlier versions matched generic phrases like "all scrapers
    // failed" / "all strategies failed", but those fire on EVERY failure
    // type — network blips, dead URLs, rate limits, scraper bugs — and
    // were the root cause of the client looping back into the sign-in
    // dialog after every failure. Keep this list tight.
    const msg = (error.message || '').toLowerCase();
    const looksLikeLoginWall =
      msg.includes('login required')      ||
      msg.includes('requires login')      ||
      msg.includes('redirected to login') ||
      msg.includes('login_required')      ||
      msg.includes('private account')     ||
      msg.includes('private profile')     ||
      msg.includes('cookie rejected')     ||
      msg.includes('cookie appears stale');

    // ── PUBLIC URL guard ───────────────────────────────────────────────
    // Facebook share/v, share/r, share/p, fb.watch, /reel/, /watch/?v=
    // are PUBLIC content. So are Instagram /p/, /reel/, /tv/. So is any
    // X/Twitter status URL (status/<id>). These never require login on
    // other downloader apps. If we got here, the failure is on OUR side
    // (rate limit, mirror down, scraper bug) — not a missing session.
    // Returning LOGIN_REQUIRED for a public URL would push the user into
    // an unnecessary sign-in flow that wouldn't fix anything. Suppress.
    const isPublicFacebookUrl =
      /facebook\.com\/share\/(v|r|p)\//i.test(url) ||
      /fb\.watch/i.test(url)                       ||
      /facebook\.com\/(watch|reel|video)/i.test(url) ||
      /facebook\.com\/[^/]+\/(videos|posts)\//i.test(url);
    const isPublicInstagramUrl =
      /instagram\.com\/(p|reel|tv)\//i.test(url);
    const isPublicTwitterUrl =
      /(?:x|twitter)\.com\/[^/]+\/status\//i.test(url);
    const urlIsPublic =
      (failedPlatform === 'facebook'  && isPublicFacebookUrl) ||
      (failedPlatform === 'instagram' && isPublicInstagramUrl) ||
      (failedPlatform === 'twitter'   && isPublicTwitterUrl);

    if (looksLikeLoginWall && !urlIsPublic &&
        (failedPlatform === 'facebook' ||
         failedPlatform === 'instagram' ||
         failedPlatform === 'twitter')) {
      return res.status(401).json({
        success:   false,
        code:      'LOGIN_REQUIRED',
        platform:  failedPlatform,
        error:     'Sign in required to download this content',
        details:   error.message,
        timestamp: new Date().toISOString(),
      });
    }

    // ── Structured error classification ─────────────────────────────────
    // Map the raw failure (yt-dlp stderr, scraper messages) to a stable
    // error code + clean user message + actionable suggestions. The client
    // switches on `code`: AGE_RESTRICTED / GEO_BLOCKED / PRIVATE_CONTENT /
    // LOGIN_REQUIRED / DRM_PROTECTED / NOT_FOUND / RATE_LIMITED /
    // LIVE_ONLY / UNSUPPORTED_SITE / TIMEOUT / DOWNLOAD_FAILED.
    const classified = classifyError(error);

    // LOGIN_REQUIRED on a PUBLIC url is our failure, not the user's —
    // downgrade so the app doesn't push an unnecessary sign-in flow
    // (same reasoning as the login-wall guard above).
    if (classified.code === 'LOGIN_REQUIRED' && urlIsPublic) {
      classified.code        = 'DOWNLOAD_FAILED';
      classified.status      = 500;
      classified.userMessage = 'Failed to download media from this link.';
      classified.suggestions = ['Try again — this public link failed on our side, not yours'];
    }

    res.status(classified.status).json({
      error:       classified.userMessage,
      success:     false,
      code:        classified.code,
      retryable:   classified.retryable,
      details:     error.message,
      platform:    failedPlatform,
      timestamp:   new Date().toISOString(),
      suggestions: [
        ...classified.suggestions,
        ...getErrorSuggestions(error.message, failedPlatform),
      ],
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