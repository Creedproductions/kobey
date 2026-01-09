const { spawn } = require('child_process');
console.log("🍪 Cookies path:", process.env.YTDLP_COOKIES);
function runYtDlp(args, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let out = '';
    let err = '';

    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new Error('Request timeout'));
    }, timeoutMs);

    p.stdout.on('data', d => (out += d.toString('utf8')));
    p.stderr.on('data', d => (err += d.toString('utf8')));

    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });

    p.on('close', code => {
      clearTimeout(timer);
      if (code === 0) return resolve({ stdout: out, stderr: err });
      reject(new Error(err.trim() || `yt-dlp exited with code ${code}`));
    });
  });
}

class YouTubeDownloader {
  constructor() {
    this.maxBuffer = 50 * 1024 * 1024; // kept for compatibility, not used by spawn
  }

  extractYouTubeId(url) {
    try {
      if (url.includes('youtu.be/')) {
        return url.split('youtu.be/')[1]?.split(/[?&/#]/)[0];
      }

      const urlObj = new URL(url);
      let videoId = urlObj.searchParams.get('v');
      if (videoId && videoId.length === 11) return videoId;

      const pathname = urlObj.pathname;
      if (pathname.includes('/shorts/') || pathname.includes('/embed/')) {
        return pathname.split('/').pop()?.split(/[?&/#]/)[0];
      }

      return null;
    } catch {
      const regex = /(?:v=|\/)([0-9A-Za-z_-]{11})/;
      const match = String(url).match(regex);
      return match ? match[1] : null;
    }
  }

  async fetchYouTubeData(url) {
    const videoId = this.extractYouTubeId(url);
    if (!videoId) {
      throw new Error('Invalid YouTube URL');
    }

    console.log(`🎬 Processing YouTube video: ${videoId}`);

    try {
      const args = [
        '--dump-json',
        '--no-playlist',
        '--no-warnings',

        // retry/network hardening
        '--socket-timeout', '15',
        '--retries', '2',
        '--extractor-retries', '2',

        // IMPORTANT: try alternate YouTube clients (helps on server sometimes)
        '--extractor-args', 'youtube:player_client=android,web,mweb',

        // Reduce bot triggers (doesn't require cookies)
        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
        '--add-header', 'Accept-Language:en-US,en;q=0.9',
        '--add-header', 'DNT:1',
        '--add-header', 'Connection:keep-alive',
      ];

      // OPTIONAL: proxy support (set env YTDLP_PROXY)
      if (process.env.YTDLP_PROXY) {
        args.push('--proxy', process.env.YTDLP_PROXY);
      }

      // OPTIONAL: cookies support (set env YTDLP_COOKIES to a file path)
      // If you cannot use cookies at all, leave this unset.
      if (process.env.YTDLP_COOKIES) {
        args.push('--cookies', process.env.YTDLP_COOKIES);
      }

      args.push(url);

      const { stdout } = await runYtDlp(args, { timeoutMs: 30000 });

      const info = JSON.parse(stdout);
      const allFormats = info.formats || [];

      console.log(`📊 Found ${allFormats.length} total formats`);

      // VIDEO FORMATS: Must have BOTH video AND audio
      const videoWithAudio = allFormats.filter(f =>
        f.vcodec && f.vcodec !== 'none' &&
        f.acodec && f.acodec !== 'none' &&
        f.height &&
        f.url &&
        !f.is_live
      );

      // AUDIO FORMATS: Audio only, NO video
      const audioOnly = allFormats.filter(f =>
        (!f.vcodec || f.vcodec === 'none') &&
        f.acodec && f.acodec !== 'none' &&
        f.url &&
        !f.is_live
      );

      console.log(`🎥 Video+Audio formats: ${videoWithAudio.length}`);
      console.log(`🎵 Audio-only formats: ${audioOnly.length}`);

      // BUILD VIDEO QUALITY OPTIONS (NO AUDIO MIXED IN)
      const videoQualities = [];
      const uniqueHeights = new Set();

      videoWithAudio
        .sort((a, b) => (b.height || 0) - (a.height || 0))
        .forEach(format => {
          const height = format.height;

          // Skip duplicates and very low quality
          if (uniqueHeights.has(height) || height < 144) return;
          uniqueHeights.add(height);

          videoQualities.push({
            quality: `${height}p`,
            qualityNum: height,
            url: format.url,
            type: format.ext || 'mp4',
            extension: format.ext || 'mp4',
            filesize: format.filesize || format.filesize_approx || 'unknown',
            fps: format.fps || 30,
            hasAudio: true,
            hasVideo: true,
            isAudioOnly: false,
            isPremium: height > 360,
            needsMerge: false,
            bitrate: format.tbr || format.vbr || 0,
          });
        });

      // BUILD AUDIO QUALITY OPTIONS (SEPARATE)
      const audioQualities = [];

      audioOnly
        .sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0))
        .slice(0, 3)
        .forEach(format => {
          const bitrate = Math.round(format.abr || format.tbr || 128);

          audioQualities.push({
            quality: `${bitrate}kbps Audio`,
            qualityNum: 0,
            url: format.url,
            type: format.ext || 'm4a',
            extension: format.ext || 'm4a',
            filesize: format.filesize || format.filesize_approx || 'unknown',
            hasAudio: true,
            hasVideo: false,
            isAudioOnly: true,
            isPremium: bitrate > 128,
            needsMerge: false,
            bitrate: bitrate,
          });
        });

      // COMBINE: Videos first (descending), then Audio
      const qualityOptions = [
        ...videoQualities.sort((a, b) => b.qualityNum - a.qualityNum),
        ...audioQualities
      ];

      console.log(`✅ Video qualities: ${videoQualities.length}, Audio qualities: ${audioQualities.length}`);
      console.log(`✅ Total quality options: ${qualityOptions.length}`);

      // Select default: 360p video (mobile-friendly)
      const defaultQuality = videoQualities.find(q => q.qualityNum === 360)
        || videoQualities[0]
        || qualityOptions[0];

      console.log(`🎯 Default quality: ${defaultQuality?.quality || 'None'}`);

      if (!defaultQuality || qualityOptions.length === 0) {
        throw new Error('No download formats available');
      }

      return {
        title: info.title || 'Unknown',
        thumbnail: info.thumbnail || `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
        duration: parseInt(info.duration) || 0,
        description: info.description || '',
        author: info.uploader || info.channel || 'Unknown',
        viewCount: parseInt(info.view_count) || 0,

        formats: qualityOptions,
        allFormats: qualityOptions,

        videoFormats: videoQualities,
        audioFormats: audioQualities,

        url: defaultQuality.url,
        selectedQuality: defaultQuality,

        videoId: videoId,
        isShorts: url.includes('/shorts/'),

        metadata: {
          videoId: videoId,
          author: info.uploader || 'Unknown',
          uploadDate: info.upload_date || null,
          category: info.categories?.[0] || null,
        },

        _debug: {
          totalFormats: allFormats.length,
          videoWithAudio: videoWithAudio.length,
          audioOnly: audioOnly.length,
          videoQualities: videoQualities.length,
          audioQualities: audioQualities.length,
          defaultQuality: defaultQuality.quality,
        }
      };

    } catch (err) {
      console.error('❌ YouTube fetch error:', err.message);

      // More precise messaging for your server issue
      if (String(err.message).includes("Sign in to confirm you’re not a bot")) {
        throw new Error(
          "YouTube blocked this server IP as suspicious. Try setting YTDLP_PROXY (residential egress). Cookies also work if available."
        );
      }

      if (err.message.includes('ERROR: Video unavailable')) {
        throw new Error('Video not found or has been removed');
      }
      if (err.message.includes('Private video')) {
        throw new Error('Video is private or age-restricted');
      }
      if (err.message.includes('Request timeout')) {
        throw new Error('Request timeout');
      }

      throw new Error(`YouTube download failed: ${err.message}`);
    }
  }
}

const youtubeDownloader = new YouTubeDownloader();

async function fetchYouTubeData(url) {
  return youtubeDownloader.fetchYouTubeData(url);
}

module.exports = {
  fetchYouTubeData,
  YouTubeDownloader,
};
