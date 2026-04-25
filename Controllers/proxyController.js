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

const safeFilename = (raw, fallbackExt = '') => {
  let name = String(raw || 'video').trim();
  // Strip path separators and other risky characters
  name = name.replace(/[/\\?%*:|"<>\x00-\x1f]+/g, '_').slice(0, 200);
  if (!name) name = 'video';
  if (fallbackExt && !/\.[a-z0-9]{2,5}$/i.test(name)) name += fallbackExt;
  return name;
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
    // Buffer the entire body before resolving. This eliminates streaming
    // race conditions (premature close, mid-flight header issues) that
    // some hosting platforms — Render in particular — exhibit with
    // piped responses. The 100 MB cap is plenty for TikTok / IG / FB
    // videos and prevents runaway memory on huge files.
    responseType:     'arraybuffer',
    timeout:          90_000,
    maxRedirects:     10,
    validateStatus:   (s) => s < 500,
    maxContentLength: 100 * 1024 * 1024,
    maxBodyLength:    100 * 1024 * 1024,
  });
}

const proxyDownload = async (req, res) => {
  const targetUrl = req.query.url;
  const platform  = String(req.query.platform || 'default').toLowerCase();
  const reqMethod = (req.method || 'GET').toUpperCase();

  if (!targetUrl || typeof targetUrl !== 'string' || !targetUrl.startsWith('http')) {
    return res.status(400).json({ error: 'Missing or invalid url parameter' });
  }

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

  // HEAD: status + headers only, no body
  if (reqMethod === 'HEAD') {
    res.end();
    return;
  }

  // GET: send the buffered body in one shot. upstream.data is already a
  // Buffer (because of responseType: 'arraybuffer'), so this is reliable
  // and bypasses any platform-level stream mangling.
  try {
    const body     = Buffer.from(upstream.data);
    const expected = Number(upstream.headers['content-length']) || 0;
    const ok       = !expected || body.length === expected;

    console.log(
      `   ↳ sending ${body.length}/${expected || '?'} bytes to client ` +
      `${ok ? '✓' : '⚠ MISMATCH (upstream sent fewer bytes than Content-Length advertised)'}`
    );

    // Re-set Content-Length to the actual byte count we have. Otherwise the
    // client sits waiting for bytes that will never arrive and eventually
    // times out / retries. This is the fix for upstream CDNs that lie about
    // size and close the connection early.
    res.setHeader('Content-Length', body.length.toString());
    res.end(body);
  } catch (err) {
    console.error(`❌ Proxy send failed [${platform}]: ${err.message}`);
    if (!res.headersSent) {
      res.status(502).json({ error: 'Send failed', details: err.message });
    }
  }
};

module.exports = { proxyDownload };