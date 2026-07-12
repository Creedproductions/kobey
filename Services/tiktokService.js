// Services/tiktokService.js
//
// TikTok downloader with a layered fallback chain.
//
// Why this exists:
//   The previous single-source approach (tikwm only, then ttdl) fails whenever
//   tikwm hits its 1 req/sec rate limit or returns code:-1, leaving users
//   stranded. This service tries multiple providers in priority order and
//   returns the first that yields a usable result.
//
// Chain:
//   1. tikwm.com         — fastest when not rate-limited; auto-retry with jitter
//   2. ssstik.io         — well-maintained scraper, used by many downloaders
//   3. musicaldown.com   — alt scraper, different infra than tikwm
//   4. ttdl (btch-dl)    — last resort, same package the project already uses
//
// Output shape (compatible with existing dataFormatters.tiktok):
//   {
//     title:     string,
//     thumbnail: string,
//     video:     [url],            // empty array if slideshow
//     audio:     [url],            // optional music url
//     images:    [url, ...]        // present only for slideshow posts
//   }

const axios   = require('axios');
const cheerio = require('cheerio');
const { ttdl } = require('btch-downloader');
const ytdlp   = require('./ytDlpRunner');

// ─── Shared headers ──────────────────────────────────────────────────────────

const UA_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const UA_MOBILE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const jitter = (min, max) => min + Math.floor(Math.random() * (max - min));

// ─── Strategy 1: tikwm.com ───────────────────────────────────────────────────
// Rate limit is 1 req/s — retry on code:-1 with backoff before giving up.

async function tryTikwm(url) {
  const MAX_ATTEMPTS = 3;
  let lastErr = null;

  // tikwm accepts a bare numeric video id OR a full URL. When we have a
  // canonical /video/<id> URL we strip everything except the id — tikwm's
  // URL parser is strict and rejects various legitimate share URLs but
  // always accepts the numeric id.
  const idMatch = String(url).match(/\/video\/(\d{6,})/);
  const payload = idMatch ? idMatch[1] : url;

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    if (i > 0) await sleep(jitter(1100, 1800)); // respect their 1 req/s ceiling

    try {
      const resp = await axios.post(
        'https://www.tikwm.com/api/',
        new URLSearchParams({ url: payload, hd: '1' }).toString(),
        {
          timeout: 15000,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent':   UA_DESKTOP,
            Accept:         'application/json',
          },
        }
      );

      const body = resp.data;
      if (!body) { lastErr = new Error('tikwm: empty response'); continue; }

      // code:0 = success; code:-1 = rate-limited or temp error → retry
      if (body.code === 0 && body.data) {
        const d = body.data;
        console.log('🎵 tikwm OK — slideshow:', !!(d.images?.length));
        return {
          title:     d.title || d.author?.nickname || 'TikTok Post',
          thumbnail: d.cover || d.origin_cover || '',
          video:     d.play   ? [d.play]   : (d.wmplay ? [d.wmplay] : []),
          audio:     d.music  ? [d.music]  : [],
          ...(d.images && d.images.length > 0 && {
            images: d.images
              .map(img => typeof img === 'string' ? img : (img?.url || img?.download || ''))
              .filter(u => u && u.startsWith('http')),
          }),
        };
      }

      lastErr = new Error(`tikwm: code=${body.code} msg=${body.msg || 'unknown'}`);
      // -1 typically means rate-limited — worth retrying. Other codes usually aren't.
      if (body.code !== -1) break;
    } catch (e) {
      lastErr = e;
    }
  }

  throw lastErr || new Error('tikwm: exhausted retries');
}

// ─── Strategy 2: ssstik.io ───────────────────────────────────────────────────
// ssstik renders an HTML form and then sends a POST with a CSRF-like
// "tt" token. The token comes from the index page in a small JS snippet.

