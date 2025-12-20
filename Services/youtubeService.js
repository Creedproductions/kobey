const { spawn } = require('child_process');
const { promisify } = require('util');
const exec = promisify(require('child_process').exec);

class YouTubeDownloader {
  constructor() {
    this.ytDlpPath = 'yt-dlp'; // Will be installed globally
  }

  extractYouTubeId(url) {
    try {
      const urlObj = new URL(url);
      let videoId = urlObj.searchParams.get('v');
      if (videoId && videoId.length === 11) return videoId;

      const pathname = urlObj.pathname;
      if (pathname.includes('youtu.be/')) {
        const id = pathname.split('youtu.be/')[1]?.split(/[?&/#]/)[0];
        if (id && id.length === 11) return id;
      }
      if (pathname.includes('shorts/')) {
        const id = pathname.split('shorts/')[1]?.split(/[?&/#]/)[0];
        if (id && id.length === 11) return id;
      }

      const regexPatterns = [
        /(?:v=|\/)([0-9A-Za-z_-]{11})/,
        /youtu\.be\/([0-9A-Za-z_-]{11})/
      ];

      for (const pattern of regexPatterns) {
        const match = url.match(pattern);
        if (match && match[1]) return match[1];
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  normalizeYouTubeUrl(url) {
    if (url.includes('youtu.be/')) {
      const videoId = url.split('youtu.be/')[1].split('?')[0].split('&')[0];
      return `https://www.youtube.com/watch?v=${videoId}`;
    }
    if (url.includes('m.youtube.com')) {
      return url.replace('m.youtube.com', 'www.youtube.com');
    }
    return url;
  }

  extractQualityNumber(qualityLabel) {
    if (!qualityLabel) return 0;
    const match = qualityLabel.match(/(\d+)p/);
    if (match) return parseInt(match[1]);
    return 360;
  }

  /**
   * Use yt-dlp to fetch video information
   */
  async fetchWithYtDlp(url) {
    const normalizedUrl = this.normalizeYouTubeUrl(url);

    console.log('🔧 Using yt-dlp to fetch video info...');

    try {
      // Get JSON info about the video
      const { stdout, stderr } = await exec(
          `${this.ytDlpPath} --dump-json --no-warnings "${normalizedUrl}"`,
          { timeout: 30000, maxBuffer: 10 * 1024 * 1024 }
      );

      if (stderr && !stderr.includes('WARNING')) {
        console.error('yt-dlp stderr:', stderr);
      }

      const info = JSON.parse(stdout);

      console.log(`✅ yt-dlp succeeded: "${info.title}"`);
      console.log(`📊 Formats available: ${info.formats?.length || 0}`);

      return this.processYtDlpData(info);
    } catch (error) {
      console.error('❌ yt-dlp failed:', error.message);
      throw new Error(`yt-dlp extraction failed: ${error.message}`);
    }
  }

  /**
   * Process yt-dlp data into our format
   */
  processYtDlpData(data) {
    const formats = data.formats || [];

    // Filter video formats (with height) and audio formats
    const videoFormats = formats.filter(f =>
        f.vcodec && f.vcodec !== 'none' && f.height && f.url
    );

    const audioFormats = formats.filter(f =>
        f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none') && f.url
    );

    // Group video formats by quality
    const qualityMap = new Map();

    videoFormats.forEach(format => {
      const quality = format.height;
      const hasAudio = format.acodec && format.acodec !== 'none';

      if (!qualityMap.has(quality)) {
        qualityMap.set(quality, format);
      } else {
        // Prefer formats with audio
        const existing = qualityMap.get(quality);
        const existingHasAudio = existing.acodec && existing.acodec !== 'none';

        if (!existingHasAudio && hasAudio) {
          qualityMap.set(quality, format);
        } else if (existingHasAudio === hasAudio && format.filesize > existing.filesize) {
          qualityMap.set(quality, format);
        }
      }
    });

    // Convert to our format
    const qualityOptions = Array.from(qualityMap.values())
        .sort((a, b) => (a.height || 0) - (b.height || 0))
        .map(format => {
          const quality = format.height;
          const hasAudio = format.acodec && format.acodec !== 'none';
          const isPremium = quality > 360;

          return {
            quality: `${quality}p`,
            qualityNum: quality,
            url: format.url,
            type: format.ext === 'mp4' ? 'video/mp4' : `video/${format.ext}`,
            extension: format.ext || 'mp4',
            filesize: format.filesize || 'unknown',
            isPremium: isPremium,
            hasAudio: hasAudio,
            isVideoOnly: !hasAudio,
            isAudioOnly: false,
            bitrate: format.tbr || format.abr || 0
          };
        });

    // Add audio-only formats
    const bestAudio = audioFormats
        .sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];

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
        bitrate: bestAudio.abr || 128
      });
    }

    // Select default quality (360p with audio, or best available)
    let selectedFormat = qualityOptions.find(opt =>
        !opt.isAudioOnly && opt.qualityNum === 360 && opt.hasAudio
    ) || qualityOptions.find(opt => !opt.isAudioOnly) || qualityOptions[0];

    const videoId = this.extractYouTubeId(data.webpage_url || data.url);

    return {
      title: data.title || "YouTube Video",
      thumbnail: data.thumbnail || `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
      duration: data.duration || 0,
      description: data.description || '',
      author: data.uploader || data.channel || '',
      viewCount: data.view_count || 0,
      formats: qualityOptions,
      allFormats: qualityOptions,
      url: selectedFormat?.url || null,
      selectedQuality: selectedFormat,
      audioGuaranteed: selectedFormat?.hasAudio || false,
      videoId: videoId,
      source: 'yt-dlp'
    };
  }

  async fetchYouTubeData(url) {
    const videoId = this.extractYouTubeId(url);

    if (!videoId) {
      throw new Error('Invalid YouTube URL');
    }

    console.log(`🎬 Processing YouTube video: ${videoId}`);

    try {
      const result = await this.fetchWithYtDlp(url);
      console.log(`✅ SUCCESS with ${result.formats.length} formats (via yt-dlp)`);
      return result;
    } catch (error) {
      console.error('❌ yt-dlp extraction failed:', error.message);
      throw error;
    }
  }
}

const youtubeDownloader = new YouTubeDownloader();

async function fetchYouTubeData(url) {
  return youtubeDownloader.fetchYouTubeData(url);
}

async function testYouTube() {
  try {
    const testUrl = 'https://youtu.be/dQw4w9WgXcQ';
    console.log(`\n🧪 Testing yt-dlp YouTube downloader with: ${testUrl}\n`);

    const data = await fetchYouTubeData(testUrl);

    console.log('\n✅ TEST PASSED');
    console.log(`📺 Title: ${data.title}`);
    console.log(`📊 Formats: ${data.formats.length}`);

    return true;
  } catch (error) {
    console.error('\n❌ TEST FAILED:', error.message);
    return false;
  }
}

module.exports = {
  fetchYouTubeData,
  testYouTube,
  YouTubeDownloader
};