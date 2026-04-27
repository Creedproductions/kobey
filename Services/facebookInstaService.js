/**
 * facebookInstaService.js
 *
 * Facebook  : runs strategies in PARALLEL with per-strategy timeouts. The
 *             previous sequential chain meant a single hanging strategy could
 *             stall the whole request until the global 45s timeout. Now they
 *             race — first to succeed wins, slow ones are abandoned.
 *
 *             Detects FB Story / login-required URLs upfront (any URL that
 *             redirects to /login.php or /login/) and returns a clean
 *             "Authentication required" error instead of letting every
 *             strategy waste time hitting a login wall.
 *
 * Instagram : same treatment — early Story / private-content detection, plus
 *             snapsave + snapinsta + igdl + embed scrape, run as a race.
 *
 * Output for Facebook:    { hd, sd, thumbnail, title } OR a metadownloader-shaped object
 * Output for Instagram:   { status: true, data: [items] }
 */

const axios   = require('axios');
const cheerio = require('cheerio');

let metadownloader;
try { metadownloader = require('metadownloader'); }
catch (_) { metadownloader = null; console.warn('⚠️ metadownloader not installed (optional)'); }

let igdl;
try { ({ igdl } = require('btch-downloader')); }
catch (_) { igdl = null; console.warn('⚠️ btch-downloader igdl not available'); }

// ─── Shared headers ──────────────────────────────────────────────────────────

