const axios = require('axios');
const { URL } = require('url');

// Services
const { fetchYouTubeData } = require('../Services/youtubeService');
const facebookInstagramDownloader = require('../Services/facebookInstaService');
const threadsDownloader = require('../Services/threadsService');
const { downloadTwmateData } = require('../Services/twitterService');
const linkedinDownloader = require('../Services/linkedinService');

/* ───────────────────────── helpers ───────────────────────── */

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

// Detect HLS/DASH or manifest-ish formats
function isHlsDashLike(f) {
  const q = `${f.quality || ''} ${f.label || ''} ${f.container || f.extension || ''}`.toLowerCase();
  const u = (f.url || '').toLowerCase();
  return (
    u.includes('.m3u8') ||
    u.includes('.mpd') ||
    q.includes('hls') ||
    q.includes('dash') ||
    /m3u8|mpd/.test(q)
  );
}

// Simple muxed guess: treat non-manifest mp4/webm as muxed unless explicitly audio-only
function isLikelyMuxed(f) {
  const ext = (f.extension || f.container || '').toLowerCase();
  const u = (f.url || '').toLowerCase();
  const isVideoType = (f.type || '').toLowerCase().includes('video');
  const isAudioType = (f.type || '').toLowerCase().includes('audio');

  if (isAudioType) return false; // audio-only
  if (isHlsDashLike(f)) return false; // manifest

  const looksMp4 = ext === 'mp4' || u.includes('.mp4');
  const looksWebm = ext === 'webm' || u.includes('.webm');

  return (isVideoType || looksMp4 || looksWebm);
}

// Prefer <=1080p mp4 to avoid YT adaptive-only pitfalls; bump to 720 if needed
function numericHeight(f) {
  const q = `${f.quality || f.label || ''}`.toLowerCase();
  const m = q.match(/(\d{3,4})p/);
  return m ? parseInt(m[1], 10) : 0;
}

function makeItagLikeSlug(fmt, index) {
  const type = (fmt.type || (fmt.hasVideo ? 'video' : 'audio') || 'unknown').toString().toLowerCase();
  const quality = (fmt.quality || fmt.label || '').toString().toLowerCase().replace(/[^a-z0-9]+/g,'') || 'auto';
  const ext = (fmt.extension || fmt.container || '').toString().toLowerCase() || 'mp4';
  return `${type}_${quality}_${ext}_${index}`;
}

function mapFormats(rawFormats = []) {
  return rawFormats.map((f, i) => {
    const hasVideo = (f.type || '').toString().toLowerCase().includes('video') || f.hasVideo === true || isLikelyMuxed(f);
    const hasAudio = (f.type || '').toString().toLowerCase().includes('audio')
      || f.hasAudio === true
      || (hasVideo && isLikelyMuxed(f)); // treat muxed as A+V

    return {
      itag: makeItagLikeSlug(f, i),
      quality: f.quality || f.label || (hasAudio && !hasVideo ? (f.bitrate ? `${f.bitrate} kbps` : 'audio') : 'unknown'),
      container: f.extension || f.container || (hasAudio && !hasVideo ? 'mp3' : 'mp4'),
      hasAudio,
      hasVideo,
      isVideo: f.isVideo != null ? !!f.isVideo : hasVideo,
      audioCodec: f.audioCodec || null,
      videoCodec: f.videoCodec || null,
      audioBitrate: f.audioBitrate || f.bitrate || null,
      contentLength: f.contentLength || null,
      url: f.url || null,
    };
  });
}

function pickByItag(formats, itag) {
  if (!Array.isArray(formats)) return null;
  return formats.find(f => f.itag === itag) || null;
}

const basicThumb = (url) => (url ? [{ url }] : []);

// Stream proxy with optional Referer (solves FB/IG/Pin hotlink)
async function streamRemote(res, remoteUrl, { referer, fileName } = {}) {
  let size = null, ctype = null;

  try {
    const head = await axios.head(remoteUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Referer: referer,
      },
      maxRedirects: 5,
      validateStatus: s => s < 500,
    });
    size = head.headers['content-length'] ? parseInt(head.headers['content-length'], 10) : null;
    ctype = head.headers['content-type'] || null;
  } catch (_) {}

  const range = res.req.headers.range;
  const headers = { 'User-Agent': 'Mozilla/5.0', Referer: referer };
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
  res.status(isPartial ? 206 : 200);
  if (isPartial && upstream.headers['content-range']) res.setHeader('Content-Range', upstream.headers['content-range']);
  if (isPartial) res.setHeader('Accept-Ranges', 'bytes');

  const len = upstream.headers['content-length'] || size;
  if (len) res.setHeader('Content-Length', len);

  if (fileName) {
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
  }

  upstream.data.on('error', () => { if (!res.headersSent) res.status(502); res.end(); });
  upstream.data.pipe(res);
}

