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

const proxyDownload = async (req, res) => {
  const targetUrl = req.query.url;
  const platform  = String(req.query.platform || 'default').toLowerCase();
  const reqMethod = (req.method || 'GET').toUpperCase();

  if (!targetUrl || typeof targetUrl !== 'string' || !targetUrl.startsWith('http')) {
    return res.status(400).json({ error: 'Missing or invalid url parameter' });
  }

  console.log(`🔄 Proxy download: platform=${platform} url=${targetUrl.slice(0, 150)}`);

  // Build upstream headers — start with platform defaults, then forward any
  // Range header from the client so resumable / partial-content downloads work.
  const upstreamHeaders = { ...(HEADERS_BY_PLATFORM[platform] || HEADERS_BY_PLATFORM.default) };
  if (req.headers.range)        upstreamHeaders.Range            = req.headers.range;
  if (req.headers['if-range'])  upstreamHeaders['If-Range']       = req.headers['if-range'];

  let upstream;
  try {
    upstream = await axios({
      method:         reqMethod === 'HEAD' ? 'HEAD' : 'GET',
      url:            targetUrl,
      headers:        upstreamHeaders,
      responseType:   reqMethod === 'HEAD' ? 'arraybuffer' : 'stream',
      timeout:        60_000,
      maxRedirects:   10,
      // Surface 4xx (e.g. 403, 404) to the client instead of throwing — the
      // app can then decide how to handle them. Only 5xx errors throw.
      validateStatus: (s) => s < 500,
      // Big files: don't buffer in memory
      maxContentLength: Infinity,
      maxBodyLength:    Infinity,
    });
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

  // Forward status + relevant headers
  res.status(upstream.status);
  for (const h of FORWARD_HEADERS) {
    const v = upstream.headers[h];
    if (v) res.setHeader(h, v);
  }

  // Always set a sensible Content-Disposition so the client saves the file
  // with our intended name rather than the upstream's generic filename.
  const ct       = upstream.headers['content-type'] || '';
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

  // GET: pipe the stream to the client. Handle disconnects + upstream errors.
  upstream.data.on('error', (err) => {
    console.error(`❌ Proxy stream error [${platform}]: ${err.message}`);
    if (!res.headersSent) {
      res.status(502).json({ error: 'Stream error', details: err.message });
    } else {
      res.destroy(err);
    }
  });

  req.on('close', () => {
    // Client disconnected — kill the upstream so we stop wasting bandwidth.
    if (upstream.data && typeof upstream.data.destroy === 'function') {
      upstream.data.destroy();
    }
  });

  upstream.data.pipe(res);
};

module.exports = { proxyDownload };