const UA_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const UA_MOBILE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const BROWSER_HEADERS = {
  'User-Agent':                UA_DESKTOP,
  Accept:                      'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language':           'en-US,en;q=0.9',
  'Accept-Encoding':           'gzip, deflate, br',
  Connection:                  'keep-alive',
  'Upgrade-Insecure-Requests': '1',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Run an async function with a hard timeout. Saves us from hanging strategies. */
function withTimeout(promise, ms, label) {
  let to;
  const timer = new Promise((_, rej) => {
    to = setTimeout(() => rej(new Error(`${label}: timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timer]).finally(() => clearTimeout(to));
}

/** First fulfilled wins. Rejects only when all reject. */
function firstSuccess(promises, errors = []) {
  return new Promise((resolve, reject) => {
    let done = false, settled = 0;
    promises.forEach(p => {
      p.then(
        v => { if (!done) { done = true; resolve(v); } },
        e => {
          errors.push(e.message || String(e));
          settled++;
          if (settled === promises.length && !done) {
            reject(new Error(errors.join(' | ')));
          }
        }
      );
    });
  });
}

function unescapeJsString(s) {
  return s
    .replace(/\\u003C/gi, '<').replace(/\\u003E/gi, '>')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u00[0-9a-f]{2}/gi, m => String.fromCharCode(parseInt(m.slice(2), 16)))
    .replace(/\\\//g, '/').replace(/\\"/g, '"');
}

function decodeCdnUrl(href) {
  if (!href) return '';
  try {
    const u = new URL(href);
    for (const p of ['url', 'u', 'src', 'link', 'media']) {
      const val = u.searchParams.get(p);
      if (val && val.startsWith('http')) {
        const d = decodeURIComponent(val);
        return d.includes('%3A') ? decodeCdnUrl(d) : d;
      }
    }
  } catch (_) {}
  return href;
}

function detectType(url) {
  if (!url) return 'video';
  const p = url.toLowerCase().split('?')[0];
  if (p.match(/\.(mp4|mov|webm|mkv|avi|ts)$/))         return 'video';
  if (p.match(/\.(jpg|jpeg|png|gif|webp|heic|avif)$/))  return 'image';
  if (p.includes('/t16/') || p.includes('/o1/v/') ||
      p.includes('/t50.') || p.includes('/video/'))     return 'video';
  if (p.includes('/t51.') || p.includes('/t39.'))       return 'image';
  return 'video';
}

function isMediaHref(href) {
  if (!href || !href.startsWith('http')) return false;
  const l = href.toLowerCase();
  return (
    l.includes('cdninstagram.com') || l.includes('fbcdn.net') ||
    l.includes('scontent')         || l.includes('snapsave.app') ||
    l.includes('snapinsta.app')    ||
    l.match(/\.(mp4|mov|webm|jpg|jpeg|png|gif|webp)(\?|$)/i) != null
  );
}


const looksLikeFbVideo = (u) =>
  typeof u === 'string' && u.startsWith('http') &&
  (u.includes('fbcdn.net') || u.includes('scontent') || /\.mp4(\?|$)/i.test(u));

function looksLikeLoginWall(html = '', finalUrl = '') {
  return (
    /\/login(\.php|\/)?(?:[?#]|$)/i.test(finalUrl || '') ||
    /login_form|id=[\"']loginbutton[\"']|checkpoint|Log in to Facebook/i.test(html || '') ||
    String(html || '').includes('recover/initiate')
  );
}

function isFacebookShareUrl(url = '') {
  return /facebook\.com\/share\/(v|r|p)\//i.test(url);
}

function cleanFbUrlKeepImportant(rawUrl) {
  try {
    const u = new URL(String(rawUrl || '').trim());
    const keep = new URLSearchParams();
    for (const k of ['v', 'story_fbid', 'id']) {
      const v = u.searchParams.get(k);
      if (v) keep.set(k, v);
    }
    u.search = keep.toString();
    u.hash = '';
    return u.toString();
  } catch (_) {
    return rawUrl;
  }
}

function buildFacebookCandidateUrls(rawUrl, canonical = '') {
  const out = [];
  const add = (u) => {
    if (!u || typeof u !== 'string') return;
    const x = u.trim();
    if (!x || out.includes(x)) return;
    out.push(x);
  };

  add(rawUrl);
  add(canonical);
  add(cleanFbUrlKeepImportant(rawUrl));
  add(cleanFbUrlKeepImportant(canonical));

  for (const u of [...out]) {
    try {
      const parsed = new URL(u);
      const hostVariants = ['www.facebook.com', 'm.facebook.com', 'mbasic.facebook.com'];
      for (const host of hostVariants) {
        parsed.hostname = host;
        add(parsed.toString());
      }
      if (/\/reel\/(\d+)/i.test(parsed.pathname)) {
        const id = parsed.pathname.match(/\/reel\/(\d+)/i)[1];
        add(`https://www.facebook.com/watch/?v=${id}`);
        add(`https://m.facebook.com/watch/?v=${id}`);
        add(`https://mbasic.facebook.com/watch/?v=${id}`);
      }
    } catch (_) {}
  }
  return [...new Set(out)].slice(0, 18);
}

function extractFacebookMediaFromHtml(html, pageUrl = '') {
  const decoded = unescapeJsString(String(html || '')).replace(/&amp;/g, '&');
  const $ = cheerio.load(decoded);
  let hd = '', sd = '';

  const regexes = [
    { key: 'hd', re: /"browser_native_hd_url"\s*:\s*"([^"]+)"/g },
    { key: 'sd', re: /"browser_native_sd_url"\s*:\s*"([^"]+)"/g },
    { key: 'hd', re: /"hd_src"\s*:\s*"([^"]+)"/g },
    { key: 'sd', re: /"sd_src"\s*:\s*"([^"]+)"/g },
    { key: 'hd', re: /"hd_src_no_ratelimit"\s*:\s*"([^"]+)"/g },
    { key: 'sd', re: /"sd_src_no_ratelimit"\s*:\s*"([^"]+)"/g },
    { key: 'hd', re: /"playable_url_quality_hd"\s*:\s*"([^"]+)"/g },
    { key: 'sd', re: /"playable_url"\s*:\s*"([^"]+)"/g },
    { key: 'sd', re: /"video_url"\s*:\s*"([^"]+)"/g },
  ];

  for (const { key, re } of regexes) {
    let m;
    while ((m = re.exec(decoded)) !== null) {
      const u = decodeCdnUrl(m[1]).replace(/\\u0025/g, '%');
      if (!looksLikeFbVideo(u)) continue;
      if (key === 'hd' && !hd) hd = u;
      if (key === 'sd' && !sd) sd = u;
      if (hd && sd) break;
    }
    if (hd && sd) break;
  }

  if (!hd && !sd) {
    const mp4s = decoded.match(/https?:\/\/[^"'\s<>\\]+\.mp4[^"'\s<>\\]*/gi) || [];
    for (const u0 of mp4s) {
      const u = decodeCdnUrl(u0).replace(/&amp;/g, '&');
      if (!looksLikeFbVideo(u)) continue;
      if (!sd) sd = u;
      if (/hd|720|1080/i.test(u) && !hd) hd = u;
    }
  }

  if (!hd && !sd) return null;
  return {
    hd,
    sd,
    thumbnail: $('meta[property="og:image"]').attr('content') || '',
    title: $('meta[property="og:title"]').attr('content') || 'Facebook Video',
    pageUrl,
  };
}

// ─── Optional Story cookies (Instagram only) ─────────────────────────────────
//
// Instagram Stories optionally support cookie-authenticated downloads via
// IG_SESSION_COOKIE. Facebook Stories are NOT supported via cookies in this
// version — we use public-mirror scrapers only. See `tryFbStoryPublic()` for
// the Facebook story implementation.
//
// To enable Instagram cookie support, set IG_SESSION_COOKIE to the full
// Cookie header copied from a logged-in browser tab (DevTools → Application
// → Cookies → instagram.com → build "name=value; name=value;…" string).
//
// IMPORTANT: cookies expire (typically 30-90 days). Use a throwaway account,
// not your personal one. When the cookie goes stale the code falls back to
// a clean error.

const IG_COOKIE = process.env.IG_SESSION_COOKIE || '';

// Optional: self-hosted cobalt API fallback. Do NOT use public api.cobalt.tools.
// Set COBALT_API_URL=https://your-cobalt-api-domain.com
// Optional auth: COBALT_API_KEY=...
const COBALT_API_URL = (process.env.COBALT_API_URL || '').replace(/\/+$/, '');
const COBALT_API_KEY = process.env.COBALT_API_KEY || '';

function looksLikeIgStoryUrl(u) { return /instagram\.com\/stories\//i.test(u); }
function looksLikeFbStoryUrl(u) { return /facebook\.com\/stor(y|ies)\//i.test(u); }

/**
 * Public-mirror Facebook story scraper. No cookie required.
 *
 * Tries multiple unaffiliated mirror services in sequence, each of which
 * scrapes Facebook's public-facing endpoints to extract Story videos. None
 * of these will work for private profiles or restricted content — that's
 * a hard limit imposed by Facebook, not by this code.
 *
 * Returns { hd, sd, thumbnail, title } or throws.
 */
async function tryFbStoryPublic(url) {
  const errors = [];

  // ── Mirror 1: fbdownloader.net (POST form scraper) ──────────────────────
  // Accepts the share URL directly, returns HTML with download anchors.
  try {
    const resp = await axios.post(
      'https://fbdownloader.net/en',
      new URLSearchParams({ url }).toString(),
      {
        timeout: 18000,
        headers: {
          'Content-Type':              'application/x-www-form-urlencoded',
          'User-Agent':                UA_DESKTOP,
          Accept:                      'text/html,application/xhtml+xml,*/*;q=0.9',
          Origin:                      'https://fbdownloader.net',
          Referer:                     'https://fbdownloader.net/en',
          'Upgrade-Insecure-Requests': '1',
        },
        maxRedirects: 5,
      }
    );

    const html = typeof resp.data === 'string' ? resp.data : '';
    if (html && html.length > 500) {
      const $ = cheerio.load(html);
      let hd = '', sd = '';
      $('a[href]').each((_, a) => {
        const href = $(a).attr('href') || '';
        const text = $(a).text().toLowerCase();
        if (!looksLikeFbVideo(href)) return;
        if (!hd && (text.includes('hd') || text.includes('high'))) { hd = href; return; }
        if (!sd) sd = href;
      });

      if (hd || sd) {
        console.log(`📘 FB Story (fbdownloader.net) ✓`);
        return {
          hd, sd,
          thumbnail: $('img').first().attr('src') || '',
          title:     'Facebook Story',
        };
      }
    }
    errors.push('fbdownloader.net: no FB video links found');
  } catch (e) {
    errors.push(`fbdownloader.net: ${e.message}`);
  }

  // ── Mirror 2: savefrom.net helper API ───────────────────────────────────
  // Their public endpoint accepts URL via query and returns JSON. No CSRF
  // required for FB URLs because they're publicly indexed.
  try {
    const apiUrl = `https://worker.sf-tools.com/savefrom?sf_url=${encodeURIComponent(url)}&sf_locale=en`;
    const resp = await axios.get(apiUrl, {
      timeout: 18000,
      headers: {
        'User-Agent': UA_DESKTOP,
        Accept:       'application/json',
        Referer:      'https://en.savefrom.net/',
        Origin:       'https://en.savefrom.net',
      },
    });

    const data = resp.data || {};
    const list = data.url || data.urls || data.formats || data.media || [];
    let hd = '', sd = '';

    for (const item of (Array.isArray(list) ? list : [])) {
      const u   = item.url || item.src || '';
      const lbl = String(item.quality || item.label || '').toLowerCase();
      if (!looksLikeFbVideo(u)) continue;
      if (!hd && (lbl.includes('hd') || lbl.includes('720') || lbl.includes('1080'))) { hd = u; continue; }
      if (!sd) sd = u;
    }

    if (hd || sd) {
      console.log(`📘 FB Story (savefrom.net) ✓`);
      return {
        hd, sd,
        thumbnail: data.thumb || data.thumbnail || '',
        title:     data.meta?.title || 'Facebook Story',
      };
    }
    errors.push('savefrom.net: no FB video links in response');
  } catch (e) {
    errors.push(`savefrom.net: ${e.message}`);
  }

  // ── Mirror 3: mbasic.facebook.com unauth scrape ─────────────────────────
  // Many public Facebook stories are still served by mbasic without login.
  // It's the lightweight HTML-only frontend Facebook keeps for old phones,
  // and content owners who set their stories to public are visible there.
  try {
    const target = url.replace(/(?:m|web|www|business)?\.?facebook\.com/i, 'mbasic.facebook.com');
    const resp = await axios.get(target, {
      timeout: 18000,
      maxRedirects: 10,
      validateStatus: () => true,
      headers: {
        'User-Agent':      UA_MOBILE,
        'Accept-Language': 'en-US,en;q=0.9',
        Accept:            'text/html,*/*;q=0.8',
      },
    });

    // Bounced to login = content not public. Skip.
    const finalUrl = resp.request?.res?.responseUrl || '';
    if (/\/login(\.php|\/)/.test(finalUrl)) {
      errors.push('mbasic: redirected to login (story not public)');
    } else {
      const html = typeof resp.data === 'string' ? resp.data : '';
      const mp4Matches = html.match(/https?:\/\/[^"'\s<>]*\.mp4[^"'\s<>]*/gi) || [];
      const fbVideos = [...new Set(mp4Matches)]
        .map(u => unescapeJsString(u).replace(/&amp;/g, '&'))
        .filter(u => u.includes('fbcdn.net') || u.includes('scontent'));

      if (fbVideos.length > 0) {
        const $ = cheerio.load(html);
        console.log(`📘 FB Story (mbasic) ✓`);
        return {
          hd:        '',
          sd:        fbVideos[0],
          thumbnail: $('meta[property="og:image"]').attr('content') || '',
          title:     $('meta[property="og:title"]').attr('content') || 'Facebook Story',
        };
      }
      errors.push('mbasic: no .mp4 URLs in HTML');
    }
  } catch (e) {
    errors.push(`mbasic: ${e.message}`);
  }

  throw new Error(`fb-story-public: ${errors.join(' | ')}`);
}

/**
 * Authenticated Instagram story scraper. Uses the GraphQL story endpoint
 * which only works with a valid session cookie.
 */
async function tryIgStoryWithCookie(url) {
  if (!IG_COOKIE) throw new Error('ig-story: no IG_SESSION_COOKIE configured');

  // URLs look like: https://instagram.com/stories/<username>/<media_pk>/
  const m = url.match(/instagram\.com\/stories\/([^/]+)\/(\d+)/i);
  if (!m) throw new Error('ig-story: could not parse username/media_pk');
  const [, username, mediaPk] = m;
  console.log(`📸 IG Story (cookie) → @${username} pk=${mediaPk}`);

  // Step 1: resolve username → user_id via the public profile JSON endpoint
  // (still requires session cookie because IG blocks unauth profile requests)
  const profileResp = await axios.get(
    `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
    {
      timeout: 12000,
      validateStatus: () => true,
      headers: {
        'User-Agent':       UA_DESKTOP,
        'X-IG-App-ID':      '936619743392459',
        Accept:             'application/json',
        Cookie:             IG_COOKIE,
        Referer:            'https://www.instagram.com/',
      },
    }
  );
  const userId = profileResp.data?.data?.user?.id;
  if (!userId) {
    if (profileResp.status === 401 || profileResp.status === 403) {
      throw new Error('ig-story: cookie appears stale (auth rejected)');
    }
    throw new Error(`ig-story: profile lookup failed (status ${profileResp.status})`);
  }

  // Step 2: fetch reels-tray for that user, pick the matching media_pk
  const trayResp = await axios.get(
    `https://i.instagram.com/api/v1/feed/user/${userId}/reel_media/`,
    {
      timeout: 12000,
      validateStatus: () => true,
      headers: {
        'User-Agent':  UA_DESKTOP,
        'X-IG-App-ID': '936619743392459',
        Accept:        'application/json',
        Cookie:        IG_COOKIE,
        Referer:       `https://www.instagram.com/${username}/`,
      },
    }
  );

  const items = trayResp.data?.items || [];
  const target = items.find(it => String(it.pk) === String(mediaPk)) || items[0];
  if (!target) throw new Error('ig-story: story not found in tray (may be expired)');

  // Story is either a video (has video_versions) or an image (only image_versions2)
  const videoUrl = target.video_versions?.[0]?.url;
  const imageUrl = target.image_versions2?.candidates?.[0]?.url;
  const items_out = [];

  if (videoUrl) {
    items_out.push({
      url:       videoUrl,
      thumbnail: imageUrl || '',
      type:      'video',
      quality:   'Original Quality',
    });
  } else if (imageUrl) {
    items_out.push({
      url:       imageUrl,
      thumbnail: imageUrl,
      type:      'image',
      quality:   'Original Quality',
    });
  } else {
    throw new Error('ig-story: no video or image in story media');
  }

  return items_out;
}

// ─── Step 1 : resolve share URL to canonical (with login detection) ──────────

async function resolveCanonicalFbUrl(rawUrl) {
  const normalized = normalizeFacebookUrl(rawUrl);

  // Already useful enough; don't waste time resolving direct canonical forms.
  if (
    normalized.match(/facebook\.com\/(watch|reel|video)\/\d+/) ||
    normalized.match(/facebook\.com\/[^/]+\/videos\/\d+/) ||
    normalized.includes('facebook.com/watch?v=')
  ) return { url: normalized, requiresLogin: false, loginWall: false };

  const url = normalized.replace('m.facebook.com', 'www.facebook.com');
  console.log(`🔗 Resolving: ${url}`);

  try {
    const resp = await axios.get(url, {
      maxRedirects:   20,
      timeout:        12000,
      validateStatus: () => true,
      headers:        BROWSER_HEADERS,
    });

    const html = typeof resp.data === 'string' ? resp.data : '';
    const final =
      resp.request?.res?.responseUrl ||
      resp.request?.responseURL      ||
      (resp.config?.url !== url ? resp.config?.url : null) ||
      url;

    // IMPORTANT: share/reel public URLs often show login HTML to datacenter IPs.
    // Do not stop the whole pipeline here; external/self-hosted fallbacks may still work.
    const loginWall = looksLikeLoginWall(html, final);
    if (loginWall) {
      console.log('🔗 ⚠ FB resolve hit login wall; continuing with fallback candidates');
    }

    const isProfileShape = (u) => {
      try {
        const parts = new URL(u).pathname.split('/').filter(Boolean);
        return parts.length === 1;
      } catch { return false; }
    };

    if (html && html.length > 500) {
      const $ = cheerio.load(html);
      const og = $('meta[property="og:url"]').attr('content') || '';
      if (og && og.includes('facebook.com') && !og.includes('/share/') && !isProfileShape(og)) {
        console.log(`🔗 og:url → ${og}`);
        return { url: cleanFbUrlKeepImportant(og), requiresLogin: false, loginWall };
      }
    }

    if (final && final !== url && !/\/login(\.php|\/)/i.test(final)) {
      if (!final.includes('/share/') && !isProfileShape(final)) {
        console.log(`🔗 Resolved → ${final}`);
        return { url: cleanFbUrlKeepImportant(final), requiresLogin: false, loginWall };
      }
    }

    return { url: rawUrl, requiresLogin: false, loginWall };
  } catch (e) {
    console.warn(`🔗 Redirect failed: ${e.message}`);
  }

  console.warn('🔗 Could not resolve — using original URL');
  return { url: rawUrl, requiresLogin: false, loginWall: false };
}


// ─── Strategy : metadownloader ───────────────────────────────────────────────

async function tryMetadownloader(url) {
  if (!metadownloader) throw new Error('metadownloader: not installed');

  let result;
  try {
    result = await metadownloader(url);
  } catch (e) {
    const msg = e?.message || String(e);
    // metadownloader throws "Cannot read properties of undefined (reading 'split')"
    // when the page has no video metadata — usually a login wall or deleted post.
    if (msg.includes("reading 'split'") || msg.includes('undefined')) {
      throw new Error('metadownloader: no video on page (login-walled, private, or deleted)');
    }
    throw new Error(`metadownloader: ${msg}`);
  }

  if (result && result.status === false) {
    throw new Error(`metadownloader: ${result.msg || 'status false'}`);
  }
  if (!result) throw new Error('metadownloader: returned null');
  return result;
}

// ─── Strategy : direct desktop scrape ────────────────────────────────────────

const FB_REGEXES = [
  { key: 'hd', re: /"browser_native_hd_url"\s*:\s*"([^"]+)"/ },
  { key: 'sd', re: /"browser_native_sd_url"\s*:\s*"([^"]+)"/ },
  { key: 'hd', re: /"hd_src"\s*:\s*"([^"]+)"/ },
  { key: 'sd', re: /"sd_src"\s*:\s*"([^"]+)"/ },
  { key: 'hd', re: /"hd_src_no_ratelimit"\s*:\s*"([^"]+)"/ },
  { key: 'sd', re: /"sd_src_no_ratelimit"\s*:\s*"([^"]+)"/ },
  { key: 'hd', re: /"playable_url_quality_hd"\s*:\s*"([^"]+)"/ },
  { key: 'sd', re: /"playable_url"\s*:\s*"([^"]+)"/ },
];

