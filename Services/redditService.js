// Services/redditService.js
//
// Dedicated Reddit extractor. Reddit-hosted video (v.redd.it) is DASH:
// the `fallback_url` / DASH_<q>.mp4 renditions are VIDEO-ONLY and the audio
// lives in a separate DASH_AUDIO_*.mp4 track. The old path (plain yt-dlp via
// genericService) had two failure modes:
//
//   1. When only HLS muxed variants existed, the "best" pick was an .m3u8
//      MANIFEST url — the client saved a playlist text file named .mp4.
//   2. When only DASH formats existed, no muxed format survived and the
//      default fell through to the LAST sorted format — the audio-only
//      track. Users got an m4a "video", or a silent clip.
//
// Strategy here:
//   1. Resolve share links (reddit.com/r/<sub>/s/<token>) and redd.it short
//      links to the canonical /comments/ URL.
//   2. Hit Reddit's public .json API directly (fast, no subprocess). Build
//      video formats from the DASH renditions and pair them with the audio
//      track via `needsMerge` — the controller's reddit formatter rewrites
//      those into /api/merge-audio?videoUrl=…&audioUrl=… links so ffmpeg
//      muxes server-side and the client receives ONE playable mp4.
//   3. On any JSON-API failure (datacenter-IP blocks, private subs), fall
//      back to yt-dlp — then apply the SAME video+audio pairing over
//      yt-dlp's formats list so the default is never silent or a manifest.
//
// Galleries / image posts return `mediaItems` so the client carousel works.
// External posts (imgur, streamable, youtube links inside reddit) delegate
// to downloadGeneric on the destination URL.

const axios = require('axios');
const { downloadGeneric } = require('./genericService');
const ytdlpRunner = require('./ytDlpRunner');

const UA_DESKTOP = ytdlpRunner.UA_DESKTOP;

const JSON_HEADERS = {
  'User-Agent':      UA_DESKTOP,
  'Accept':          'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
};

const isShareLink = (url) =>
  /(?:redd\.it\/|reddit\.com\/(?:r|u|user)\/[^/]+\/s\/)/i.test(url);

// ─── Share-link resolution ──────────────────────────────────────────────────
// reddit.com/r/<sub>/s/<token> and redd.it/<id> both 301 to the canonical
// /comments/ URL. Follow redirects manually so we capture the Location even
// when the final page itself would 403 for a non-browser client.
async function resolveShareLink(url) {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    let resp;
    try {
      resp = await axios.get(current, {
        maxRedirects: 0,
        timeout: 8000,
        validateStatus: () => true,
        headers: JSON_HEADERS,
      });
    } catch (_) {
      return current;
    }
    const loc = resp.headers?.location;
    if (resp.status >= 300 && resp.status < 400 && loc) {
      current = loc.startsWith('http')
        ? loc
        : `https://www.reddit.com${loc.startsWith('/') ? '' : '/'}${loc}`;
      if (/\/comments\//i.test(current)) return current.split('?')[0];
      continue;
    }
    return current;
  }
  return current;
}

