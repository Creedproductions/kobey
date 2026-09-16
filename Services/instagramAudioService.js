const { execFile } = require('child_process');

const FFPROBE_BIN = process.env.FFPROBE_BIN || 'ffprobe';
const IG_HEADERS =
  'Referer: https://www.instagram.com/\r\n' +
  'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36\r\n';

function isVideoItem(item) {
  if (!item) return false;
  const type = String(item.type || '').toLowerCase();
  if (type === 'image') return false;
  if (type === 'video') return true;
  const url = String(item.url || item.download || '');
  return /(?:\.mp4(?:[?#]|$)|\/t50\.|\/o1\/v\/|\/t16\/)/i.test(url);
}

function hasVerifiedAudio(item) {
  return item?.hasAudio === true ||
    item?.audioVerified === true ||
    !!(item?.audioUrl || item?.mergeAudioUrl);
}

function probeHasAudio(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    if (!/^https?:\/\//i.test(String(url || ''))) {
      return reject(new Error('audio probe: invalid media URL'));
    }

    const args = [
      '-v', 'error',
      '-headers', IG_HEADERS,
      '-rw_timeout', String(Math.max(1000, timeoutMs - 1000) * 1000),
      '-select_streams', 'a:0',
      '-show_entries', 'stream=codec_type',
      '-of', 'csv=p=0',
      url,
    ];

    execFile(FFPROBE_BIN, args, {
      timeout: timeoutMs,
      maxBuffer: 256 * 1024,
      killSignal: 'SIGKILL',
    }, (error, stdout, stderr) => {
      if (error && error.code === 'ENOENT') {
        return reject(new Error('audio probe: ffprobe is not installed'));
      }
      if (error && !stdout) {
        const detail = String(stderr || error.message || '').trim().split('\n').pop();
        return reject(new Error(`audio probe failed: ${detail || 'unknown ffprobe error'}`));
      }
      resolve(/\baudio\b/i.test(String(stdout || '')));
    });
  });
}

async function requireAudioForInstagramVideos(items, opts = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Instagram audio validation: no media items');
  }

  const probe = opts.probe || probeHasAudio;
  return Promise.all(items.map(async (item) => {
    if (!isVideoItem(item) || hasVerifiedAudio(item)) return item;

    const url = item.url || item.download || '';
    const hasAudio = await probe(url, opts.timeoutMs || 8000);
    if (!hasAudio) {
      throw new Error('Instagram extractor returned a video-only stream (audio track missing)');
    }
    return { ...item, hasAudio: true, audioVerified: true };
  }));
}

module.exports = {
  isVideoItem,
  hasVerifiedAudio,
  probeHasAudio,
  requireAudioForInstagramVideos,
};