async function tryDirectScrape(url) {
  const urls = buildFacebookCandidateUrls(url, url);
  const errors = [];

  for (const target of urls) {
    for (const ua of [UA_DESKTOP, UA_MOBILE, 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)']) {
      try {
        const resp = await axios.get(target, {
          timeout: 12000,
          maxRedirects: 8,
          validateStatus: () => true,
          headers: {
            'User-Agent': ua,
            'Accept-Language': 'en-US,en;q=0.9',
            Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
            Referer: 'https://www.facebook.com/',
          },
        });

        const finalUrl = resp.request?.res?.responseUrl || '';
        const html = typeof resp.data === 'string' ? resp.data : '';
        if (!html || html.length < 300) {
          errors.push('empty html');
          continue;
        }
        if (looksLikeLoginWall(html, finalUrl)) {
          errors.push('login wall');
          continue;
        }

        const result = extractFacebookMediaFromHtml(html, target);
        if (result && (result.hd || result.sd)) return result;
        errors.push('no media json');
      } catch (e) {
        errors.push(e.message);
      }
    }
  }

  throw new Error(`direct: ${errors.slice(0, 8).join(' | ')}`);
}


// ─── Strategy : getfvid.com ──────────────────────────────────────────────────

async function tryGetfvid(url) {
  const resp = await axios.post(
    'https://getfvid.com/downloader',
    new URLSearchParams({ url }).toString(),
    {
      timeout: 18000,
      headers: {
        'Content-Type':              'application/x-www-form-urlencoded',
        'User-Agent':                UA_DESKTOP,
        Accept:                      'text/html,application/xhtml+xml,*/*;q=0.9',
        Origin:                      'https://getfvid.com',
        Referer:                     'https://getfvid.com/',
        'Upgrade-Insecure-Requests': '1',
      },
      maxRedirects:   5,
      // Accept 5xx so we throw a CLEAN error instead of axios's generic
      // "Request failed with status code 522". Cloudflare 522s on getfvid
      // are common (their origin is intermittently down) and shouldn't
      // poison the whole result with noisy axios errors.
      validateStatus: () => true,
    }
  );

  if (resp.status >= 500) {
    throw new Error(`getfvid: upstream ${resp.status} (Cloudflare/origin down)`);
  }
  if (resp.status >= 400) {
    throw new Error(`getfvid: HTTP ${resp.status}`);
  }

  const html = typeof resp.data === 'string' ? resp.data : '';
  if (!html || html.length < 200) throw new Error('getfvid: empty response');

  const $ = cheerio.load(html);
  let hd = '', sd = '';
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href') || '';
    const text = $(a).text().toLowerCase();
    if (!looksLikeFbVideo(href)) return;
    if (!hd && (text.includes('hd') || text.includes('high'))) { hd = href; return; }
    if (!sd) sd = href;
  });

  if (!hd && !sd) throw new Error('getfvid: no FB video links found');

  return {
    hd, sd,
    thumbnail: $('img').first().attr('src') || '',
    title:     'Facebook Video',
  };
}

