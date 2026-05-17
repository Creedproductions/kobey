/**
 * facebookInstaService.js
 *
 * Facebook  : runs strategies in PARALLEL with per-strategy timeouts. The
 *             previous sequential chain meant a single hanging strategy could
 *             stall the whole request until the global 45s timeout. Now they
 *             race — first to succeed wins, slow ones are abandoned.
 *
 *             2026 strategy lineup (no signin needed for public content):
 *               1. og-meta-extract  — pulls og:video / og:video:secure_url
 *                                     and inline JSON keys from the share
 *                                     page itself. Cheapest + fastest.
 *               2. direct-scrape    — iPhone + Bot UA against the canonical
 *                                     URL. Still the workhorse; handles
 *                                     reels, watch URLs, share/v, share/r.
 *               3. snapsave-fb      — snapsave.app's /action_download.php
 *                                     also accepts Facebook URLs (not just
 *                                     Instagram). Survives a lot of cases
 *                                     where direct-scrape returns nothing.
 *               4. fdownloader-net  — fdownloader.net's POST scraper; new
 *                                     mirror that's been reliable through
 *                                     2025-2026.
 *               5. savefbs          — savefbs.com fallback for the cases
 *                                     where every other mirror is blocked.
 *               6. fdown-v2         — fdown.net with Cloudflare-friendly
 *                                     headers. Removed if 403s persist.
 *
 *             RETIRED in 2026:
 *               - getfvid.com   (DNS resolution fails consistently from
 *                                Koyeb's EU regions — EAI_AGAIN every call)
 *               - mbasic-video  (Facebook removed video playback from
 *                                mbasic.facebook.com; now serves zero mp4
 *                                URLs and just redirects to login)
 *               - metadownloader npm package (throws "split of undefined"
 *                                on every response shape since FB's
 *                                Dec 2024 markup change). Kept disabled
 *                                behind FB_USE_LEGACY_METADOWNLOADER=1.
 *
 *             Detects FB Story / login-required URLs upfront (any URL that
 *             redirects to /login.php or /login/) and returns a clean
 *             "Authentication required" error instead of letting every
 *             strategy waste time hitting a login wall.
 *
 * Instagram : same treatment — early Story / private-content detection, plus
 *             snapsave + snapinsta + igdl + embed scrape, run as a race.
 *             Stories use the multi-mirror public path (storiesig.info,
 *             anonyig.com, imginn.com) — no cookie required for public
 *             profiles. TikTok stories handled by tiktokService.
 *
 * Output for Facebook:    { hd, sd, thumbnail, title } OR a metadownloader-shaped object
 * Output for Instagram:   { status: true, data: [items] }
 */

const axios   = require('axios');
const cheerio = require('cheerio');
const ytdlp   = require('./ytDlpRunner');

let metadownloader;
try { metadownloader = require('metadownloader'); }
catch (_) { metadownloader = null; console.warn('⚠️ metadownloader not installed (optional)'); }

let igdl;
try { ({ igdl } = require('btch-downloader')); }
catch (_) { igdl = null; console.warn('⚠️ btch-downloader igdl not available'); }

// yt-dlp is invoked as a child process — used only as a last-resort fallback
// for Facebook share URLs where every HTTP scraper hits a dead end (share
// token isn't the canonical ID, no third-party mirror accepts the URL, FB's
// own plugin endpoint returns no metadata). yt-dlp follows FB's redirect
// chain natively and can extract the underlying fbcdn URL.
//
// IMPORTANT: yt-dlp may not be installed (e.g. when running under Koyeb's
// buildpack fallback). _resolveYtDlp() returns null in that case, and the
// strategy registers a no-op skip instead of polluting the error log with
// "spawn yt-dlp ENOENT" lines.
const _fs = require('fs');
const { execFile: _execFile } = require('child_process');
const { execSync: _execSync } = require('child_process');
const _YT_DLP_CANDIDATES = [
  process.env.YT_DLP_BIN,
  '/opt/yt/bin/yt-dlp',
  '/usr/local/bin/yt-dlp',
  '/usr/bin/yt-dlp',
].filter(Boolean);
let _ytDlpBin = null;
let _ytDlpResolved = false;
function _resolveYtDlp() {
  if (_ytDlpResolved) return _ytDlpBin;
  _ytDlpResolved = true;
  for (const p of _YT_DLP_CANDIDATES) {
    try { _fs.accessSync(p, _fs.constants.X_OK); _ytDlpBin = p; return p; } catch (_) {}
  }
  // Last resort: try PATH lookup via `which`. If that fails, mark as
  // unavailable (null) so callers can skip the strategy cleanly.
  try {
    const which = _execSync('which yt-dlp', { encoding: 'utf8', timeout: 2000 }).trim();
    if (which && which.startsWith('/')) {
      try { _fs.accessSync(which, _fs.constants.X_OK); _ytDlpBin = which; return which; } catch (_) {}
    }
  } catch (_) { /* `which` failed - binary not on PATH */ }
  _ytDlpBin = null;
  return null;
}
// Resolve once at module load so we know upfront whether the strategy is viable
const _YTDLP_AVAILABLE = !!_resolveYtDlp();
console.log(`📘 yt-dlp: ${_YTDLP_AVAILABLE ? `✅ available at ${_ytDlpBin}` : '⚠️  not installed — yt-dlp-fb strategy disabled'}`);

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

/**
 * Like firstSuccess, but each entry is { name, promise, slow } and the race
 * REJECTS early once every non-slow ("fast") promise has rejected with a
 * permanent error — without waiting for the slow promises to finish.
 *
 * This is the key UX win for failed FB URLs: when og-meta + snapsave + savefbs
 * + fb-plugin + direct-scrape have all returned permanent failures (404, "no
 * video metadata", timeouts), yt-dlp's success rate is near-zero, so making
 * the user wait an extra ~10s for yt-dlp's wrapper timeout is dead weight.
 *
 * Slow promises continue running in the background (we don't have a
 * universal cancel signal) but their results are ignored after early exit.
 * The wrapper around them — withTimeout — still fires SIGKILL on subprocess
 * timeouts, so they won't leak forever.
 */
