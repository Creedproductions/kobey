// Controllers/downloaderController.js
const axios = require('axios');
const { URL } = require('url');

const { fetchYouTubeData } = require('../Services/youtubeService');
const facebookInstagramDownloader = require('../Services/facebookInstaService');
const threadsDownloader = require('../Services/threadsService');
const { downloadTwmateData } = require('../Services/twitterService');
const linkedinDownloader = require('../Services/linkedinService');
const { fetchPinterest } = require('../Services/pinterestService'); // optional

// ───────── helpers ─────────
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
    if (url.hostname.includes('youtu.be')) {
      const id = url.pathname.split('/').filter(Boolean).pop();
      return `https://www.youtube.com/watch?v=${id}`;
    }
    if (url.hostname.includes('youtube.com') && url.searchParams.get('v')) {
      const id = url.searchParams.get('v');
      return `https://www.youtube.com/watch?v=${id}`;
    }
    if (url.hostname.startsWith('m.facebook.com')) {
      url.hostname = 'www.facebook.com';
      return url.toString();
    }
    if (url.hostname.includes('threads.net')) {
      return `https://${url.hostname}${url.pathname}`;
    }
    return url.toString();
  } catch {
    return u;
  }
}

function makeItagLikeSlug(fmt, index) {
  const type = (fmt.type || (fmt.hasVideo ? 'video' : 'audio') || 'unknown').toString().toLowerCase();
  const quality = (fmt.quality || fmt.label || '').toString().toLowerCase().replace(/[^a-z0-9]+/g,'') || 'auto';
  const ext = (fmt.extension || fmt.container || '').toString().toLowerCase() || 'mp4';
  return `${type}_${quality}_${ext}_${index}`;
}

function mapFormats(rawFormats = [], preferNativeTag = false) {
  return rawFormats.map((f, i) => {
    const hasVideo = (f.hasVideo === true) || ((f.type || '').includes('video')) || ((f.vcodec||'') !== 'none');
    const hasAudio = (f.hasAudio === true) || ((f.type || '').includes('audio')) || ((f.acodec||'') !== 'none');
    const itag = preferNativeTag && f.itag !== undefined ? String(f.itag) : makeItagLikeSlug(f, i);
    return {
      itag,
      quality: f.quality || f.label || (hasAudio && !hasVideo ? (f.audioBitrate ? `${f.audioBitrate} kbps` : 'audio') : 'auto'),
      container: f.extension || f.container || f.ext || 'mp4',
      hasAudio,
      hasVideo,
      audioCodec: f.audioCodec || f.acodec || null,
      videoCodec: f.videoCodec || f.vcodec || null,
      audioBitrate: f.audioBitrate || f.abr || null,
      contentLength: f.contentLength || f.filesize || f.filesize_approx || null,
      url: f.url || null,
    };
  }).filter(x => !!x.url);
}

function pickByItag(formats, itag) {
  if (!Array.isArray(formats)) return null;
  return formats.find(f => String(f.itag) === String(itag)) || null;
}

const basicThumb = (url) => (url ? [{ url }] : []);

// Stream proxy (prevents client-side 403s and saves “real” media)
async function proxyStream(mediaUrl, res) {
  const upstream = await axios.get(mediaUrl, {
    responseType: 'stream',
    validateStatus: s => s >= 200 && s < 400,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36',
      'Referer': mediaUrl,
      'Accept': '*/*',
      'Connection': 'keep-alive',
    }
  });
  const ct = upstream.headers['content-type'];
  const cl = upstream.headers['content-length'];
  if (ct) res.setHeader('Content-Type', ct);
  if (cl) res.setHeader('Content-Length', cl);
  upstream.data.pipe(res);
}

// ───────── controllers ─────────