// ─── Strategy : snapsave (Facebook side) ─────────────────────────────────────
// snapsave handles both Instagram and Facebook URLs. We already use it for
// IG; the same endpoint accepts FB share URLs and returns the same HTML
// shape. Adding it as a 4th FB strategy gives us another shot when getfvid
// is 522'd and metadownloader chokes on the page.

async function trySnapsaveFb(url) {
  const resp = await axios.post(
    'https://snapsave.app/action_download.php',
    `url=${encodeURIComponent(url)}`,
    {
      timeout:        18000,
      validateStatus: () => true,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent':   UA_DESKTOP,
        Origin:         'https://snapsave.app',
        Referer:        'https://snapsave.app/',
      },
    }
  );

  if (resp.status >= 500) throw new Error(`snapsave-fb: upstream ${resp.status}`);
  if (resp.status >= 400) throw new Error(`snapsave-fb: HTTP ${resp.status}`);

  const html = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
  if (!html || html.length < 200) throw new Error('snapsave-fb: empty response');

  const $ = cheerio.load(html);
  let hd = '', sd = '';
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href') || '';
    const text = $(a).text().toLowerCase();
    if (!looksLikeFbVideo(href)) return;
    if (!hd && (text.includes('hd') || text.includes('high'))) { hd = href; return; }
    if (!sd) sd = href;
  });

  if (!hd && !sd) throw new Error('snapsave-fb: no FB video links found');

  return {
    hd, sd,
    thumbnail: $('img').first().attr('src') || '',
    title:     $('h2, .video-title').first().text().trim() || 'Facebook Video',
  };
}


