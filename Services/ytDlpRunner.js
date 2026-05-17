// Services/ytDlpRunner.js
//
// Shared yt-dlp runner with per-platform tuning. Built so every platform
// service (facebook, instagram, twitter, tiktok, generic) can call into the
// same well-vetted subprocess wrapper instead of each service hand-rolling
// its own execFile + flag set.
//
// Why this exists
// ---------------
// In 2026 yt-dlp is the single most reliable scraper for every platform we
// support. It gets monthly extractor updates, handles edge cases (DASH,
// HLS, watermark stripping, GraphQL fallbacks) the third-party mirrors
// quietly broke on, and ships with sensible defaults for FB/IG/TT/X. The
// downside is that every platform needs slightly different flags — FB wants
// a desktop UA and en_US locale, TikTok wants no-watermark sorting, X needs
// guest-token rotation. Centralising the invocation lets us tune those
// flags in one place.
//
// Public API
// ----------
//   const runner = require('./ytDlpRunner');
//   runner.isAvailable                       → boolean
//   runner.getBin()                          → string | null
//   await runner.run(url, opts)              → yt-dlp info JSON
//   runner.formatVideoInfo(info)             → { hd, sd, thumbnail, title }
//
// `opts`:
//   - platform:   'facebook' | 'instagram' | 'twitter' | 'tiktok' | 'generic'
//   - timeoutMs:  per-call subprocess timeout (default 28000)
//   - extraArgs:  extra CLI args appended after the platform defaults
//   - format:     yt-dlp format selector (default 'best[height<=?1080]/best')
//
// Errors are normalised — the rejected Error always starts with the prefix
// `yt-dlp(${platform}):` and includes the last 3 lines of stderr (clipped).
// This makes log greps and error dedup actually work.

const fs                 = require('fs');
const { execFile, execSync } = require('child_process');

// ─── Binary resolution ───────────────────────────────────────────────────────

const YT_DLP_CANDIDATES = [
  process.env.YT_DLP_BIN,
  '/opt/yt/bin/yt-dlp',
  '/usr/local/bin/yt-dlp',
  '/usr/bin/yt-dlp',
].filter(Boolean);

let _resolvedBin    = null;
let _resolveAttempted = false;

function _resolveYtDlp() {
  if (_resolveAttempted) return _resolvedBin;
  _resolveAttempted = true;
  for (const p of YT_DLP_CANDIDATES) {
    try { fs.accessSync(p, fs.constants.X_OK); _resolvedBin = p; return p; } catch (_) {}
  }
  try {
    const which = execSync('which yt-dlp', { encoding: 'utf8', timeout: 2000 }).trim();
    if (which && which.startsWith('/')) {
      try { fs.accessSync(which, fs.constants.X_OK); _resolvedBin = which; return which; } catch (_) {}
    }
  } catch (_) { /* not on PATH */ }
  _resolvedBin = null;
  return null;
}

const _bin = _resolveYtDlp();
const isAvailable = !!_bin;
console.log(`[yt-dlp-runner] ${isAvailable ? `✅ ${_bin}` : '⚠️ not installed'}`);

function getBin() { return _resolvedBin; }

// ─── Shared user agents (browser + bot) ──────────────────────────────────────

const UA_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const UA_MOBILE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

// ─── Per-platform flag profiles ──────────────────────────────────────────────
//
// Each profile is the list of CLI flags appended AFTER the shared defaults.
// Notes per platform are inline so future maintainers know why each flag is
// there (yt-dlp default behaviour has changed several times in 2025-2026).

