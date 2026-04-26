// Controllers/proxyController.js
//
// Server-side proxy that fetches a CDN URL and streams it to the client.
// Why this exists:
//   • CDNs (especially TikTok's) reject direct client requests because the IP
//     that fetched the metadata must match the IP that downloads the bytes.
//   • Some CDNs check Referer / User-Agent / Sec-Fetch-* headers.
//   • Browsers can't follow cross-origin downloads with custom headers.
//
// The proxy receives:
//   GET /api/proxy-download?url=<encoded>&filename=<name>&platform=<id>
//
// It then fetches the upstream URL with platform-specific headers, forwards
// the upstream status + relevant headers, and streams the body to the client.
// HEAD requests are supported (used by the Dart client to sniff Content-Type).

const axios = require('axios');

// ─── Platform-specific upstream headers ──────────────────────────────────────
// Each platform's CDN expects a slightly different header signature.
// These were derived from observing real browser requests against each CDN.

const UA_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const HEADERS_BY_PLATFORM = {
  tiktok: {
    'User-Agent':      UA_DESKTOP,
    Referer:           'https://www.tiktok.com/',
    Origin:            'https://www.tiktok.com',
    Accept:            '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Sec-Fetch-Dest':  'video',
    'Sec-Fetch-Mode':  'no-cors',
    'Sec-Fetch-Site':  'cross-site',
  },
  facebook: {
    'User-Agent':      UA_DESKTOP,
    Referer:           'https://www.facebook.com/',
    Accept:            '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
  },
  instagram: {
    'User-Agent':      UA_DESKTOP,
    Referer:           'https://www.instagram.com/',
    Accept:            '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
  },
  threads: {
    'User-Agent':      UA_DESKTOP,
    Referer:           'https://www.threads.com/',
    Accept:            '*/*',
  },
  twitter: {
    'User-Agent':      UA_DESKTOP,
    Referer:           'https://twitter.com/',
    Accept:            '*/*',
  },
  pinterest: {
    'User-Agent':      UA_DESKTOP,
    Referer:           'https://www.pinterest.com/',
  },
  youtube: {
    'User-Agent':      UA_DESKTOP,
    Referer:           'https://www.youtube.com/',
  },
  linkedin: {
    'User-Agent':      UA_DESKTOP,
    Referer:           'https://www.linkedin.com/',
  },
  default: {
    'User-Agent':      UA_DESKTOP,
    Accept:            '*/*',
  },
};

// Headers we forward from upstream → client. Anything not in this list is
// dropped to keep the response clean (e.g. Set-Cookie from upstream is junk).
const FORWARD_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'last-modified',
  'etag',
  'cache-control',
];

// ─── Filename safety ─────────────────────────────────────────────────────────

// ─── Filename safety ─────────────────────────────────────────────────────────
//
// Aggressively cleans filenames so they're safe to write on every major
// filesystem (ext4, APFS, NTFS, FAT32). The key constraint is ext4's 255-byte
// per-component limit on Android — Dio's download() silently fails if the
// path exceeds it, with no exception and no progress callback. TikTok titles
// routinely exceed 400 characters with emojis, hashtags, and captions, so
// this function is the last line of defence for downloads to succeed.
//
// Strips:
//   • emojis & non-BMP unicode (🔥💯シ etc.)
//   • hashtag markers, shell metachars, path separators, control codes
//   • repeated whitespace → single underscore
//   • leading/trailing dots and spaces (Windows + macOS share quirks)
//
// Caps the basename at 120 chars. Linux's hard limit is 255 BYTES, but UTF-8
// chars can be up to 4 bytes — so 120 chars × 4 = 480 byte ceiling, which
// safely fits even worst-case multibyte input.
const safeFilename = (raw, fallbackExt = '') => {
  let name = String(raw || 'video').trim();

  // Pull off the extension (if any) so length capping doesn't eat it
  const extMatch = name.match(/\.([a-zA-Z0-9]{2,5})$/);
  let stem       = extMatch ? name.slice(0, -extMatch[0].length) : name;
  let ext        = extMatch ? extMatch[0] : fallbackExt;

  // Strip emojis and non-BMP unicode. \u{...} ranges cover the common emoji
  // blocks; the catch-all surrogate pair regex handles anything else above
  // U+FFFF that slipped through.
  stem = stem
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, '')   // misc symbols & pictographs
    .replace(/[\u{2600}-\u{27BF}]/gu, '')     // dingbats / misc symbols
    .replace(/[\u{2300}-\u{23FF}]/gu, '')     // misc technical
    .replace(/[\u{2B00}-\u{2BFF}]/gu, '')     // arrows & decorative
    .replace(/[\u{1F000}-\u{1F2FF}]/gu, '')   // game pieces, transport
    .replace(/[\uD800-\uDFFF]/g, '')          // any leftover surrogate halves
    // Shell-unfriendly + path-unfriendly punctuation
    .replace(/[#@*?:|"<>\\/]+/g, '')
    // Control codes
    .replace(/[\x00-\x1f\x7f]+/g, '')
    // Whitespace runs
    .replace(/\s+/g, '_')
    // Leading/trailing junk
    .replace(/^[._\s-]+|[._\s-]+$/g, '');

  if (!stem) stem = 'video';

  // Hard length cap on the stem
  const MAX_STEM = 120;
  if (stem.length > MAX_STEM) stem = stem.slice(0, MAX_STEM);

  // Ensure we have an extension
  if (!ext) ext = fallbackExt || '';

  // Reserved Windows names (CON, PRN, AUX, NUL, COM1-9, LPT1-9) — append _ to
  // be safe even though we're primarily targeting Android, since users may
  // sync to Windows over USB.
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) stem += '_';

  return stem + ext;
};

