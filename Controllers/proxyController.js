/**
 * proxyController.js
 *
 * GET /api/proxy-download?url=<encoded>&filename=<name>&platform=<facebook|etc>
 *
 * Fetches a CDN URL server-side (with platform-specific headers) and streams
 * the response back to the Flutter client. This bypasses Facebook/Instagram
 * CDN restrictions that block direct client downloads.
 */

const axios = require('axios');

// Per-platform request headers to satisfy CDN origin checks
const PLATFORM_HEADERS = {
  facebook: {
    Referer:         'https://www.facebook.com/',
    Origin:          'https://www.facebook.com',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Dest': 'video',
    Accept:          'video/webm,video/ogg,video/*;q=0.9,*/*;q=0.1',
  },
  instagram: {
    Referer:         'https://www.instagram.com/',
    Origin:          'https://www.instagram.com',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Dest': 'video',
    Accept:          'video/webm,video/ogg,video/*;q=0.9,*/*;q=0.1',
  },
  tiktok: {
    Referer: 'https://www.tiktok.com/',
  },
  default: {
    Accept: '*/*',
  },
};

const COMMON_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language':   'en-US,en;q=0.9',
  'Accept-Encoding':   'identity', // tell CDN not to compress — we stream raw bytes
  Connection:          'keep-alive',
  'Cache-Control':     'no-cache',
};

// Guess a filename extension from content-type
function extFromContentType(ct) {
  if (!ct) return 'mp4';
  if (ct.includes('mp4'))  return 'mp4';
  if (ct.includes('webm')) return 'webm';
  if (ct.includes('ogg'))  return 'ogg';
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg';
  if (ct.includes('png'))  return 'png';
  if (ct.includes('gif'))  return 'gif';
  if (ct.includes('webp')) return 'webp';
  if (ct.includes('mp3') || ct.includes('mpeg')) return 'mp3';
  if (ct.includes('m4a') || ct.includes('aac'))  return 'm4a';
  return 'mp4';
}

const proxyDownload = async (req, res) => {
  const { url, filename, platform } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'Missing url parameter', success: false });
  }

  let decodedUrl;
  try {
    decodedUrl = decodeURIComponent(url);
    new URL(decodedUrl); // validate
  } catch (_) {
    return res.status(400).json({ error: 'Invalid url parameter', success: false });
  }

  console.log(`🔄 Proxy download: platform=${platform || 'default'} url=${decodedUrl.slice(0, 120)}`);

  const platformKey = (platform || '').toLowerCase();
  const extraHeaders = PLATFORM_HEADERS[platformKey] || PLATFORM_HEADERS.default;
  const headers = { ...COMMON_HEADERS, ...extraHeaders };

  try {
    // Support range requests so Flutter's http client can resume / seek
    if (req.headers.range) {
      headers.Range = req.headers.range;
    }

    const upstream = await axios.get(decodedUrl, {
      responseType:   'stream',
      timeout:        60_000,
      maxRedirects:   10,
      headers,
      validateStatus: (s) => s < 500, // pass 206 partial content through
    });

    const contentType   = upstream.headers['content-type']   || 'video/mp4';
    const contentLength = upstream.headers['content-length'] || '';
    const accept_ranges = upstream.headers['accept-ranges']  || 'bytes';

    // Derive filename
    const ext     = extFromContentType(contentType);
    const dlName  = filename
      ? (filename.endsWith(`.${ext}`) ? filename : `${filename}.${ext}`)
      : `video.${ext}`;

    // ── headers to client ──────────────────────────────────────────────────
    res.setHeader('Content-Type',        contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${dlName}"`);
    res.setHeader('Accept-Ranges',       accept_ranges);
    res.setHeader('Cache-Control',       'no-cache, no-store');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Proxy-Platform',    platformKey || 'unknown');

    if (contentLength) {
      res.setHeader('Content-Length', contentLength);
    }

    // Pass through 206 Partial Content for range requests
    const statusCode = upstream.status === 206 ? 206 : 200;
    if (upstream.status === 206 && upstream.headers['content-range']) {
      res.setHeader('Content-Range', upstream.headers['content-range']);
    }

    res.status(statusCode);

    // ── stream ─────────────────────────────────────────────────────────────
    upstream.data.pipe(res);

    upstream.data.on('error', (err) => {
      console.error(`🔄 Proxy stream error: ${err.message}`);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Stream error', details: err.message });
      } else {
        res.end();
      }
    });

    req.on('close', () => {
      // Client disconnected — destroy upstream to free the connection
      upstream.data.destroy();
    });

  } catch (err) {
    console.error(`🔄 Proxy download error: ${err.message}`);
    if (!res.headersSent) {
      res.status(502).json({
        error:   'Proxy fetch failed',
        details: err.message,
        success: false,
      });
    }
  }
};

module.exports = { proxyDownload };