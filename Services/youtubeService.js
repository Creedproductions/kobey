// services/youtubeService.js
const youtubedl = require('youtube-dl-exec');
const ytdl = require('@distube/ytdl-core');

class YouTubeService {
  constructor() {
    this.priority = ['yt-dlp', 'distube-ytdl'];
  }

  async fetchYouTubeData(url, options = {}) {
    console.log('🎬 YouTube: Starting download process...');
    
    // Try methods in order of reliability
    for (const method of this.priority) {
      try {
        console.log(`🔄 Trying ${method}...`);
        const result = await this[method](url, options);
        if (result) {
          console.log(`✅ Success with ${method}`);
          return result;
        }
      } catch (error) {
        console.warn(`❌ ${method} failed:`, error.message);
        continue;
      }
    }
    
    throw new Error('All YouTube download methods failed');
  }

  async ['yt-dlp'](url, options) {
    try {
      const result = await youtubedl(url, {
        dumpSingleJson: true,
        noCheckCertificates: true,
        noWarnings: true,
        preferFreeFormats: true,
        format: 'best[height<=720][vcodec^=avc1][acodec^=mp4a]/best[height<=720]',
        addHeader: [
          'referer:youtube.com',
          'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        ]
      });

      if (!result || !result.formats || result.formats.length === 0) {
        throw new Error('No formats available');
      }

      // Find the best format with audio and video
      const format = result.formats.find(f => 
        f.vcodec !== 'none' && 
        f.acodec !== 'none' && 
        (f.height <= 720 || !f.height)
      ) || result.formats[0];

      const formats = result.formats
        .filter(f => f.vcodec !== 'none' && f.acodec !== 'none')
        .map(f => ({
          quality: f.format_note || `${f.height}p` || 'unknown',
          qualityNum: f.height || 0,
          url: f.url,
          type: f.ext,
          extension: f.ext,
          hasAudio: f.acodec !== 'none',
          filesize: f.filesize || 'unknown'
        }))
        .sort((a, b) => b.qualityNum - a.qualityNum);

      return {
        title: result.title,
        thumbnail: result.thumbnail,
        duration: result.duration,
        formats: formats,
        allFormats: formats,
        url: format.url,
        selectedQuality: formats[0],
        audioGuaranteed: true
      };
    } catch (error) {
      throw new Error(`yt-dlp: ${error.message}`);
    }
  }

  async ['distube-ytdl'](url, options) {
    try {
      const info = await ytdl.getInfo(url);
      
      const formats = ytdl.filterFormats(info.formats, 'videoandaudio')
        .map(format => ({
          quality: format.qualityLabel || 'unknown',
          qualityNum: parseInt(format.qualityLabel?.replace('p', '')) || 0,
          url: format.url,
          type: format.mimeType?.split(';')[0] || 'video/mp4',
          extension: format.container || 'mp4',
          hasAudio: true,
          filesize: format.contentLength || 'unknown'
        }))
        .filter(f => f.qualityNum > 0)
        .sort((a, b) => b.qualityNum - a.qualityNum);

      if (formats.length === 0) {
        throw new Error('No formats with audio found');
      }

      return {
        title: info.videoDetails.title,
        thumbnail: info.videoDetails.thumbnails?.pop()?.url,
        duration: info.videoDetails.lengthSeconds,
        formats: formats,
        allFormats: formats,
        url: formats[0].url,
        selectedQuality: formats[0],
        audioGuaranteed: true
      };
    } catch (error) {
      throw new Error(`distube-ytdl: ${error.message}`);
    }
  }
}

module.exports = new YouTubeService();