// ─── Strategy : mbasic / m.facebook.com video scraper ────────────────────────

async function tryMbasicVideo(url) {
  const errors = [];
  const targets = buildFacebookCandidateUrls(url, url)
    .filter(u => /facebook\.com/i.test(u))
    .flatMap(u => {
      try {
        const p = new URL(u);
        return ['mbasic.facebook.com', 'm.facebook.com', 'www.facebook.com'].map(h => {
          p.hostname = h;
          return p.toString();
        });
      } catch (_) { return [u]; }
    });

  for (const target of [...new Set(targets)]) {
    try {
      const resp = await axios.get(target, {
        timeout: 12000,
        maxRedirects: 8,
        validateStatus: () => true,
        headers: {
          'User-Agent': UA_MOBILE,
          'Accept-Language': 'en-US,en;q=0.9',
          Accept: 'text/html,*/*;q=0.8',
          Referer: 'https://m.facebook.com/',
        },
      });

      const finalUrl = resp.request?.res?.responseUrl || '';
      const html = typeof resp.data === 'string' ? resp.data : '';
      if (looksLikeLoginWall(html, finalUrl)) {
        errors.push('login wall');
        continue;
      }

      const parsed = extractFacebookMediaFromHtml(html, target);
      if (parsed && (parsed.hd || parsed.sd)) return parsed;
      errors.push('no mp4 urls');
    } catch (e) {
      errors.push(e.message);
    }
  }

  throw new Error(`mbasic-video: ${errors.slice(0, 8).join(' | ')}`);
}


