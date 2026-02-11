'use strict';

/**
 * youtubeService.js — youtubei.js InnerTube API with multi-client fallback
 *
 * Fixes:
 *  - Uses getInfo() correctly (getBasicInfo second arg is options, not client type)
 *  - Handles ciphered formats (signatureCipher/cipher) by deciphering via session player
 *  - Avoids empty location; uses proper default (US) and supports env overrides
 *  - Adds optional cookie / visitor_data / po_token support via env (if you run authenticated)
 *
 * Env (optional):
 *  - YT_LANG          (default: en)
 *  - YT_LOCATION      (default: US)
 *  - YT_VISITOR_DATA  (optional)
 *  - YT_PO_TOKEN      (optional; session-bound attestation token)
 *  - YT_COOKIE / YT_COOKIES (optional; auth cookies)
 */

const { Innertube, UniversalCache } = require('youtubei.js');

// ─── Singleton pool — one instance per client type ───────────────────────────
const _pool = Object.create(null);

const ENV = {
  LANG: (process.env.YT_LANG || 'en').trim() || 'en',
  LOCATION: (process.env.YT_LOCATION || 'US').trim() || 'US',
  VISITOR_DATA: (process.env.YT_VISITOR_DATA || '').trim() || undefined,
  PO_TOKEN: (process.env.YT_PO_TOKEN || '').trim() || undefined,
  COOKIE: (process.env.YT_COOKIE || process.env.YT_COOKIES || '').trim() || undefined,
};

async function getClient(clientType = 'IOS') {
  if (_pool[clientType]) return _pool[clientType];

  console.log(`🔧 [youtubei] Creating InnerTube client: ${clientType}`);

  // UniversalCache supports an optional path in newer versions; safe to pass. :contentReference[oaicite:3]{index=3}
  const cacheDir = `/tmp/ytjs-cache-${clientType}`;

  _pool[clientType] = await Innertube.create({
    cache: new UniversalCache(true, cacheDir),

    // Session config (docs defaults are sensible; don’t pass empty strings). :contentReference[oaicite:4]{index=4}
    client_type: clientType,
    lang: ENV.LANG,
    location: ENV.LOCATION,
    visitor_data: ENV.VISITOR_DATA,
    po_token: ENV.PO_TOKEN,
    cookie: ENV.COOKIE,

    // Keep player retrieval ON so deciphering is possible. :contentReference[oaicite:5]{index=5}
    retrieve_player: true,
    enable_safety_mode: false,

    // More reliable than local generation for tougher videos; keep caching on. :contentReference[oaicite:6]{index=6}
    generate_session_locally: false,
    enable_session_cache: true,
  });

  return _pool[clientType];
}