async function trySSStik(url) {
  // Step 1: load index to grab the tt token. ssstik renames this token
  // every few months — check the tt: literal, then any name="tt" hidden
  // input, then any 8+ char token-shaped string near the form.
  const idx = await axios.get('https://ssstik.io/en', {
    timeout: 12000,
    headers: {
      'User-Agent':      UA_DESKTOP,
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  const html  = typeof idx.data === 'string' ? idx.data : '';
  const tt =
    (html.match(/tt\s*[:=]\s*['"]([a-zA-Z0-9_]+)['"]/) || [])[1] ||
    (html.match(/name=["']tt["'][^>]*value=["']([a-zA-Z0-9_]+)["']/) || [])[1] ||
    (html.match(/value=["']([a-zA-Z0-9_]{8,})["'][^>]*name=["']tt["']/) || [])[1] ||
    '';
  if (!tt) throw new Error('ssstik: tt token not found');

  // Step 2: POST the URL
  const form = new URLSearchParams({ id: url, locale: 'en', tt }).toString();
  const resp = await axios.post('https://ssstik.io/abc?url=dl', form, {
    timeout: 15000,
    headers: {
      'Content-Type':     'application/x-www-form-urlencoded',
      'User-Agent':       UA_DESKTOP,
      'HX-Request':       'true',
      'HX-Trigger':       '_gcaptcha_pt',
      'HX-Target':        'target',
      'HX-Current-URL':   'https://ssstik.io/en',
      'Origin':           'https://ssstik.io',
      'Referer':          'https://ssstik.io/en',
    },
  });

  const $    = cheerio.load(typeof resp.data === 'string' ? resp.data : '');
  // The result page exposes:
  //   <a class="without_watermark"  href="...mp4">    no-watermark video
  //   <a class="without_watermark_direct" href="...">
  //   <a class="music"              href="...mp3">    music
  //   <img src="...">                                  thumbnail
  const noWm   = $('a.without_watermark').first().attr('href') ||
                 $('a.without_watermark_direct').first().attr('href') || '';
  const music  = $('a.music').first().attr('href') ||
                 $('a[href*=".mp3"]').first().attr('href') || '';
  const cover  = $('img').first().attr('src') || '';
  const title  = $('p.maintext').first().text().trim() ||
                 $('h2').first().text().trim() || 'TikTok Post';

  // Slideshow detection — ssstik shows a list of <img> for image posts
  const images = [];
  $('a[href]').each((_, a) => {
    const h = $(a).attr('href') || '';
    if (/\.(jpg|jpeg|webp|png)(\?|$)/i.test(h) && !images.includes(h)) images.push(h);
  });

  if (!noWm && images.length === 0) {
    throw new Error('ssstik: no media in response');
  }

  return {
    title,
    thumbnail: cover,
    video:     noWm ? [noWm] : [],
    audio:     music ? [music] : [],
    ...(images.length > 0 && { images }),
  };
}

// ─── Strategy 3: musicaldown.com ─────────────────────────────────────────────
// Two-step: (1) GET form to extract dynamic field names + token,
//           (2) POST with those fields, parse the result page.

async function tryMusicaldown(url) {
  const idx = await axios.get('https://musicaldown.com/en', {
    timeout: 12000,
    headers: { 'User-Agent': UA_DESKTOP },
  });

  const $form = cheerio.load(typeof idx.data === 'string' ? idx.data : '');
  // The form has 3 inputs, each with a dynamic name. We pick them by index.
  const inputs = [];
  $form('form input').each((_, el) => {
    const name  = $form(el).attr('name');
    const value = $form(el).attr('value') || '';
    if (name) inputs.push({ name, value });
  });
  if (inputs.length < 3) throw new Error('musicaldown: form not parseable');

  const cookies = (idx.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');

  // First input is URL field, others are token + verify
  const formData = new URLSearchParams();
  formData.append(inputs[0].name, url);
  inputs.slice(1).forEach(i => formData.append(i.name, i.value));

  const resp = await axios.post('https://musicaldown.com/download', formData.toString(), {
    timeout: 15000,
    maxRedirects: 5,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent':   UA_DESKTOP,
      'Origin':       'https://musicaldown.com',
      'Referer':      'https://musicaldown.com/en',
      ...(cookies && { Cookie: cookies }),
    },
  });

  const $ = cheerio.load(typeof resp.data === 'string' ? resp.data : '');

  // Result page exposes anchors labelled HD / Watermark / MP3.
  // We scan all anchors and pick by text/attr heuristics.
  let videoNoWm = '', videoHd = '', music = '';
  const images = [];
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href') || '';
    const text = $(a).text().toLowerCase();
    if (!href.startsWith('http')) return;

    if (/\.(jpg|jpeg|webp|png)(\?|$)/i.test(href)) {
      if (!images.includes(href)) images.push(href);
      return;
    }
    if (text.includes('mp3') || /\.mp3/i.test(href)) { music = music || href; return; }
    if (text.includes('hd') || text.includes('hd video')) { videoHd  = videoHd  || href; return; }
    if (text.includes('without') || text.includes('no watermark')) {
      videoNoWm = videoNoWm || href; return;
    }
  });

  const video = videoNoWm || videoHd;
  const cover = $('img').first().attr('src') || '';

  if (!video && images.length === 0) {
    throw new Error('musicaldown: no media in response');
  }

  return {
    title:     $('h2').first().text().trim() || 'TikTok Post',
    thumbnail: cover,
    video:     video ? [video] : [],
    audio:     music ? [music] : [],
    ...(images.length > 0 && { images }),
  };
}

// ─── Strategy 4: btch-downloader (last resort) ───────────────────────────────

async function tryTtdl(url) {
  const data = await ttdl(url);
  if (!data || (!data.video && !data.images)) {
    throw new Error('ttdl: no video or images returned');
  }
  return {
    title:     data.title || 'TikTok Post',
    thumbnail: data.thumbnail || '',
    video:     Array.isArray(data.video) ? data.video : (data.video ? [data.video] : []),
    audio:     Array.isArray(data.audio) ? data.audio : (data.audio ? [data.audio] : []),
    ...(data.images && Array.isArray(data.images) && data.images.length > 0 && {
      images: data.images,
    }),
  };
}

// ─── Strategy 5: yt-dlp (handles edge cases tikwm/ssstik miss) ──────────────
//
// yt-dlp is our most reliable fallback in 2026 because TikTok pushes
// frequent API changes that break the HTTP scrapers (signed-URL rotation,
// new aweme schemas). yt-dlp ships extractor updates within days of each
// TikTok change. It also gracefully handles:
//   - story posts (which our HTTP scrapers can't reach without cookies)
//   - private profile reposts (where ssstik returns 404)
//   - photo slideshows (returned as image_url[])
// We DON'T put it first because it's slower (5–10s) than tikwm (1–2s) on
// the happy path. Used as the third-line fallback after tikwm and ssstik.

async function tryYtDlpTikTok(url, opts = {}) {
  if (!ytdlp.isAvailable) {
    throw new Error('yt-dlp: binary not installed');
  }
  const { cookieFile = null } = opts;
  const info = await ytdlp.run(url, {
    platform: 'tiktok',
    timeoutMs: 20000,
    // User's TikTok session (Netscape cookies.txt). yt-dlp's TikTok extractor
    // needs it to reach Stories / private reposts — without it those 404.
    cookieFile,
  });
  const out = ytdlp.formatTikTokInfo(info);
  if ((!out.video || out.video.length === 0) &&
      (!out.images || out.images.length === 0)) {
    throw new Error('yt-dlp: returned no usable video/images');
  }
  return out;
}

// ─── URL resolution for short URLs ───────────────────────────────────────────
//
// vm.tiktok.com / vt.tiktok.com / tiktok.com/t/<id> URLs are short redirects.
// In 2026 the redirect target Location often comes back as
//   https://www.tiktok.com/@/video/<numeric_id>?...
// — note the EMPTY username "@/" — because TikTok strips the handle from the
// share-redirect path. tikwm rejects this URL with "Url parsing is failed!"
// (and ssstik / musicaldown also break on the empty handle). Our fix:
// extract the numeric video id from the redirected Location and rebuild a
// canonical "https://www.tiktok.com/@x/video/<id>" URL — every scraper
// accepts that shape.
//
// Resolution flow:
//   1. HEAD with maxRedirects:0 → grab Location header
//   2. If Location has "/video/<id>" — extract id and synthesise a canonical
//      URL with placeholder handle "@x"
//   3. Otherwise fall through to a normal redirect-following GET that may
//      return the real handle in the final URL.

const SHORT_URL_HOSTS = ['vm.tiktok.com', 'vt.tiktok.com'];

function looksLikeTtShort(url) {
  try {
    const u = new URL(url);
    if (SHORT_URL_HOSTS.includes(u.hostname)) return true;
    // tiktok.com/t/<id>/ also redirects to a canonical URL
    if (/^(?:www\.)?tiktok\.com$/i.test(u.hostname) &&
        /^\/t\/[A-Za-z0-9]+/i.test(u.pathname)) return true;
  } catch (_) {}
  return false;
}

function buildCanonicalFromVideoId(id) {
  return `https://www.tiktok.com/@x/video/${id}`;
}

async function resolveShortUrl(url) {
  if (!looksLikeTtShort(url)) return url;

  // Step 1 — fast HEAD with no redirects to grab the Location header.
  try {
    const head = await axios.head(url, {
      maxRedirects:   0,
      timeout:        8000,
      validateStatus: s => s >= 200 && s < 400,
      headers: {
        'User-Agent':      UA_DESKTOP,
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    const loc = head.headers?.location || head.headers?.Location || '';
    if (loc) {
      const idMatch = String(loc).match(/\/video\/(\d{6,})/);
      if (idMatch) {
        const canonical = buildCanonicalFromVideoId(idMatch[1]);
        console.log(`🎵 TikTok: short→canonical (HEAD) ${url} → ${canonical}`);
        return canonical;
      }
      // Location exists but no video id — strip query and return as-is
      try {
        const u = new URL(loc);
        return `${u.origin}${u.pathname}`;
      } catch (_) {
        return String(loc).split('?')[0];
      }
    }
  } catch (e) {
    // Bubble through to GET fallback
    console.warn(`🎵 TikTok: HEAD failed: ${e.message}`);
  }

  // Step 2 — follow redirects with GET as a safety net.
  try {
    const resp = await axios.get(url, {
      timeout:        10000,
      maxRedirects:   10,
      validateStatus: () => true,
      headers: { 'User-Agent': UA_DESKTOP },
    });
    const final = resp.request?.res?.responseUrl ||
                  resp.request?.responseURL      ||
                  (resp.config?.url !== url ? resp.config?.url : null);
    if (final && final !== url) {
      const idMatch = String(final).match(/\/video\/(\d{6,})/);
      if (idMatch) {
        const canonical = buildCanonicalFromVideoId(idMatch[1]);
        console.log(`🎵 TikTok: short→canonical (GET) ${url} → ${canonical}`);
        return canonical;
      }
      try {
        const u = new URL(final);
        return `${u.origin}${u.pathname}`;
      } catch (_) {
        return String(final).split('?')[0];
      }
    }
  } catch (e) {
    console.warn(`🎵 TikTok: GET fallback failed: ${e.message}`);
  }

  return url;
}

// ─── Story / live detection ──────────────────────────────────────────────────
//
// TikTok Live streams (tiktok.com/@user/live) are real-time-only — hard reject.
//
// TikTok Stories (tiktok.com/@user/story/<id>) are served through
// authenticated API calls, so public scrapers can't fetch them directly —
// per Apr-2026 testing, tikwm only returns story THUMBNAILS, not playback.
// BUT: the numeric story ID shares TikTok's video-ID space, and some
// "story" URLs are actually normal videos shared via the story sheet.
// So instead of hard-rejecting, we rewrite /story/<id> → /video/<id> and
// let the normal strategy chain take ONE cheap shot. Genuine ephemeral
// stories still fail cleanly with the explanatory error below.

function detectUnsupported(url) {
  if (/tiktok\.com\/@[^/]+\/live/i.test(url)) {
    return 'TikTok Live streams cannot be downloaded — they\'re real-time-only and not stored.';
  }
  return null;
}

const STORY_ERROR =
  'TikTok Stories are not downloadable — they require login and use ' +
  'ephemeral signed URLs that expire too fast for scrapers.';

/** /story/<id> → /video/<id> rewrite; returns null if not a story URL. */
function storyToVideoUrl(url) {
  const m = url.match(/tiktok\.com\/(@[^/]+)\/story\/(\d+)/i);
  if (!m) return null;
  return `https://www.tiktok.com/${m[1]}/video/${m[2]}`;
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

async function downloadTikTok(rawUrl, opts = {}) {
  // cookieFile (Netscape cookies.txt from the user's TikTok session) is only
  // consumed by the yt-dlp strategy — the HTTP mirror scrapers ignore the
  // extra arg. This is what lets logged-in users' Stories/private posts
  // resolve instead of hitting STORY_ERROR.
  const { cookieFile = null } = opts;
  // Stage 1 — bail early on live streams with a useful message
  const unsupported = detectUnsupported(rawUrl);
  if (unsupported) throw new Error(unsupported);

  // Stage 1b — story URLs: rewrite to /video/<id> and try the normal chain.
  // If every strategy fails on the rewritten URL, surface the story-specific
  // error (not the generic "all strategies failed") so the user understands.
  const storyRewrite = storyToVideoUrl(rawUrl);
  const isStory = !!storyRewrite;
  if (isStory) {
    console.log(`🎵 TikTok: story URL → trying as video: ${storyRewrite}`);
  }

  // Stage 2 — resolve short URLs to canonical form
  const url = await resolveShortUrl(isStory ? storyRewrite : rawUrl);

  // Strategy order: cheap+fast first, robust fallbacks after. yt-dlp goes
  // between musicaldown and ttdl because it's slower than the HTTP scrapers
  // when they work, but more reliable than ttdl (which wraps the same
  // scrapers we already tried). When TikTok pushes a breaking API change,
  // yt-dlp is usually the only thing still working.
  const strategies = [
    { name: 'tikwm',       fn: tryTikwm        },
    { name: 'ssstik',      fn: trySSStik       },
    { name: 'musicaldown', fn: tryMusicaldown  },
    { name: 'yt-dlp',      fn: tryYtDlpTikTok  },
    { name: 'ttdl',        fn: tryTtdl         },
  ];

  const errors = [];
  for (const s of strategies) {
    try {
      console.log(`🎵 TikTok: trying ${s.name}…`);
      const data = await s.fn(url, { cookieFile });
      const ok = (data.video && data.video.length > 0) ||
                 (data.images && data.images.length > 0);
      if (ok) {
        console.log(`🎵 TikTok: ✅ ${s.name} succeeded`);
        return data;
      }
      errors.push(`${s.name}: returned no video/images`);
    } catch (e) {
      console.warn(`🎵 TikTok: ❌ ${s.name} failed — ${e.message}`);
      errors.push(`${s.name}: ${e.message}`);
    }
  }

  if (isStory) {
    // No session was supplied → the user isn't signed into TikTok, and a
    // login-gated story needs their cookies. Use a strict "requires login"
    // phrase so the controller maps this to LOGIN_REQUIRED → the app shows
    // the guided sign-in flow (which then captures the TikTok session and
    // retries). Without a session there is nothing more we can do here.
    if (!cookieFile) {
      console.warn('🎵 TikTok: story failed with no session — requires login');
      throw new Error(
        'TikTok Story requires login — sign in to download this story.');
    }
    // A session WAS supplied but every strategy still failed → this is a
    // genuinely ephemeral / already-expired story, not an auth problem.
    console.warn('🎵 TikTok: story rewrite failed all strategies (with session) — genuine ephemeral story');
    throw new Error(STORY_ERROR);
  }
  throw new Error(`TikTok: all strategies failed — ${errors.join(' | ')}`);
}

module.exports = { downloadTikTok };