exports.getYoutubeInfo = async (req, res) => {
  try {
    const url = normalizeUrl(req.query.url || '');
    const data = await fetchYouTubeData(url); // ytdl-core, fallback yt-dlp
    const formats = mapFormats(data.formats || [], true /* prefer native itag for YT */);
    res.json({
      platform: 'YouTube',
      title: data.title || 'YouTube Video',
      thumbnails: data.thumbnails || [],
      duration: data.duration || null,
      formats,
      originalUrl: url,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch YouTube info', errorDetail: err.message });
  }
};

exports.getThreadsInfo = async (req, res) => {
  try {
    const url = normalizeUrl(req.query.url || '');
    const info = await threadsDownloader(url);
    const fmt = { type: 'video', quality: info.quality || 'auto', extension: 'mp4', url: info.download, hasVideo: true, hasAudio: true };
    res.json({
      platform: 'Threads',
      title: 'Threads media',
      thumbnails: basicThumb(info.thumbnail),
      duration: null,
      formats: mapFormats([fmt]),
      originalUrl: url,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch Threads info', errorDetail: err.message });
  }
};

exports.getFacebookInfo = async (req, res) => {
  try {
    const url = normalizeUrl(req.query.url || '');
    const resp = await facebookInstagramDownloader(url); // returns {title, thumbnail, formats}
    const formats = mapFormats(resp.formats || []);
    if (!formats.length) {
      return res.status(404).json({ error: 'No downloadable formats found', platform: 'Facebook/Instagram' });
    }
    res.json({
      platform: detectPlatform(url) === 'instagram' ? 'Instagram' : 'Facebook',
      title: resp.title || 'Media',
      thumbnails: basicThumb(resp.thumbnail),
      duration: null,
      formats,
      originalUrl: url,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch Facebook/Instagram info', errorDetail: err.message });
  }
};

exports.getSpecialMedia = async (req, res) => {
  try {
    const url = normalizeUrl(req.query.url || '');
    const platform = detectPlatform(url);

    if (platform === 'twitter') {
      const list = await downloadTwmateData(url);
      const raw = (Array.isArray(list) ? list : []).map(r => ({
        type: 'video', quality: r.quality || (r.height ? `${r.height}p` : 'auto'),
        extension: 'mp4', url: r.videoUrl || r.url, hasVideo: true, hasAudio: true,
      }));
      return res.json({ platform: 'Twitter', title: 'Tweet video', thumbnails: basicThumb(list?.thumbnail), duration: null, formats: mapFormats(raw), originalUrl: url });
    }

    if (platform === 'linkedin') {
      const li = await linkedinDownloader(url);
      const urls = Array.isArray(li) ? li : (li.urls || []);
      const raw = urls.map(u => ({ type: 'video', quality: 'auto', extension: 'mp4', url: u, hasVideo: true, hasAudio: true }));
      return res.json({ platform: 'LinkedIn', title: li?.title || 'LinkedIn media', thumbnails: basicThumb(li?.thumbnail), duration: null, formats: mapFormats(raw), originalUrl: url });
    }

    return res.status(400).json({ error: 'Unsupported platform for special-media', platform });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch media info', errorDetail: err.message });
  }
};

exports.getPinterestInfo = async (req, res) => {
  try {
    const url = normalizeUrl(req.query.url || '');
    const data = await fetchPinterest(url);  // optional helper
    return res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to process Pinterest', errorDetail: err.message });
  }
};

// Unified router that delegates by platform (kept)
exports.getInfo = async (req, res) => {
  const url = normalizeUrl(req.query.url || '');
  const platform = detectPlatform(url);
  try {
    if (platform === 'youtube') return exports.getYoutubeInfo(req, res);
    if (platform === 'threads') return exports.getThreadsInfo(req, res);
    if (platform === 'facebook' || platform === 'instagram') return exports.getFacebookInfo(req, res);
    if (['twitter','linkedin','reddit','vimeo','dailymotion','twitch'].includes(platform)) {
      return exports.getSpecialMedia(req, res);
    }
    return res.status(400).json({ error: 'Unsupported or unknown platform', platform, originalUrl: url });
  } catch (err) {
    res.status(500).json({ error: 'Failed to process media info', errorDetail: err.message });
  }
};

// Direct download: support proxy=1 (default true for YT/FB/IG)
exports.downloadByItag = async (req, res) => {
  try {
    const url = normalizeUrl(req.query.url || '');
    const itag = req.query.itag || '';
    const proxy = (req.query.proxy || '1') !== '0';
    const platform = detectPlatform(url);

    let formats = [];

    if (platform === 'youtube') {
      const info = await fetchYouTubeData(url);
      formats = mapFormats(info.formats || [], true);
    } else if (platform === 'threads') {
      const t = await threadsDownloader(url);
      formats = mapFormats([{ type: 'video', quality: t.quality, extension: 'mp4', url: t.download, hasVideo: true, hasAudio: true }]);
    } else if (platform === 'facebook' || platform === 'instagram') {
      const d = await facebookInstagramDownloader(url);
      formats = mapFormats(d.formats || []);
    } else if (platform === 'twitter') {
      const list = await downloadTwmateData(url);
      formats = mapFormats((Array.isArray(list) ? list : []).map(r => ({
        type: 'video', quality: r.quality || (r.height ? `${r.height}p` : 'auto'),
        extension: 'mp4', url: r.videoUrl || r.url, hasVideo: true, hasAudio: true,
      })));
    } else if (platform === 'linkedin') {
      const li = await linkedinDownloader(url);
      const urls = Array.isArray(li) ? li : (li.urls || []);
      formats = mapFormats(urls.map(u => ({ type: 'video', quality: 'auto', extension: 'mp4', url: u, hasVideo: true, hasAudio: true })));
    } else {
      return res.status(400).json({ error: 'Unsupported platform', platform });
    }

    const selected = pickByItag(formats, itag) || formats[0];
    if (!selected || !selected.url) return res.status(404).json({ error: 'Format not found' });

    if (proxy) return proxyStream(selected.url, res);
    return res.redirect(selected.url);
  } catch (err) {
    res.status(500).json({ error: 'Failed to build download', errorDetail: err.message });
  }
};

exports.downloadAudio = async (req, res) => {
  try {
    const url = normalizeUrl(req.query.url || '');
    const itag = req.query.itag || '';
    const proxy = (req.query.proxy || '1') !== '0';
    const info = await fetchYouTubeData(url); // audio-only works best for YT
    let formats = mapFormats(info.formats || [], true);
    const audioOnly = formats.filter(f => f.hasAudio && !f.hasVideo);
    if (audioOnly.length) formats = audioOnly;
    const selected = (itag ? pickByItag(formats, itag) : null) || formats[0];
    if (!selected || !selected.url) return res.status(404).json({ error: 'Audio format not found' });
    if (proxy) return proxyStream(selected.url, res);
    return res.redirect(selected.url);
  } catch (err) {
    res.status(500).json({ error: 'Failed to build audio download', errorDetail: err.message });
  }
};

// Compatibility wrappers
exports.directDownload = async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Missing url' });
  const proxy = (req.query.proxy || '1') !== '0';
  if (proxy) return proxyStream(url, res);
  res.setHeader('Content-Disposition', 'attachment');
  return res.redirect(url);
};
exports.threadsDownload = async (req, res) => exports.downloadByItag(req, res);
exports.facebookDownload = async (req, res) => exports.downloadByItag(req, res);