// ─── Strategy : self-hosted cobalt API fallback ──────────────────────────────
// Official cobalt does not provide a public pre-hosted API for third-party apps.
// Run your own instance and set COBALT_API_URL. This is optional and skipped if unset.

async function tryCobaltFacebook(url) {
  if (!COBALT_API_URL) throw new Error('cobalt: COBALT_API_URL not set');

  const resp = await axios.post(
    `${COBALT_API_URL}/`,
    {
      url,
      downloadMode: 'auto',
      filenameStyle: 'basic',
      videoQuality: '720',
      youtubeVideoCodec: 'h264',
      youtubeDubLang: 'en',
    },
    {
      timeout: 25000,
      validateStatus: () => true,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(COBALT_API_KEY ? { Authorization: `Api-Key ${COBALT_API_KEY}` } : {}),
      },
    }
  );

  if (resp.status >= 400) {
    throw new Error(`cobalt: HTTP ${resp.status} ${resp.data?.error?.code || resp.data?.error || ''}`.trim());
  }

  const data = resp.data || {};
  const direct = data.url || data.download || data.tunnel || '';
  const picker = Array.isArray(data.picker) ? data.picker : [];
  const first = picker.find(i => i?.url && (i.type === 'video' || looksLikeFbVideo(i.url))) || picker.find(i => i?.url);
  const mediaUrl = direct || first?.url || '';

  if (!mediaUrl || !mediaUrl.startsWith('http')) throw new Error('cobalt: no media url');

  return {
    hd: '',
    sd: mediaUrl,
    thumbnail: data.thumb || first?.thumb || '',
    title: data.filename || data.title || 'Facebook Video',
  };
}

// ─── Facebook entry ──────────────────────────────────────────────────────────

