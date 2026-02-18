
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const YTDLP_TIMEOUT = 35000; // 35 seconds
const MIN_VALID_URL_LENGTH = 100; // Real TikTok CDN URLs are 300-600+ chars

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * Strips tracking query params that can sometimes confuse yt-dlp
 * but keeps the core video URL intact.
 */
function cleanTikTokUrl(url) {
  try {
    const parsed = new URL(url);
    // Keep only the path — remove all query params
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return url.split('?')[0];
  }
}

/**
 * Validates that a URL looks like a real TikTok CDN video URL.
 * Bogus/placeholder URLs are typically <100 chars.
 */
function isValidVideoUrl(url) {
  if (!url || typeof url !== 'string') return false;
  if (url.length < MIN_VALID_URL_LENGTH) return false;
  // Must be a proper http URL
  if (!url.startsWith('http')) return false;
  return true;
}

/**
 * Safely extracts the first URL from either a string or array.
 */
function extractFirstUrl(value) {
  if (Array.isArray(value)) return value[0] || '';
  return value || '';
}

// ─────────────────────────────────────────────────────────────
// LAYER 1: yt-dlp (child process — already installed on Koyeb)
// ─────────────────────────────────────────────────────────────

async function downloadWithYtDlp(url) {
  console.log('🎯 TikTok [Layer 1 / yt-dlp]: Starting...');

  const cleanUrl = cleanTikTokUrl(url);
  console.log(`  Clean URL: ${cleanUrl}`);

  // We use --print to extract metadata without downloading the file.
  // Format: id|||title|||thumbnail|||direct_video_url|||duration
  const printTemplate = '%(id)s|||%(title)s|||%(thumbnail)s|||%(url)s|||%(duration)s';

  const cmd = [
    'yt-dlp',
    '--no-warnings',
    '--no-playlist',
    '--print', `"${printTemplate}"`,
    // Best watermark-free format
    '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
    // Spoof a browser user-agent to avoid bot detection
    '--user-agent', '"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"',
    '--extractor-args', '"tiktok:app_name=trill"',
    `"${cleanUrl}"`
  ].join(' ');

  let stdout;
  try {
    const result = await execAsync(cmd, {
      timeout: YTDLP_TIMEOUT,
      maxBuffer: 1024 * 1024 * 5 // 5MB buffer
    });
    stdout = result.stdout;
  } catch (execError) {
    // execAsync throws on non-zero exit code; extract the stderr message
    const msg = execError.stderr || execError.message || 'yt-dlp process failed';
    throw new Error(`yt-dlp exited with error: ${msg.substring(0, 300)}`);
  }

  // yt-dlp may print multiple lines; the --print output is the last meaningful one
  const lines = stdout.trim().split('\n').filter(Boolean);
  const printLine = lines.find(l => l.includes('|||')) || '';

  if (!printLine) {
    throw new Error('yt-dlp returned no parseable output line');
  }

  const parts = printLine.split('|||');
  if (parts.length < 4) {
    throw new Error(`yt-dlp output format unexpected: "${printLine.substring(0, 200)}"`);
  }

  const [id, title, thumbnail, videoUrl, duration] = parts;

  if (!isValidVideoUrl(videoUrl)) {
    throw new Error(
      `yt-dlp returned an invalid/short video URL (${videoUrl?.length || 0} chars). ` +
      `URL: ${videoUrl?.substring(0, 80)}`
    );
  }

  console.log(`✅ TikTok [Layer 1 / yt-dlp]: Success — title: "${title}", URL length: ${videoUrl.length}`);

  return {
    title: title || 'TikTok Video',
    video: [videoUrl],
    thumbnail: thumbnail || '',
    audio: [],
    duration: duration || 'unknown',
    _source: 'yt-dlp'
  };
}

// ─────────────────────────────────────────────────────────────
// LAYER 2: @tobyg74/tiktok-api-dl
// Uses TikTok's own mobile API directly — no intermediate server
// Install: npm install @tobyg74/tiktok-api-dl
// ─────────────────────────────────────────────────────────────

