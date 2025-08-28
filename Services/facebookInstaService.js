// Services/facebookInstaService.js
// 1) try metadownloader/snapsave (your existing approach)
// 2) if nothing usable, fallback to yt-dlp
const meta = require('metadownloader');        // if this was what you used
const { probe } = require('./universalYtDlp');

async function viaMeta(url) {
  try {
    const resp = await meta(url);
    let list = [];

    if (Array.isArray(resp)) list = resp;
    else if (Array.isArray(resp?.downloads)) list = resp.downloads;
    else if (Array.isArray(resp?.links)) list = resp.links;
    else if (resp?.url) list = [resp];

    const normalized = list.map(d => ({
      type: d.type || 'video',
      quality: d.quality || d.label || 'auto',
      extension: d.extension || d.ext || 'mp4',
      url: d.url || d.download || d.link,
      hasVideo: true,
      hasAudio: true,
    })).filter(x => x.url);

    return normalized.length ? { ok: true, formats: normalized, thumb: resp?.thumbnail, title: resp?.title } : { ok: false };
  } catch {
    return { ok: false };
  }
}

async function facebookInstagramDownloader(url) {
  // try metadownloader first
  const a = await viaMeta(url);
  if (a.ok) return { title: a.title || 'Media', thumbnail: a.thumb, formats: a.formats };

  // fallback to yt-dlp (very reliable)
  const p = await probe(url);
  return { title: p.title, thumbnail: (p.thumbnails[0] && p.thumbnails[0].url) || null, formats: p.formats };
}

module.exports = facebookInstagramDownloader;