function _profileFor(platform) {
  switch (platform) {
    // Facebook — public reels and /<user>/videos/<id>/ posts work without
    // cookies as long as we send a believable desktop UA + Accept-Language.
    // The default yt-dlp UA triggers FB's bot path which serves a stripped
    // HTML with no playable_url. en_US locale forces consistent JSON keys.
    case 'facebook':
      return [
        '--user-agent', UA_DESKTOP,
        '--add-header', 'Accept-Language:en-US,en;q=0.9',
        '--extractor-args', 'facebook:locale=en_US',
        '--socket-timeout', '12',
        '--retries', '2',
      ];

    // Instagram — yt-dlp's IG extractor needs cookies for stories and most
    // private content, but public reels and posts work without auth as long
    // as we mimic the iOS app's request signature. The --no-warnings flag
    // is already in the shared defaults; here we pin the locale and ramp
    // retries because IG's edge often 503s mid-extract.
    case 'instagram':
      return [
        '--user-agent', UA_MOBILE,
        '--add-header', 'Accept-Language:en-US,en;q=0.9',
        '--add-header', 'X-IG-App-ID:936619743392459',
        '--extractor-args', 'instagram:include_image=true',
        '--socket-timeout', '12',
        '--retries', '3',
      ];

    // X / Twitter — login is now required for many tweets in 2026 (yt-dlp
    // upstream issue #12291). Without cookies we can still get public tweets
    // by relying on the syndication fallback yt-dlp uses internally. The
    // guest-token rotation is automatic.
    case 'twitter':
    case 'x':
      return [
        '--user-agent', UA_DESKTOP,
        '--add-header', 'Accept-Language:en-US,en;q=0.9',
        // yt-dlp's twitter extractor tries the GraphQL → syndication →
        // legacy API chain in that order. api=syndication forces the
        // public no-auth path which is the only one that works without
        // cookies in 2026.
        '--extractor-args', 'twitter:api=syndication',
        '--socket-timeout', '12',
        '--retries', '2',
      ];

    // TikTok — yt-dlp returns the watermark-free MP4 directly from
    // TikTok's CDN. No cookies needed. The extractor handles short URLs
    // (vm.tiktok.com, vt.tiktok.com) natively but we still resolve them
    // upstream so error messages reference the canonical URL.
    case 'tiktok':
      return [
        '--user-agent', UA_DESKTOP,
        '--add-header', 'Accept-Language:en-US,en;q=0.9',
        // The mobile API path returns the unwatermarked MP4 plus author
        // metadata. Default web API sometimes only has the watermarked
        // version for newer posts.
        '--extractor-args', 'tiktok:api_hostname=api22-normal-c-useast2a.tiktokv.com',
        '--socket-timeout', '10',
        '--retries', '2',
      ];

    // Generic — minimal flags. Used for everything else yt-dlp supports
    // (~1700 sites): reddit, vimeo, dailymotion, twitch, soundcloud, etc.
    case 'generic':
    default:
      return [
        '--user-agent', UA_DESKTOP,
        '--socket-timeout', '15',
        '--retries', '2',
      ];
  }
}

// ─── Subprocess runner ───────────────────────────────────────────────────────

/**
 * Run yt-dlp against `url` with platform-aware flags. Returns a Promise that
 * resolves with the parsed JSON info object or rejects with a normalised
 * Error whose message includes the last few stderr lines.
 *
 * @param {string} url
 * @param {{platform?: string, timeoutMs?: number, extraArgs?: string[], format?: string}} opts
 * @returns {Promise<object>}
 */
function run(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const bin = _resolveYtDlp();
    if (!bin) return reject(new Error(`yt-dlp(${opts.platform || 'generic'}): binary not installed`));

    const platform   = opts.platform   || 'generic';
    const timeoutMs  = opts.timeoutMs  || 28000;
    const format     = opts.format     || 'best[height<=?1080]/best';
    const extraArgs  = Array.isArray(opts.extraArgs) ? opts.extraArgs : [];

    // Optional cookies file. Some platforms (IG stories, NSFW tweets,
    // private FB content) only work with a valid session cookie. The
    // operator sets this once via env; if absent we skip and rely on the
    // public extraction paths.
    const cookiePath = String(process.env.YT_DLP_COOKIES_FILE || '').trim();
    const cookieArgs = cookiePath ? ['--cookies', cookiePath] : [];

    const args = [
      '-f', format,
      '--no-playlist',
      '--no-warnings',
      '--no-check-certificate',
      '--geo-bypass',
      '--ignore-config',
      ..._profileFor(platform),
      ...cookieArgs,
      ...extraArgs,
      '--dump-json',
      url,
    ];

    execFile(bin, args, {
      timeout: timeoutMs,
      maxBuffer: 25 * 1024 * 1024,
      killSignal: 'SIGKILL',
    }, (err, stdout, stderr) => {
      if (err) {
        // Surface the actual yt-dlp error rather than the boilerplate
        // "Command failed: …" line that node prepends. We keep the last
        // three meaningful lines of stderr because that's where the real
        // diagnostic (e.g. "Unable to extract video info") lives.
        const raw = (stderr || err.message || '').trim();
        const cleaned = raw
          .replace(/^Command failed:[\s\S]*?\n/, '')
          .replace(/\bWARNING:\s+/g, '')
          .split('\n')
          .filter(l => l.trim())
          .slice(-3)
          .join(' | ')
          .slice(0, 400);
        return reject(new Error(`yt-dlp(${platform}): ${cleaned || 'spawn failed'}`));
      }
      try {
        // yt-dlp prints one JSON object per video. For playlists or
        // multi-video pages there can be several — pick the first.
        const firstLine = stdout.split('\n').find(l => l.trim().startsWith('{')) || stdout;
        resolve(JSON.parse(firstLine));
      } catch (e) {
        reject(new Error(`yt-dlp(${platform}): parse error - ${e.message}`));
      }
    });
  });
}

