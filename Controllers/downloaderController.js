// Controllers/downloaderController.js
const axios = require('axios');
const { URL } = require('url');

// Services (note: keep these paths consistent with your project layout)
const { fetchYouTubeData } = require('../Services/youtubeService');
const facebookInstagramDownloader = require('../Services/facebookInstaService');
const threadsDownloader = require('../Services/threadsService');
const { downloadTwmateData } = require('../Services/twitterService');
const linkedinDownloader = require('../Services/linkedinService');

// ───────────────────────── helpers ─────────────────────────

function detectPlatform(rawUrl = '') {
  const url = (rawUrl || '').toLowerCase();
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube';
  if (url.includes('facebook.com') || url.includes('fb.com') || url.includes('fb.watch')) return 'facebook';
  if (url.includes('instagram.com')) return 'instagram';
  if (url.includes('threads.net')) return 'threads';
  if (url.includes('twitter.com') || url.includes('x.com')) return 'twitter';
  if (url.includes('linkedin.com')) return 'linkedin';
  if (url.includes('pinterest.com')) return 'pinterest';
  if (url.includes('reddit.com')) return 'reddit';
  if (url.includes('tiktok.com')) return 'tiktok';
  if (url.includes('vimeo.com')) return 'vimeo';
  if (url.includes('dailymotion.com') || url.includes('dai.ly')) return 'dailymotion';
  if (url.includes('twitch.tv')) return 'twitch';
  return 'generic';
}

function normalizeUrl(u) {
  try {
    if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
    const url = new URL(u);

    // YT: unify short to watch?v=
    if (url.hostname.includes('youtu.be')) {
      const id = url.pathname.split('/').filter(Boolean).pop();
      return `https://www.youtube.com/watch?v=${id}`;
    }
    if (url.hostname.includes('youtube.com') && url.searchParams.get('v')) {
      const id = url.searchParams.get('v');
      return `https://www.youtube.com/watch?v=${id}`;
    }

    // Facebook: prefer www
    if (url.hostname.startsWith('m.facebook.com')) {
      url.hostname = 'www.facebook.com';
      return url.toString();
    }

    // Threads: drop params
    if (url.hostname.includes('threads.net')) {
      return `https://${url.hostname}${url.pathname}`;
    }

    return url.toString();
  } catch (e) {
    return u;
  }
}

// Build a deterministic "itag" the Flutter app can echo back on /download
function makeItagLikeSlug(fmt, index) {
  const type = (fmt.type || (fmt.hasVideo ? 'video' : 'audio') || 'unknown').toString().toLowerCase();
  const quality = (fmt.quality || fmt.label || '').toString().toLowerCase().replace(/[^a-z0-9]+/g,'') || 'auto';
  const ext = (fmt.extension || fmt.container || '').toString().toLowerCase() || 'mp4';
  return `${type}_${quality}_${ext}_${index}`;
}

// Unify formats to the structure the Flutter dialog expects
function mapFormats(rawFormats = []) {
  return rawFormats.map((f, i) => {
    const hasVideo = (f.type || '').toString().toLowerCase().includes('video') || f.hasVideo === true;
    const hasAudio = (f.type || '').toString().toLowerCase().includes('audio') || f.hasAudio === true || (!hasVideo && f.type);
    return {
      itag: makeItagLikeSlug(f, i),
      quality: f.quality || f.label || (hasAudio ? (f.bitrate ? `${f.bitrate} kbps` : 'audio') : 'unknown'),
      container: f.extension || f.container || (hasAudio ? 'mp3' : 'mp4'),
      hasAudio,
      hasVideo,
      isVideo: f.isVideo != null ? !!f.isVideo : hasVideo, // keep Pinterest' isVideo hint
      audioCodec: f.audioCodec || null,
      videoCodec: f.videoCodec || null,
      audioBitrate: f.audioBitrate || f.bitrate || null,
      contentLength: f.contentLength || null,
      url: f.url || null, // kept for /direct
    };
  });
}
function pickByItag(formats, itag) {
  if (!Array.isArray(formats)) return null;
  return formats.find(f => f.itag === itag) || null;
}
const basicThumb = (url) => (url ? [{ url }] : []);