// ─── Video ID extractor ───────────────────────────────────────────────────────
function extractVideoId(url) {
  try {
    const s = String(url);

    if (s.includes('youtu.be/')) {
      return s.split('youtu.be/')[1]?.split(/[?&/#]/)[0] || null;
    }

    const u = new URL(s);
    const v = u.searchParams.get('v');
    if (v && v.length === 11) return v;

    const p = u.pathname || '';
    if (p.includes('/shorts/') || p.includes('/embed/')) {
      const id = p.split('/').pop()?.split(/[?&/#]/)[0];
      return id && id.length === 11 ? id : null;
    }
  } catch {
    const m = String(url).match(/(?:v=|\/)([0-9A-Za-z_-]{11})/);
    return m ? m[1] : null;
  }
  return null;
}

// ─── Cipher/url resolver ──────────────────────────────────────────────────────
async function resolveFormatUrl(format, player, nsigCache) {
  // Direct URL present
  if (format?.url) return format.url;

  // youtubei.js may expose either camelCase or snake_case depending on version
  const signatureCipher = format?.signature_cipher || format?.signatureCipher;
  const cipher = format?.cipher;

  // If no cipher fields, nothing to do
  if (!signatureCipher && !cipher) return null;

  // Decipher via player if available. :contentReference[oaicite:7]{index=7}
  if (!player || typeof player.decipher !== 'function') return null;

  try {
    return await player.decipher(undefined, signatureCipher, cipher, nsigCache);
  } catch {
    return null;
  }
}

// ─── Format builder (muxed + audio-only) ──────────────────────────────────────
async function buildQualityOptions(yt, streamingData) {
  const videoQualities = [];
  const audioQualities = [];

  const seenHeights = new Set();
  const nsigCache = new Map();
  const player = yt?.session?.player;

  // youtubei.js versions vary: formats/adaptive_formats vs formats/adaptiveFormats
  const muxed = streamingData?.formats ?? [];
  const adaptive = streamingData?.adaptive_formats ?? streamingData?.adaptiveFormats ?? [];

  // Muxed (video + audio in one stream) — ready to download, no merge needed
  const muxedSorted = muxed
    .filter(f => f && f.has_video && f.has_audio && f.height)
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0));

  for (const f of muxedSorted) {
    const h = f.height;
    if (!h || seenHeights.has(h) || h < 144) continue;

    const url = await resolveFormatUrl(f, player, nsigCache);
    if (!url) continue;

    seenHeights.add(h);

    videoQualities.push({
      quality: `${h}p`,
      qualityNum: h,
      url,
      type: 'mp4',
      extension: 'mp4',
      filesize: f.content_length ? Number(f.content_length) : 'unknown',
      fps: f.fps ?? 30,
      hasAudio: true,
      hasVideo: true,
      isAudioOnly: false,
      needsMerge: false,
      bitrate: f.bitrate ?? 0,
      itag: f.itag,
    });
  }

  // Audio-only adaptive streams
  const audioOnlySorted = adaptive
    .filter(f => f && !f.has_video && f.has_audio)
    .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))
    .slice(0, 3);

  for (const f of audioOnlySorted) {
    const url = await resolveFormatUrl(f, player, nsigCache);
    if (!url) continue;

    const kbps = Math.round((f.bitrate ?? 128000) / 1000);
    const ext = f.mime_type?.includes('webm') ? 'webm' : 'm4a';

    audioQualities.push({
      quality: `${kbps}kbps Audio`,
      qualityNum: 0,
      url,
      type: ext,
      extension: ext,
      filesize: f.content_length ? Number(f.content_length) : 'unknown',
      hasAudio: true,
      hasVideo: false,
      isAudioOnly: true,
      needsMerge: false,
      bitrate: kbps,
      itag: f.itag,
    });
  }

  return { videoQualities, audioQualities };
}

