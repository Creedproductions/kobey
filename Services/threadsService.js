const axios = require('axios');

function sanitizeUrl(u) {
  if (!u || typeof u !== 'string') return '';
  let x = u.trim();
  const i = x.indexOf('#');
  if (i !== -1) x = x.slice(0, i);
  return x;
}
function normalizeThreadsUrl(url) {
  let u = sanitizeUrl(url);
  try {
    const p = new URL(u);
    if (p.hostname === 'threads.com') { p.hostname = 'threads.net'; u = p.toString(); }
  } catch {}
  return u;
}
function pickMeta(content, prop) {
  const re = new RegExp(`<meta[^>]+property=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i');
  const m = content.match(re);
  return m ? m[1] : null;
}
function findFirstMp4(content) {
  const re = /https?:\/\/[^"']+\.mp4[^"']*/gi;
  const all = content.match(re);
  return all && all.length ? all[0] : null;
}
function safeJsonParse(str) { try { return JSON.parse(str); } catch { return null; } }
function extractJsonBlobs(html) {
  const blobs = [];
  const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = scriptRe.exec(html))) {
    const s = m[1] || '';
    if (s.includes('{') && s.includes('}')) {
      const a = s.indexOf('{'), b = s.lastIndexOf('}');
      if (a !== -1 && b !== -1 && b > a) {
        const obj = safeJsonParse(s.slice(a, b + 1));
        if (obj && typeof obj === 'object') blobs.push(obj);
      }
    }
  }
  return blobs;
}
function searchForVideoUrl(json) {
  let url = null;
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.video_url && typeof node.video_url === 'string') { url = node.video_url; return; }
    if (node.fallbackUrl && typeof node.fallbackUrl === 'string') { url = node.fallbackUrl; return; }
    if (node.playback_url && typeof node.playback_url === 'string') { url = node.playback_url; return; }
    for (const k of Object.keys(node)) {
      if (url) break;
      const v = node[k];
      if (v && typeof v === 'object') walk(v);
      if (Array.isArray(v)) for (const it of v) { if (url) break; if (it && typeof it === 'object') walk(it); }
    }
  };
  walk(json);
  return url;
}

async function fetchHtml(url) {
  try {
    const r = await axios.get(url, {
      timeout: 15000,
      maxRedirects: 5,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Upgrade-Insecure-Requests': '1'
      }
    });
    return r.data || '';
  } catch (e) {
    // Fallback via read-only mirror to bypass 403
    const mirror = `https://r.jina.ai/http://${url.replace(/^https?:\/\//, '')}`;
    const r2 = await axios.get(mirror, { timeout: 15000, maxRedirects: 5 });
    return r2.data || '';
  }
}

module.exports = async function threadsDownloader(originalUrl) {
  const url = normalizeThreadsUrl(originalUrl);
  const html = await fetchHtml(url);

  // 1) Try og:video
  const ogVideo = pickMeta(html, 'og:video');
  if (ogVideo && /\.mp4(\?|$)/i.test(ogVideo)) {
    return {
      title: 'Threads Post',
      download: ogVideo,
      thumbnail: pickMeta(html, 'og:image') || null,
      quality: 'Best'
    };
  }

  // 2) JSON blobs
  const blobs = extractJsonBlobs(html);
  for (const b of blobs) {
    const v = searchForVideoUrl(b);
    if (v && /^https?:\/\//i.test(v)) {
      return {
        title: 'Threads Post',
        download: v,
        thumbnail: pickMeta(html, 'og:image') || null,
        quality: 'Best'
      };
    }
  }

  // 3) Fallback
  const fallback = findFirstMp4(html);
  if (fallback) {
    return {
      title: 'Threads Post',
      download: fallback,
      thumbnail: pickMeta(html, 'og:image') || null,
      quality: 'Best'
    };
  }

  throw new Error('No downloadable media found on Threads page');
};