// Generic streaming proxy (with Range + Referer support)
async function streamRemote(res, remoteUrl, { referer, fileName } = {}) {
  // HEAD best-effort
  let size = null, ctype = null;
  try {
    const head = await axios.head(remoteUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
        Referer: referer,
      },
      maxRedirects: 5,
      validateStatus: s => s < 500,
    });
    size = head.headers['content-length'] ? parseInt(head.headers['content-length'], 10) : null;
    ctype = head.headers['content-type'] || null;
  } catch (_) {}

  const range = res.req.headers.range;
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
    Referer: referer,
  };
  if (range) headers.Range = range;

  const upstream = await axios.get(remoteUrl, {
    responseType: 'stream',
    headers,
    maxRedirects: 5,
    validateStatus: s => s < 500,
  });

  if (ctype) res.setHeader('Content-Type', ctype);
  else if (upstream.headers['content-type']) res.setHeader('Content-Type', upstream.headers['content-type']);

  const isPartial = upstream.status === 206 || !!range;
  if (isPartial) {
    res.status(206);
    if (upstream.headers['content-range']) res.setHeader('Content-Range', upstream.headers['content-range']);
    res.setHeader('Accept-Ranges', 'bytes');
  } else {
    res.status(200);
  }

  const len = upstream.headers['content-length'] || size;
  if (len) res.setHeader('Content-Length', len);

  if (fileName) {
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
  } else {
    // try to derive a decent name
    try {
      const u = new URL(remoteUrl);
      const base = u.pathname.split('/').pop() || 'download';
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(base)}`);
    } catch {}
  }

  upstream.data.on('error', () => {
    if (!res.headersSent) res.status(502);
    res.end();
  });
  upstream.data.pipe(res);
}

// ───────────────────────── Pinterest helpers ─────────────────────────

function normalizePinterestUrl(raw) {
  try {
    let u = String(raw || '').trim();
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    const parsed = new URL(u);
    // strip query for consistency
    parsed.search = '';
    return parsed.toString();
  } catch {
    return raw;
  }
}
function rx(html, re) { const m = html.match(re); return (m && m[1]) ? m[1] : null; }
const uniq = (arr) => Array.from(new Set(arr));

function extractPinterestFromHtml(html) {
  const title =
    rx(html, /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
    rx(html, /<meta[^>]+name=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
    rx(html, /<title[^>]*>([^<]+)<\/title>/i) ||
    'Pinterest media';

  const thumb =
    rx(html, /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
    rx(html, /"image_url"\s*:\s*"([^"]+)"/i) ||
    null;

  // meta video first
  const metaVideo =
    rx(html, /<meta[^>]+property=["']og:video(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i);

  // video_list urls (720p, 480p...)
  const videoListBlock = rx(html, /"video_list"\s*:\s*{([\s\S]*?)}/i);
  const fromVideoList = videoListBlock
    ? uniq(
        (videoListBlock.match(/"url"\s*:\s*"([^"]+)"/gi) || [])
          .map(m => m.replace(/"url"\s*:\s*"/i, '').replace(/"$/, '').replace(/\\u0026/g, '&'))
      )
    : [];

  // any direct pinimg mp4
  const mp4s = uniq(
    (html.match(/https:\/\/v\.pinimg\.com\/[^"'<> ]+?\.mp4[^"'<> ]*/gi) || []).map(s => s.replace(/\\u0026/g, '&'))
  );

  // images (fallback)
  const imageCandidates = uniq(
    (html.match(/https:\/\/i\.pinimg\.com\/[^"'<> ]+\.(?:jpg|jpeg|png|gif)/gi) || [])
  );

  let videoUrls = uniq([...(metaVideo ? [metaVideo] : []), ...fromVideoList, ...mp4s]);

  const formats = [];
  if (videoUrls.length) {
    for (const url of videoUrls) {
      const guessQ =
        rx(url, /(\d{3,4})p/i) || rx(url, /height=(\d{3,4})/i) || rx(url, /\/(\d{3,4})x\d{3,4}\//i);
      const quality = guessQ ? `${guessQ}p` : 'SD';
      formats.push({
        type: 'video',
        quality,
        extension: 'mp4',
        url,
        hasVideo: true,
        hasAudio: true,
        isVideo: true,
        videoCodec: 'h264',
        audioCodec: 'aac',
      });
    }
    // best first
    formats.sort((a, b) => (parseInt(b.quality) || 0) - (parseInt(a.quality) || 0));
    return {
      platform: 'Pinterest',
      mediaType: 'video',
      title,
      duration: null,
      thumbnails: thumb ? [{ url: thumb }] : [],
      formats,
    };
  }

  if (imageCandidates.length) {
    for (const u of imageCandidates) {
      formats.push({
        type: 'image',
        quality: 'image',
        extension: (u.split('.').pop() || 'jpg').toLowerCase(),
        url: u,
        hasVideo: false,
        hasAudio: false,
        isVideo: true, // ensure it appears under "Video" tab in your Pinterest UI case
      });
    }
    return {
      platform: 'Pinterest',
      mediaType: 'image',
      title,
      duration: null,
      thumbnails: thumb ? [{ url: thumb }] : [{ url: imageCandidates[0] }],
      formats,
    };
  }

  return null;
}

// ───────────────────────── controllers ─────────────────────────

/** GET /api/youtube?url= */
exports.getYoutubeInfo = async (req, res) => {
  try {
    const url = normalizeUrl(req.query.url || '');
    const data = await fetchYouTubeData(url);

    const formats = mapFormats(data.formats || []);
    res.json({
      platform: 'YouTube',
      title: data.title || 'YouTube Video',
      thumbnails: data.thumbnails || basicThumb(data.thumbnail || data.image),
      duration: data.duration || null,
      formats,
      originalUrl: url,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch YouTube info', errorDetail: err.message });
  }
};

/** GET /api/threads?url= */
exports.getThreadsInfo = async (req, res) => {
  try {
    const url = normalizeUrl(req.query.url || '');
    const info = await threadsDownloader(url);

    const fmt = {
      type: 'video',
      quality: info.quality || 'unknown',
      extension: 'mp4',
      url: info.download,
      hasVideo: true,
      hasAudio: true,
      isVideo: true,
    };
    const formats = mapFormats([fmt]);

    res.json({
      platform: 'Threads',
      title: 'Threads media',
      thumbnails: basicThumb(info.thumbnail),
      duration: null,
      formats,
      originalUrl: url,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch Threads info', errorDetail: err.message });
  }
};

/** GET /api/facebook?url=  (also handles Instagram URLs) */
exports.getFacebookInfo = async (req, res) => {
  try {
    const url = normalizeUrl(req.query.url || '');
    const platform = detectPlatform(url);

    const resp = await facebookInstagramDownloader(url);

    // metadownloader responses vary — normalize shape
    let entries = [];
    if (Array.isArray(resp)) entries = resp;
    else if (Array.isArray(resp?.downloads)) entries = resp.downloads;
    else if (Array.isArray(resp?.links)) entries = resp.links;
    else if (resp?.url) entries = [resp];

    const rawFormats = entries.map(d => ({
      type: d.type || 'video',
      quality: d.quality || d.label || 'auto',
      extension: d.extension || d.ext || 'mp4',
      url: d.url || d.download || d.link,
      hasVideo: true,
      hasAudio: true,
      isVideo: true,
    }));

    const formats = mapFormats(rawFormats);

    res.json({
      platform: platform === 'instagram' ? 'Instagram' : 'Facebook',
      title: resp?.title || 'Media',
      thumbnails: basicThumb(resp?.thumbnail),
      duration: resp?.duration || null,
      formats,
      originalUrl: url,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch Facebook/Instagram info', errorDetail: err.message });
  }
};

/** GET /api/special-media?url=  (now: Twitter, LinkedIn; more to add) */
exports.getSpecialMedia = async (req, res) => {
  try {
    const url = normalizeUrl(req.query.url || '');
    const platform = detectPlatform(url);

    if (platform === 'twitter') {
      const list = await downloadTwmateData(url); // returns array
      const raw = (Array.isArray(list) ? list : []).map(r => ({
        type: 'video',
        quality: r.quality || (r.height ? `${r.height}p` : 'auto'),
        extension: 'mp4',
        url: r.videoUrl || r.url,
        hasVideo: true,
        hasAudio: true,
        isVideo: true,
      }));
      return res.json({
        platform: 'Twitter',
        title: 'Tweet video',
        thumbnails: basicThumb(list?.thumbnail),
        duration: null,
        formats: mapFormats(raw),
        originalUrl: url,
      });
    }

    if (platform === 'linkedin') {
      const li = await linkedinDownloader(url);
      const urls = Array.isArray(li) ? li : (li.urls || []);
      const raw = urls.map(u => ({
        type: 'video',
        quality: 'auto',
        extension: 'mp4',
        url: u,
        hasVideo: true,
        hasAudio: true,
        isVideo: true,
      }));
      return res.json({
        platform: 'LinkedIn',
        title: (li && li.title) || 'LinkedIn media',
        thumbnails: basicThumb(li && li.thumbnail),
        duration: null,
        formats: mapFormats(raw),
        originalUrl: url,
      });
    }

    // TODO: add Vimeo, Dailymotion, Reddit, Twitch here
    return res.status(400).json({ error: 'Unsupported platform for special-media', platform });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch media info', errorDetail: err.message });
  }
};

/** GET /api/pinterest?url=  — IMPLEMENTED */
exports.getPinterestInfo = async (req, res) => {
  try {
    const raw = req.query.url || '';
    if (!raw) return res.status(400).json({ error: 'Missing url' });
    const url = normalizePinterestUrl(raw);

    const resp = await axios.get(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: 'https://www.pinterest.com/',
      },
      maxRedirects: 5,
      timeout: 15000,
      validateStatus: s => s < 500,
    });
    if (resp.status >= 400) {
      return res.status(400).json({
        platform: 'Pinterest',
        error: 'Failed to fetch Pinterest page',
        errorDetail: `Status ${resp.status}`,
      });
    }

    const parsed = extractPinterestFromHtml(resp.data || '');
    if (!parsed || !parsed.formats || !parsed.formats.length) {
      return res.json({
        platform: 'Pinterest',
        error: 'No downloadable media found on this Pin',
        errorDetail: 'It may be private, region-locked, or removed.',
      });
    }

    const formats = mapFormats(parsed.formats);
    return res.json({
      platform: 'Pinterest',
      title: parsed.title,
      thumbnails: parsed.thumbnails,
      duration: parsed.duration,
      mediaType: parsed.mediaType,
      formats,
      originalUrl: url,
    });
  } catch (err) {
    res.status(500).json({
      platform: 'Pinterest',
      error: 'Pinterest parser error',
      errorDetail: err?.message || String(err),
    });
  }
};

/** GET /api/info?url=  — auto-delegate to the right handler */
exports.getInfo = async (req, res) => {
  const raw = req.query.url || '';
  const url = normalizeUrl(raw);
  const platform = detectPlatform(url);

  try {
    if (platform === 'youtube') return exports.getYoutubeInfo(req, res);
    if (platform === 'threads') return exports.getThreadsInfo(req, res);
    if (platform === 'facebook' || platform === 'instagram') return exports.getFacebookInfo(req, res);
    if (platform === 'pinterest') return exports.getPinterestInfo(req, res);
    if (['twitter','linkedin','reddit','vimeo','dailymotion','twitch'].includes(platform)) {
      return exports.getSpecialMedia(req, res);
    }
    return res.status(400).json({ error: 'Unsupported or unknown platform', platform, originalUrl: url });
  } catch (err) {
    res.status(500).json({ error: 'Failed to process media info', errorDetail: err.message });
  }
};

/** GET /api/direct?url=&filename=  — 302 to direct URL (generic) */
exports.directDownload = async (req, res) => {
  try {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: 'Missing url' });
    const filename = req.query.filename;
    res.setHeader('Content-Disposition', filename ? `attachment; filename="${filename}"` : 'attachment');
    return res.redirect(url);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create direct link', errorDetail: err.message });
  }
};

/** GET /api/download?url=&itag=  — resolve formats again, redirect OR stream if Pinterest */
exports.downloadByItag = async (req, res) => {
  try {
    const raw = req.query.url || '';
    let url = normalizeUrl(raw);
    const itag = req.query.itag || '';
    const pfOverride = (req.query.platform || '').toString().toLowerCase();
    let platform = pfOverride || detectPlatform(url);

    if (!url || !itag) return res.status(400).json({ error: 'Missing url or itag' });

    // Pinterest needs streaming with Referer header to avoid 403
    if (platform === 'pinterest') {
      const htmlResp = await axios.get(normalizePinterestUrl(url), {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
          Referer: 'https://www.pinterest.com/',
        },
        maxRedirects: 5,
        validateStatus: s => s < 500,
      });
      const parsed = extractPinterestFromHtml(htmlResp.data || '');
      if (!parsed || !parsed.formats || !parsed.formats.length) {
        return res.status(404).json({ error: 'No Pinterest formats found' });
      }
      const unified = mapFormats(parsed.formats);
      const selected = pickByItag(unified, itag) || unified[0];
      if (!selected || !selected.url) return res.status(404).json({ error: 'Format not found' });

      const fileName = req.query.filename || undefined;
      return streamRemote(res, selected.url, { referer: 'https://www.pinterest.com/', fileName });
    }

    // All other platforms: rebuild formats then 302 to direct URL
    let info;
    if (platform === 'youtube') {
      info = await fetchYouTubeData(url);
    } else if (platform === 'threads') {
      const t = await threadsDownloader(url);
      info = {
        formats: [{ type: 'video', quality: t.quality, extension: 'mp4', url: t.download, hasVideo: true, hasAudio: true, isVideo: true }]
      };
    } else if (platform === 'facebook' || platform === 'instagram') {
      const d = await facebookInstagramDownloader(url);
      let entries = [];
      if (Array.isArray(d)) entries = d;
      else if (Array.isArray(d?.downloads)) entries = d.downloads;
      else if (Array.isArray(d?.links)) entries = d.links;
      else if (d?.url) entries = [d];
      info = {
        formats: entries.map(x => ({
          type: 'video',
          quality: x.quality || x.label || 'auto',
          extension: x.extension || x.ext || 'mp4',
          url: x.url || x.download || x.link,
          hasVideo: true, hasAudio: true, isVideo: true
        }))
      };
    } else if (platform === 'twitter') {
      const list = await downloadTwmateData(url);
      info = {
        formats: (Array.isArray(list) ? list : []).map(r => ({
          type: 'video',
          quality: r.quality || (r.height ? `${r.height}p` : 'auto'),
          extension: 'mp4',
          url: r.videoUrl || r.url,
          hasVideo: true, hasAudio: true, isVideo: true
        }))
      };
    } else if (platform === 'linkedin') {
      const li = await linkedinDownloader(url);
      const urls = Array.isArray(li) ? li : (li.urls || []);
      info = {
        formats: urls.map(u => ({
          type: 'video',
          quality: 'auto',
          extension: 'mp4',
          url: u,
          hasVideo: true, hasAudio: true, isVideo: true
        }))
      };
    } else {
      return res.status(400).json({ error: 'Unsupported platform', platform });
    }

    const unified = mapFormats(info.formats || []);
    const selected = pickByItag(unified, itag) || unified[0];
    if (!selected || !selected.url) return res.status(404).json({ error: 'Format not found' });

    return res.redirect(selected.url);
  } catch (err) {
    res.status(500).json({ error: 'Failed to build download', errorDetail: err.message });
  }
};

/** GET /api/audio?url=&itag=  — prefer audio-only formats when present */
exports.downloadAudio = async (req, res) => {
  try {
    const url = normalizeUrl(req.query.url || '');
    const itag = req.query.itag || '';
    const platform = detectPlatform(url);

    // Right now, YouTube is the one where we consistently get true audio-only formats
    let info;
    if (platform === 'youtube') {
      info = await fetchYouTubeData(url);
    } else {
      info = await fetchYouTubeData(url); // fallback: same logic
    }

    let unified = mapFormats(info.formats || []);
    const audioOnly = unified.filter(f => f.hasAudio && !f.hasVideo);
    unified = audioOnly.length ? audioOnly : unified;
    const selected = (itag ? pickByItag(unified, itag) : null) || unified[0];
    if (!selected || !selected.url) return res.status(404).json({ error: 'Audio format not found' });

    return res.redirect(selected.url);
  } catch (err) {
    res.status(500).json({ error: 'Failed to build audio download', errorDetail: err.message });
  }
};

/** GET /api/threads-download?url=&itag=  — wrapper for compatibility */
exports.threadsDownload = async (req, res) => exports.downloadByItag(req, res);

/** GET /api/facebook-download?url=&format=hd|sd */
exports.facebookDownload = async (req, res) => {
  try {
    const url = normalizeUrl(req.query.url || '');
    const fmt = (req.query.format || '').toLowerCase();
    const d = await facebookInstagramDownloader(url);

    let entries = [];
    if (Array.isArray(d)) entries = d;
    else if (Array.isArray(d?.downloads)) entries = d.downloads;
    else if (Array.isArray(d?.links)) entries = d.links;
    else if (d?.url) entries = [d];

    const list = entries.map(x => ({
      quality: (x.quality || x.label || '').toLowerCase(),
      url: x.url || x.download || x.link
    }));

    let chosen;
    if (fmt) chosen = list.find(x => x.quality.includes(fmt));
    if (!chosen) chosen = list[0];

    if (!chosen) return res.status(404).json({ error: 'No facebook formats found' });
    return res.redirect(chosen.url);
  } catch (err) {
    res.status(500).json({ error: 'Failed to build facebook download', errorDetail: err.message });
  }
};