async function downloadFacebook(rawUrl) {
  console.log(`📘 Facebook: starting for ${rawUrl}`);

  const normalized = normalizeFacebookUrl(rawUrl);
  const { url: canonical, requiresLogin } = await resolveCanonicalFbUrl(normalized);

  // Stories are truly time/auth restricted; keep clean handling.
  if (looksLikeFbStoryUrl(rawUrl) || looksLikeFbStoryUrl(canonical)) {
    try {
      const result = await withTimeout(tryFbStoryPublic(rawUrl), 25000, 'fb-story-public');
      if (result && (result.hd || result.sd)) return result;
    } catch (e) {
      console.warn(`📘 FB Story public path failed: ${e.message}`);
    }
    throw new Error('Facebook Story not accessible. It may be private, restricted, or expired.');
  }

  const candidateUrls = buildFacebookCandidateUrls(rawUrl, canonical);
  console.log(`📘 Facebook candidates: ${candidateUrls.length}`);

  // Snapsave is currently returning 404 often, so keep it last as a weak fallback.
  const strategies = [];
  for (const candidate of candidateUrls) {
    strategies.push(
      ['cobalt',        () => tryCobaltFacebook(candidate),  25000],
      ['getfvid',       () => tryGetfvid(candidate),         16000],
      ['mbasic-video',  () => tryMbasicVideo(candidate),     12000],
      ['direct-scrape', () => tryDirectScrape(candidate),    12000],
      ['metadownloader',() => tryMetadownloader(candidate),  18000],
      ['snapsave-fb',   () => trySnapsaveFb(candidate),      12000],
    );
  }

  const runRound = async (round) => {
    const errors = [];
    const promises = strategies.map(([name, fn, ms]) =>
      withTimeout(fn(), ms, `${name}/${round}`).then(
        result => {
          if (name === 'metadownloader') {
            if (result) { console.log(`📘 ✅ ${name} succeeded`); return result; }
            throw new Error(`${name}: empty result`);
          }
          if (result && (result.hd || result.sd || result.url || result.download)) {
            console.log(`📘 ✅ ${name} succeeded`);
            return result;
          }
          throw new Error(`${name}: no usable URL`);
        },
        err => {
          const msg = err.message || String(err);
          throw new Error(`${name}: ${msg}`);
        }
      )
    );
    try {
      return await firstSuccess(promises, errors);
    } catch (_) {
      throw new Error(errors.join(' | '));
    }
  };

  try {
    return await runRound('first');
  } catch (firstErr) {
    console.warn(`🔁 Facebook retry once: ${firstErr.message.slice(0, 180)}`);
    try {
      return await runRound('retry');
    } catch (retryErr) {
      throw new Error(`Facebook: all strategies failed — ${firstErr.message} | retry: ${retryErr.message}`);
    }
  }
}


// ─── Instagram scrapers ──────────────────────────────────────────────────────

async function scrapeSnapsave(igUrl) {
  const resp = await axios.post(
    'https://snapsave.app/action_download.php',
    `url=${encodeURIComponent(igUrl)}`,
    {
      timeout: 18000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent':   UA_DESKTOP,
        Origin:         'https://snapsave.app',
        Referer:        'https://snapsave.app/',
      },
    }
  );

  const html  = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
  const $     = cheerio.load(html);
  const items = [];
  const seen  = new Set();

  $('table tr, .download-items').each((_, row) => {
    const $r      = $(row);
    const thumb   = $r.find('img').first().attr('src') || '';
    const anchors = [];
    $r.find('a[href]').each((_, a) => {
      const href = $(a).attr('href') || '';
      if (isMediaHref(href)) anchors.push({ href, text: $(a).text().trim() });
    });
    if (!anchors.length) return;
    const best = anchors.find(a => a.text.toLowerCase().includes('hd')) || anchors[0];
    const real = decodeCdnUrl(best.href);
    if (seen.has(real)) return;
    seen.add(real);
    const type = detectType(best.href);
    items.push({ thumbnail: thumb || (type === 'image' ? real : ''), url: real, type, quality: 'HD' });
  });

  if (!items.length) {
    const thumb = $('img').first().attr('src') || '';
    $('a[href]').each((_, a) => {
      const href = $(a).attr('href') || '';
      if (!isMediaHref(href)) return;
      const real = decodeCdnUrl(href);
      if (seen.has(real)) return;
      seen.add(real);
      items.push({ thumbnail: thumb, url: real, type: detectType(href), quality: 'Original Quality' });
    });
  }

  return items;
}

async function scrapeSnapinsta(igUrl) {
  const resp = await axios.post(
    'https://snapinsta.app/api/ajaxSearch',
    `q=${encodeURIComponent(igUrl)}&t=media&lang=en`,
    {
      timeout: 18000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent':   UA_DESKTOP,
        Origin:         'https://snapinsta.app',
        Referer:        'https://snapinsta.app/',
      },
    }
  );

  const html = resp.data?.data || resp.data || '';
  if (!html || typeof html !== 'string') return [];

  const $ = cheerio.load(html);
  const items = [], seen = new Set();

  $('.download-items, .dl-item, .media-wrap').each((_, block) => {
    const $b    = $(block);
    const thumb = $b.find('img').first().attr('src') || '';
    const ancs  = [];
    $b.find('a[href]').each((_, a) => {
      const href = $(a).attr('href') || '';
      if (isMediaHref(href)) ancs.push({ href, text: $(a).text().trim() });
    });
    if (!ancs.length) return;
    const best = ancs.find(a => a.text.toLowerCase().includes('hd')) || ancs[0];
    const real = decodeCdnUrl(best.href);
    if (seen.has(real)) return;
    seen.add(real);
    items.push({ thumbnail: thumb, url: real, type: detectType(best.href), quality: 'HD' });
  });

  if (!items.length) {
    const thumb = $('img').first().attr('src') || '';
    $('a[href]').each((_, a) => {
      const href = $(a).attr('href') || '';
      if (!isMediaHref(href)) return;
      const real = decodeCdnUrl(href);
      if (seen.has(real)) return;
      seen.add(real);
      items.push({ thumbnail: thumb, url: real, type: detectType(href), quality: 'Original Quality' });
    });
  }

  return items;
}

// ─── Instagram Stories scraper (public profiles only) ───────────────────────
//
// Instagram doesn't expose stories publicly through normal URLs, but a few
// mirror sites scrape public-profile stories. We try them in sequence; if
// none returns media, the caller falls back to the "login required" message.
//
// Note: these mirrors are flaky and frequently rate-limit. They're best-effort.

