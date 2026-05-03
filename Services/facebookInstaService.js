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

// Facebook's open-graph crawler UA. Public videos (including most reels and
// share/v/ links) bypass the soft login wall when fetched with this UA
// because FB serves the embedded video JSON unauthenticated to og:crawlers.
// In 2026 this is the single biggest improvement to the public-scrape path.
const UA_FB_BOT =
  'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

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
  (u.includes('fbcdn.net') || /\.mp4(\?|$)/i.test(u));

// ─── Facebook auth + URL helpers ─────────────────────────────────────────────

function normalizeFacebookUrl(rawUrl) {
  try {
    const original = String(rawUrl || '').trim();
    if (/fb\.watch/i.test(original)) return original; // redirect is useful for fb.watch

    const u = new URL(original);

    // Strip tracking params that often break mirror scrapers, but keep the
    // actual video id for watch URLs.
    const keep = new URLSearchParams();
    const v = u.searchParams.get('v');
    if (v) keep.set('v', v);
    u.search = keep.toString();
    u.hash = '';

    return u.toString();
  } catch (_) {
    return rawUrl;
  }
}

// Builds the standard Facebook request headers. The optional second
// argument lets callers override the cookie per-request (used when the
// Flutter app has captured a user's session cookies via the platform
// browser sign-in flow). Falls back to FB_COOKIE env var when null.
function fbHeaders(extra = {}, overrideCookie = null) {
  const cookie = overrideCookie || FB_COOKIE;
  return {
    ...BROWSER_HEADERS,
    'User-Agent': UA_DESKTOP,
    Referer: 'https://www.facebook.com/',
    ...(cookie ? { Cookie: cookie } : {}),
    ...extra,
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
const FB_COOKIE = String(process.env.FB_SESSION_COOKIE || '').trim();
console.log(`📘 🍪 FB COOKIE: ${FB_COOKIE ? 'SET' : 'MISSING'}`);

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

  // ── Mirror 2: fdown.net (POST form scraper) ─────────────────────────────
  // fdown.net's downloader endpoint takes the FB URL via the URLz field
  // (NOT `url` like most scrapers). The Jun 2025 update added Reels support.
  try {
    const fdResult = await tryFdownNet(url);
    if (fdResult && (fdResult.hd || fdResult.sd)) {
      console.log(`📘 FB Story (fdown.net) ✓`);
      return fdResult;
    }
    errors.push('fdown.net: no FB video links found');
  } catch (e) {
    errors.push(`fdown.net: ${e.message}`);
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
async function tryIgStoryWithCookie(url, cookieOverride = null) {
  const activeCookie = cookieOverride || IG_COOKIE;
  if (!activeCookie) {
    throw new Error('ig-story: no cookie supplied (per-request and IG_SESSION_COOKIE both empty)');
  }

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
        Cookie:             activeCookie,
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
        Cookie:        activeCookie,
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
  // If already canonical, no resolve needed
  if (
    rawUrl.match(/facebook\.com\/(watch|reel|video)\/\d+/) ||
    rawUrl.match(/facebook\.com\/[^/]+\/videos\/\d+/) ||
    rawUrl.includes('facebook.com/watch?v=')
  ) return { url: rawUrl, requiresLogin: false };

  const url = rawUrl.replace('m.facebook.com', 'www.facebook.com');
  console.log(`🔗 Resolving: ${url}`);

  // ── STEP 1: fetch without following redirects to get the share page HTML ──
  // Many share/r/ and share/v/ links serve a meta refresh or JavaScript redirect
  // that axios can't follow. The canonical URL is often already in the meta tags.
  let shareHtml = '';
  try {
    const resp = await axios.get(url, {
      maxRedirects: 0,               // ← DO NOT follow redirects
      timeout: 15000,
      validateStatus: (status) => status < 500, // accept 3xx, 4xx
      headers:        fbHeaders(),
    });
    shareHtml = typeof resp.data === 'string' ? resp.data : '';
  } catch (err) {
    // If the request fails completely, just continue with the normal redirect approach
    console.log(`🔗 First fetch failed: ${err.message}`);
  }

  const isProfileShape = (u) => {
    try {
      const parts = new URL(u).pathname.split('/').filter(Boolean);
      return parts.length === 1; // just a username
    } catch { return false; }
  };

  // ── STEP 2: parse the share page HTML for canonical meta tags ─────────────
  if (shareHtml) {
    const $ = cheerio.load(shareHtml);

    const ogUrl = $('meta[property="og:url"]').attr('content');
    if (ogUrl && ogUrl.includes('facebook.com') && !ogUrl.includes('/share/') && !isProfileShape(ogUrl)) {
      console.log(`🔗 share page og:url → ${ogUrl}`);
      return { url: ogUrl, requiresLogin: false };
    }

    const alIos = $('meta[property="al:ios:url"]').attr('content') ||
                  $('meta[property="al:android:url"]').attr('content');
    if (alIos && alIos.includes('facebook.com') && !alIos.includes('/share/') && !isProfileShape(alIos)) {
      console.log(`🔗 share page al:url → ${alIos}`);
      return { url: alIos, requiresLogin: false };
    }
  }

  // ── STEP 3: build a guessed URL from the share ID (share/v/ID → /reel/ID) ─
  const shareMatch = url.match(/share\/(v|r)\/([A-Za-z0-9_-]+)/);
  if (shareMatch) {
    const id = shareMatch[2];
    const guessed = `https://www.facebook.com/reel/${id}/`;
    console.log(`🔗 Guessing canonical from share ID: ${guessed}`);
    // Quick check (HEAD) to see if the guessed URL is NOT a login wall
    try {
      const check = await axios.head(guessed, {
        timeout: 8000,
        maxRedirects: 5,
        validateStatus: () => true,
        headers: fbHeaders(),
      });
      const finalUrl = check.request?.res?.responseUrl || '';
      if (!/\/login/.test(finalUrl)) {
        console.log(`🔗 Guess confirmed: ${guessed}`);
        return { url: guessed, requiresLogin: false };
      }
    } catch (_) {
      // guess might still be usable; let the strategies try it
    }
    // Return the guess anyway – even if it redirects to login, the strategies will handle it
    return { url: guessed, requiresLogin: false };
  }

  // ── STEP 4: fallback to normal redirect chain (original behaviour) ─────────
  console.warn('🔗 Fallback: following redirects normally');
  try {
    const resp = await axios.get(url, {
      maxRedirects:   20,
      timeout:        15000,
      validateStatus: () => true,
      headers:        fbHeaders(),
    });

    const final =
      resp.request?.res?.responseUrl ||
      resp.request?.responseURL      ||
      (resp.config?.url !== url ? resp.config?.url : null);

    if (final && !/\/login/.test(final) && !final.includes('/share/')) {
      console.log(`🔗 Resolved via redirect → ${final}`);
      return { url: final, requiresLogin: false };
    }
  } catch (e) {
    console.warn(`🔗 Redirect fallback failed: ${e.message}`);
  }

  console.warn('🔗 Could not resolve — using original URL');
  return { url, requiresLogin: false };
}

// ─── Strategy : fdown.net ────────────────────────────────────────────────────
// fdown.net is a long-running public Facebook downloader. Its form field is
// `URLz` (not `url` like every other site we hit). The Jun 2025 update added
// Reels support that several other mirrors still don't have.

async function tryFdownNet(url) {
  const resp = await axios.post(
    'https://fdown.net/download.php',
    new URLSearchParams({ URLz: url }).toString(),
    {
      timeout: 18000,
      maxRedirects: 5,
      validateStatus: () => true,
      headers: {
        'Content-Type':              'application/x-www-form-urlencoded',
        'User-Agent':                UA_DESKTOP,
        Accept:                      'text/html,application/xhtml+xml,*/*;q=0.9',
        'Accept-Language':           'en-US,en;q=0.9',
        Origin:                      'https://fdown.net',
        Referer:                     'https://fdown.net/',
        'Upgrade-Insecure-Requests': '1',
      },
    }
  );

  if (resp.status >= 500) throw new Error(`fdown: upstream ${resp.status}`);
  if (resp.status >= 400) throw new Error(`fdown: HTTP ${resp.status}`);

  const html = typeof resp.data === 'string' ? resp.data : '';
  if (!html || html.length < 200) throw new Error('fdown: empty response');

  const $ = cheerio.load(html);
  let hd = $('#hdlink').attr('href') || '';
  let sd = $('#sdlink').attr('href') || '';

  // Fallback: scan all anchors for fbcdn URLs
  if (!hd && !sd) {
    $('a[href]').each((_, a) => {
      const href = $(a).attr('href') || '';
      const text = $(a).text().toLowerCase();
      if (!looksLikeFbVideo(href)) return;
      if (!hd && (text.includes('hd') || text.includes('high'))) { hd = href; return; }
      if (!sd) sd = href;
    });
  }

  if (!hd && !sd) throw new Error('fdown: no FB video links found');

  return {
    hd, sd,
    thumbnail: $('img').first().attr('src') || '',
    title:     $('p').first().text().trim() || 'Facebook Video',
  };
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
  // 2024–2025 FB JSON structures (Relay/RSC payloads)
  { key: 'hd', re: /"video_url"\s*:\s*"(https:\/\/[^"]*fbcdn[^"]+)"/ },
  { key: 'sd', re: /"stream_url"\s*:\s*"(https:\/\/[^"]*fbcdn[^"]+)"/ },
  { key: 'hd', re: /"base_url"\s*:\s*"(https:\/\/[^"]*fbcdn[^"]+\.mp4[^"]*)"/ },
];

async function tryDirectScrape(url) {
  // Try two UAs in order:
  //   1. iPhone Safari mobile UA — produces real fbcdn.net URLs in the
  //      `playable_url` / `playable_url_quality_hd` JSON keys. This is the
  //      one that actually downloads.
  //   2. facebookexternalhit/1.1 — FB's own crawler UA can bypass some soft
  //      login walls, BUT in 2026 it returns `playable_url` values pointing
  //      to `lookaside.fbsbx.com/lookaside/crawler/media/?media_id=…`. That
  //      endpoint is HTML for non-bot fetchers, so our proxy then streams
  //      300 bytes of HTML labelled .mp4 — a non-playable file. We accept
  //      bot-UA results ONLY when the resulting URL is a real fbcdn video.
  //
  // looksLikeFbVideo() rejects lookaside URLs and any other non-fbcdn /
  // non-.mp4 string, which is exactly the validation the previous version
  // was missing.
  const uas = [UA_MOBILE, UA_FB_BOT];
  let lastErr = '';

  for (const ua of uas) {
    const tag = ua === UA_FB_BOT ? 'bot' : 'ios';
    try {
      const resp = await axios.get(url, {
        timeout: 15000,
        maxRedirects: 10,
        headers: fbHeaders({
          'User-Agent': ua,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        }),
      });

      const html = typeof resp.data === 'string' ? resp.data : '';
      if (!html || html.length < 500) {
        lastErr = `direct(${tag}): empty response`;
        continue;
      }

      let hd = '', sd = '';
      for (const { key, re } of FB_REGEXES) {
        const m = html.match(re);
        if (m?.[1]) {
          const clean = unescapeJsString(m[1]);
          // Reject lookaside.fbsbx.com / og:image / non-video matches —
          // looksLikeFbVideo only accepts fbcdn.net URLs and .mp4 paths,
          // which is the only thing the proxy can actually stream.
          if (!looksLikeFbVideo(clean)) continue;
          if (key === 'hd' && !hd) hd = clean;
          if (key === 'sd' && !sd) sd = clean;
        }
        if (hd && sd) break;
      }

      if (!hd && !sd) {
        // Some reels expose only a raw mp4 in the HTML, not via the JSON keys.
        const mp4Matches = html.match(/https?:\/\/[^"'\s<>]*fbcdn\.net[^"'\s<>]*\.mp4[^"'\s<>]*/gi) || [];
        if (mp4Matches.length) sd = unescapeJsString(mp4Matches[0]).replace(/&amp;/g, '&');
      }

      if (!hd && !sd) {
        lastErr = `direct(${tag}): no video URLs (login required?)`;
        continue;
      }

      const $ = cheerio.load(html);
      return {
        hd, sd,
        thumbnail: $('meta[property="og:image"]').attr('content') || '',
        title:     $('meta[property="og:title"]').attr('content') || 'Facebook Video',
      };
    } catch (e) {
      lastErr = `direct(${tag}): ${e.message}`;
    }
  }

  throw new Error(lastErr || 'direct: no video URLs (login required?)');
}

// ─── Strategy : getfvid.com ──────────────────────────────────────────────────

async function tryGetfvid(url) {
  const resp = await axios.post(
    'https://getfvid.com/downloader',
    new URLSearchParams({ url }).toString(),
    {
      timeout: 25000, // increased
      headers: {
        'Content-Type':              'application/x-www-form-urlencoded',
        'User-Agent':                UA_DESKTOP,
        Accept:                      'text/html,application/xhtml+xml,*/*;q=0.9',
        Origin:                      'https://getfvid.com',
        Referer:                     'https://getfvid.com/',
        'Upgrade-Insecure-Requests': '1',
      },
      maxRedirects:   5,
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

// ─── Strategy : mbasic / m.facebook.com video scraper ────────────────────────

async function tryMbasicVideo(url) {
  const errors = [];

  const targets = [...new Set([
    url,
    url.replace(/(?:m|web|www|business)?\.?facebook\.com/i, 'mbasic.facebook.com'),
    url.replace(/(?:m|web|www|business)?\.?facebook\.com/i, 'm.facebook.com'),
  ])];

  // Skip mbasic for /reel/ URLs — they always redirect to login on mbasic
  // in 2026. Reels work via direct-scrape with the bot UA instead.
  const filteredTargets = targets.filter(t => !/\/reel\//i.test(t));
  const useTargets = filteredTargets.length ? filteredTargets : targets;

  for (const target of useTargets) {
    try {
      const resp = await axios.get(target, {
        timeout: 12000,
        maxRedirects: 10,
        validateStatus: () => true,
        headers: fbHeaders({
          // Bot UA bypasses many soft login walls on mbasic for public posts.
          'User-Agent': UA_FB_BOT,
          Accept: 'text/html,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        }),
      });

      const finalUrl = resp.request?.res?.responseUrl || '';
      if (/\/login(\.php|\/)/.test(finalUrl)) {
        errors.push('redirected to login');
        continue;
      }

      const html = typeof resp.data === 'string' ? resp.data : '';
      const mp4Matches = html.match(/https?:\/\/[^"'\s<>]*\.mp4[^"'\s<>]*/gi) || [];
      const videos = [...new Set(mp4Matches)]
        .map(u => unescapeJsString(u).replace(/&amp;/g, '&'))
        .filter(u => u.includes('fbcdn.net') || u.includes('scontent'));

      if (videos.length) {
        const $ = cheerio.load(html);
        return {
          hd: '',
          sd: videos[0],
          thumbnail: $('meta[property="og:image"]').attr('content') || '',
          title: $('meta[property="og:title"]').attr('content') || 'Facebook Video',
        };
      }

      errors.push('no mp4 urls');
    } catch (e) {
      errors.push(e.message);
    }
  }

  throw new Error(`mbasic-video: ${errors.join(' | ')}`);
}

// ─── Strategy : authenticated Facebook scrape using FB_SESSION_COOKIE ─────────

async function tryFacebookCookieScrape(url, cookieOverride = null) {
  const activeCookie = cookieOverride || FB_COOKIE;
  if (!activeCookie) {
    throw new Error('fb-cookie: no cookie supplied (per-request and FB_SESSION_COOKIE both empty)');
  }

  const targets = [...new Set([
    url,
    url.replace(/(?:m|web|www|business)?\.?facebook\.com/i, 'www.facebook.com'),
    url.replace(/(?:m|web|www|business)?\.?facebook\.com/i, 'm.facebook.com'),
    url.replace(/(?:m|web|www|business)?\.?facebook\.com/i, 'mbasic.facebook.com'),
  ])];

  const errors = [];

  for (const target of targets) {
    try {
      const isBasic = target.includes('mbasic.facebook.com') || target.includes('m.facebook.com');
      const resp = await axios.get(target, {
        timeout: 18000,
        maxRedirects: 15,
        validateStatus: () => true,
        headers: fbHeaders(
          {
            'User-Agent': isBasic ? UA_MOBILE : UA_DESKTOP,
            Accept: 'text/html,application/xhtml+xml,*/*;q=0.9',
          },
          activeCookie,
        ),
      });

      const finalUrl = resp.request?.res?.responseUrl || '';
      if (/\/login(\.php|\/)/.test(finalUrl)) {
        errors.push('cookie rejected/login redirect');
        continue;
      }

      const html = typeof resp.data === 'string' ? resp.data : '';
      if (!html || html.length < 500) {
        errors.push('empty html');
        continue;
      }

      if (
        html.includes('login_form') ||
        html.includes('id="loginbutton"') ||
        html.includes('checkpoint')
      ) {
        errors.push('cookie rejected/login html');
        continue;
      }

      let hd = '', sd = '';

      for (const { key, re } of FB_REGEXES) {
        const m = html.match(re);
        if (m?.[1]) {
          const clean = unescapeJsString(m[1]).replace(/&amp;/g, '&');
          if (key === 'hd' && !hd && clean.startsWith('http')) hd = clean;
          if (key === 'sd' && !sd && clean.startsWith('http')) sd = clean;
        }
        if (hd && sd) break;
      }

      if (!hd && !sd) {
        const mp4Matches = html.match(/https?:\/\/[^"'\s<>]*\.mp4[^"'\s<>]*/gi) || [];
        const videos = [...new Set(mp4Matches)]
          .map(u => unescapeJsString(u).replace(/&amp;/g, '&'))
          .filter(u => u.includes('fbcdn.net') || u.includes('scontent'));
        if (videos.length) sd = videos[0];
      }

      if (hd || sd) {
        const $ = cheerio.load(html);
        return {
          hd,
          sd,
          thumbnail: $('meta[property="og:image"]').attr('content') || '',
          title: $('meta[property="og:title"]').attr('content') || 'Facebook Video',
        };
      }

      errors.push('no video urls');
    } catch (e) {
      errors.push(e.message);
    }
  }

  throw new Error(`fb-cookie: ${errors.join(' | ')}`);
}

// ─── Facebook entry ──────────────────────────────────────────────────────────

async function downloadFacebook(rawUrl, opts = {}) {
  const { fbCookie = null } = opts;
  console.log(`📘 Facebook: starting for ${rawUrl}`);

  const normalized = normalizeFacebookUrl(rawUrl);
  const { url: canonical, requiresLogin } = await resolveCanonicalFbUrl(normalized);

  // Stories still need the story-specific public path first. If a cookie is
  // available (per-request OR FB_COOKIE env), normal authenticated scrape is
  // also allowed as a fallback below.
  if (looksLikeFbStoryUrl(rawUrl)) {
    if (fbCookie || FB_COOKIE) {
      try {
        const cookieResult = await withTimeout(
          tryFacebookCookieScrape(rawUrl, fbCookie),
          18000,
          'fb-cookie-story'
        );
        if (cookieResult && (cookieResult.hd || cookieResult.sd)) {
          console.log('📘 ✅ FB Story via cookie succeeded');
          return cookieResult;
        }
      } catch (e) {
        console.warn(`📘 FB Story cookie path failed: ${e.message}`);
      }
    }

    try {
      const result = await withTimeout(
        tryFbStoryPublic(rawUrl),
        25000,
        'fb-story-public'
      );
      if (result && (result.hd || result.sd)) {
        console.log('📘 ✅ FB Story via public mirror succeeded');
        return result;
      }
    } catch (e) {
      console.warn(`📘 FB Story public path failed: ${e.message}`);
    }

    throw new Error(
      'Facebook Story not accessible. Public-profile stories can sometimes ' +
      'be downloaded, but this one was either private, restricted, expired, ' +
      'or no valid session cookie was supplied. Sign in to Facebook in the ' +
      'app to enable Story downloads.'
    );
  }

  // If a non-story resolved to login, do NOT stop immediately. Some mirrors
  // and metadownloader can still resolve share URLs. Cookie strategy is added
  // when EITHER a per-request cookie is provided OR FB_SESSION_COOKIE is set.
  if (requiresLogin && !fbCookie && !FB_COOKIE) {
    console.warn('📘 Facebook resolved to login wall and no cookie available; trying public fallbacks only');
  }

  const candidateUrls = [...new Set([canonical, normalized, rawUrl].filter(Boolean))];
  const strategies = [];

  for (const candidate of candidateUrls) {
    if (fbCookie || FB_COOKIE) {
      strategies.push([
        'fb-cookie',
        () => tryFacebookCookieScrape(candidate, fbCookie),
        18000,
      ]);
    }

    strategies.push(
      // direct-scrape with bot UA is now the most reliable strategy in 2026.
      ['direct-scrape',  () => tryDirectScrape(candidate),         15000],
      ['fdown',          () => tryFdownNet(candidate),             18000],
      ['mbasic-video',   () => tryMbasicVideo(candidate),          12000],
      ['getfvid',        () => tryGetfvid(candidate),              20000],
      // metadownloader package is dead (throws split-on-undefined) — kept
      // only as last resort so successful runs are still logged when FB
      // restores its older response shape.
      ['metadownloader', () => tryMetadownloader(candidate),       12000],
    );
  }

  const buildPromises = (errors) => strategies.map(([name, fn, ms]) =>
    withTimeout(fn(), ms, name).then(
      result => {
        if (name === 'metadownloader') {
          if (result) { console.log(`📘 ✅ ${name} succeeded`); return result; }
          throw new Error(`${name}: empty result`);
        }
        if (result && (result.hd || result.sd)) {
          console.log(`📘 ✅ ${name} succeeded`);
          return result;
        }
        throw new Error(`${name}: no usable URL`);
      },
      err => {
        const msg = err.message || String(err);
        console.warn(`📘 ❌ ${name}: ${msg.slice(0, 120)}`);
        throw new Error(`${name}: ${msg}`);
      }
    )
  );

  const errors = [];
  try {
    return await firstSuccess(buildPromises(errors), errors);
  } catch (_) {
    console.warn('🔁 Facebook retry once with same candidates');
    const retryErrors = [];
    try {
      return await firstSuccess(buildPromises(retryErrors), retryErrors);
    } catch (_) {
      const allErrors = [...errors, ...retryErrors].join(' | ');
      const cookieHint = (fbCookie || FB_COOKIE)
        ? ''
        : ' | login required: Facebook share/reel URLs often need a signed-in session — sign in via the in-app browser to enable auth';
      throw new Error(`Facebook: all strategies failed — ${allErrors}${cookieHint}`);
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

async function tryInstagramStories(url) {
  const m = url.match(/instagram\.com\/stories\/([^/?#]+)(?:\/(\d+))?/i);
  if (!m) throw new Error('stories: could not extract username');
  const username = m[1];
  const targetMediaPk = m[2] || '';

  console.log(`📸 stories: trying public mirrors for @${username}`);

  const buildItems = (rawStories) => {
    if (!Array.isArray(rawStories)) return [];
    return rawStories.map(s => {
      const videoUrl =
        s.video_versions?.[0]?.url || s.video_url || s.video || s.url ||
        (Array.isArray(s.videos) ? s.videos[0]?.url || s.videos[0] : '') || '';
      const imageUrl =
        s.image_versions2?.candidates?.[0]?.url || s.image_url ||
        s.thumbnail_url || s.thumb || s.thumbnail || s.display_url || '';
      const isVideoEntry = !!videoUrl ||
        s.media_type === 2 || s.media_type === '2' ||
        s.type === 'video';
      const finalUrl = isVideoEntry ? (videoUrl || imageUrl) : (imageUrl || videoUrl);
      if (!finalUrl) return null;
      return {
        url:       finalUrl,
        thumbnail: imageUrl || finalUrl,
        type:      isVideoEntry ? 'video' : 'image',
        quality:   'Original Quality',
      };
    }).filter(Boolean);
  };

  // ── Strategy A: storiesig.info — current 2026 layout is a 2-step API ────
  // /api/userinfo/?username=… returns the user id, then
  // /api/stories/?id=<user_id> returns the JSON story list. The headers
  // x-requested-with + Referer are required — without them the endpoints
  // return empty bodies (which was the symptom of the failing logs).
  for (const host of ['storiesig.info', 'storiessig.com']) {
    try {
      const userResp = await axios.get(
        `https://${host}/api/userinfo/?username=${encodeURIComponent(username)}`,
        {
          timeout: 12_000,
          headers: {
            'User-Agent':       UA_DESKTOP,
            Accept:             'application/json, text/plain, */*',
            'X-Requested-With': 'XMLHttpRequest',
            Origin:             `https://${host}`,
            Referer:            `https://${host}/en/${username}`,
            'Accept-Language':  'en-US,en;q=0.9',
          },
          validateStatus: () => true,
        }
      );

      const userId =
        userResp.data?.result?.user?.pk ||
        userResp.data?.result?.user?.id ||
        userResp.data?.user?.pk ||
        userResp.data?.id || '';
      if (!userId) {
        console.log(`📸 stories: ${host} userinfo: no id`);
        continue;
      }

      const storyResp = await axios.get(
        `https://${host}/api/stories/?id=${encodeURIComponent(userId)}`,
        {
          timeout: 15_000,
          headers: {
            'User-Agent':       UA_DESKTOP,
            Accept:             'application/json, text/plain, */*',
            'X-Requested-With': 'XMLHttpRequest',
            Origin:             `https://${host}`,
            Referer:            `https://${host}/en/${username}`,
            'Accept-Language':  'en-US,en;q=0.9',
          },
          validateStatus: () => true,
        }
      );

      const stories =
        storyResp.data?.result || storyResp.data?.data ||
        storyResp.data?.stories || storyResp.data?.items || [];
      const items = buildItems(stories);
      if (items.length) {
        // If a specific media_pk was in the URL, prefer that one first.
        if (targetMediaPk) {
          const idx = stories.findIndex(s =>
            String(s.pk || s.id || '') === String(targetMediaPk));
          if (idx >= 0) return [items[idx]];
        }
        console.log(`📸 stories: ${host} ✓ ${items.length} item(s)`);
        return items;
      }
    } catch (e) {
      console.log(`📸 stories: ${host} failed: ${e.message}`);
    }
  }

  // ── Strategy B: anonyig.com (v1 endpoint shape) ─────────────────────────
  try {
    const resp = await axios.get(
      `https://anonyig.com/api/ig/story?url=${encodeURIComponent(url)}`,
      {
        timeout: 15_000,
        headers: {
          'User-Agent':       UA_DESKTOP,
          Accept:             'application/json, text/plain, */*',
          'X-Requested-With': 'XMLHttpRequest',
          Origin:             'https://anonyig.com',
          Referer:            `https://anonyig.com/profile/${username}/`,
          'Accept-Language':  'en-US,en;q=0.9',
        },
        validateStatus: () => true,
      }
    );
    const stories =
      resp.data?.result || resp.data?.data ||
      resp.data?.stories || resp.data?.items || [];
    const items = buildItems(stories);
    if (items.length) {
      console.log(`📸 stories: anonyig.com ✓ ${items.length} item(s)`);
      return items;
    }
  } catch (e) {
    console.log(`📸 stories: anonyig.com failed: ${e.message}`);
  }

  // ── Strategy C: imginn.com HTML scrape ─────────────────────────────────
  // imginn renders story pages server-side. Cheerio against <video> and
  // <img> tags works for public profiles. Reliability ~60-80% but a
  // valuable fallback when the JSON APIs above return nothing.
  try {
    const resp = await axios.get(
      `https://imginn.com/stories/${encodeURIComponent(username)}/`,
      {
        timeout: 18_000,
        maxRedirects: 5,
        validateStatus: () => true,
        headers: {
          'User-Agent':      UA_DESKTOP,
          Accept:            'text/html,application/xhtml+xml,*/*;q=0.9',
          'Accept-Language': 'en-US,en;q=0.9',
          Referer:           'https://imginn.com/',
        },
      }
    );
    const html = typeof resp.data === 'string' ? resp.data : '';
    if (html && html.length > 500) {
      const $ = cheerio.load(html);
      const items = [];
      $('video').each((_, v) => {
        const src = $(v).attr('src') || $(v).find('source').attr('src') || '';
        if (src && src.startsWith('http')) {
          items.push({
            url: src,
            thumbnail: $(v).attr('poster') || src,
            type: 'video',
            quality: 'Original Quality',
          });
        }
      });
      // For pages that render images only (story photo cards)
      if (!items.length) {
        $('img').each((_, im) => {
          const src = $(im).attr('src') || $(im).attr('data-src') || '';
          if (src && src.startsWith('http') &&
              (src.includes('cdninstagram') || src.includes('fbcdn'))) {
            items.push({ url: src, thumbnail: src, type: 'image', quality: 'Original Quality' });
          }
        });
      }
      if (items.length) {
        console.log(`📸 stories: imginn.com ✓ ${items.length} item(s)`);
        return items;
      }
    }
  } catch (e) {
    console.log(`📸 stories: imginn.com failed: ${e.message}`);
  }

  return [];
}

// ─── Public API ──────────────────────────────────────────────────────────────

async function facebookInsta(url, opts = {}) {
  const { fbCookie = null, igCookie = null } = opts;

  // Detect Facebook URLs (including m.facebook.com and fb.watch)
  const isFb = /(?:^|\/\/)(?:m|web|www|business)?\.?facebook\.com|fb\.watch/i.test(url);
  if (isFb) {
    return downloadFacebook(url, { fbCookie });
  }

  // ── Instagram ──────────────────────────────────────────────────────────
  // Stories: try the public mirror scrapers (storiesig.info, anonyig) first
  // — these can fetch public-profile stories without auth. If those fail
  // and a session cookie is available (per-request OR env), try the
  // authenticated GraphQL path. If everything fails, return a clean
  // "requires login" message that the controller turns into LOGIN_REQUIRED.
  if (looksLikeIgStoryUrl(url)) {
    // Step 1: public mirrors (free, no cookie required)
    try {
      const items = await tryInstagramStories(url);
      if (items.length) return { status: true, data: items, _source: 'stories-mirror' };
    } catch (e) {
      console.warn(`📸 stories public mirror failed: ${e.message}`);
    }

    // Step 2: cookie-authenticated path — accepts per-request cookie too.
    const activeIgCookie = igCookie || IG_COOKIE;
    if (activeIgCookie) {
      try {
        const items = await withTimeout(
          tryIgStoryWithCookie(url, igCookie), // forwards override
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

    // Step 3: clean error — message is now friendlier since per-request
    // cookies are available via the in-app browser sign-in flow.
    throw new Error(
      'Instagram Stories require login or come from a private account. ' +
      'Public-profile stories can sometimes be fetched, but this one was ' +
      'not accessible.' +
      (activeIgCookie ? '' : ' Sign in to Instagram in the in-app browser to enable Story downloads.')
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