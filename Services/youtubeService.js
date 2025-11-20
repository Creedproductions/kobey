const ytdl = require('ytdl-core');
const axios = require('axios');

class YouTubeService {
  constructor() {
    this.maxRetries = 3;
  }

  async fetchYouTubeData(url) {
    console.log('🎬 YouTube: Starting download process...');
    
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        console.log(`🔄 Attempt ${attempt}/${this.maxRetries}`);
        
        const data = await this.getYouTubeData(url);
        if (data && data.url) {
          console.log(`✅ YouTube: Success with ${data.formats?.length || 0} formats`);
          return data;
        }
      } catch (error) {
        console.warn(`❌ Attempt ${attempt} failed:`, error.message);
        if (attempt === this.maxRetries) {
          throw new Error(`All YouTube download attempts failed: ${error.message}`);
        }
        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      }
    }
  }

  async getYouTubeData(url) {
    try {
      console.log('📹 Getting YouTube video info...');
      
      // Validate URL first
      if (!ytdl.validateURL(url)) {
        throw new Error('Invalid YouTube URL');
      }

      const info = await ytdl.getInfo(url);
      console.log('✅ Got video info:', info.videoDetails.title);

      // Method 1: Try to get combined audio+video formats first
      let formats = this.getCombinedFormats(info.formats);
      
      // Method 2: If no combined formats, get separate audio and video
      if (formats.length === 0) {
        console.log('🔄 No combined formats found, trying separate audio/video...');
        formats = this.getSeparateFormats(info.formats);
      }

      if (formats.length === 0) {
        throw new Error('No downloadable formats found');
      }

      // Select the best format (720p or closest available)
      const selectedFormat = this.selectBestFormat(formats);
      
      console.log(`🎯 Selected format: ${selectedFormat.quality}`);

      return {
        title: info.videoDetails.title,
        url: selectedFormat.url,
        thumbnail: this.getBestThumbnail(info.videoDetails.thumbnails),
        duration: parseInt(info.videoDetails.lengthSeconds) || 0,
        formats: formats,
        allFormats: formats,
        selectedQuality: selectedFormat,
        audioGuaranteed: selectedFormat.hasAudio
      };

    } catch (error) {
      console.error('❌ YouTube data fetch failed:', error.message);
      throw error;
    }
  }

  getCombinedFormats(formats) {
    return formats
      .filter(format => 
        format.hasVideo && 
        format.hasAudio && 
        format.qualityLabel &&
        !format.qualityLabel.includes('HDR')
      )
      .map(format => ({
        quality: format.qualityLabel,
        qualityNum: parseInt(format.qualityLabel) || 0,
        url: format.url,
        type: format.mimeType?.split(';')[0] || 'video/mp4',
        extension: format.container || 'mp4',
        hasAudio: true,
        hasVideo: true,
        filesize: format.contentLength || 'unknown',
        isCombined: true
      }))
      .filter(f => f.qualityNum > 0)
      .sort((a, b) => b.qualityNum - a.qualityNum);
  }

  getSeparateFormats(formats) {
    // Get highest quality video format
    const videoFormats = formats
      .filter(format => format.hasVideo && !format.hasAudio && format.qualityLabel)
      .map(format => ({
        quality: format.qualityLabel,
        qualityNum: parseInt(format.qualityLabel) || 0,
        url: format.url,
        type: format.mimeType?.split(';')[0] || 'video/mp4',
        extension: format.container || 'mp4',
        hasAudio: false,
        hasVideo: true,
        filesize: format.contentLength || 'unknown',
        isCombined: false
      }))
      .filter(f => f.qualityNum > 0)
      .sort((a, b) => b.qualityNum - a.qualityNum);

    // Get best audio format
    const audioFormats = formats
      .filter(format => format.hasAudio && !format.hasVideo)
      .map(format => ({
        quality: 'audio',
        qualityNum: 0,
        url: format.url,
        type: format.mimeType?.split(';')[0] || 'audio/mp4',
        extension: format.container || 'mp4',
        hasAudio: true,
        hasVideo: false,
        filesize: format.contentLength || 'unknown',
        isCombined: false
      }))
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

    return [...videoFormats, ...audioFormats];
  }

  selectBestFormat(formats) {
    // Prefer combined formats
    const combinedFormats = formats.filter(f => f.isCombined);
    if (combinedFormats.length > 0) {
      // Try to get 720p, then 480p, then highest available
      return combinedFormats.find(f => f.qualityNum === 720) ||
             combinedFormats.find(f => f.qualityNum === 480) ||
             combinedFormats[0];
    }

    // Fallback to any format with video
    const videoFormats = formats.filter(f => f.hasVideo);
    if (videoFormats.length > 0) {
      return videoFormats.find(f => f.qualityNum === 720) ||
             videoFormats.find(f => f.qualityNum === 480) ||
             videoFormats[0];
    }

    // Last resort: any format
    return formats[0];
  }

  getBestThumbnail(thumbnails) {
    if (!thumbnails || thumbnails.length === 0) {
      return 'https://via.placeholder.com/1280x720';
    }
    
    // Prefer higher resolution thumbnails
    return thumbnails
      .sort((a, b) => (b.width || 0) - (a.width || 0))
      [0].url;
  }

  // Alternative method for problematic videos
  async getFallbackYouTubeData(url) {
    try {
      console.log('🔄 Trying fallback YouTube method...');
      
      const info = await ytdl.getInfo(url);
      
      // Use ytdl's built-in format selection
      const format = ytdl.chooseFormat(info.formats, {
        quality: 'highest',
        filter: 'audioandvideo'
      });

      if (!format) {
        throw new Error('No suitable format found');
      }

      const basicFormats = [{
        quality: format.qualityLabel || 'unknown',
        qualityNum: parseInt(format.qualityLabel) || 0,
        url: format.url,
        type: format.mimeType?.split(';')[0] || 'video/mp4',
        extension: format.container || 'mp4',
        hasAudio: format.hasAudio,
        hasVideo: format.hasVideo,
        filesize: format.contentLength || 'unknown'
      }];

      return {
        title: info.videoDetails.title,
        url: format.url,
        thumbnail: this.getBestThumbnail(info.videoDetails.thumbnails),
        duration: parseInt(info.videoDetails.lengthSeconds) || 0,
        formats: basicFormats,
        allFormats: basicFormats,
        selectedQuality: basicFormats[0],
        audioGuaranteed: format.hasAudio
      };

    } catch (error) {
      throw new Error(`Fallback method failed: ${error.message}`);
    }
  }
}

module.exports = new YouTubeService();
