// Services/genericService.js
//
// Generic yt-dlp wrapper. Handles every URL the dedicated platform services
// don't cover — reddit, vimeo, dailymotion, twitch, soundcloud, vk, rumble,
// bilibili, douyin, streamable, kick, odysee, and ~1700 other sites yt-dlp
// supports out of the box.
//
// Used as a fallback in downloaderController.downloadMedia() when
// identifyPlatform() returns null. Returns the same shape as the
// platform-specific services so the existing formatter pipeline can
// consume it without special-casing.

const ytdlp = require('./ytDlpRunner');

// Thin shim around the shared yt-dlp runner so legacy callers in this file
// keep their existing signature. All the heavy lifting (binary resolution,
// platform-aware flags, stderr surfacing) is centralised in ytDlpRunner.js.
function runYtDlp(url, extraArgs = []) {
  return ytdlp.run(url, {
    platform: 'generic',
    timeoutMs: 50000,
    extraArgs,
  });
}

// ─── Format normalisation ────────────────────────────────────────────────────
//
// Convert yt-dlp's heterogeneous formats array into the shape the existing
// downloaderController formatter expects. Audio-only and video-only streams
// are tagged so the client can pick the right one.

function normaliseFormats(info) {
  const formats = [];
  const seen = new Set();

  const push = (f) => {
    if (!f.url || typeof f.url !== 'string') return;
    const isAudioOnly = f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none');
    const isVideoOnly = f.vcodec && f.vcodec !== 'none' && (!f.acodec || f.acodec === 'none');
    const height = f.height || 0;
    const abr = f.abr ? Math.round(f.abr) : 0;
    const key = isAudioOnly ? `a:${abr}` : `v:${height}`;
    if (seen.has(key)) return;
    seen.add(key);
    formats.push({
      quality:    isAudioOnly ? `${abr || 128}kbps` : (height ? `${height}p` : 'Best Quality'),
      qualityNum: isAudioOnly ? (abr || 128) * 1000 : height,
      url:        f.url,
      type:       isAudioOnly ? 'audio/mp4' : 'video/mp4',
      extension:  f.ext || (isAudioOnly ? 'm4a' : 'mp4'),
      filesize:   f.filesize || f.filesize_approx || 'unknown',
      isPremium:  false,
      hasAudio:   !isVideoOnly,
      isVideoOnly,
      isAudioOnly,
      streamType: isAudioOnly ? 'audioOnly' : (isVideoOnly ? 'videoOnly' : 'muxed'),
    });
  };

  // Top-level URL (best muxed stream chosen by `-f`).
  if (info.url && (!info.formats || info.formats.length === 0)) {
    push({
      url:    info.url,
      vcodec: info.vcodec || 'h264',
      acodec: info.acodec || 'aac',
      height: info.height,
      ext:    info.ext,
    });
  }

  // Full formats array if present.
  if (Array.isArray(info.formats)) {
    for (const f of info.formats) push(f);
  }

  // Sort: muxed first by height ascending, then audio-only by bitrate.
  formats.sort((a, b) => {
    if (a.isAudioOnly !== b.isAudioOnly) return a.isAudioOnly ? 1 : -1;
    return a.qualityNum - b.qualityNum;
  });

  return formats;
}

// ─── Public entry ────────────────────────────────────────────────────────────

const { isAgeRestricted } = require('./errorClassifier');

async function downloadGeneric(url) {
  console.log(`🌐 Generic: extracting ${url}`);

  let info;
  try {
    info = await runYtDlp(url);
  } catch (e) {
    // ── Age-gate recovery ────────────────────────────────────────────────
    // YouTube (and some embeds) age-gate videos behind "Sign in to confirm
    // your age". The embedded/TV player clients historically skip the gate
    // for videos that allow embedding, so one retry with those clients is
    // cheap and recovers a real slice of age-restricted links. If a
    // cookies file is configured (YT_DLP_COOKIES_FILE) the runner already
    // sends it on every call — this retry is for the no-cookie case.
    if (isAgeRestricted(e)) {
      console.log('🌐 Generic: age-gate detected → retrying with embedded player clients');
      try {
        info = await runYtDlp(url, [
          '--extractor-args', 'youtube:player_client=web_embedded,tv_embedded,mediaconnect',
        ]);
        console.log('🌐 Generic: ✅ age-gate bypassed via embedded client');
      } catch (e2) {
        console.warn(`🌐 Generic: embedded-client retry also failed: ${String(e2.message).slice(0, 120)}`);
        throw e; // surface the ORIGINAL age-restriction error for clean classification
      }
    } else {
      throw e;
    }
  }

  let formats = normaliseFormats(info);

  // ── Format-selection fallback ──────────────────────────────────────────
  // Some extractors return an info object where the pre-selected `-f` pick
  // failed but a re-run with the permissive selector succeeds (sites that
  // only expose HLS/DASH manifests, or whose "best" is video-only). One
  // retry with `-f b*/b` before giving up.
  if (!formats.length) {
    console.log('🌐 Generic: 0 formats from default selector → retrying with permissive -f');
    try {
      info = await runYtDlp(url, ['-f', 'b*/bv*+ba/b']);
      formats = normaliseFormats(info);
    } catch (_) { /* fall through to the clean error below */ }
  }

  if (!formats.length) {
    throw new Error('Generic: no usable formats extracted');
  }

  // Pick the highest-quality muxed format as the default download URL.
  const muxed = formats.filter(f => !f.isAudioOnly && !f.isVideoOnly);
  const def = muxed[muxed.length - 1] || formats[formats.length - 1];

  const extractor = info.extractor_key || info.extractor || 'generic';

  console.log(
    `🌐 Generic: ✅ extractor=${extractor} formats=${formats.length} ` +
    `default=${def.quality}`
  );

  return {
    success:  true,
    platform: extractor.toLowerCase(),
    title:    info.title || info.fulltitle || 'Media',
    thumbnail: info.thumbnail || null,
    duration: info.duration || 0,
    uploader: info.uploader || info.channel || '',
    url:      def.url,
    formats,
    allFormats: formats,
    selectedQuality: def,
    extractor,
  };
}

module.exports = { downloadGeneric };
