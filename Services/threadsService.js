const axios = require('axios');

function extractThreadId(url) {
  const m = url.match(/threads\.net\/(?:@[^/]+\/post\/|t\/)(\d+)/i);
  return m ? m[1] : null;
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

function safeJsonParse(str) {
  try { return JSON.parse(str); } catch { return null; }
}

function extractJsonBlobs(html) {
  const blobs = [];
  const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = scriptRe.exec(html))) {
    const s = m[1] || '';
    if (s.includes('{') && s.includes('}')) {
      const first = s.indexOf('{');
      const last = s.lastIndexOf('}');
      if (first !== -1 && last !== -1 && last > first) {
        const candidate = s.slice(first, last + 1);
        const obj = safeJsonParse(candidate);
        if (obj && typeof obj === 'object') blobs.push(obj);
      }
    }
  }
  return blobs;
}

function searchForThreadVideo(json) {
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

module.exports = async function threadsDownloader(threadUrl) {
  const resp = await axios.get(threadUrl, {
    timeout: 15000,
    maxRedirects: 5,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; UniSaverBot/1.0)',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  });
  const html = resp.data || '';

  // 1) Try og:video first
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
    const v = searchForThreadVideo(b);
    if (v && /^https?:\/\//i.test(v)) {
      return {
        title: 'Threads Post',
        download: v,
        thumbnail: pickMeta(html, 'og:image') || null,
        quality: 'Best'
      };
    }
  }

  // 3) Fallback: any mp4 in page
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
