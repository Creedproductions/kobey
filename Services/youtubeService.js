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
    // Keep your existing extraction logic
  }

  async fetchYouTubeData(url) {
    const videoId = this.extractYouTubeId(url);
    if (!videoId) throw new Error('Invalid YouTube URL');

    const yt = await this.init();
    const info = await yt.getInfo(videoId);

    // Get formats
    const formats = info.streaming_data.formats || [];
    const adaptiveFormats = info.streaming_data.adaptive_formats || [];
    const allFormats = [...formats, ...adaptiveFormats];

    const qualityOptions = allFormats
        .filter(f => f.url)
        .map(format => ({
          quality: format.quality_label || (format.bitrate ? 'audio' : 'unknown'),
          qualityNum: parseInt(format.quality_label) || 0,
          url: format.url,
          type: format.mime_type,
          extension: format.mime_type?.split('/')[1]?.split(';')[0] || 'mp4',
          filesize: format.content_length || 'unknown',
          hasAudio: format.has_audio,
          hasVideo: format.has_video,
          isVideoOnly: format.has_video && !format.has_audio,
          isAudioOnly: format.has_audio && !format.has_video,
          bitrate: format.bitrate
        }))
        .sort((a, b) => a.qualityNum - b.qualityNum);

    const selectedFormat = qualityOptions.find(opt =>
        !opt.isAudioOnly && opt.qualityNum === 360 && opt.hasAudio
    ) || qualityOptions.find(opt => !opt.isAudioOnly && opt.hasAudio) || qualityOptions[0];

    return {
      title: info.basic_info.title,
      thumbnail: info.basic_info.thumbnail[0].url,
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