// ─── Audio track discovery ──────────────────────────────────────────────────
// Probe the well-known audio filenames next to the video rendition; fall
// back to mining the DASH manifest. Returns null for genuinely silent posts.
async function findAudioUrl(baseDir, dashUrl) {
  const candidates = [
    'DASH_AUDIO_128.mp4', 'DASH_AUDIO_64.mp4', 'DASH_AUDIO_256.mp4',
    'DASH_audio.mp4', 'DASH_AUDIO.mp4', 'audio',
  ];
  for (const name of candidates) {
    const u = `${baseDir}${name}`;
    try {
      const r = await axios.head(u, {
        timeout: 4000,
        validateStatus: () => true,
        headers: { 'User-Agent': UA_DESKTOP },
      });
      if (r.status < 400) return u;
    } catch (_) { /* try next */ }
  }
  if (dashUrl) {
    try {
      const r = await axios.get(dashUrl, {
        timeout: 5000,
        responseType: 'text',
        headers: { 'User-Agent': UA_DESKTOP },
      });
      const body = String(r.data || '');
      const m =
        body.match(/<AdaptationSet[^>]*(?:contentType|mimeType)="audio[^>]*>[\s\S]*?<BaseURL>([^<]+)<\/BaseURL>/i) ||
        body.match(/(DASH_AUDIO[^"<]*\.mp4)/i);
      if (m && m[1]) return m[1].startsWith('http') ? m[1] : `${baseDir}${m[1]}`;
    } catch (_) { /* silent post */ }
  }
  return null;
}

const videoFormat = (url, height, audioUrl) => ({
  quality:    height ? `${height}p` : 'Original Quality',
  qualityNum: height || 0,
  url,
  type:       'video/mp4',
  extension:  'mp4',
  filesize:   'unknown',
  isPremium:  false,
  hasAudio:   !!audioUrl,      // true once merged server-side
  isVideoOnly: false,          // post-merge the client gets a muxed mp4
  isAudioOnly: false,
  streamType: 'muxed',
  // Consumed by dataFormatters.reddit → rewritten to /api/merge-audio
  ...(audioUrl ? { needsMerge: true, mergeVideoUrl: url, mergeAudioUrl: audioUrl } : {}),
});

// ─── reddit_video → generic-shaped data ─────────────────────────────────────
async function buildFromRedditVideo(rv, post) {
  const fallback = (rv.fallback_url || '').split('?')[0];
  if (!fallback) throw new Error('Reddit: reddit_video without fallback_url');
  const dashUrl = rv.dash_url || null;

  // https://v.redd.it/<id>/DASH_720.mp4 → https://v.redd.it/<id>/
  const baseDir = fallback.slice(0, fallback.lastIndexOf('/') + 1);

  const hasAudio = rv.has_audio !== false;
  const audioUrl = hasAudio ? await findAudioUrl(baseDir, dashUrl) : null;

  const nativeHeight = rv.height || 720;
  const formats = [videoFormat(fallback, nativeHeight, audioUrl)];
  // Offer the standard lower renditions too (same file family, always
  // present for heights at or below the native one).
  for (const q of [1080, 720, 480, 360]) {
    if (q >= nativeHeight) continue;
    formats.push(videoFormat(`${baseDir}DASH_${q}.mp4`, q, audioUrl));
  }
  formats.sort((a, b) => b.qualityNum - a.qualityNum);

  // Expose the raw audio track so audio-only downloads stay possible.
  if (audioUrl) {
    formats.push({
      quality: '128kbps', qualityNum: 128000, url: audioUrl,
      type: 'audio/mp4', extension: 'm4a', filesize: 'unknown',
      isPremium: false, hasAudio: true, isVideoOnly: false,
      isAudioOnly: true, streamType: 'audioOnly',
    });
  }

  const def = formats[0];
  return {
    success:   true,
    platform:  'reddit',
    extractor: 'reddit-json',
    title:     post.title || 'Reddit Video',
    thumbnail: cleanThumb(post.thumbnail, post),
    duration:  rv.duration || 0,
    uploader:  post.author || '',
    url:       def.url,
    formats,
    allFormats: formats,
    selectedQuality: def,
  };
}

function cleanThumb(thumb, post) {
  const t = String(thumb || '');
  if (t.startsWith('http')) return t.replace(/&amp;/g, '&');
  const preview = post?.preview?.images?.[0]?.source?.url;
  return preview ? String(preview).replace(/&amp;/g, '&') : null;
}

// ─── .json API path ─────────────────────────────────────────────────────────
async function tryRedditJson(url) {
  const base = url.split('?')[0].replace(/\/+$/, '');
  const jsonUrl = `${base}.json?raw_json=1`;

  const resp = await axios.get(jsonUrl, {
    timeout: 9000,
    validateStatus: () => true,
    headers: JSON_HEADERS,
  });
  if (resp.status !== 200 || !Array.isArray(resp.data)) {
    throw new Error(`Reddit JSON API: status ${resp.status}`);
  }
  const post = resp.data?.[0]?.data?.children?.[0]?.data;
  if (!post) throw new Error('Reddit JSON API: no post data');

  // 1. Reddit-hosted video (also inside crossposts)
  const rv =
    post.secure_media?.reddit_video ||
    post.media?.reddit_video ||
    post.crosspost_parent_list?.find(c => c?.media?.reddit_video)?.media?.reddit_video ||
    post.crosspost_parent_list?.find(c => c?.secure_media?.reddit_video)?.secure_media?.reddit_video;
  if (rv) return buildFromRedditVideo(rv, post);

  // 2. Gallery → mediaItems carousel
  if (post.media_metadata && typeof post.media_metadata === 'object') {
    const items = [];
    for (const v of Object.values(post.media_metadata)) {
      if (!v || typeof v !== 'object') continue;
      const mp4 = v.s?.mp4, gif = v.s?.gif, img = v.s?.u;
      const u = mp4 || gif || img;
      if (u) {
        items.push({
          url: String(u).replace(/&amp;/g, '&'),
          thumbnail: String(img || u).replace(/&amp;/g, '&'),
          type: mp4 ? 'video' : 'image',
          quality: 'Original Quality',
        });
      }
    }
    if (items.length) {
      return {
        success: true, platform: 'reddit', extractor: 'reddit-json',
        title: post.title || 'Reddit Post',
        thumbnail: cleanThumb(post.thumbnail, post),
        duration: 0, uploader: post.author || '',
        url: items[0].url, formats: [], allFormats: [],
        selectedQuality: null, mediaItems: items,
      };
    }
  }

  // 3. Direct image / gif post
  const dest = post.url_overridden_by_dest || post.url || '';
  if (/\.(jpe?g|png|gif|webp)(\?|$)/i.test(dest)) {
    return {
      success: true, platform: 'reddit', extractor: 'reddit-json',
      title: post.title || 'Reddit Post',
      thumbnail: cleanThumb(post.thumbnail, post) || dest,
      duration: 0, uploader: post.author || '',
      url: dest.replace(/&amp;/g, '&'), formats: [], allFormats: [],
      selectedQuality: null,
    };
  }

  // 4. External media (imgur / streamable / youtube …) → yt-dlp on the
  //    destination, which knows every one of those hosts.
  if (dest && !/reddit\.com|redd\.it/i.test(dest)) {
    console.log(`👽 Reddit: external destination → generic (${dest.slice(0, 80)})`);
    const data = await downloadGeneric(dest);
    data.title = post.title || data.title;
    return data;
  }

  throw new Error('Reddit JSON API: post has no downloadable media');
}

// ─── yt-dlp fallback with DASH pairing ──────────────────────────────────────
// Runs when the JSON API is blocked (datacenter IPs) or returned nothing.
// yt-dlp's Reddit extractor still resolves most posts; we then re-derive a
// sane default: best progressive video track + audio track → needsMerge,
// never an .m3u8 manifest and never the bare audio track.
async function ytdlpFallback(url) {
  const data = await downloadGeneric(url);
  const formats = Array.isArray(data.formats) ? data.formats : [];

  const isManifest = (u) => /\.(m3u8|mpd)(\?|$)/i.test(String(u || ''));
  const videos = formats
    .filter(f => !f.isAudioOnly && !isManifest(f.url))
    .sort((a, b) => (b.qualityNum || 0) - (a.qualityNum || 0));
  const audio = formats.find(f => f.isAudioOnly && !isManifest(f.url)) || null;

  if (videos.length) {
    const best = videos[0];
    if (best.isVideoOnly && audio) {
      best.needsMerge    = true;
      best.mergeVideoUrl = best.url;
      best.mergeAudioUrl = audio.url;
      best.hasAudio      = true;
      best.isVideoOnly   = false;
      best.streamType    = 'muxed';
    }
    data.url = best.url;
    data.selectedQuality = best;
  }
  return data;
}


// ─── Cloudflare relay + public embed page ───────────────────────────────────
// Reddit now answers 403 "Blocked" to datacenter IPs (Koyeb included) for the
// share-link redirect, the .json API and normal post pages. Two things still
// work: Cloudflare's network (our ud-relay Worker), and embed.reddit.com,
// whose HTML carries `packaged-media-json` — MP4 renditions WITH audio
// already muxed (packaged-media.redd.it), so no ffmpeg merge is needed.
const RELAY_URL    = process.env.REDDIT_RELAY_URL || 'https://relay.creedmotions.store/fetch';
const RELAY_ORIGIN = process.env.REDDIT_RELAY_ORIGIN || 'https://redditdownloader.creedmotions.store';

const unescapeHtml = (t) => String(t || '')
  .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>').replace(/&amp;/g, '&');

async function getPage(url, { relay = false, timeout = 12000 } = {}) {
  const target = relay ? `${RELAY_URL}?url=${encodeURIComponent(url)}` : url;
  const resp = await axios.get(target, {
    timeout,
    maxRedirects: relay ? 0 : 5,
    responseType: 'text',
    transformResponse: [d => d],
    validateStatus: () => true,
    headers: relay
      ? { Origin: RELAY_ORIGIN, 'User-Agent': UA_DESKTOP }
      : { 'User-Agent': UA_DESKTOP, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
  });
  const finalUrl = relay ? (resp.headers['x-relay-final-url'] || url) : (resp.request?.res?.responseUrl || url);
  const status = relay ? Number(resp.headers['x-relay-status'] || resp.status) : resp.status;
  return { status, finalUrl, body: String(resp.data || '') };
}

async function resolveShareViaRelay(url) {
  try {
    const r = await getPage(url, { relay: true });
    if (/\/comments\//i.test(r.finalUrl)) return r.finalUrl.split('?')[0];
  } catch (e) { console.warn(`👽 Reddit: relay share resolve failed: ${e.message}`); }
  return url;
}

function embedUrlFor(canonical) {
  const u = new URL(canonical);
  return `https://embed.reddit.com${u.pathname.replace(/\/?$/, '/')}`;
}

function parseEmbed(html, canonical) {
  const h1 = (html.match(/<h1[^>]*>([^<]{1,300})<\/h1>/i) || [])[1];
  const slug = (canonical.match(/\/comments\/[a-z0-9]+\/([^/?#]+)/i) || [])[1];
  const ogTitle = (html.match(/<meta property="og:title" content="([^"]*)"/i) || [])[1];
  const title = unescapeHtml(h1 || (ogTitle && !/heart of the internet/i.test(ogTitle) ? ogTitle : '') || (slug ? slug.replace(/_/g, ' ') : '') ||
                (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || 'Reddit Post').replace(/\s*:\s*r\/\w+$/i, '').trim();
  const thumb = unescapeHtml((html.match(/<meta property="og:image" content="([^"]*)"/i) || [])[1] || '') || null;
  const pm = html.match(/packaged-media-json="([^"]+)"/i);
  if (pm) {
    let data = null;
    try { data = JSON.parse(unescapeHtml(pm[1])); } catch (_) {}
    const perms = data?.playbackMp4s?.permutations || [];
    const formats = perms
      .map(p => ({ url: p?.source?.url, h: p?.source?.dimensions?.height || 0 }))
      .filter(p => p.url)
      .map(p => ({
        quality: p.h ? `${p.h}p` : 'Original Quality', qualityNum: p.h, url: p.url,
        type: 'video/mp4', extension: 'mp4', filesize: 'unknown', isPremium: false,
        hasAudio: true, isVideoOnly: false, isAudioOnly: false, streamType: 'muxed',
      }))
      .sort((a, b) => b.qualityNum - a.qualityNum);
    if (formats.length) {
      return {
        success: true, platform: 'reddit', extractor: 'reddit-embed',
        title, thumbnail: thumb, duration: data?.playbackMp4s?.duration || 0, uploader: '',
        url: formats[0].url, formats, allFormats: formats, selectedQuality: formats[0],
      };
    }
  }
  // Image / gallery posts: collect full-size i.redd.it images.
  const imgs = [...new Set((html.match(/https:\/\/i\.redd\.it\/[A-Za-z0-9_-]+\.(?:jpe?g|png|gif|webp)/g) || []))];
  if (imgs.length > 1) {
    const items = imgs.map(u => ({ url: u, thumbnail: u, type: 'image', quality: 'Original Quality' }));
    return { success: true, platform: 'reddit', extractor: 'reddit-embed', title, thumbnail: thumb || imgs[0],
             duration: 0, uploader: '', url: imgs[0], formats: [], allFormats: [], selectedQuality: null, mediaItems: items };
  }
  if (imgs.length === 1) {
    return { success: true, platform: 'reddit', extractor: 'reddit-embed', title, thumbnail: thumb || imgs[0],
             duration: 0, uploader: '', url: imgs[0], formats: [], allFormats: [], selectedQuality: null };
  }
  throw new Error('Reddit embed: no media in embed page');
}

async function tryEmbed(canonical) {
  const embed = embedUrlFor(canonical);
  let lastErr;
  for (const relay of [false, true]) {
    try {
      const r = await getPage(embed, { relay });
      if (r.status !== 200) throw new Error(`embed status ${r.status}${relay ? ' (relay)' : ''}`);
      const data = parseEmbed(r.body, canonical);
      console.log(`👽 Reddit: ✅ embed page${relay ? ' via relay' : ''} (${data.mediaItems ? data.mediaItems.length + ' item(s)' : data.selectedQuality?.quality || 'image'})`);
      return data;
    } catch (e) { lastErr = e; console.warn(`👽 Reddit: embed${relay ? ' via relay' : ''} failed — ${e.message}`); }
  }
  throw lastErr || new Error('Reddit embed failed');
}

// ─── Public entry ───────────────────────────────────────────────────────────
async function downloadReddit(url) {
  let resolved = url;
  if (isShareLink(url)) {
    resolved = await resolveShareLink(url);
    if (resolved !== url) console.log(`👽 Reddit: share link resolved → ${resolved.slice(0, 100)}`);
  }

  // Direct redirect is blocked from datacenter IPs → resolve through the relay.
  if (!/\/comments\//i.test(resolved)) {
    const viaRelay = await resolveShareViaRelay(url);
    if (viaRelay !== url) { resolved = viaRelay; console.log(`👽 Reddit: share link resolved via relay → ${resolved.slice(0, 100)}`); }
  }

  try {
    const data = await tryRedditJson(resolved);
    console.log(`👽 Reddit: ✅ JSON API (${data.mediaItems ? `${data.mediaItems.length} item(s)` : data.selectedQuality?.quality || 'media'})`);
    return data;
  } catch (e) {
    console.warn(`👽 Reddit: JSON API failed (${String(e.message).slice(0, 120)}) → embed page`);
  }

  if (/\/comments\//i.test(resolved)) {
    try { return await tryEmbed(resolved); } catch (_) { /* fall through */ }
  }

  return ytdlpFallback(resolved);
}

module.exports = { downloadReddit };