function firstSuccessFastFail(entries, errors, isPermanentErrorFn) {
  return new Promise((resolve, reject) => {
    let done = false;
    let totalSettled = 0;
    let fastTotal = entries.filter(e => !e.slow).length;
    let fastSettled = 0;
    let fastAllPermanent = true;

    entries.forEach(entry => {
      entry.promise.then(
        v => { if (!done) { done = true; resolve(v); } },
        e => {
          const msg = e.message || String(e);
          errors.push(msg);
          totalSettled++;

          if (!entry.slow) {
            fastSettled++;
            if (!isPermanentErrorFn(msg)) fastAllPermanent = false;

            // Early-exit: every fast strategy has rejected, and every one of
            // them was a permanent failure. No point waiting for the slow ones.
            if (!done && fastTotal > 0 && fastSettled === fastTotal && fastAllPermanent) {
              done = true;
              console.warn('⚡ Facebook: all fast strategies permanently failed — aborting slow strategies early');
              reject(new Error(errors.join(' | ')));
              return;
            }
          }

          if (totalSettled === entries.length && !done) {
            done = true;
            reject(new Error(errors.join(' | ')));
          }
        }
      );
    });

    // Defensive: if there are zero entries, reject immediately so we don't hang.
    if (entries.length === 0) {
      done = true;
      reject(new Error('no strategies to run'));
    }
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
//
// 2026 update: we now return up to FOUR candidate canonical URLs (not just
// one) and let the downstream strategies race against each. The reason: a
// share/p/<id> URL might actually point to a /posts/, /videos/, OR a /reel/
// — Facebook decides at server-side. Guessing only /reel/ was the root
// cause of share/p/<id> failures in the alert logs. Strategies that don't
// match the actual type fail fast (404 / no video), and the matching one
// wins the race.

async function resolveCanonicalFbUrl(rawUrl) {
  // Strip tracking params (?fs=e, ?mibextid=…, ?s=…) that some FB redirect
  // chains re-add on every hop, causing maxRedirects to be exceeded. Done
  // BEFORE the canonical-shortcut check so URLs like
  //   /reel/1664954301489817/?mibextid=9drbnH&s=yWDuG2&fs=e
  // are normalised to /reel/1664954301489817/ before we hand them to mirrors
  // (most third-party scrapers reject URLs with FB tracking params).
  let cleanRaw = String(rawUrl).trim();
  try {
    const u = new URL(cleanRaw);
    [
      'fs', 'mibextid', 'extid', 'lst', '_rdr', 's', 'idorvanity',
      'rdid', 'paipv', 'eav', 'comment_id', 'reply_comment_id',
      'notif_t', 'notif_id', '__cft__[0]', '__tn__',
    ].forEach(k => u.searchParams.delete(k));
    // Strip ALL params except ones we know are content-bearing
    const keep = ['v', 'story_fbid', 'id'];
    [...u.searchParams.keys()].forEach(k => { if (!keep.includes(k)) u.searchParams.delete(k); });
    cleanRaw = u.toString().replace(/\?$/, '');
  } catch (_) { /* leave as-is */ }

  // If already canonical, fetch the share page HTML so og-meta-extract can
  // still run. Previously we returned early with shareHtml='' which silently
  // disabled og-meta for every canonical URL — wasteful when og:video is
  // sometimes the only signal we get for share/p/ posts that redirected.
  if (
    cleanRaw.match(/facebook\.com\/(watch|reel|video)\/\d+/) ||
    cleanRaw.match(/facebook\.com\/[^/]+\/videos\/\d+/) ||
    cleanRaw.includes('facebook.com/watch?v=')
  ) {
    let shareHtml = '';
    try {
      const resp = await axios.get(cleanRaw, {
        timeout: 8000,
        maxRedirects: 15,
        validateStatus: () => true,
        headers: fbHeaders({
          'User-Agent': UA_FB_BOT,
          Accept: 'text/html,application/xhtml+xml,*/*;q=0.9',
        }),
      });
      shareHtml = typeof resp.data === 'string' ? resp.data : '';
    } catch (_) { /* og-meta will just skip */ }
    return { url: cleanRaw, candidates: [cleanRaw], requiresLogin: false, shareHtml };
  }

  const url = cleanRaw.replace('m.facebook.com', 'www.facebook.com');
  console.log(`🔗 Resolving: ${url}`);

  // ── STEP 1: fetch share page HTML for canonical meta tags & inline JSON ──
  // Try bot UA first (cleanest crawler output, fewest redirects), then iPhone
  // (returns richest JSON when bot is rate-limited), then desktop.
  // maxRedirects 25 — FB's redirect chain for share URLs can be 12-18 hops.
  //
  // We now also capture the FINAL URL after redirects (responseUrl). For
  // /share/v/, /share/r/, /share/p/ URLs, Facebook does a server-side 30x
  // chain that lands on the real canonical (e.g. /<user>/videos/<fbid>/).
  // Previously we threw that information away and tried to guess the
  // canonical from the share ID — which produced URLs like
  //   https://www.facebook.com/watch/?v=<base62>
  // that always 404 because /watch/?v= expects a numeric FBID, not the
  // base62 share token. Using the actual redirect target eliminates the
  // 404 storm seen in production logs.
  let shareHtml = '';
  let redirectedTo = '';
  const uaProbes = [UA_FB_BOT, UA_MOBILE, UA_DESKTOP];
  for (const ua of uaProbes) {
    try {
      const resp = await axios.get(url, {
        maxRedirects: 25,
        timeout: 12000,
        validateStatus: () => true,
        headers: fbHeaders({
          'User-Agent': ua,
          Accept: 'text/html,application/xhtml+xml,*/*;q=0.9',
        }),
      });
      const body = typeof resp.data === 'string' ? resp.data : '';
      if (body && body.length > shareHtml.length) shareHtml = body;

      // The most reliable canonical signal we have: where did the redirect
      // chain actually land? We keep the LAST non-login, non-share target.
      const finalUrl =
        resp.request?.res?.responseUrl ||
        resp.request?.responseURL      ||
        (resp.config?.url !== url ? resp.config?.url : '');
      if (
        finalUrl && typeof finalUrl === 'string' &&
        finalUrl !== url &&
        !/\/login(\.php|\/)/.test(finalUrl) &&
        !/\/share\//.test(finalUrl)
      ) {
        redirectedTo = finalUrl;
        console.log(`🔗 share resolver final URL → ${finalUrl}`);
      }

      if (body && body.length > 5000) break;
    } catch (_) {
      // try the next UA
    }
  }

  const isProfileShape = (u) => {
    try {
      const parts = new URL(u).pathname.split('/').filter(Boolean);
      return parts.length === 1;
    } catch { return false; }
  };

  // ── STEP 2: parse share page HTML for canonical URL (multiple paths) ─────
  // FB serves the canonical URL in several places depending on the UA used:
  //   - <meta property="og:url" content="…"/> (most common)
  //   - <meta property="al:ios:url"> / <meta property="al:android:url">
  //   - <link rel="canonical" href="…"/>
  //   - <meta http-equiv="refresh" content="0; url=…"/>
  //   - inline JSON: "permalink_url":"…" or "story_url":"…"
  //   - inline JS:  document.location.replace("…")
  let canonicalFromMeta = '';
  if (shareHtml) {
    const $ = cheerio.load(shareHtml);

    const acceptCanonical = (u) => {
      if (!u || typeof u !== 'string') return false;
      const trimmed = u.trim().replace(/&amp;/g, '&');
      if (!trimmed.includes('facebook.com')) return false;
      if (trimmed.includes('/share/'))       return false;
      if (trimmed.includes('/login'))        return false;
      if (isProfileShape(trimmed))           return false;
      // Must look like an actual content URL
      return /\/(watch|reel|video|videos|posts|story|permalink|reels)/i.test(trimmed) ||
             /watch\/\?v=/i.test(trimmed) ||
             /story_fbid=/i.test(trimmed);
    };

    const ogUrl = $('meta[property="og:url"]').attr('content');
    if (acceptCanonical(ogUrl)) {
      console.log(`🔗 share page og:url → ${ogUrl}`);
      canonicalFromMeta = ogUrl;
    }

    if (!canonicalFromMeta) {
      const alUrl = $('meta[property="al:ios:url"]').attr('content') ||
                    $('meta[property="al:android:url"]').attr('content');
      if (acceptCanonical(alUrl)) {
        console.log(`🔗 share page al:url → ${alUrl}`);
        canonicalFromMeta = alUrl;
      }
    }

    if (!canonicalFromMeta) {
      const linkCanonical = $('link[rel="canonical"]').attr('href');
      if (acceptCanonical(linkCanonical)) {
        console.log(`🔗 link rel=canonical → ${linkCanonical}`);
        canonicalFromMeta = linkCanonical;
      }
    }

    if (!canonicalFromMeta) {
      const refresh = $('meta[http-equiv="refresh"]').attr('content') || '';
      const m = refresh.match(/url\s*=\s*['"]?([^'"]+)['"]?/i);
      if (m && acceptCanonical(m[1])) {
        console.log(`🔗 meta refresh → ${m[1]}`);
        canonicalFromMeta = m[1];
      }
    }

    if (!canonicalFromMeta) {
      // Inline JSON / JS patterns Facebook uses in share-page HTML
      const inlinePatterns = [
        /"permalink_url"\s*:\s*"([^"]+)"/,
        /"story_url"\s*:\s*"([^"]+)"/,
        /"canonical_url"\s*:\s*"([^"]+)"/,
        /document\.location\.replace\(['"]([^'"]+)['"]\)/,
        /window\.location\s*=\s*['"]([^'"]+)['"]/,
      ];
      for (const re of inlinePatterns) {
        const m = shareHtml.match(re);
        if (m?.[1]) {
          const decoded = unescapeJsString(m[1]);
          if (acceptCanonical(decoded)) {
            console.log(`🔗 inline pattern → ${decoded}`);
            canonicalFromMeta = decoded;
            break;
          }
        }
      }
    }
  }

  // ── STEP 3: build candidate URLs ──────────────────────────────────────────
  // PRIORITY ORDER:
  //   1. The actual final URL the redirect chain landed on (most reliable)
  //   2. The canonical URL extracted from <meta og:url> / <link canonical>
  //   3. ONE guess per share kind, only when the guess is plausibly correct
  //      for the share-token format
  //
  // We previously generated lots of guesses like /watch/?v=<base62> and
  // /video.php?v=<base62> for share/v URLs, and /<base62>/posts/ for share/p.
  // Those endpoints REQUIRE numeric FBIDs, so they always returned 404 and
  // wasted strategy attempts. The share token in /share/v/<id>/ is base62,
  // NOT a numeric FBID — only /reel/<token>/ accepts base62 in 2026.
  const candidates = new Set();

  if (redirectedTo) candidates.add(redirectedTo);
  if (canonicalFromMeta) candidates.add(canonicalFromMeta);

  const isNumericId = (s) => /^\d{6,}$/.test(s);

  const shareMatch = url.match(/facebook\.com\/share\/(v|r|p|s)\/([A-Za-z0-9_-]+)/i);
  if (shareMatch) {
    const kind = shareMatch[1].toLowerCase();
    const id   = shareMatch[2];
    const numeric = isNumericId(id);

    if (kind === 'v') {
      // /reel/<base62>/ is the only path that accepts non-numeric share IDs.
      // The /watch/?v= and /video.php?v= endpoints require numeric FBIDs and
      // 404 every time a base62 token is passed — never include them.
      candidates.add(`https://www.facebook.com/reel/${id}/`);
      if (numeric) {
        candidates.add(`https://www.facebook.com/watch/?v=${id}`);
        candidates.add(`https://www.facebook.com/video.php?v=${id}`);
      }
    } else if (kind === 'r') {
      candidates.add(`https://www.facebook.com/reel/${id}/`);
      candidates.add(`https://www.facebook.com/reels/${id}/`);
      if (numeric) candidates.add(`https://www.facebook.com/watch/?v=${id}`);
    } else if (kind === 'p') {
      // /share/p/<token> is a post. /<token>/posts/ and
      // permalink.php?story_fbid=<token> both require numeric IDs to resolve,
      // so we only generate them for numeric tokens. For base62 tokens, the
      // share URL itself + the redirect target + the meta canonical are the
      // only useful candidates.
      if (numeric) {
        candidates.add(`https://www.facebook.com/${id}/posts/`);
        candidates.add(`https://www.facebook.com/permalink.php?story_fbid=${id}`);
      }
    } else if (kind === 's') {
      // /share/s/ — sometimes used for "stories" or generic shares.
      // No reliable guess; rely on redirect target + share URL itself.
    }
  }

  // fb.watch redirects to the canonical via a 30x — try resolving with iOS
  // UA (FB serves more direct redirects to mobile clients than to desktop).
  if (/fb\.watch/i.test(url) && !redirectedTo) {
    for (const ua of [UA_MOBILE, UA_FB_BOT, UA_DESKTOP]) {
      try {
        const probe = await axios.get(url, {
          maxRedirects: 25,
          timeout: 10000,
          validateStatus: () => true,
          headers: fbHeaders({ 'User-Agent': ua }),
        });
        const finalUrl =
          probe.request?.res?.responseUrl ||
          probe.request?.responseURL      ||
          (probe.config?.url !== url ? probe.config?.url : '');
        if (finalUrl && !/\/login/.test(finalUrl) && !/\/share\//.test(finalUrl)) {
          console.log(`🔗 fb.watch redirected (${ua === UA_FB_BOT ? 'bot' : ua === UA_MOBILE ? 'ios' : 'desk'}) → ${finalUrl}`);
          candidates.add(finalUrl);
          break;
        }
      } catch (_) { /* try next UA */ }
    }
  }

  // ── STEP 3.5: explicit redirect-follow for ALL share URLs ────────────────
  // Even when STEP 1 returned HTML, the final URL of that fetch may have
  // been a /share/ URL (FB sometimes redirects share/v -> share/r -> canonical
  // and we missed the last hop). This second probe uses the iOS UA which
  // consistently produces the cleanest single-hop redirect to the canonical
  // /<username>/videos/<fbid>/ URL.
  if (/facebook\.com\/share\//i.test(url) && !redirectedTo) {
    for (const ua of [UA_MOBILE, UA_FB_BOT]) {
      try {
        const probe = await axios.get(url, {
          maxRedirects: 25,
          timeout: 10000,
          validateStatus: () => true,
          headers: fbHeaders({ 'User-Agent': ua }),
        });
        const finalUrl =
          probe.request?.res?.responseUrl ||
          probe.request?.responseURL      ||
          (probe.config?.url !== url ? probe.config?.url : '');
        if (finalUrl && !/\/login/.test(finalUrl) && !/\/share\//.test(finalUrl)) {
          console.log(`🔗 share redirected (${ua === UA_FB_BOT ? 'bot' : 'ios'}) → ${finalUrl}`);
          candidates.add(finalUrl);
          break;
        }
      } catch (_) { /* try next UA */ }
    }
  }

  // ── STEP 4: last-ditch fallback redirect chain ───────────────────────────
  if (candidates.size === 0) {
    console.warn('🔗 Fallback: following redirects normally');
    try {
      const resp = await axios.get(url, {
        maxRedirects:   25,
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
        candidates.add(final);
      }
    } catch (e) {
      console.warn(`🔗 Redirect fallback failed: ${e.message}`);
    }
  }

  // NOTE: we deliberately do NOT add m.facebook.com / mbasic.facebook.com
  // variants for /share/ URLs anymore. Production logs showed these always
  // redirect to the mobile login wall and time out direct-scrape (15s each),
  // adding 30+ seconds of dead time to every share-URL request. mbasic
  // remains usable for /watch/ and /videos/ URLs via the mbasic-video
  // strategy (opt-in via FB_USE_MBASIC=1).

  // Always include the original URL as a candidate — third-party scrapers
  // (snapsave-fb, fdownloader-net, savefbs) accept the /share/ URL directly.
  candidates.add(url);

  const list = [...candidates];
  const primary = list[0];
  console.log(`🔗 Candidates (${list.length}):`, list.map(u => u.slice(0, 80)).join(' | '));
  return { url: primary, candidates: list, requiresLogin: false, shareHtml };
}