/* ───────────────────────── Pinterest helpers ───────────────────────── */

function normalizePinterestUrl(raw) {
  try {
    let u = String(raw || '').trim();
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    const parsed = new URL(u);
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

  const metaVideo =
    rx(html, /<meta[^>]+property=["']og:video(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i);

  const videoListBlock = rx(html, /"video_list"\s*:\s*{([\s\S]*?)}/i);
  const fromVideoList = videoListBlock
    ? uniq((videoListBlock.match(/"url"\s*:\s*"([^"]+)"/gi) || []).map(m => m.replace(/"url"\s*:\s*"/i,'').replace(/"$/,'').replace(/\\u0026/g,'&')))
    : [];

  const mp4s = uniq((html.match(/https:\/\/v\.pinimg\.com\/[^"'<> ]+?\.mp4[^"'<> ]*/gi) || []).map(s => s.replace(/\\u0026/g,'&')));
  const imageCandidates = uniq(html.match(/https:\/\/i\.pinimg\.com\/[^"'<> ]+\.(?:jpg|jpeg|png|gif)/gi) || []);

  const formats = [];
  const videoUrls = uniq([...(metaVideo ? [metaVideo] : []), ...fromVideoList, ...mp4s]);

  if (videoUrls.length) {
    for (const url of videoUrls) {
      const g = rx(url, /(\d{3,4})p/i) || rx(url, /height=(\d{3,4})/i) || rx(url, /\/(\d{3,4})x\d{3,4}\//i);
      const quality = g ? `${g}p` : 'SD';
      formats.push({ type:'video', quality, extension:'mp4', url, hasVideo:true, hasAudio:true, isVideo:true, videoCodec:'h264', audioCodec:'aac' });
    }
    formats.sort((a,b)=> (parseInt(b.quality)||0) - (parseInt(a.quality)||0));
    return { platform:'Pinterest', mediaType:'video', title, duration:null, thumbnails: thumb ? [{url:thumb}] : [], formats };
  }

  if (imageCandidates.length) {
    for (const u of imageCandidates) {
      formats.push({ type:'image', quality:'image', extension:(u.split('.').pop()||'jpg').toLowerCase(), url:u, hasVideo:false, hasAudio:false, isVideo:true });
    }
    return { platform:'Pinterest', mediaType:'image', title, duration:null, thumbnails: thumb ? [{url:thumb}] : [{url:imageCandidates[0]}], formats };
  }
  return null;
}

/* ───────────────────────── controllers ───────────────────────── */

/** GET /api/youtube?url= */
exports.getYoutubeInfo = async (req, res) => {
  try {
    const url = normalizeUrl(req.query.url || '');
    const data = await fetchYouTubeData(url); // returns { title, duration, formats: [{type, label/quality, ext, url}] }

    // 1) Remove HLS/DASH
    let raw = (data.formats || []).filter(f => !isHlsDashLike(f));

    // 2) Prefer muxed MP4/WebM (A+V). If everything looks adaptive, still pass what we have.
    const muxed = raw.filter(isLikelyMuxed);
    raw = muxed.length ? muxed : raw;

    // 3) Sort by height (desc), but push >1080 lower to avoid adaptive-only traps
    raw.sort((a, b) => {
      const ah = numericHeight(a), bh = numericHeight(b);
      if (ah === bh) return 0;
      // Prefer <=1080 first
      const aPenalty = ah > 1080 ? 1 : 0;
      const bPenalty = bh > 1080 ? 1 : 0;
      if (aPenalty !== bPenalty) return aPenalty - bPenalty;
      return bh - ah;
    });

    const formats = mapFormats(raw);

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
    const fmt = { type:'video', quality: info.quality || 'unknown', extension:'mp4', url: info.download, hasVideo:true, hasAudio:true, isVideo:true };
    const formats = mapFormats([fmt]);
    res.json({ platform:'Threads', title:'Threads media', thumbnails: basicThumb(info.thumbnail), duration:null, formats, originalUrl: url });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch Threads info', errorDetail: err.message });
  }
};

/** GET /api/facebook?url=  (also handles Instagram) */
exports.getFacebookInfo = async (req, res) => {
  try {
    const url = normalizeUrl(req.query.url || '');
    const platform = detectPlatform(url);
    const resp = await facebookInstagramDownloader(url);

    let entries = [];
    if (Array.isArray(resp)) entries = resp;
    else if (Array.isArray(resp?.downloads)) entries = resp.downloads;
    else if (Array.isArray(resp?.links)) entries = resp.links;
    else if (resp?.url) entries = [resp];

    // keep only direct MP4/WebM, drop HLS
    const rawFormats = (entries || [])
      .map(d => ({
        type: d.type || 'video',
        quality: d.quality || d.label || 'auto',
        extension: (d.extension || d.ext || '').toLowerCase() || (String(d.url || d.download || d.link || '').toLowerCase().includes('.mp4') ? 'mp4' : 'mp4'),
        url: d.url || d.download || d.link,
        hasVideo: true,
        hasAudio: true,
        isVideo: true,
      }))
      .filter(f => f.url && !isHlsDashLike(f));

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

/** GET /api/special-media?url=  (Twitter, LinkedIn for now) */
exports.getSpecialMedia = async (req, res) => {
  try {
    const url = normalizeUrl(req.query.url || '');
    const platform = detectPlatform(url);

    if (platform === 'twitter') {
      const list = await downloadTwmateData(url);
      const raw = (Array.isArray(list) ? list : []).map(r => ({
        type: 'video',
        quality: r.quality || (r.height ? `${r.height}p` : 'auto'),
        extension: 'mp4',
        url: r.videoUrl || r.url,
        hasVideo: true,
        hasAudio: true,
        isVideo: true,
      })).filter(f => !isHlsDashLike(f));
      return res.json({ platform:'Twitter', title:'Tweet video', thumbnails: basicThumb(list?.thumbnail), duration:null, formats: mapFormats(raw), originalUrl: url });
    }

    if (platform === 'linkedin') {
      const li = await linkedinDownloader(url);
      const urls = Array.isArray(li) ? li : (li.urls || []);
      const raw = urls.map(u => ({ type:'video', quality:'auto', extension:'mp4', url:u, hasVideo:true, hasAudio:true, isVideo:true }))
                      .filter(f => !isHlsDashLike(f));
      return res.json({ platform:'LinkedIn', title:(li && li.title) || 'LinkedIn media', thumbnails: basicThumb(li && li.thumbnail), duration:null, formats: mapFormats(raw), originalUrl: url });
    }

    return res.status(400).json({ error: 'Unsupported platform for special-media', platform });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch media info', errorDetail: err.message });
  }
};

/** GET /api/pinterest?url= */
exports.getPinterestInfo = async (req, res) => {
  try {
    const raw = req.query.url || '';
    if (!raw) return res.status(400).json({ error: 'Missing url' });
    const url = normalizePinterestUrl(raw);

    const resp = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: 'https://www.pinterest.com/',
      },
      maxRedirects: 5, timeout: 15000, validateStatus: s => s < 500,
    });
    if (resp.status >= 400) {
      return res.status(400).json({ platform:'Pinterest', error:'Failed to fetch Pinterest page', errorDetail:`Status ${resp.status}` });
    }

    const parsed = extractPinterestFromHtml(resp.data || '');
    if (!parsed || !parsed.formats || !parsed.formats.length) {
      return res.json({ platform:'Pinterest', error:'No downloadable media found on this Pin', errorDetail:'It may be private, region-locked, or removed.' });
    }

    const formats = mapFormats(parsed.formats);
    return res.json({ platform:'Pinterest', title: parsed.title, thumbnails: parsed.thumbnails, duration: parsed.duration, mediaType: parsed.mediaType, formats, originalUrl: url });
  } catch (err) {
    res.status(500).json({ platform:'Pinterest', error:'Pinterest parser error', errorDetail: err?.message || String(err) });
  }
};

/** GET /api/info?url= */
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

/** GET /api/direct?url=&filename=  — 302 redirect (generic) */
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

/** GET /api/download?url=&itag=&platform=  — resolve formats, then:
 *  - Pinterest / Facebook / Instagram → STREAM with Referer (avoid 403/non-playable)
 *  - Others → 302 to direct URL
 */
exports.downloadByItag = async (req, res) => {
  try {
    const raw = req.query.url || '';
    const itag = req.query.itag || '';
    let url = normalizeUrl(raw);
    let platform = (req.query.platform || '').toString().toLowerCase() || detectPlatform(url);

    if (!url || !itag) return res.status(400).json({ error: 'Missing url or itag' });

    const needsStream = (p) => p === 'pinterest' || p === 'facebook' || p === 'instagram';

    let info, unified, selected;

    if (platform === 'pinterest') {
      const html = await axios.get(normalizePinterestUrl(url), {
        headers: { 'User-Agent':'Mozilla/5.0', Referer:'https://www.pinterest.com/' },
        validateStatus: s => s < 500,
      });
      const parsed = extractPinterestFromHtml(html.data || '');
      if (!parsed) return res.status(404).json({ error: 'No Pinterest formats found' });
      unified = mapFormats(parsed.formats);
      selected = pickByItag(unified, itag) || unified[0];
      if (!selected?.url) return res.status(404).json({ error: 'Format not found' });
      return streamRemote(res, selected.url, { referer: 'https://www.pinterest.com/', fileName: req.query.filename });
    }

    if (platform === 'facebook' || platform === 'instagram') {
      const d = await facebookInstagramDownloader(url);
      let entries = [];
      if (Array.isArray(d)) entries = d;
      else if (Array.isArray(d?.downloads)) entries = d.downloads;
      else if (Array.isArray(d?.links)) entries = d.links;
      else if (d?.url) entries = [d];

      const rawFormats = (entries || []).map(x => ({
        type:'video',
        quality: x.quality || x.label || 'auto',
        extension: (x.extension || x.ext || '').toLowerCase() || (String(x.url || x.download || x.link || '').toLowerCase().includes('.mp4') ? 'mp4' : 'mp4'),
        url: x.url || x.download || x.link,
        hasVideo:true, hasAudio:true, isVideo:true
      })).filter(f => f.url && !isHlsDashLike(f));

      unified = mapFormats(rawFormats);
      selected = pickByItag(unified, itag) || unified[0];
      if (!selected?.url) return res.status(404).json({ error: 'Format not found' });

      // stream with Referer so FB/IG CDNs serve the media
      const ref = platform === 'instagram' ? 'https://www.instagram.com/' : 'https://www.facebook.com/';
      return streamRemote(res, selected.url, { referer: ref, fileName: req.query.filename });
    }

    // YouTube / Twitter / LinkedIn → 302
    if (platform === 'youtube') {
      info = await fetchYouTubeData(url);
      let raw = (info.formats || []).filter(f => !isHlsDashLike(f));
      const muxed = raw.filter(isLikelyMuxed);
      raw = muxed.length ? muxed : raw;
      raw.sort((a,b)=> numericHeight(b) - numericHeight(a));
      unified = mapFormats(raw);
    } else if (platform === 'threads') {
      const t = await threadsDownloader(url);
      unified = mapFormats([{ type:'video', quality:t.quality, extension:'mp4', url:t.download, hasVideo:true, hasAudio:true, isVideo:true }]);
    } else if (platform === 'twitter') {
      const list = await downloadTwmateData(url);
      unified = mapFormats((Array.isArray(list)?list:[]).map(r=>({ type:'video', quality:r.quality || (r.height?`${r.height}p`:'auto'), extension:'mp4', url:r.videoUrl || r.url, hasVideo:true, hasAudio:true, isVideo:true })).filter(f=>!isHlsDashLike(f)));
    } else if (platform === 'linkedin') {
      const li = await linkedinDownloader(url);
      const urls = Array.isArray(li) ? li : (li.urls || []);
      unified = mapFormats(urls.map(u=>({ type:'video', quality:'auto', extension:'mp4', url:u, hasVideo:true, hasAudio:true, isVideo:true })).filter(f=>!isHlsDashLike(f)));
    } else {
      return res.status(400).json({ error: 'Unsupported platform', platform });
    }

    selected = pickByItag(unified, itag) || unified[0];
    if (!selected?.url) return res.status(404).json({ error: 'Format not found' });
    return res.redirect(selected.url);
  } catch (err) {
    res.status(500).json({ error: 'Failed to build download', errorDetail: err.message });
  }
};

/** GET /api/audio?url=&itag= */
exports.downloadAudio = async (req, res) => {
  try {
    const url = normalizeUrl(req.query.url || '');
    const itag = req.query.itag || '';
    const platform = detectPlatform(url);

    // Focus on YT audio-only for now
    let info = await fetchYouTubeData(url);
    let unified = mapFormats((info.formats || []).filter(f => !isHlsDashLike(f)));
    const audioOnly = unified.filter(f => f.hasAudio && !f.hasVideo);
    unified = audioOnly.length ? audioOnly : unified;

    const selected = (itag ? pickByItag(unified, itag) : null) || unified[0];
    if (!selected?.url) return res.status(404).json({ error: 'Audio format not found' });

    return res.redirect(selected.url);
  } catch (err) {
    res.status(500).json({ error: 'Failed to build audio download', errorDetail: err.message });
  }
};

exports.threadsDownload = async (req, res) => exports.downloadByItag(req, res);

/** GET /api/facebook-download?url=&format=hd|sd (kept for compatibility; streams with Referer) */
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

    const list = entries
      .map(x => ({
        quality: (x.quality || x.label || '').toLowerCase(),
        url: x.url || x.download || x.link
      }))
      .filter(u => u.url && !/\.m3u8|\.mpd/i.test(u.url));

    let chosen = fmt ? list.find(x => x.quality.includes(fmt)) : null;
    if (!chosen) chosen = list[0];
    if (!chosen) return res.status(404).json({ error: 'No facebook formats found' });

    const ref = detectPlatform(url) === 'instagram' ? 'https://www.instagram.com/' : 'https://www.facebook.com/';
    return streamRemote(res, chosen.url, { referer: ref });
  } catch (err) {
    res.status(500).json({ error: 'Failed to build facebook download', errorDetail: err.message });
  }
};