// ─── Helpers: shape conversion ───────────────────────────────────────────────
//
// Different consumers want different shapes. `formatVideoInfo` produces the
// {hd, sd, thumbnail, title} shape Facebook expects; `formatTikTokInfo`
// produces the {video[], audio[], images[], title, thumbnail} shape TikTok
// expects; etc. These are small enough to share rather than duplicate.

/**
 * Pick HD + SD muxed URLs out of a yt-dlp info object.
 * Returns `{ hd, sd, thumbnail, title }`. `hd` may be empty if only one
 * usable format was returned.
 */
function formatVideoInfo(info) {
  if (!info) return { hd: '', sd: '', thumbnail: '', title: '' };

  let hd = '', sd = '';
  const formats = Array.isArray(info.formats) ? info.formats : [];

  // Prefer muxed formats (video + audio in one stream). Sort by height desc.
  const muxed = formats
    .filter(f => f.url && typeof f.url === 'string'
              && (f.vcodec ? f.vcodec !== 'none' : true)
              && (f.acodec ? f.acodec !== 'none' : true))
    .sort((a, b) => (b.height || 0) - (a.height || 0));

  if (muxed.length > 0) {
    hd = muxed[0].url;
    if (muxed.length > 1) sd = muxed[muxed.length - 1].url;
  } else if (info.url && typeof info.url === 'string') {
    sd = info.url;
  }

  return {
    hd, sd,
    thumbnail: info.thumbnail || info.thumbnails?.[0]?.url || '',
    title:     info.title || info.fulltitle || 'Video',
  };
}

/**
 * Pick highest-quality MP4 variants for Twitter/X. Returns an array of
 * `{ quality, type, url }` matching twitterService's existing output shape.
 */
function formatTwitterVariants(info) {
  if (!info) return [];
  const formats = Array.isArray(info.formats) ? info.formats : [];
  const mp4s = formats
    .filter(f => f.url && typeof f.url === 'string' && /mp4/i.test(f.ext || f.protocol || ''))
    .sort((a, b) => (b.height || b.tbr || 0) - (a.height || a.tbr || 0));

  if (mp4s.length === 0 && info.url) {
    return [{
      quality: info.height ? `${info.height}p` : 'HD',
      type:    'video/mp4',
      url:     info.url,
    }];
  }

  return mp4s.map((f, i) => ({
    quality: f.height ? `${f.height}p` : (i === 0 ? 'HD' : 'SD'),
    type:    'video/mp4',
    url:     f.url,
  }));
}

/**
 * Convert a TikTok yt-dlp info object to the shape tikwm-style consumers
 * expect: `{ title, thumbnail, video[], audio[], images[] }`.
 */
function formatTikTokInfo(info) {
  if (!info) return { title: 'TikTok', thumbnail: '', video: [], audio: [] };

  const formats = Array.isArray(info.formats) ? info.formats : [];
  const video = [];
  const audio = [];

  for (const f of formats) {
    if (!f.url || typeof f.url !== 'string') continue;
    const isAudio = f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none');
    const isVideo = f.vcodec && f.vcodec !== 'none';
    if (isVideo && !video.includes(f.url)) video.push(f.url);
    if (isAudio && !audio.includes(f.url)) audio.push(f.url);
  }

  // Top-level URL fallback (single muxed stream) when formats[] is empty
  if (!video.length && info.url && typeof info.url === 'string') {
    video.push(info.url);
  }

  return {
    title:     info.title || info.description?.slice(0, 80) || 'TikTok Post',
    thumbnail: info.thumbnail || info.thumbnails?.[0]?.url || '',
    video,
    audio,
  };
}

/**
 * Instagram items in the format scrapeSnapsave / igdl produce:
 *   [{ url, thumbnail, type, quality }, …]
 */
function formatInstagramItems(info) {
  if (!info) return [];
  const items = [];

  const formats = Array.isArray(info.formats) ? info.formats : [];
  // Prefer muxed formats. yt-dlp's IG extractor returns one per quality.
  const muxed = formats
    .filter(f => f.url && typeof f.url === 'string')
    .sort((a, b) => (b.height || 0) - (a.height || 0));

  if (muxed.length > 0) {
    for (const f of muxed) {
      items.push({
        url:       f.url,
        thumbnail: info.thumbnail || '',
        type:      (f.vcodec && f.vcodec !== 'none') ? 'video' : 'image',
        quality:   f.height ? `${f.height}p` : 'Original Quality',
      });
    }
  } else if (info.url && typeof info.url === 'string') {
    items.push({
      url:       info.url,
      thumbnail: info.thumbnail || '',
      type:      'video',
      quality:   'Original Quality',
    });
  }

  return items;
}

module.exports = {
  isAvailable,
  getBin,
  run,
  formatVideoInfo,
  formatTwitterVariants,
  formatTikTokInfo,
  formatInstagramItems,
  // Exposed UAs so callers using axios can share the same fingerprint
  UA_DESKTOP,
  UA_MOBILE,
};