async function tryInstagramStories(url) {
  // Extract username from /stories/<username>/<id> URL
  const m = url.match(/instagram\.com\/stories\/([^/?#]+)/i);
  if (!m) throw new Error('stories: could not extract username');
  const username = m[1];

  console.log(`📸 stories: trying public mirrors for @${username}`);

  // Strategy A: storiesig.info — POST scraper
  try {
    const resp = await axios.post(
      'https://storiesig.info/api/ig/stories/' + encodeURIComponent(username),
      null,
      {
        timeout: 15_000,
        headers: {
          'User-Agent': UA_DESKTOP,
          Accept:       'application/json',
          Origin:       'https://storiesig.info',
          Referer:      `https://storiesig.info/en/${username}`,
        },
      }
    );

    const stories = resp.data?.result || resp.data?.data || resp.data?.stories || [];
    if (Array.isArray(stories) && stories.length > 0) {
      const items = stories.map(s => {
        const videoUrl = s.video_versions?.[0]?.url || s.video || '';
        const imageUrl = s.image_versions2?.candidates?.[0]?.url || s.image_url || s.thumbnail_url || '';
        const finalUrl = videoUrl || imageUrl;
        if (!finalUrl) return null;
        return {
          url:       finalUrl,
          thumbnail: imageUrl || finalUrl,
          type:      videoUrl ? 'video' : 'image',
          quality:   'Original Quality',
        };
      }).filter(Boolean);
      if (items.length) return items;
    }
  } catch (e) {
    console.log(`📸 stories: storiesig.info failed: ${e.message}`);
  }

  // Strategy B: anonyig.com mirror
  try {
    const resp = await axios.get(
      'https://anonyig.com/api/ig/stories/' + encodeURIComponent(username),
      {
        timeout: 15_000,
        headers: {
          'User-Agent': UA_DESKTOP,
          Accept:       'application/json',
          Referer:      `https://anonyig.com/profile/${username}/`,
        },
      }
    );
    const stories = resp.data?.result || resp.data?.data || [];
    if (Array.isArray(stories) && stories.length > 0) {
      const items = stories.map(s => {
        const videoUrl = s.video_versions?.[0]?.url || '';
        const imageUrl = s.image_versions2?.candidates?.[0]?.url || '';
        const finalUrl = videoUrl || imageUrl;
        if (!finalUrl) return null;
        return {
          url:       finalUrl,
          thumbnail: imageUrl || finalUrl,
          type:      videoUrl ? 'video' : 'image',
          quality:   'Original Quality',
        };
      }).filter(Boolean);
      if (items.length) return items;
    }
  } catch (e) {
    console.log(`📸 stories: anonyig.com failed: ${e.message}`);
  }

  return [];
}

// ─── Public API ──────────────────────────────────────────────────────────────

async function facebookInsta(url) {
  // Detect Facebook URLs (including m.facebook.com and fb.watch)
  const isFb = /(?:^|\/\/)(?:m|web|www|business)?\.?facebook\.com|fb\.watch/i.test(url);
  if (isFb) {
    return downloadFacebook(url);
  }

  // ── Instagram ──────────────────────────────────────────────────────────
  // Stories: try the public mirror scrapers (storiesig.info, anonyig) first
  // — these can fetch public-profile stories without auth. If those fail
  // and a session cookie is configured, try the authenticated GraphQL path.
  // If everything fails, return a clean "requires login" message.
  if (looksLikeIgStoryUrl(url)) {
    // Step 1: public mirrors (free, no cookie required)
    try {
      const items = await tryInstagramStories(url);
      if (items.length) return { status: true, data: items, _source: 'stories-mirror' };
    } catch (e) {
      console.warn(`📸 stories public mirror failed: ${e.message}`);
    }

    // Step 2: cookie-authenticated path (only if admin set IG_SESSION_COOKIE)
    if (IG_COOKIE) {
      try {
        const items = await withTimeout(
          tryIgStoryWithCookie(url),
          18000,
          'ig-story-cookie'
        );
        if (items && items.length > 0) {
          console.log('📸 ✅ IG Story via cookie succeeded');
          return { status: true, data: items, _source: 'ig-story-cookie' };
        }
      } catch (e) {
        console.warn(`📸 IG Story cookie path failed: ${e.message}`);
      }
    }

    // Step 3: clean error
    throw new Error(
      'Instagram Stories require login or come from a private account. ' +
      'Public-profile stories can sometimes be fetched, but this one was ' +
      'not accessible.' +
      (IG_COOKIE ? '' : ' Server admin: set IG_SESSION_COOKIE to enable authenticated Story downloads.')
    );
  }

  const errors = [];

  // Try snapsave + snapinsta (each with its own timeout) in parallel.
  const promises = [
    withTimeout(scrapeSnapsave(url),  18000, 'snapsave').then(
      items => items.length ? { source: 'snapsave', items } : Promise.reject(new Error('snapsave: 0 items'))
    ),
    withTimeout(scrapeSnapinsta(url), 18000, 'snapinsta').then(
      items => items.length ? { source: 'snapinsta', items } : Promise.reject(new Error('snapinsta: 0 items'))
    ),
  ];

  try {
    const winner = await firstSuccess(promises, errors);
    return { status: true, data: winner.items, _source: winner.source };
  } catch (_) {
    // Both failed — fall through to igdl, which lives in the controller's
    // existing pipeline. We re-throw with the collected errors so the
    // caller can decide whether to try other sources.
    throw new Error(`Instagram: all scrapers failed. ${errors.join(' | ')}`);
  }
}

module.exports = facebookInsta;