// ─── Strategy : og-meta-extract (cheapest, runs on the share page HTML) ──────
// Pulls video URLs straight out of og:video / og:video:secure_url meta tags
// and from inline JSON keys (playable_url, hd_src, video_url) embedded in the
// share page HTML that the resolver already fetched. This costs zero extra
// network calls when the resolver succeeded, and is often the only strategy
// that works for share/p/<id> photo+video posts.

async function tryOgMetaExtract(shareHtml /* string */) {
  if (!shareHtml || shareHtml.length < 200) {
    throw new Error('og-meta: share page HTML not available');
  }
  const $ = cheerio.load(shareHtml);

  let hd = '', sd = '';

  // og:video:secure_url is the canonical Open Graph spec key. og:video is
  // the older one. Both can appear with multiple <meta> tags for HD + SD.
  $('meta[property="og:video:secure_url"], meta[property="og:video:url"], meta[property="og:video"]').each((_, el) => {
    const v = $(el).attr('content') || '';
    if (!v) return;
    const clean = v.replace(/&amp;/g, '&');
    if (!looksLikeFbVideo(clean)) return;
    if (!hd) hd = clean;
    else if (!sd && clean !== hd) sd = clean;
  });

  // Inline JSON keys (same FB_REGEXES we use in direct-scrape)
  if (!hd || !sd) {
    for (const { key, re } of FB_REGEXES) {
      const m = shareHtml.match(re);
      if (m?.[1]) {
        const clean = unescapeJsString(m[1]);
        if (!looksLikeFbVideo(clean)) continue;
        if (key === 'hd' && !hd) hd = clean;
        if (key === 'sd' && !sd) sd = clean;
      }
      if (hd && sd) break;
    }
  }

  // Last resort: any fbcdn .mp4 anywhere in the share HTML
  if (!hd && !sd) {
    const mp4Matches = shareHtml.match(/https?:\/\/[^"'\s<>]*fbcdn\.net[^"'\s<>]*\.mp4[^"'\s<>]*/gi) || [];
    if (mp4Matches.length) sd = unescapeJsString(mp4Matches[0]).replace(/&amp;/g, '&');
  }

  if (!hd && !sd) throw new Error('og-meta: no video URLs in share page HTML');

  return {
    hd, sd,
    thumbnail: $('meta[property="og:image"]').attr('content') || '',
    title:     $('meta[property="og:title"]').attr('content') || 'Facebook Video',
  };
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
  // 2026 FB RSC payload keys (added 2026-05). FB renamed several keys when
  // they migrated to the React Server Components Reel player. New patterns:
  //   - "videoDeliveryLegacyFields": object containing playable_url_quality_hd
  //   - "video_deliver_legacy_fields"
  //   - "playable_url_quality" (was playable_url_quality_hd, now under a list)
  //   - "best_quality" / "muxed_url" (Reel-specific muxed track)
  //   - "dash_manifest_url" / "dash_manifest" — DASH MPD URLs (last resort)
  { key: 'hd', re: /"playable_url_quality_hd_v2"\s*:\s*"([^"]+)"/ },
  { key: 'sd', re: /"playable_url_v2"\s*:\s*"([^"]+)"/ },
  { key: 'hd', re: /"muxed_url"\s*:\s*"([^"]+)"/ },
  { key: 'hd', re: /"best_quality"\s*:\s*"([^"]+)"/ },
  // The Reel player payload key — `representative_id` precedes the URL
  { key: 'hd', re: /"hd_playable_url"\s*:\s*"([^"]+)"/ },
  { key: 'sd', re: /"sd_playable_url"\s*:\s*"([^"]+)"/ },
  // Catch-all: any "url":"<fbcdn .mp4>" pattern. Lower priority because it
  // can match audio-only URLs, but worth a try when nothing else matched.
  { key: 'sd', re: /"url"\s*:\s*"(https:\/\/[^"]*fbcdn\.net[^"]*\.mp4[^"]*)"/ },
];

