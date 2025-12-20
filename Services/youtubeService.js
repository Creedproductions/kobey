const { Innertube, UniversalCache } = require('youtubei.js');

class YouTubeDownloader {
  constructor() {
    this.innertube = null;
    this.isInitializing = false;
  }

  // Initialize the Innertube instance (Singleton pattern)
  async init() {
    if (this.innertube) return;
    if (this.isInitializing) {
      while (this.isInitializing) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return;
    }

    this.isInitializing = true;
    try {
      // Innertube works best with a cache to store session data
      this.innertube = await Innertube.create({
        cache: new UniversalCache(false),
        generate_session_locally: true
      });
      console.log('✅ YouTube Innertube initialized');
    } catch (err) {
      console.error('❌ Failed to initialize Innertube:', err);
      throw err;
    } finally {
      this.isInitializing = false;
    }
  }

  extractYouTubeId(url) {
    try {
      const urlObj = new URL(url);
      let videoId = urlObj.searchParams.get('v');
      if (videoId) return videoId;

      const pathname = urlObj.pathname;
      if (pathname.includes('youtu.be/')) {
        return pathname.split('youtu.be/')[1]?.split(/[?&/#]/)[0];
      }
      if (pathname.includes('/shorts/') || pathname.includes('/embed/')) {
        return pathname.split('/').pop()?.split(/[?&/#]/)[0];
      }

      const regex = /(?:v=|\/)([0-9A-Za-z_-]{11})/;
      const match = String(url).match(regex);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  async fetchYouTubeData(url) {
    await this.init();
    const videoId = this.extractYouTubeId(url);

    if (!videoId) {
      throw new Error('Invalid YouTube URL');
    }

    console.log(`🎬 Processing YouTube video via Innertube: ${videoId}`);

    try {
      // getInfo() fetches metadata and streaming manifests
      const info = await this.innertube.getInfo(videoId);
      const basic = info.basic_info;

      // Extract and format quality options
      const qualityOptions = [];

      // Combine video+audio formats and video-only formats
      const allFormats = [...info.formats, ...info.adaptive_formats];

      allFormats.forEach((f) => {
        const hasVideo = f.has_video;
        const hasAudio = f.has_audio;
        const quality = f.quality_label || (hasAudio && !hasVideo ? 'Audio' : 'Unknown');

        qualityOptions.push({
          quality: quality,
          qualityNum: parseInt(f.height) || 0,
          url: f.decipher(this.innertube.session.player), // Decipher the URL
          type: f.mime_type,
          extension: f.mime_type.split(';')[0].split('/')[1] || 'mp4',
          filesize: f.content_length || 'unknown',
          isPremium: parseInt(f.height) > 360,
          hasAudio: hasAudio,
          isVideoOnly: hasVideo && !hasAudio,
          isAudioOnly: hasAudio && !hasVideo,
          needsMerge: hasVideo && !hasAudio,
          bitrate: f.bitrate,
        });
      });

      // Sort: Highest resolution first
      qualityOptions.sort((a, b) => b.qualityNum - a.qualityNum);

      // Select default (360p combined or first available)
      const selectedFormat =
          qualityOptions.find(o => o.qualityNum === 360 && o.hasAudio) ||
          qualityOptions[0];

      return {
        title: basic.title,
        thumbnail: basic.thumbnail[0]?.url || `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
        duration: basic.duration,
        description: basic.short_description || '',
        author: basic.author,
        viewCount: basic.view_count,
        formats: qualityOptions,
        allFormats: qualityOptions,
        url: selectedFormat?.url || null,
        selectedQuality: selectedFormat,
        videoId,
        source: 'innertube',
        bestAudioUrl: qualityOptions.find(o => o.isAudioOnly)?.url
      };
    } catch (err) {
      console.error('❌ Innertube error:', err.message);
      throw new Error(`YouTube extraction failed: ${err.message}`);
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