const guessExtFromContentType = (ct) => {
  if (!ct) return '';
  const c = ct.toLowerCase();
  if (c.includes('mp4'))      return '.mp4';
  if (c.includes('webm'))     return '.webm';
  if (c.includes('quicktime')) return '.mov';
  if (c.includes('mpegurl'))  return '.m3u8';
  if (c.includes('mp3') || c.includes('mpeg-audio')) return '.mp3';
  if (c.includes('aac'))      return '.m4a';
  if (c.includes('audio/mp4')) return '.m4a';
  if (c.includes('jpeg'))     return '.jpg';
  if (c.includes('png'))      return '.png';
  if (c.includes('webp'))     return '.webp';
  if (c.includes('gif'))      return '.gif';
  return '';
};

// ─── Main handler ────────────────────────────────────────────────────────────

const UA_TIKTOK_APP =
  'com.zhiliaoapp.musically/2023600040 (Linux; U; Android 13; en_US; ' +
  'Pixel 7; Build/TQ2A.230505.002.A1; Cronet/58.0.2991.0)';

async function fetchUpstream(targetUrl, headers, method) {
  return axios({
    method,
    url:              targetUrl,
    headers,
    // STREAMING: pipe bytes directly from upstream to client without
    // buffering the whole file in memory. This is critical for two reasons:
    //
    //   1. Memory: buffering even a single 50 MB FB video uses 50 MB of RAM.
    //      With a few concurrent users, the 256 MB Koyeb instance OOMs and
    //      gets killed (we saw this in production).
    //
    //   2. Size limit: axios defaults to a 100 MB cap when buffering. Long
    //      Facebook reels and TikToks routinely exceed this — the upstream
    //      throws "maxContentLength size of 104857600 exceeded" and the
    //      phone sees a dropped connection, which the user perceives as
    //      "downloads work sometimes".
    //
    // Streaming has neither problem: bytes flow upstream → proxy → client
    // with constant ~64 KB memory per request regardless of file size.
    //
    // Caveat: stream errors must be handled explicitly (see proxyDownload).
    // Without that, a mid-stream upstream disconnect would crash the process.
    responseType:   'stream',
    timeout:        90_000,
    maxRedirects:   10,
    validateStatus: (s) => s < 500,
  });
}