async function tryDirectScrape(url) {
  // Race 4 UAs in PARALLEL. The previous sequential loop meant a stalled iOS
  // request consumed the entire 10s outer budget before Android/bot UAs even
  // got to try. Running them concurrently and resolving on first success
  // means the *fastest* working UA wins — for healthy URLs this is 1-3s; for
  // dead URLs all three fail in parallel within their per-UA timeout.
  //
  // UAs explained:
  //   - iPhone Safari mobile     → richest `playable_url` JSON
  //   - Android Chrome           → richer `browser_native_hd_url` JSON (now
  //                                paired with Sec-CH-UA client hints — without
  //                                these FB returns HTTP 400 in 2026 because
  //                                it expects modern Chromium fingerprinting)
  //   - facebookexternalhit/1.1  → bot UA, sometimes bypasses soft login wall
  //   - Desktop Chrome (m.fb)    → m.facebook.com sometimes serves the
  //                                playable_url JSON in plain HTML where
  //                                www.facebook.com only serves a JS shell
  //
  // looksLikeFbVideo() filters out lookaside.fbsbx.com URLs returned by the
  // bot UA (those aren't directly streamable).
  const UA_ANDROID =
    'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36';

  // Per-UA extra headers. Android/desktop Chrome require Sec-CH-UA client
  // hints in 2026; without them www.facebook.com responds with HTTP 400 to
  // every request that looks like Chrome but doesn't fingerprint like Chrome.
  const CH_UA_ANDROID = {
    'sec-ch-ua':           '"Google Chrome";v="125", "Chromium";v="125", "Not.A/Brand";v="24"',
    'sec-ch-ua-mobile':    '?1',
    'sec-ch-ua-platform':  '"Android"',
    'sec-fetch-dest':      'document',
    'sec-fetch-mode':      'navigate',
    'sec-fetch-site':      'none',
    'sec-fetch-user':      '?1',
  };
  const CH_UA_DESKTOP = {
    'sec-ch-ua':           '"Google Chrome";v="124", "Chromium";v="124", "Not.A/Brand";v="24"',
    'sec-ch-ua-mobile':    '?0',
    'sec-ch-ua-platform':  '"Windows"',
    'sec-fetch-dest':      'document',
    'sec-fetch-mode':      'navigate',
    'sec-fetch-site':      'none',
    'sec-fetch-user':      '?1',
  };

  // The m.facebook.com variant — mobile site still serves the playable_url
  // JSON for public videos in plain HTML for desktop UAs. Useful for /reel/
  // URLs where www.facebook.com returns an empty React shell.
  let mUrl = url;
  try {
    mUrl = url.replace(/(?:www|web|business)\.facebook\.com/i, 'm.facebook.com');
    if (mUrl === url && /facebook\.com/.test(url) && !/m\.facebook\.com/.test(url)) {
      mUrl = url.replace(/facebook\.com/, 'm.facebook.com');
    }
  } catch (_) { mUrl = url; }

  const uas = [
    { ua: UA_MOBILE,   tag: 'ios', target: url,  extra: {} },
    { ua: UA_ANDROID,  tag: 'and', target: url,  extra: CH_UA_ANDROID },
    { ua: UA_FB_BOT,   tag: 'bot', target: url,  extra: {} },
    { ua: UA_DESKTOP,  tag: 'm',   target: mUrl, extra: CH_UA_DESKTOP },
  ];

  // Build one promise per UA. Each promise resolves with a {hd, sd, …} shape
  // on success or rejects with a tagged error on failure. firstSuccess wins
  // on the first resolution; if all reject, the joined errors bubble up.
  const attempts = uas.map(({ ua, tag, target, extra }) => (async () => {
    const resp = await axios.get(target, {
      timeout: 8000,
      maxRedirects: 25,
      validateStatus: () => true,
      headers: fbHeaders({
        'User-Agent': ua,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
        ...extra,
      }),
    });

    if (resp.status >= 400) {
      throw new Error(`direct(${tag}): HTTP ${resp.status}`);
    }

    const html = typeof resp.data === 'string' ? resp.data : '';
    if (!html || html.length < 500) {
      throw new Error(`direct(${tag}): empty response`);
    }

    let hd = '', sd = '';
    for (const { key, re } of FB_REGEXES) {
      const m = html.match(re);
      if (m?.[1]) {
        const clean = unescapeJsString(m[1]);
        if (!looksLikeFbVideo(clean)) continue;
        if (key === 'hd' && !hd) hd = clean;
        if (key === 'sd' && !sd) sd = clean;
      }
      if (hd && sd) break;
    }

    // og:video meta tags fallback (used by share/p posts)
    if (!hd || !sd) {
      const $og = cheerio.load(html);
      $og('meta[property="og:video:secure_url"], meta[property="og:video:url"], meta[property="og:video"]').each((_, el) => {
        const v = ($og(el).attr('content') || '').replace(/&amp;/g, '&');
        if (!looksLikeFbVideo(v)) return;
        if (!hd) hd = v;
        else if (!sd && v !== hd) sd = v;
      });
    }

    // Raw fbcdn .mp4 anywhere in the HTML
    if (!hd && !sd) {
      const mp4Matches = html.match(/https?:\/\/[^"'\s<>]*fbcdn\.net[^"'\s<>]*\.mp4[^"'\s<>]*/gi) || [];
      if (mp4Matches.length) sd = unescapeJsString(mp4Matches[0]).replace(/&amp;/g, '&');
    }

    if (!hd && !sd) {
      // NOTE: avoid the literal phrase "login required" — the controller
      // substring-matches it to flip the response into LOGIN_REQUIRED 401.
      throw new Error(`direct(${tag}): no video metadata found in HTML`);
    }

    const $ = cheerio.load(html);
    return {
      hd, sd,
      thumbnail: $('meta[property="og:image"]').attr('content') || '',
      title:     $('meta[property="og:title"]').attr('content') || 'Facebook Video',
    };
  })());

  const errs = [];
  try {
    return await firstSuccess(attempts, errs);
  } catch (_) {
    throw new Error(errs.join(' | ') || 'direct: no video metadata found in HTML');
  }
}

// ─── Strategy : snapsave.app for Facebook ────────────────────────────────────
// snapsave.app is primarily an Instagram downloader but it ALSO supports
// Facebook video URLs at the same /action_download.php endpoint. In 2026 it
// is one of the most reliable public mirrors for share/v/ and share/r/
// links because it resolves the share URL itself (no canonical-URL guessing
// needed on our side).

