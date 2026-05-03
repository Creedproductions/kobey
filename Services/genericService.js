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

const fs = require('fs');
const { execFile } = require('child_process');

const YT_DLP_CANDIDATES = [
  process.env.YT_DLP_BIN,
  '/opt/yt/bin/yt-dlp',
  '/usr/local/bin/yt-dlp',
  '/usr/bin/yt-dlp',
].filter(Boolean);

let RESOLVED_BIN = null;
function resolveBin() {
  if (RESOLVED_BIN !== null) return RESOLVED_BIN;
  for (const p of YT_DLP_CANDIDATES) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      RESOLVED_BIN = p;
      console.log(`[generic] yt-dlp resolved at ${p}`);
      return p;
    } catch (_) { /* try next */ }
  }
  RESOLVED_BIN = 'yt-dlp';
  console.warn('[generic] yt-dlp not found at any absolute path; falling back to PATH lookup');
  return RESOLVED_BIN;
}

// ─── Core wrapper ────────────────────────────────────────────────────────────

function runYtDlp(url, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const bin = resolveBin();
    const args = [
      '-f', 'best[height<=?1080]/best',
      '--no-playlist',
      '--no-warnings',
      '--no-check-certificate',
      '--geo-bypass',
      '--socket-timeout', '15',
      '--dump-json',
      ...extraArgs,
      url,
    ];

    execFile(bin, args, {
      timeout: 50000,
      maxBuffer: 25 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message || '').slice(0, 250).trim();
        return reject(new Error(`yt-dlp: ${msg || 'spawn failed'}`));
      }
      try {
        // yt-dlp prints one JSON object per video. For playlists/multi-video
        // pages we'd see multiple — pick the first valid object.
        const firstLine =
          stdout.split('\n').find(l => l.trim().startsWith('{')) || stdout;
        const info = JSON.parse(firstLine);
        resolve(info);
      } catch (parseErr) {
        reject(new Error(`yt-dlp: parse error - ${parseErr.message}`));
      }
    });
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

async function downloadGeneric(url) {
  console.log(`🌐 Generic: extracting ${url}`);

  const info = await runYtDlp(url);
  const formats = normaliseFormats(info);
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