const proxyDownload = async (req, res) => {
  let targetUrl   = req.query.url;
  const platform  = String(req.query.platform || 'default').toLowerCase();
  const reqMethod = (req.method || 'GET').toUpperCase();

  if (!targetUrl || typeof targetUrl !== 'string' || !targetUrl.startsWith('http')) {
    return res.status(400).json({ error: 'Missing or invalid url parameter' });
  }

  // ── URL repair for TikTok / scraper-derived URLs ───────────────────────
  // tikwm and similar services return URLs that often contain malformed
  // query strings: double ampersands ("&&bt=") that create empty params,
  // trailing fragments stuck onto the query ("?#"), and URL-encoded chars
  // that some axios versions handle inconsistently. Clean these up before
  // passing to axios — otherwise the request to upstream may either 400 or
  // hash to a different cache key than the one tikwm signed.
  try {
    // Strip double-ampersands and trailing junk
    targetUrl = targetUrl.replace(/&{2,}/g, '&').replace(/[?&]+$/, '');
    // Drop any fragment — fragments shouldn't be in URLs sent to servers
    const hashIdx = targetUrl.indexOf('#');
    if (hashIdx !== -1) targetUrl = targetUrl.slice(0, hashIdx);
  } catch (_) {}

  console.log(`🔄 Proxy ${reqMethod} [${platform}]: ${targetUrl.slice(0, 250)}`);

  // Build upstream headers — start with platform defaults, then forward any
  // Range header from the client so resumable / partial-content downloads work.
  const upstreamHeaders = { ...(HEADERS_BY_PLATFORM[platform] || HEADERS_BY_PLATFORM.default) };
  const clientSentRange = !!req.headers.range;
  if (clientSentRange)             upstreamHeaders.Range      = req.headers.range;
  if (req.headers['if-range'])     upstreamHeaders['If-Range'] = req.headers['if-range'];

  let upstream;
  let attempt = 'primary';
  try {
    const httpMethod = reqMethod === 'HEAD' ? 'HEAD' : 'GET';
    upstream = await fetchUpstream(targetUrl, upstreamHeaders, httpMethod);

    // TikTok-specific recovery: if the desktop UA gets blocked (403/451/etc),
    // retry once with the TikTok app UA. Many tikwm-derived URLs are signed
    // for app clients and reject browser-style fetches.
    if (
      platform === 'tiktok' &&
      [401, 403, 451].includes(upstream.status) &&
      httpMethod === 'GET'
    ) {
      console.warn(`⚠️ tiktok primary returned ${upstream.status}, retrying with app UA`);
      // Drain the failed stream so the connection is freed
      if (upstream.data && typeof upstream.data.destroy === 'function') {
        upstream.data.destroy();
      }
      const retryHeaders = { ...upstreamHeaders, 'User-Agent': UA_TIKTOK_APP };
      upstream = await fetchUpstream(targetUrl, retryHeaders, httpMethod);
      attempt = 'app-ua';
    }
  } catch (err) {
    const upstreamStatus = err.response?.status;
    console.error(
      `❌ Proxy upstream failed [${platform}]: ${err.message}` +
      (upstreamStatus ? ` (status ${upstreamStatus})` : '')
    );
    if (!res.headersSent) {
      res.status(upstreamStatus || 502).json({
        error:    'Proxy fetch failed',
        details:  err.message,
        platform,
        upstream: upstreamStatus || null,
      });
    }
    return;
  }

  // Always log the upstream outcome — this is critical for debugging which
  // URLs/platforms are being rejected and why.
  const ct  = upstream.headers['content-type']    || '';
  const cl  = upstream.headers['content-length']  || '?';
  const cr  = upstream.headers['content-range']   || '';
  console.log(
    `   ↳ upstream ${upstream.status} [${attempt}] ct=${ct} len=${cl}${cr ? ` range=${cr}` : ''}`
  );
  if (upstream.status >= 400) {
    console.warn(`   ↳ NON-OK status — client will see ${upstream.status}`);
  }

  // Status normalization: if the client didn't request a Range but the
  // upstream returned 206, present it to the client as a normal 200. Some
  // HTTP clients (notably Dio's download method) get confused by 206
  // responses they didn't ask for — they may treat the body as a partial
  // chunk and either truncate the file or trigger retry storms. Stripping
  // Content-Range here keeps the response shape consistent with a plain GET.
  if (!clientSentRange && upstream.status === 206) {
    res.status(200);
  } else {
    res.status(upstream.status);
  }

  for (const h of FORWARD_HEADERS) {
    if (h === 'content-range' && !clientSentRange) continue; // see comment above
    const v = upstream.headers[h];
    if (v) res.setHeader(h, v);
  }

  // Always set a sensible Content-Disposition so the client saves the file
  // with our intended name rather than the upstream's generic filename.
  const ext      = guessExtFromContentType(ct);
  const fname    = safeFilename(req.query.filename, ext);
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);

  // CORS — open by default since this is a download endpoint
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Expose-Headers',
    'Content-Length, Content-Range, Accept-Ranges, Content-Disposition, Content-Type');

  // HEAD: status + headers only, drain any inbound stream so the connection
  // is freed cleanly.
  if (reqMethod === 'HEAD') {
    if (upstream.data && typeof upstream.data.destroy === 'function') {
      upstream.data.destroy();
    }
    res.end();
    return;
  }

  // GET: pipe upstream stream directly to client. This avoids buffering in
  // memory, so file size is unlimited and RAM usage is constant per request.
  //
  // Error handling: a streaming pipe must handle errors on BOTH ends.
  //   - Upstream error (CDN drops connection mid-flight): we close client
  //     gracefully. Phone sees a partial download and our retry logic
  //     handles the rest.
  //   - Client error (user closed app, bad network): we destroy the
  //     upstream stream so we don't leak a worker waiting for bytes nobody
  //     will read.
  // Without this, mid-stream upstream disconnects crash the entire Node
  // process (unhandled 'error' on a Readable). DO NOT remove these.
  let bytesSent = 0;
  upstream.data.on('data', (chunk) => { bytesSent += chunk.length; });

  upstream.data.on('error', (err) => {
    console.error(`❌ Upstream stream error [${platform}] after ${bytesSent} bytes: ${err.message}`);
    if (!res.headersSent) {
      res.status(502).json({ error: 'Upstream stream failed', details: err.message });
    } else {
      res.destroy(err);
    }
  });

  res.on('close', () => {
    // Client closed connection (downloaded everything OR cancelled). Either
    // way, kill the upstream stream so we don't waste CPU/sockets.
    if (!upstream.data.destroyed) {
      upstream.data.destroy();
    }
    const expected = Number(upstream.headers['content-length']) || 0;
    if (expected && bytesSent < expected) {
      console.warn(`⚠ client closed early [${platform}]: sent ${bytesSent}/${expected} bytes`);
    } else {
      console.log(`   ↳ streamed ${bytesSent}/${expected || '?'} bytes to client ✓`);
    }
  });

  upstream.data.pipe(res);
};

module.exports = { proxyDownload };