async function trySnapsaveFb(url) {
  // snapsave moved its endpoint in 2025-2026 — try all known paths/hosts.
  // The original /action_download.php now 404s; the active endpoints are
  // /action.php (current) and /api/ajaxSearch (newer mirror layout).
  const endpoints = [
    { ep: 'https://snapsave.app/action.php',         host: 'snapsave.app' },
    { ep: 'https://snapsave.app/action_download.php', host: 'snapsave.app' },
    { ep: 'https://snapsave.app/api/ajaxSearch',     host: 'snapsave.app' },
    { ep: 'https://snapsave.io/action.php',          host: 'snapsave.io' },
    { ep: 'https://en.savefrom.net/savefrom.php',    host: 'en.savefrom.net' },
  ];

  let resp = null;
  let lastErr = '';
  for (const { ep, host } of endpoints) {
    try {
      const useAjax = ep.includes('ajaxSearch');
      const body = useAjax
        ? new URLSearchParams({ q: url, t: 'media', lang: 'en' }).toString()
        : `url=${encodeURIComponent(url)}`;
      const r = await axios.post(ep, body, {
        timeout: 10000,
        maxRedirects: 5,
        validateStatus: () => true,
        headers: {
          'Content-Type':              'application/x-www-form-urlencoded',
          'User-Agent':                UA_DESKTOP,
          Accept:                      'text/html,application/xhtml+xml,*/*;q=0.9',
          'Accept-Language':           'en-US,en;q=0.9',
          Origin:                      `https://${host}`,
          Referer:                     `https://${host}/`,
          'X-Requested-With':          'XMLHttpRequest',
          'Upgrade-Insecure-Requests': '1',
        },
      });
      if (r.status >= 400) { lastErr = `${host}: HTTP ${r.status}`; continue; }
      resp = r;
      break;
    } catch (e) {
      lastErr = `${host}: ${e.message}`;
    }
  }
  if (!resp) throw new Error(`snapsave-fb: ${lastErr || 'all endpoints failed'}`);

  // snapsave returns JSON for FB with an embedded HTML body, OR raw HTML
  let html = '';
  if (typeof resp.data === 'string') html = resp.data;
  else if (resp.data?.data && typeof resp.data.data === 'string') html = resp.data.data;
  else if (resp.data?.html && typeof resp.data.html === 'string') html = resp.data.html;
  else html = JSON.stringify(resp.data || '');

  if (!html || html.length < 100) throw new Error('snapsave-fb: empty response');

  const $ = cheerio.load(html);
  let hd = '', sd = '';

  // Style 1: id-tagged anchors (matches both snapsave + snapsave.life layouts)
  hd = $('#hdlink, a[data-fquality="hd"], a.btn-download-hd').attr('href') || '';
  sd = $('#sdlink, a[data-fquality="sd"], a.btn-download-sd').attr('href') || '';

  // Style 2: all anchors, pick by text
  if (!hd && !sd) {
    $('a[href]').each((_, a) => {
      const href = $(a).attr('href') || '';
      const text = $(a).text().toLowerCase();
      if (!looksLikeFbVideo(href)) return;
      if (!hd && (text.includes('hd') || text.includes('720') || text.includes('1080') || text.includes('high'))) {
        hd = href; return;
      }
      if (!sd) sd = href;
    });
  }

  if (!hd && !sd) throw new Error('snapsave-fb: no FB video links found');

  return {
    hd, sd,
    thumbnail: $('img').first().attr('src') || '',
    title:     $('p, h3, .video-title, .title').first().text().trim() || 'Facebook Video',
  };
}

// ─── Strategy : fdownloader.net ──────────────────────────────────────────────
// fdownloader.net is a different service from fdown.net (which Cloudflare-
// blocks our IP range in 2026). The form field is `url` (lowercase) and the
// endpoint is /api/ajaxSearch which returns JSON with an HTML payload.

