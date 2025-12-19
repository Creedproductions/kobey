const { Innertube } = require('youtubei.js');

class YouTubeDownloader {
  constructor() {
    this.innertube = null;
  }

  async init() {
    if (!this.innertube) {
      this.innertube = await Innertube.create();
    }
    return this.innertube;
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

      return null;
    } catch (error) {
      return null;
    }
  }

  async fetchYouTubeData(url) {
    const videoId = this.extractYouTubeId(url);
    if (!videoId) throw new Error('Invalid YouTube URL');

    console.log(`🎬 Fetching video: ${videoId}`);

    const yt = await this.init();
    const info = await yt.getInfo(videoId);

    const formats = info.streaming_data?.formats || [];
    const adaptiveFormats = info.streaming_data?.adaptive_formats || [];
    const allFormats = [...formats, ...adaptiveFormats];

    const qualityOptions = allFormats
        .filter(f => f.url)
        .map(format => ({
          quality: format.quality_label || (format.has_audio ? 'audio' : 'unknown'),
          qualityNum: parseInt(format.quality_label) || 0,
          url: format.url,
          type: format.mime_type,
          extension: format.mime_type?.split('/')[1]?.split(';')[0] || 'mp4',
          filesize: format.content_length || 'unknown',
          hasAudio: format.has_audio || false,
          hasVideo: format.has_video || false,
          isVideoOnly: format.has_video && !format.has_audio,
          isAudioOnly: format.has_audio && !format.has_video,
          bitrate: format.bitrate,
          isPremium: parseInt(format.quality_label) > 360
        }))
        .sort((a, b) => a.qualityNum - b.qualityNum);

    const selectedFormat = qualityOptions.find(opt =>
        !opt.isAudioOnly && opt.qualityNum === 360 && opt.hasAudio
    ) || qualityOptions.find(opt => !opt.isAudioOnly && opt.hasAudio) || qualityOptions[0];

    console.log(`✅ Found ${qualityOptions.length} formats`);

    return {
      title: info.basic_info.title,
      thumbnail: info.basic_info.thumbnail?.[0]?.url,
      duration: info.basic_info.duration,
      description: info.basic_info.short_description,
      author: info.basic_info.author,
      viewCount: info.basic_info.view_count,
      formats: qualityOptions,
      allFormats: qualityOptions,
      url: selectedFormat?.url || null,
      selectedQuality: selectedFormat,
      audioGuaranteed: selectedFormat?.hasAudio || false,
      videoId: videoId,
      source: 'youtubei'
    };
  }
}

// Create singleton
const youtubeDownloader = new YouTubeDownloader();

// CRITICAL: Export as a function
module.exports = {
  fetchYouTubeData: (url) => youtubeDownloader.fetchYouTubeData(url),
  YouTubeDownloader
};