async function downloadWithTobyApi(url) {
  console.log('🎯 TikTok [Layer 2 / tobyg74]: Starting...');

  let TikTokDl;
  try {
    TikTokDl = require('@tobyg74/tiktok-api-dl');
  } catch (e) {
    throw new Error(
      '@tobyg74/tiktok-api-dl is not installed. Run: npm install @tobyg74/tiktok-api-dl'
    );
  }

  let result;
  try {
    // v3 uses the mobile API and is the most stable version
    result = await TikTokDl.Downloader(url, {
      version: 'v3',
      showOriginalResponse: false
    });
  } catch (e) {
    throw new Error(`tobyg74 API threw: ${e.message}`);
  }

  if (!result || result.status !== 'success') {
    throw new Error(
      `tobyg74 API returned non-success status: "${result?.status}". ` +
      `Message: ${result?.message || 'none'}`
    );
  }

  const videoData = result.result;
  if (!videoData) {
    throw new Error('tobyg74 API returned success but result is empty');
  }

  // The package may return video as string or array depending on version
  const rawVideo = videoData.video || videoData.play || videoData.hdplay;
  const videoUrl = extractFirstUrl(rawVideo);

  if (!isValidVideoUrl(videoUrl)) {
    throw new Error(
      `tobyg74 returned invalid/short video URL (${videoUrl?.length || 0} chars)`
    );
  }

  const rawAudio = videoData.music || videoData.music_info?.play || '';
  const audioUrl = extractFirstUrl(rawAudio);

  console.log(`✅ TikTok [Layer 2 / tobyg74]: Success — title: "${videoData.title}", URL length: ${videoUrl.length}`);

  return {
    title: videoData.title || 'TikTok Video',
    video: [videoUrl],
    thumbnail: videoData.cover || videoData.origin_cover || '',
    audio: audioUrl ? [audioUrl] : [],
    duration: videoData.duration ? String(videoData.duration) : 'unknown',
    _source: 'tobyg74'
  };
}

// ─────────────────────────────────────────────────────────────
// LAYER 3: btch-downloader (original — kept as last resort)
// Calls a hosted third-party API; prone to 502 when that server is down
// ─────────────────────────────────────────────────────────────

async function downloadWithBtch(url) {
  console.log('🎯 TikTok [Layer 3 / btch-downloader]: Starting...');

  const { ttdl } = require('btch-downloader');

  let data;
  try {
    data = await ttdl(url);
  } catch (e) {
    throw new Error(`btch-downloader ttdl threw: ${e.message}`);
  }

  if (!data || !data.video) {
    throw new Error('btch-downloader returned null or missing video field');
  }

  const videoUrl = extractFirstUrl(data.video);

  // ⚠️ Critical guard — btch sometimes returns a 62-char bogus URL on success
  if (!isValidVideoUrl(videoUrl)) {
    throw new Error(
      `btch-downloader returned a suspiciously short/invalid URL ` +
      `(${videoUrl?.length || 0} chars). This is a known issue when the ` +
      `upstream API is degraded. URL: "${videoUrl?.substring(0, 80)}"`
    );
  }

  console.log(`✅ TikTok [Layer 3 / btch-downloader]: Success — URL length: ${videoUrl.length}`);

  return {
    title: data.title || 'TikTok Video',
    video: Array.isArray(data.video) ? data.video : [data.video],
    thumbnail: data.thumbnail || '',
    audio: data.audio
      ? (Array.isArray(data.audio) ? data.audio : [data.audio])
      : [],
    duration: 'unknown',
    _source: 'btch-downloader'
  };
}

// ─────────────────────────────────────────────────────────────
// MAIN EXPORT — tries all layers in order, returns first success
// ─────────────────────────────────────────────────────────────

async function robustTikTokDownload(url) {
  console.log(`\n🚀 TikTok: Starting robust download for URL: ${url}`);

  const layers = [
    { name: 'yt-dlp',              fn: () => downloadWithYtDlp(url)   },
    { name: '@tobyg74/tiktok-api-dl', fn: () => downloadWithTobyApi(url) },
    { name: 'btch-downloader',     fn: () => downloadWithBtch(url)    },
  ];

  const errors = [];

  for (const layer of layers) {
    try {
      const result = await layer.fn();

      // Double-check the result before returning
      const finalUrl = extractFirstUrl(result.video);
      if (!isValidVideoUrl(finalUrl)) {
        throw new Error(
          `Post-validation failed: URL returned by ${layer.name} is still invalid ` +
          `(${finalUrl?.length || 0} chars)`
        );
      }

      console.log(`\n🎉 TikTok: Download succeeded via [${layer.name}]`);
      console.log(`   Title    : ${result.title}`);
      console.log(`   URL len  : ${finalUrl.length}`);
      console.log(`   Has audio: ${result.audio?.length > 0}`);
      return result;

    } catch (err) {
      console.warn(`⚠️  TikTok [${layer.name}] FAILED: ${err.message}`);
      errors.push(`[${layer.name}]: ${err.message}`);
    }
  }

  // All layers failed
  const fullError = `TikTok download failed across all 3 services:\n${errors.join('\n')}`;
  console.error(`\n❌ ${fullError}`);
  throw new Error(fullError);
}

module.exports = { robustTikTokDownload };
