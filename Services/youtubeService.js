const { spawn } = require('child_process');

class YouTubeDownloader {
  constructor() {
    this.ytDlpPath = process.env.YTDLP_BIN || 'yt-dlp';

    // Optional: mount/provide a cookies.txt file and set this env var
    // Example: YTDLP_COOKIES_FILE=/app/cookies.txt
    this.cookiesFile = process.env.YTDLP_COOKIES_FILE || '';

    // Optional: proxy when datacenter IP is blocked
    // Example: YTDLP_PROXY=http://user:pass@host:port
    this.proxy = process.env.YTDLP_PROXY || '';

    // Optional: set a realistic UA (sometimes helps a bit)
    this.userAgent =
        process.env.YTDLP_UA ||
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';
  }

  extractYouTubeId(url) {
    try {
      const urlObj = new URL(url);
      let videoId = urlObj.searchParams.get('v');
      if (videoId && videoId.length === 11) return videoId;

      const pathname = urlObj.pathname || '';

      // youtu.be/<id>
      if (pathname.startsWith('/AW') || pathname.includes('youtu.be/')) {
        // keep your original logic but more robust:
      }

      if (pathname.includes('youtu.be/')) {
        const id = pathname.split('youtu.be/')[1]?.split(/[?&/#]/)[0];
        if (id && id.length === 11) return id;
      }

      // /shorts/<id>
      if (pathname.includes('/shorts/')) {
        const id = pathname.split('/shorts/')[1]?.split(/[?&/#]/)[0];
        if (id && id.length === 11) return id;
      }

      // /embed/<id>
      if (pathname.includes('/embed/')) {
        const id = pathname.split('/embed/')[1]?.split(/[?&/#]/)[0];
        if (id && id.length === 11) return id;
      }

      // fallback regex
      const regexPatterns = [
        /(?:v=|\/)([0-9A-Za-z_-]{11})/,
        /youtu\.be\/([0-9A-Za-z_-]{11})/,
      ];

      for (const pattern of regexPatterns) {
        const match = String(url).match(pattern);
        if (match && match[1]) return match[1];
      }

      return null;
    } catch {
      return null;
    }
  }

  normalizeYouTubeUrl(url) {
    url = (url || '').trim();

    // Reject obvious non-video URLs early
    // (Homepage / channels / etc. might not contain a videoId)
    // We still normalize first where possible.
    if (url.includes('youtu.be/')) {
      const videoId = url.split('youtu.be/')[1]?.split(/[?&/#]/)[0];
      if (videoId) return `https://www.youtube.com/watch?v=${videoId}`;
    }

    // Replace mobile domain
    if (url.includes('m.youtube.com')) {
      url = url.replace('m.youtube.com', 'www.youtube.com');
    }

    // Convert shorts to watch
    if (url.includes('/shorts/')) {
      const id = url.split('/shorts/')[1]?.split(/[?&/#]/)[0];
      if (id && id.length === 11) return `https://www.youtube.com/watch?v=${id}`;
    }

    return url;
  }

  buildYtDlpArgs(normalizedUrl) {
    const args = [
      '--dump-json',
      '--no-warnings',
      '--no-playlist',

      // Stability knobs
      '--socket-timeout', '20',
      '--retries', '2',
      '--fragment-retries', '2',
      '--concurrent-fragments', '1',

      // Mimic browser a bit
      '--user-agent', this.userAgent,

      // Sometimes helps reduce region/age issues (not guaranteed)
      '--geo-bypass',
      '--geo-bypass-country', 'US',
    ];

    if (this.proxy) {
      args.push('--proxy', this.proxy);
      console.log('🌐 yt-dlp proxy enabled');
    }

    if (this.cookiesFile) {
      args.push('--cookies', this.cookiesFile);
      console.log('🍪 yt-dlp cookies enabled');
    }

    args.push(normalizedUrl);
    return args;
  }

  spawnJson(bin, args, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

      let out = '';
      let err = '';

      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
        reject(new Error(`yt-dlp timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      child.stdout.on('data', (d) => (out += d.toString('utf8')));
      child.stderr.on('data', (d) => (err += d.toString('utf8')));

      child.on('error', (e) => {
        clearTimeout(timer);
        reject(new Error(`yt-dlp spawn error: ${e.message}`));
      });

      child.on('close', (code) => {
        clearTimeout(timer);

        if (code !== 0) {
          // Important: classify bot-check clearly
          if (
              err.includes("Sign in to confirm you’re not a bot") ||
              err.includes("Sign in to confirm you're not a bot") ||
              err.toLowerCase().includes('cookies')
          ) {
            return reject(
                new Error(
                    'YouTube blocked the server (bot verification). Provide cookies (YTDLP_COOKIES_FILE) or use a proxy (YTDLP_PROXY).'
                )
            );
          }
          return reject(new Error(err || `yt-dlp exit code ${code}`));
        }

        try {
          resolve(JSON.parse(out));
        } catch {
          reject(new Error(`Invalid JSON from yt-dlp. stderr=${err}`));
        }
      });
    });
  }

  async fetchWithYtDlp(url) {
    const normalizedUrl = this.normalizeYouTubeUrl(url);
    const videoId = this.extractYouTubeId(normalizedUrl);

    if (!videoId) {
      throw new Error('Invalid YouTube URL (must contain a video id)');
    }

    console.log('🔧 Using yt-dlp to fetch video info...');
    const args = this.buildYtDlpArgs(normalizedUrl);
    const info = await this.spawnJson(this.ytDlpPath, args, 60000);

    console.log(`✅ yt-dlp succeeded: "${info.title}"`);
    console.log(`📊 Formats available: ${info.formats?.length || 0}`);

    return this.processYtDlpData(info);
  }

  processYtDlpData(data) {
    const formats = data.formats || [];

    const videoOnlyFormats = formats.filter(
        (f) =>
            f.vcodec && f.vcodec !== 'none' &&
            f.height &&
            (!f.acodec || f.acodec === 'none') &&
            f.url
    );

    const combinedFormats = formats.filter(
        (f) =>
            f.vcodec && f.vcodec !== 'none' &&
            f.acodec && f.acodec !== 'none' &&
            f.height &&
            f.url
    );

    const audioOnlyFormats = formats.filter(
        (f) =>
            f.acodec && f.acodec !== 'none' &&
            (!f.vcodec || f.vcodec === 'none') &&
            f.url
    );

    console.log(
        `📊 Video-only: ${videoOnlyFormats.length}, Combined: ${combinedFormats.length}, Audio-only: ${audioOnlyFormats.length}`
    );

    const bestAudio = audioOnlyFormats.sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];

    const qualityOptions = [];

    // Combined (no merge)
    combinedFormats.forEach((format) => {
      const quality = format.height;
      qualityOptions.push({
        quality: `${quality}p`,
        qualityNum: quality,
        url: format.url,
        type: format.ext === 'mp4' ? 'video/mp4' : `video/${format.ext}`,
        extension: format.ext || 'mp4',
        filesize: format.filesize || 'unknown',
        isPremium: quality > 360,
        hasAudio: true,
        isVideoOnly: false,
        isAudioOnly: false,
        needsMerge: false,
        bitrate: format.tbr || format.abr || 0,
      });
    });

    // Video-only (merge client-side)
    videoOnlyFormats.forEach((format) => {
      const quality = format.height;
      if (!qualityOptions.find((q) => q.qualityNum === quality && !q.isAudioOnly)) {
        qualityOptions.push({
          quality: `${quality}p`,
          qualityNum: quality,
          videoUrl: format.url,
          audioUrl: bestAudio?.url,
          url: format.url,
          type: format.ext === 'mp4' ? 'video/mp4' : `video/${format.ext}`,
          extension: format.ext || 'mp4',
          filesize: format.filesize || 'unknown',
          isPremium: quality > 360,
          hasAudio: false,
          isVideoOnly: true,
          isAudioOnly: false,
          needsMerge: true,
          bitrate: format.tbr || 0,
        });
      }
    });

    // Audio-only option
    if (bestAudio) {
      qualityOptions.push({
        quality: `Audio (${Math.round(bestAudio.abr || 128)}kbps)`,
        qualityNum: 0,
        url: bestAudio.url,
        type: 'audio/mp4',
        extension: bestAudio.ext || 'm4a',
        filesize: bestAudio.filesize || 'unknown',
        isPremium: false,
        hasAudio: true,
        isVideoOnly: false,
        isAudioOnly: true,
        needsMerge: false,
        bitrate: bestAudio.abr || 128,
      });
    }

    // Sort: highest video quality first, audio last
    qualityOptions.sort((a, b) => {
      if (a.isAudioOnly && !b.isAudioOnly) return 1;
      if (!a.isAudioOnly && b.isAudioOnly) return -1;
      return (b.qualityNum || 0) - (a.qualityNum || 0);
    });

    // Default: 360p with audio, else best available video, else first
    const selectedFormat =
        qualityOptions.find((opt) => !opt.isAudioOnly && opt.qualityNum === 360 && opt.hasAudio) ||
        qualityOptions.find((opt) => !opt.isAudioOnly && opt.qualityNum === 360) ||
        qualityOptions.find((opt) => !opt.isAudioOnly) ||
        qualityOptions[0];

    const videoId = this.extractYouTubeId(data.webpage_url || data.url);

    return {
      title: data.title || 'YouTube Video',
      thumbnail: data.thumbnail || `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
      duration: data.duration || 0,
      description: data.description || '',
      author: data.uploader || data.channel || '',
      viewCount: data.view_count || 0,
      formats: qualityOptions,
      allFormats: qualityOptions,
      url: selectedFormat?.url || null,
      selectedQuality: selectedFormat,
      videoId,
      source: 'yt-dlp',
      bestAudioUrl: bestAudio?.url,
    };
  }

  async fetchYouTubeData(url) {
    const normalizedUrl = this.normalizeYouTubeUrl(url);
    const videoId = this.extractYouTubeId(normalizedUrl);

    if (!videoId) {
      throw new Error('Invalid YouTube URL (must be watch/shorts/youtu.be with a video id)');
    }

    console.log(`🎬 Processing YouTube video: ${videoId}`);
    return await this.fetchWithYtDlp(normalizedUrl);
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