async function tryFdownloaderNet(url) {
  const endpoints = [
    { ep: 'https://fdownloader.net/api/ajaxSearch', host: 'fdownloader.net' },
    { ep: 'https://fdown.io/api/ajaxSearch',        host: 'fdown.io' },
  ];

  let lastErr = '';
  for (const { ep, host } of endpoints) {
    try {
      const resp = await axios.post(
        ep,
        new URLSearchParams({ q: url, t: 'media', lang: 'en' }).toString(),
        {
          timeout: 18000,
          maxRedirects: 5,
          validateStatus: () => true,
          headers: {
            'Content-Type':     'application/x-www-form-urlencoded; charset=UTF-8',
            'User-Agent':       UA_DESKTOP,
            Accept:             '*/*',
            'Accept-Language':  'en-US,en;q=0.9',
            Origin:             `https://${host}`,
            Referer:            `https://${host}/`,
            'X-Requested-With': 'XMLHttpRequest',
          },
        }
      );

      if (resp.status >= 400) { lastErr = `${host}: HTTP ${resp.status}`; continue; }

      const html = (resp.data && resp.data.data) || resp.data || '';
      if (!html || typeof html !== 'string' || html.length < 100) {
        lastErr = `${host}: empty payload`;
        continue;
      }

      const $ = cheerio.load(html);
      let hd = '', sd = '';

      $('a[href]').each((_, a) => {
        const href = ($(a).attr('href') || '').trim();
        const text = $(a).text().toLowerCase();
        if (!href.startsWith('http')) return;
        // Accept fbcdn, scontent, .mp4, OR proxied download paths
        const isVid = href.includes('fbcdn.net')
                   || href.includes('scontent')
                   || /\.mp4(\?|$)/i.test(href)
                   || /\/(download|getvideo|stream)/i.test(href);
        if (!isVid) return;
        if (!hd && (text.includes('hd') || text.includes('720') || text.includes('1080') || text.includes('high'))) {
          hd = href; return;
        }
        if (!sd) sd = href;
      });

      // Raw URL scan in the HTML payload as last resort
      if (!hd && !sd) {
        const m = html.match(/https?:\/\/[^"'\s<>]+\.mp4[^"'\s<>]*/gi);
        if (m && m.length) {
          const uniq = [...new Set(m.map(s => s.replace(/&amp;/g, '&')))];
          hd = uniq[0]; sd = uniq[1] || '';
        }
      }

      if (!hd && !sd) { lastErr = `${host}: no FB video links found`; continue; }

      return {
        hd, sd,
        thumbnail: $('img').first().attr('src') || '',
        title:     $('h3, p, .title').first().text().trim() || 'Facebook Video',
      };
    } catch (e) {
      lastErr = `${host}: ${e.message}`;
    }
  }

  throw new Error(`fdownloader-net: ${lastErr || 'all endpoints failed'}`);
}

// ─── Strategy : savefbs.com ──────────────────────────────────────────────────
// savefbs.com is a newer mirror that's worked through most of 2026 when
// snapsave is rate-limited. Plain form POST to its index, parsed via Cheerio.

async function trySaveFbs(url) {
  // 2026 update: /api/save now 404s. Try the new endpoints (/api/ajaxSearch
  // and the homepage POST handler /download) plus the savetube.cc mirror.
  const endpoints = [
    { ep: 'https://savefbs.com/api/ajaxSearch', host: 'savefbs.com' },
    { ep: 'https://savefbs.com/download',       host: 'savefbs.com' },
    { ep: 'https://savefbs.com/api/save',       host: 'savefbs.com' },
    { ep: 'https://www.fbvideodownloader.io/api/ajaxSearch', host: 'fbvideodownloader.io' },
    { ep: 'https://fdownloader.app/api/ajaxSearch', host: 'fdownloader.app' },
  ];

  let resp = null;
  let lastErr = '';
  for (const { ep, host } of endpoints) {
    try {
      const useAjax = ep.includes('ajaxSearch');
      const body = useAjax
        ? new URLSearchParams({ q: url, t: 'media', lang: 'en' }).toString()
        : new URLSearchParams({ url }).toString();
      const r = await axios.post(ep, body, {
        timeout: 10000,
        maxRedirects: 5,
        validateStatus: () => true,
        headers: {
          'Content-Type':     'application/x-www-form-urlencoded',
          'User-Agent':       UA_DESKTOP,
          Accept:             'application/json, text/html,*/*;q=0.9',
          'Accept-Language':  'en-US,en;q=0.9',
          Origin:             `https://${host}`,
          Referer:            `https://${host}/`,
          'X-Requested-With': 'XMLHttpRequest',
        },
      });
      if (r.status >= 400) { lastErr = `${host}: HTTP ${r.status}`; continue; }
      resp = r;
      break;
    } catch (e) {
      lastErr = `${host}: ${e.message}`;
    }
  }
  if (!resp) throw new Error(`savefbs: ${lastErr || 'all endpoints failed'}`);

  const body = resp.data;
  let hd = '', sd = '', thumb = '', title = 'Facebook Video';

  // Newer payload: JSON with downloadable links
  if (body && typeof body === 'object') {
    const links = body.links || body.data?.links || body.formats || body.data?.formats || [];
    if (Array.isArray(links)) {
      for (const l of links) {
        const u = l.url || l.link || '';
        if (!looksLikeFbVideo(u)) continue;
        const q = String(l.quality || l.label || '').toLowerCase();
        if (!hd && (q.includes('hd') || q.includes('720') || q.includes('1080'))) hd = u;
        else if (!sd) sd = u;
      }
    }
    thumb = body.thumbnail || body.thumb || body.data?.thumbnail || '';
    title = body.title || body.data?.title || title;
  }

  // Older payload: HTML
  if (!hd && !sd && typeof body === 'string' && body.length > 200) {
    const $ = cheerio.load(body);
    $('a[href]').each((_, a) => {
      const href = $(a).attr('href') || '';
      const text = $(a).text().toLowerCase();
      if (!looksLikeFbVideo(href)) return;
      if (!hd && (text.includes('hd') || text.includes('720') || text.includes('1080'))) { hd = href; return; }
      if (!sd) sd = href;
    });
    thumb = thumb || $('img').first().attr('src') || '';
    title = title === 'Facebook Video' ? ($('h3, p, .title').first().text().trim() || title) : title;
  }

  if (!hd && !sd) throw new Error('savefbs: no FB video links found');
  return { hd, sd, thumbnail: thumb, title };
}

// ─── Strategy : x2download.app / fbdownloader.online ────────────────────────
// Two extra public-mirror endpoints kept as a single strategy. They share the
// `ajaxSearch` shape (q=URL, t=media, lang=en) which makes them cheap to add
// in parallel. Both have been reliable for /reel/<numeric>/ URLs in 2026
// where snapsave is sometimes rate-limited.

async function tryX2download(url) {
  const endpoints = [
    { ep: 'https://x2download.app/api/ajaxSearch',       host: 'x2download.app' },
    { ep: 'https://fbdownloader.online/api/ajaxSearch',  host: 'fbdownloader.online' },
    { ep: 'https://fdownloader.io/api/ajaxSearch',       host: 'fdownloader.io' },
  ];

  let lastErr = '';
  for (const { ep, host } of endpoints) {
    try {
      const resp = await axios.post(
        ep,
        new URLSearchParams({ q: url, t: 'media', lang: 'en' }).toString(),
        {
          timeout: 12000,
          maxRedirects: 5,
          validateStatus: () => true,
          headers: {
            'Content-Type':     'application/x-www-form-urlencoded; charset=UTF-8',
            'User-Agent':       UA_DESKTOP,
            Accept:             '*/*',
            'Accept-Language':  'en-US,en;q=0.9',
            Origin:             `https://${host}`,
            Referer:            `https://${host}/`,
            'X-Requested-With': 'XMLHttpRequest',
          },
        }
      );

      if (resp.status >= 400) { lastErr = `${host}: HTTP ${resp.status}`; continue; }

      // Response shape: { status: 'ok', data: '<html>...</html>', ... }
      // OR { status: 'ok', links: { mp4: [{quality, url}, ...] } }
      const payload = resp.data;
      const html = (payload && payload.data) || payload || '';
      if (!html || typeof html !== 'string' || html.length < 100) {
        // Could still be JSON-only response — check that path before failing
        if (payload && typeof payload === 'object') {
          const flat = JSON.stringify(payload);
          const m = flat.match(/https?:\/\/[^"'\s]+\.mp4[^"'\s]*/g);
          if (m && m.length) {
            return {
              hd: m[0],
              sd: m[1] || '',
              thumbnail: payload.thumbnail || payload.thumb || '',
              title:     payload.title || 'Facebook Video',
            };
          }
        }
        lastErr = `${host}: empty payload`;
        continue;
      }

      const $ = cheerio.load(html);
      let hd = '', sd = '';

      // Strategy A: anchors that contain anything that looks like a video URL
      // (mirrors often proxy through their own CDN — `cdn.fdownloader.io/...mp4`
      // wouldn't match `fbcdn.net` but is still a usable video URL).
      $('a[href]').each((_, a) => {
        const href = ($(a).attr('href') || '').trim();
        const text = $(a).text().toLowerCase();
        if (!href.startsWith('http')) return;
        // Accept fbcdn, scontent, .mp4, OR any URL with a download attribute
        const isVid = href.includes('fbcdn.net')
                   || href.includes('scontent')
                   || /\.mp4(\?|$)/i.test(href)
                   || /\/(download|getvideo|stream)/i.test(href);
        if (!isVid) return;
        if (!hd && (text.includes('hd') || text.includes('720') || text.includes('1080') || text.includes('high'))) {
          hd = href; return;
        }
        if (!sd) sd = href;
      });

      // Strategy B: raw URL scan in the HTML payload
      if (!hd && !sd) {
        const m = html.match(/https?:\/\/[^"'\s<>]+\.mp4[^"'\s<>]*/gi);
        if (m && m.length) {
          const uniq = [...new Set(m.map(s => s.replace(/&amp;/g, '&')))];
          hd = uniq[0];
          sd = uniq[1] || '';
        }
      }

      if (!hd && !sd) { lastErr = `${host}: no FB video links found`; continue; }

      return {
        hd, sd,
        thumbnail: $('img').first().attr('src') || '',
        title:     $('h3, p, .title').first().text().trim() || 'Facebook Video',
      };
    } catch (e) {
      lastErr = `${host}: ${e.message}`;
    }
  }

  throw new Error(`x2download: ${lastErr || 'all endpoints failed'}`);
}

// ─── Strategy : yt-dlp (last-resort fallback) ────────────────────────────────
// yt-dlp's Facebook extractor follows the share-URL redirect chain natively
// using the same JS-eval flow a browser uses. This is the only strategy that
// reliably resolves share/r/<token>/ URLs where the token isn't equal to the
// canonical reel ID. Slow (5-20s) so we only run it after all the cheaper
// HTTP scrapers have failed.

async function tryYtDlpFacebook(url) {
  // Thin wrapper around the shared yt-dlp runner. All the FB-specific
  // tuning (UA, locale, retries, cookie support) lives in ytDlpRunner.js
  // under the 'facebook' platform profile — see Services/ytDlpRunner.js
  // for the full flag list and rationale.
  if (!ytdlp.isAvailable) throw new Error('yt-dlp-fb: binary not installed (skipped)');

  const info = await ytdlp.run(url, {
    platform: 'facebook',
    timeoutMs: 26000,
  });

  // Filter to FB CDN URLs (sometimes yt-dlp's FB extractor returns DASH MPD
  // URLs that aren't directly streamable; looksLikeFbVideo filters those).
  let hd = '', sd = '';
  const formats = Array.isArray(info.formats) ? info.formats : [];
  const videoFormats = formats
    .filter(f => f.url && typeof f.url === 'string'
              && (f.vcodec ? f.vcodec !== 'none' : true)
              && looksLikeFbVideo(f.url))
    .sort((a, b) => (b.height || 0) - (a.height || 0));

  if (videoFormats.length > 0) {
    hd = videoFormats[0].url;
    if (videoFormats.length > 1) sd = videoFormats[videoFormats.length - 1].url;
  } else if (info.url && looksLikeFbVideo(info.url)) {
    sd = info.url;
  }

  if (!hd && !sd) throw new Error('yt-dlp-fb: no usable fbcdn video URLs in info');

  return {
    hd, sd,
    thumbnail: info.thumbnail || info.thumbnails?.[0]?.url || '',
    title:     info.title || info.fulltitle || 'Facebook Video',
  };
}

// ─── Strategy : Facebook iframe plugin (anonymous, no third party) ──────────
// Facebook publishes a public-iframe video player at
//   https://www.facebook.com/plugins/video.php?href=<encoded URL>
// which serves the embed HTML without authentication for any public video.
// The HTML contains the same JSON keys (hd_src / sd_src / playable_url) we
// scrape elsewhere. Because the request goes straight to facebook.com it has
// none of the third-party mirror reliability issues (DNS, Cloudflare blocks).
// This is the closest thing to an "official" public scrape.

async function tryFbPluginIframe(url) {
  const endpoint =
    `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(url)}&show_text=false&autoplay=false`;

  const uas = [UA_FB_BOT, UA_DESKTOP, UA_MOBILE];
  let lastErr = '';

  for (const ua of uas) {
    const tag = ua === UA_FB_BOT ? 'bot' : (ua === UA_MOBILE ? 'ios' : 'desk');
    // Desktop Chrome UA now requires Sec-CH-UA client hints to bypass FB's
    // 2026 fingerprint check; mobile/bot UAs ignore client hints entirely so
    // we only attach them for desktop.
    const isDesk = ua === UA_DESKTOP;
    const chHeaders = isDesk ? {
      'sec-ch-ua':          '"Google Chrome";v="124", "Chromium";v="124", "Not.A/Brand";v="24"',
      'sec-ch-ua-mobile':   '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest':     'iframe',
      'sec-fetch-mode':     'navigate',
      'sec-fetch-site':     'cross-site',
    } : {};
    try {
      const resp = await axios.get(endpoint, {
        timeout: 14000,
        maxRedirects: 10,
        validateStatus: () => true,
        headers: {
          'User-Agent':                ua,
          Accept:                      'text/html,application/xhtml+xml,*/*;q=0.9',
          'Accept-Language':           'en-US,en;q=0.9',
          Referer:                     'https://www.facebook.com/',
          'Upgrade-Insecure-Requests': '1',
          ...chHeaders,
        },
      });

      if (resp.status >= 400) { lastErr = `plugin(${tag}): HTTP ${resp.status}`; continue; }

      const html = typeof resp.data === 'string' ? resp.data : '';
      if (!html || html.length < 500) { lastErr = `plugin(${tag}): empty response`; continue; }

      let hd = '', sd = '';
      for (const { key, re } of FB_REGEXES) {
        const m = html.match(re);
        if (m?.[1]) {
          const clean = unescapeJsString(m[1]);
          if (!looksLikeFbVideo(clean)) continue;
          if (key === 'hd' && !hd) hd = clean;
          if (key === 'sd' && !sd) sd = clean;
        }
        if (hd && sd) break;
      }

      if (!hd && !sd) {
        const mp4Matches = html.match(/https?:\/\/[^"'\s<>]*fbcdn\.net[^"'\s<>]*\.mp4[^"'\s<>]*/gi) || [];
        if (mp4Matches.length) sd = unescapeJsString(mp4Matches[0]).replace(/&amp;/g, '&');
      }

      if (!hd && !sd) {
        lastErr = `plugin(${tag}): no video metadata in iframe`;
        continue;
      }

      const $ = cheerio.load(html);
      return {
        hd, sd,
        thumbnail: $('meta[property="og:image"]').attr('content') || '',
        title:     $('meta[property="og:title"]').attr('content') || 'Facebook Video',
      };
    } catch (e) {
      lastErr = `plugin(${tag}): ${e.message}`;
    }
  }

  throw new Error(lastErr || 'plugin: no video found');
}

// ─── Strategy : getfvid.com (RETIRED — kept for compatibility / re-enable) ───
// Disabled by default in 2026 because Koyeb's DNS resolver returns EAI_AGAIN
// on every lookup of getfvid.com from EU regions. Re-enable by setting the
// env var FB_USE_GETFVID=1. If you re-enable, expect this strategy to fail
// fast and increase noise in error messages.

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
        // Avoid the literal "redirected to login" phrase — the controller
        // matches that substring and flips the response to LOGIN_REQUIRED,
        // which is wrong for public URLs that just hit mbasic's auth wall.
        errors.push('hit mbasic auth wall');
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
  const resolved = await resolveCanonicalFbUrl(normalized);
  const { url: canonical, candidates: candidateUrlsFromResolve, requiresLogin, shareHtml } = resolved;

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

  // If a non-story resolved to login, do NOT stop immediately. Public-mirror
  // strategies (snapsave, fdownloader.net, savefbs) can still resolve many
  // share URLs without a cookie.
  if (requiresLogin && !fbCookie && !FB_COOKIE) {
    console.warn('📘 Facebook resolved to login wall and no cookie available; trying public fallbacks only');
  }

  // Build candidate URL list: resolver-derived candidates + normalized + raw
  const candidateUrls = [...new Set([
    ...(Array.isArray(candidateUrlsFromResolve) ? candidateUrlsFromResolve : [canonical]),
    normalized,
    rawUrl,
  ].filter(Boolean))];

  // ─── Strategy enablement ─────────────────────────────────────────────────
  // 2026-05 update: direct-scrape alone is no longer sufficient. Facebook
  // has tightened its public-content surface (HTTP 400 on Android UAs without
  // client hints, soft login wall on iOS/bot UAs for many /reel/ URLs).
  // Defaulting the public mirror strategies BACK ON gives the race more
  // attempts; even at low per-mirror success rates the aggregate recovery is
  // much higher than direct-scrape alone. Each can still be turned off via
  // its env var set to '0' if a specific mirror starts producing noise.
  //
  // Strategies that remain opt-IN (default off) because the upstream is
  // fundamentally broken from our deploy region:
  //   - getfvid.com    — DNS EAI_AGAIN from EU regions
  //   - mbasic-video   — FB removed mp4 playback on mbasic
  //   - metadownloader — npm package throws split-on-undefined
  //
  // yt-dlp defaults ON when the binary is installed (auto-detected); it's a
  // proven fallback for share-token URLs that no HTTP scraper resolves.
  const optOut = (v) => v !== '0' && String(v || '').toLowerCase() !== 'false';
  const optIn  = (v) => v === '1' || String(v || '').toLowerCase() === 'true';

  const ENABLE_OG_META         = optOut(process.env.FB_USE_OGMETA);
  const ENABLE_PLUGIN_IFRAME   = optOut(process.env.FB_USE_PLUGIN);
  const ENABLE_SNAPSAVE_FB     = optOut(process.env.FB_USE_SNAPSAVE);
  const ENABLE_SAVEFBS         = optOut(process.env.FB_USE_SAVEFBS);
  const ENABLE_FDOWNLOADER_NET = optOut(process.env.FB_USE_FDOWNLOADER);
  const ENABLE_FDOWN_NET       = optOut(process.env.FB_USE_FDOWN);
  const ENABLE_YTDLP_FB        = optOut(process.env.FB_USE_YTDLP);
  const ENABLE_GETFVID         = optIn(process.env.FB_USE_GETFVID);
  const ENABLE_MBASIC          = optIn(process.env.FB_USE_MBASIC);
  const ENABLE_METADOWNLOADER  = optIn(process.env.FB_USE_LEGACY_METADOWNLOADER);

  const strategies = [];

  // Per-strategy URL fan-out policy: mirror strategies (snapsave / savefbs
  // / fb-plugin / fdownloader) do their own URL resolution server-side, so
  // they get only the original URL once. Canonical-needing strategies
  // (direct-scrape, fb-cookie) get fanned out across every candidate.
  const ORIGINAL_URL_ONLY = [rawUrl];

  // 1) og-meta-extract — opt-in only. Always fails for share URLs because the
  //    resolver fetched the share page HTML, which has no embedded video.
  if (ENABLE_OG_META && shareHtml && shareHtml.length > 200) {
    strategies.push(['og-meta', () => tryOgMetaExtract(shareHtml), 4000]);
  }

  // 2) Mirror strategies — all opt-in because every one of them has a 0%
  //    success rate in production. Re-enable with the matching env var if
  //    upstream comes back to life.
  for (const oneUrl of ORIGINAL_URL_ONLY) {
    if (ENABLE_PLUGIN_IFRAME) {
      strategies.push(['fb-plugin-iframe', () => tryFbPluginIframe(oneUrl), 8000]);
    }
    if (ENABLE_SNAPSAVE_FB) {
      strategies.push(['snapsave-fb', () => trySnapsaveFb(oneUrl), 8000]);
    }
    if (ENABLE_SAVEFBS) {
      strategies.push(['savefbs', () => trySaveFbs(oneUrl), 8000]);
    }
    if (ENABLE_FDOWNLOADER_NET) {
      strategies.push(['fdownloader-net', () => tryFdownloaderNet(oneUrl), 8000]);
      // x2download.app / fbdownloader.online / fdownloader.io share the
      // ajaxSearch shape and ship under the same opt-out env var.
      strategies.push(['x2download',      () => tryX2download(oneUrl),     10000]);
    }
  }

  // 2b) yt-dlp last-resort — runs on the original URL and resolves share
  //     tokens to canonical via FB's redirect chain. When it works, it
  //     resolves in 2-4s; when it doesn't, it gets killed at the wrapper
  //     timeout so the user isn't stuck waiting.
  //
  //     Only register if yt-dlp is actually installed. Without this guard, on
  //     Koyeb buildpack deploys (which don't install yt-dlp) the strategy
  //     fires ENOENT on every Facebook request, eating a race slot and
  //     polluting the error log with "spawn yt-dlp ENOENT" for users who
  //     can't act on it anyway.
  //
  //     Timeout 10s — matches yt-dlp's own --socket-timeout (6s) + 1 retry
  //     + a 2s buffer. Previously 18s, which dominated total request latency
  //     on dead URLs (user waited ~18s for a confirmed-deleted post). We
  //     also flag this strategy as 'slow' so the early-exit logic below can
  //     abort it once all fast strategies have permanently failed — yt-dlp's
  //     success rate on URLs that just 404'd everywhere else is near-zero,
  //     so the wait is dead weight.
  if (ENABLE_YTDLP_FB && _YTDLP_AVAILABLE) {
    // 26s wrapper. yt-dlp's own budget is 12s socket × 2 retries = 24s
    // worst-case. We add a 2s buffer so the wrapper kills only if yt-dlp
    // itself is hung beyond its retry budget. Keep 'slow:true' so the
    // early-exit logic still aborts this when every fast strategy has
    // permanently failed (e.g. confirmed 404 on the share URL).
    strategies.push([
      'yt-dlp-fb',
      () => tryYtDlpFacebook(rawUrl),
      26000,
      { slow: true },
    ]);
  }

  // 3) Canonical-needing strategies — fan out across every candidate URL.
  for (const candidate of candidateUrls) {
    if (fbCookie || FB_COOKIE) {
      strategies.push([
        'fb-cookie',
        () => tryFacebookCookieScrape(candidate, fbCookie),
        18000,
      ]);
    }

    strategies.push(
      // 10s outer cap. tryDirectScrape uses 6s per UA × 3 UAs internally,
      // but we early-return as soon as one UA succeeds, so the actual time
      // for a healthy URL is 1-3s. 10s is enough for the worst case while
      // shaving 5s off the dead-URL wait compared to the old 15s.
      ['direct-scrape', () => tryDirectScrape(candidate), 10000],
    );

    if (ENABLE_FDOWN_NET) {
      strategies.push(['fdown', () => tryFdownNet(candidate), 12000]);
    }

    if (ENABLE_MBASIC) {
      strategies.push(['mbasic-video', () => tryMbasicVideo(candidate), 12000]);
    }

    if (ENABLE_GETFVID) {
      strategies.push(['getfvid', () => tryGetfvid(candidate), 20000]);
    }

    if (ENABLE_METADOWNLOADER) {
      strategies.push(['metadownloader', () => tryMetadownloader(candidate), 12000]);
    }
  }

  // Build per-strategy promises, preserving the optional 4th tuple element
  // ({ slow: true }) so the orchestrator can apply the early-exit rule.
  const buildPromises = (errors) => strategies.map((entry) => {
    const [name, fn, ms, meta] = entry;
    const promise = withTimeout(fn(), ms, name).then(
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
    );
    return { name, promise, slow: !!(meta && meta.slow) };
  });

  // Deduplicate strategy errors before emitting. Without this, three retries
  // of getfvid produce three identical "getaddrinfo EAI_AGAIN" lines in the
  // user-facing alert (Telegram truncates at 500 chars, so other strategies
  // get pushed out). De-dup keeps the alert informative.
  const dedupedErrors = (errs) => {
    const seen = new Set();
    return errs.filter(e => {
      const sig = String(e).replace(/\s+/g, ' ').slice(0, 80);
      if (seen.has(sig)) return false;
      seen.add(sig);
      return true;
    });
  };

  // Detect "permanent" failures — retrying these never changes the outcome.
  // 404 means the URL doesn't exist; "no video metadata in iframe" means FB
  // itself can't find the content; ENOENT means a missing binary; "binary
  // not installed" is our own short-circuit. When ALL errors are permanent
  // we skip the retry — saves ~30s on dead URLs and prevents the outer
  // 60s download wrapper from tripping with "Download timeout - operation
  // took too long" when yt-dlp also has nothing to find.
  //
  // yt-dlp timeout counts as permanent because yt-dlp has its own internal
  // --retries 2 + --socket-timeout 12, so an 18s timeout means yt-dlp has
  // already exhausted its retry budget — another run from us doesn't help.
  const isPermanentError = (e) => {
    const s = String(e || '').toLowerCase();
    // NOTE: HTTP 400 deliberately excluded. Facebook intermittently 400s
    // requests that look like Chromium but don't ship Sec-CH-UA hints
    // (or whose hints don't match). Other UAs and other strategies can
    // still succeed on the same URL — treating 400 as permanent killed
    // the whole race in 2026-05 logs.
    return s.includes('http 404')
        || s.includes('http 410')   // explicitly gone
        || s.includes('http 451')   // legal takedown
        || s.includes('no video metadata')
        || s.includes('no video urls in share page')
        || s.includes('no usable fbcdn video urls')
        || s.includes('no fb video links')
        || s.includes('enoent')
        || s.includes('binary not installed')
        || s.includes('not installed')
        || s.includes('content unavailable')
        || s.includes('login required')
        // Strategy-wrapper timeouts count as permanent: every strategy has
        // its own internal retry logic, so a wrapper timeout means the
        // strategy already burned its budget. Re-running it from scratch
        // produces the same timeout 95% of the time.
        || /timeout after \d+ms/.test(s);
  };

  const errors = [];
  try {
    return await firstSuccessFastFail(buildPromises(errors), errors, isPermanentError);
  } catch (_) {
    const allPermanent = errors.length > 0 && errors.every(isPermanentError);
    if (allPermanent) {
      console.warn('🚫 Facebook: all strategies returned permanent failures — skipping retry');
      const allErrors = dedupedErrors(errors).join(' | ');
      const isPublicUrl =
        /\/share\/(v|r|p)\//i.test(rawUrl)   ||
        /fb\.watch/i.test(rawUrl)            ||
        /facebook\.com\/(watch|reel|video)/i.test(rawUrl) ||
        /facebook\.com\/[^/]+\/videos\//i.test(rawUrl);
      // Cleaner error for the user — this URL isn't going to work even with
      // more retries. "Content unavailable" is what most other downloaders
      // call this state too.
      throw new Error(
        isPublicUrl
          ? `Facebook content unavailable. The post may be deleted, private, region-locked, or hosted on a page that requires sign-in. — ${allErrors}`
          : `Facebook: all strategies failed (permanent) — ${allErrors}`
      );
    }

    console.warn('🔁 Facebook retry once with same candidates');
    const retryErrors = [];
    try {
      return await firstSuccessFastFail(buildPromises(retryErrors), retryErrors, isPermanentError);
    } catch (_) {
      const allErrors = dedupedErrors([...errors, ...retryErrors]).join(' | ');
      // Public Facebook content (share/v, share/r, fb.watch, /reel/, /watch/)
      // does NOT require login. Don't tell the user to sign in for these —
      // the failure is on our side (mirror down, IP blocked, etc.).
      const isPublicUrl =
        /\/share\/(v|r|p)\//i.test(rawUrl)   ||
        /fb\.watch/i.test(rawUrl)            ||
        /facebook\.com\/(watch|reel|video)/i.test(rawUrl) ||
        /facebook\.com\/[^/]+\/videos\//i.test(rawUrl);

      const cookieHint = isPublicUrl
        ? '' // public URL — never tell the user to sign in
        : ((fbCookie || FB_COOKIE)
            ? ''
            : ' | hint: this URL may require a signed-in session');
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

    // Step 3: yt-dlp fallback. yt-dlp's IG extractor has its own story
    // resolution path that sometimes succeeds for public-profile stories
    // even when our mirror scrapers return empty. If YT_DLP_COOKIES_FILE
    // is set, this is also the most reliable cookie-authenticated path.
    if (ytdlp.isAvailable) {
      try {
        const info = await withTimeout(
          ytdlp.run(url, { platform: 'instagram', timeoutMs: 24000 }),
          26000,
          'yt-dlp-ig-story',
        );
        const items = ytdlp.formatInstagramItems(info);
        if (items.length > 0) {
          console.log('📸 ✅ IG Story via yt-dlp succeeded');
          return { status: true, data: items, _source: 'yt-dlp-story' };
        }
      } catch (e) {
        console.warn(`📸 IG Story yt-dlp path failed: ${e.message}`);
      }
    }

    // Step 4: clean error — message is now friendlier since per-request
    // cookies are available via the in-app browser sign-in flow.
    throw new Error(
      'Instagram Stories require login or come from a private account. ' +
      'Public-profile stories can sometimes be fetched, but this one was ' +
      'not accessible.' +
      (activeIgCookie ? '' : ' Sign in to Instagram in the in-app browser to enable Story downloads.')
    );
  }

  const errors = [];

  // Race snapsave + snapinsta + yt-dlp. yt-dlp is included even though it's
  // slower (typically 3-6s for a public reel) because it's the most reliable
  // when both HTTP scrapers are rate-limited or down. The race resolves on
  // first success, so slow strategies don't penalise the happy path.
  const promises = [
    withTimeout(scrapeSnapsave(url),  18000, 'snapsave').then(
      items => items.length ? { source: 'snapsave', items } : Promise.reject(new Error('snapsave: 0 items'))
    ),
    withTimeout(scrapeSnapinsta(url), 18000, 'snapinsta').then(
      items => items.length ? { source: 'snapinsta', items } : Promise.reject(new Error('snapinsta: 0 items'))
    ),
  ];

  if (ytdlp.isAvailable) {
    promises.push(
      withTimeout(
        (async () => {
          const info = await ytdlp.run(url, { platform: 'instagram', timeoutMs: 22000 });
          const items = ytdlp.formatInstagramItems(info);
          if (!items.length) throw new Error('yt-dlp-ig: no items in info');
          return { source: 'yt-dlp', items };
        })(),
        24000,
        'yt-dlp-ig',
      )
    );
  }

  try {
    const winner = await firstSuccess(promises, errors);
    return { status: true, data: winner.items, _source: winner.source };
  } catch (_) {
    // All failed — fall through to igdl, which lives in the controller's
    // existing pipeline. We re-throw with the collected errors so the
    // caller can decide whether to try other sources.
    throw new Error(`Instagram: all scrapers failed. ${errors.join(' | ')}`);
  }
}

module.exports = facebookInsta;