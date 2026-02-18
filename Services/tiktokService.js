// ============================================================
// Services/tiktokService.js
// Uses tikwm.com direct API only — confirmed working in production.
// Returns hdplay (HD, no watermark) as the best quality URL.
// ============================================================

const axios = require('axios');

const TIKWM_ENDPOINTS = [
  'https://www.tikwm.com/api/',
  'https://tikwm.com/api/',
];

function isValidVideoUrl(url) {
  if (!url || typeof url !== 'string') return false;
  if (!url.startsWith('http')) return false;
  if (url.length < 20) return false;
  return true;
}

async function robustTikTokDownload(url) {
  console.log(`\nTikTok: Starting download for: ${url}`);

  const errors = [];

  for (const endpoint of TIKWM_ENDPOINTS) {
    try {
      console.log(`TikTok [tikwm]: Trying ${endpoint}...`);

      const response = await axios.get(endpoint, {
        params: {
          url: url,
          hd: 1,  // request HD quality — returns hdplay instead of play
        },
        timeout: 25000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
          'Referer': 'https://www.tikwm.com/',
        },
      });

      const data = response.data;

      if (!data || data.code !== 0 || !data.data) {
        const msg = `tikwm code=${data?.code} msg=${data?.msg || 'unknown'}`;
        console.log(`  ${endpoint}: ${msg}`);
        errors.push(`${endpoint}: ${msg}`);
        continue;
      }

      const d = data.data;

      // hdplay = HD no-watermark (best quality, 300-600 chars)
      // play   = SD no-watermark (fallback)
      const videoUrl = d.hdplay || d.play || '';

      console.log(`  tikwm hdplay len: ${d.hdplay?.length || 0}`);
      console.log(`  tikwm play len  : ${d.play?.length || 0}`);

      if (!isValidVideoUrl(videoUrl)) {
        errors.push(`${endpoint}: no valid video URL (hdplay=${d.hdplay?.length || 0} chars)`);
        continue;
      }

      const audioUrl = d.music || d.music_info?.play || '';

      console.log(`TikTok: Success — URL length: ${videoUrl.length}`);
      console.log(`TikTok: URL preview: ${videoUrl.substring(0, 80)}...`);

      return {
        title: d.title || 'TikTok Video',
        video: [videoUrl],
        thumbnail: d.cover || d.origin_cover || '',
        audio: audioUrl ? [audioUrl] : [],
        duration: d.duration ? String(d.duration) : 'unknown',
        _source: 'tikwm',
      };

    } catch (e) {
      const msg = (e.message || 'unknown').substring(0, 150);
      console.log(`  tikwm ${endpoint}: ${msg}`);
      errors.push(`${endpoint}: ${msg}`);
    }
  }

  throw new Error(`TikTok download failed: ${errors.join(' | ')}`);
}

module.exports = { robustTikTokDownload };