// ─── Try one client, return null on soft failures ─────────────────────────────
async function tryClient(videoId, clientType) {
  console.log(`   → trying client: ${clientType}`);

  try {
    const yt = await getClient(clientType);

    // Correct usage: getInfo(target, options?) :contentReference[oaicite:8]{index=8}
    const info = await yt.getInfo(videoId, {
      client: clientType,
      po_token: ENV.PO_TOKEN,
    });

    // If playability says no, treat as soft fail and let other clients try.
    const ps = info?.playability_status;
    const status = ps?.status;
    const reason = ps?.reason || ps?.error_screen?.player_error_message_renderer?.reason?.simpleText;

    if (status && status !== 'OK') {
      console.warn(`   ✗ ${clientType}: playability=${status}${reason ? ` (${String(reason).slice(0, 120)})` : ''}`);
      return { softFail: true, status, reason, clientType };
    }

    const streamingData = info?.streaming_data || info?.streamingData;
    if (!streamingData) {
      console.warn(`   ✗ ${clientType}: no streaming_data`);
      return { softFail: true, status: 'NO_STREAMING_DATA', reason: 'No streaming data', clientType };
    }

    const { videoQualities, audioQualities } = await buildQualityOptions(yt, streamingData);

    if (videoQualities.length === 0 && audioQualities.length === 0) {
      console.warn(`   ✗ ${clientType}: 0 usable formats (urls may be ciphered + player/decipher unavailable)`);
      return { softFail: true, status: 'NO_USABLE_FORMATS', reason: 'No usable formats', clientType };
    }

    console.log(`   ✓ ${clientType}: ${videoQualities.length}v + ${audioQualities.length}a formats`);
    return { info, videoQualities, audioQualities, clientType };

  } catch (e) {
    const msg = String(e?.message ?? e);

    // Invalidate cached client on transient errors so it gets rebuilt
    const lower = msg.toLowerCase();
    const isSoft =
      msg.includes('429') ||
      lower.includes('timeout') ||
      lower.includes('fetch failed') ||
      lower.includes('ecconnreset') ||
      lower.includes('socket') ||
      lower.includes('temporarily');

    if (isSoft) delete _pool[clientType];

    console.warn(`   ✗ ${clientType} error: ${msg.slice(0, 160)}`);
    return { softFail: true, status: 'CLIENT_ERROR', reason: msg, clientType };
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────
async function fetchYouTubeData(url) {
  const videoId = extractVideoId(url);
  if (!videoId) throw new Error('Invalid YouTube URL');

  console.log(`🎬 [youtubei] Fetching: ${videoId}`);

  // Server-friendly client order
  const CLIENT_ORDER = ['IOS', 'TV_EMBEDDED', 'TV', 'WEB_EMBEDDED', 'ANDROID', 'WEB'];

  let best = null;
  let lastSoft = null;

  for (const clientType of CLIENT_ORDER) {
    const res = await tryClient(videoId, clientType);

    if (res && res.info) {
      best = res;
      break;
    }

    // keep the last soft fail for better error messages
    if (res?.softFail) lastSoft = res;
  }

  if (!best) {
    // Give a more accurate message based on playability when possible
    if (lastSoft?.status && lastSoft.status !== 'CLIENT_ERROR') {
      const msg =
        lastSoft.status === 'LOGIN_REQUIRED'
          ? 'Cannot access this video: sign-in required.'
          : lastSoft.status === 'UNPLAYABLE'
          ? 'Cannot access this video: unavailable in this region or restricted.'
          : lastSoft.status === 'CONTENT_CHECK_REQUIRED'
          ? 'Cannot access this video: content check required.'
          : `Cannot access this video: ${lastSoft.status}.`;

      throw new Error(`${msg}${lastSoft.reason ? ` (${String(lastSoft.reason).slice(0, 160)})` : ''}`);
    }

    throw new Error(
      'YouTube blocked all client types on this server IP or no decipherable formats were returned. ' +
      'If the video requires sign-in, run the service with authenticated cookies.'
    );
  }

  const { info, videoQualities, audioQualities, clientType: usedClient } = best;
  const details = info.basic_info || {};

  const qualityOptions = [
    ...videoQualities.sort((a, b) => b.qualityNum - a.qualityNum),
    ...audioQualities,
  ];

  const defaultQuality =
    videoQualities.find(q => q.qualityNum === 360) ||
    videoQualities[0] ||
    audioQualities[0];

  // Thumbnail shapes vary by version
  const thumbArr = Array.isArray(details.thumbnail)
    ? details.thumbnail
    : details.thumbnail?.thumbnails ?? [];

  const thumbnail =
    thumbArr?.[0]?.url ||
    `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;

  console.log(`✅ [youtubei] Done via ${usedClient}: "${details.title}" — ${qualityOptions.length} formats`);

  return {
    title: details.title || 'Unknown',
    thumbnail,
    duration: details.duration ?? 0,
    description: details.short_description || '',
    author: details.author || 'Unknown',
    viewCount: details.view_count ?? 0,

    formats: qualityOptions,
    allFormats: qualityOptions,
    videoFormats: videoQualities,
    audioFormats: audioQualities,

    url: defaultQuality?.url,
    selectedQuality: defaultQuality,

    videoId,
    isShorts: String(url).includes('/shorts/'),

    metadata: {
      videoId,
      author: details.author || 'Unknown',
    },

    _debug: {
      usedClient,
      location: ENV.LOCATION,
      hasCookie: Boolean(ENV.COOKIE),
      hasPoToken: Boolean(ENV.PO_TOKEN),
      totalMuxed: (info.streaming_data?.formats ?? info.streamingData?.formats ?? []).length,
      totalAdaptive: (info.streaming_data?.adaptive_formats ?? info.streamingData?.adaptiveFormats ?? []).length,
      videoQualities: videoQualities.length,
      audioQualities: audioQualities.length,
      defaultQuality: defaultQuality?.quality,
      playability: info.playability_status?.status,
      playabilityReason: info.playability_status?.reason,
    },
  };
}

module.exports = { fetchYouTubeData };
