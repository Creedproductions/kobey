const ytdl = require('ytdl-core');
const axios = require('axios');

class YouTubeService {
  constructor() {
    this.maxRetries = 3;
    this.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  }

  /**
   * Main method to fetch YouTube data with multiple fallback strategies
   */
  async fetchYouTubeData(url) {
    console.log('🎬 YouTube: Starting download process...');
    
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        console.log(`🔄 Attempt ${attempt}/${this.maxRetries}`);
        
        // Try different methods in order of reliability
        let data;
        
        try {
          // Method 1: Simple format (most reliable for ytdl-core issues)
          data = await this.getSimpleFormat(url);
        } catch (error) {
          console.warn(`Method 1 failed: ${error.message}`);
          
          try {
            // Method 2: Full format selection
            data = await this.getYouTubeData(url);
          } catch (error2) {
            console.warn(`Method 2 failed: ${error2.message}`);
            
            // Method 3: Fallback with basic format selection
            data = await this.getFallbackYouTubeData(url);
          }
        }
        
        if (data && data.url) {
          console.log(`✅ YouTube: Success with ${data.formats?.length || 0} formats`);
          return data;
        }
      } catch (error) {
        console.warn(`❌ Attempt ${attempt} failed:`, error.message);
        
        if (attempt === this.maxRetries) {
          throw new Error(`All YouTube download attempts failed: ${error.message}`);
        }
        
        // Exponential backoff
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      }
    }
    
    throw new Error('YouTube download failed after all retries');
  }

  /**
   * Simple format method - most reliable for 410 errors
   */
  async getSimpleFormat(url) {
    console.log('📹 YouTube: Using simple format method...');
    
    if (!ytdl.validateURL(url)) {
      throw new Error('Invalid YouTube URL');
    }

    const options = {
      requestOptions: {
        headers: {
          'User-Agent': this.userAgent,
          'Accept-Language': 'en-US,en;q=0.9'
        }
      }
    };

    const info = await ytdl.getInfo(url, options);
    console.log('✅ Got video info:', info.videoDetails.title);

    // Use ytdl's built-in format selection for reliability
    let selectedFormat;
    
    try {
      // Try to get audio+video format first
      selectedFormat = ytdl.chooseFormat(info.formats, {
        quality: 'highestvideo',
        filter: format => format.hasVideo && format.hasAudio
      });
    } catch (e) {
      console.log('⚠️ No combined formats, trying video-only...');
      
      // Fallback to video-only formats
      selectedFormat = ytdl.chooseFormat(info.formats, {
        quality: 'highestvideo',
        filter: 'videoonly'
      });
    }

    if (!selectedFormat || !selectedFormat.url) {
      throw new Error('No downloadable format found');
    }

    // Build format list
    const formats = this.buildFormatList(info.formats);

    return {
      title: info.videoDetails.title,
      url: selectedFormat.url,
      thumbnail: this.getBestThumbnail(info.videoDetails.thumbnails),
      duration: parseInt(info.videoDetails.lengthSeconds) || 0,
      formats: formats,
      allFormats: formats,
      selectedQuality: {
        quality: selectedFormat.qualityLabel || 'auto',
        qualityNum: parseInt(selectedFormat.qualityLabel) || 0,
        url: selectedFormat.url,
        type: selectedFormat.mimeType?.split(';')[0] || 'video/mp4',
        extension: selectedFormat.container || 'mp4',
        hasAudio: selectedFormat.hasAudio || false,
        hasVideo: selectedFormat.hasVideo || false,
        filesize: selectedFormat.contentLength || 'unknown',
        isCombined: selectedFormat.hasAudio && selectedFormat.hasVideo
      },
      audioGuaranteed: selectedFormat.hasAudio || false
    };
  }

  /**
   * Full YouTube data fetch with comprehensive format selection
   */
  async getYouTubeData(url) {
    console.log('📹 YouTube: Using full format method...');
    
    if (!ytdl.validateURL(url)) {
      throw new Error('Invalid YouTube URL');
    }

    const options = {
      requestOptions: {
        headers: {
          'User-Agent': this.userAgent,
          'Accept-Language': 'en-US,en;q=0.9'
        }
      }
    };

    const info = await ytdl.getInfo(url, options);
    console.log('✅ Got video info:', info.videoDetails.title);

    // Method 1: Try combined audio+video formats
    let formats = this.getCombinedFormats(info.formats);
    
    // Method 2: Get separate audio and video if no combined formats
    if (formats.length === 0) {
      console.log('🔄 No combined formats, using separate audio/video...');
      formats = this.getSeparateFormats(info.formats);
    }

    if (formats.length === 0) {
      throw new Error('No downloadable formats found');
    }

    // Select best format
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
  }

  /**
   * Fallback method using ytdl's built-in format chooser
   */
  async getFallbackYouTubeData(url) {
    console.log('🔄 YouTube: Using fallback method...');
    
    if (!ytdl.validateURL(url)) {
      throw new Error('Invalid YouTube URL');
    }

    const options = {
      requestOptions: {
        headers: {
          'User-Agent': this.userAgent
        }
      }
    };

    const info = await ytdl.getInfo(url, options);
    
    // Try multiple format selection strategies
    let format;
    const strategies = [
      { quality: 'highest', filter: 'audioandvideo' },
      { quality: 'highestvideo', filter: 'videoandaudio' },
      { quality: 'highest', filter: 'videoonly' },
      { quality: 'highest' }
    ];

    for (const strategy of strategies) {
      try {
        format = ytdl.chooseFormat(info.formats, strategy);
        if (format && format.url) break;
      } catch (e) {
        continue;
      }
    }

    if (!format || !format.url) {
      throw new Error('No suitable format found');
    }

    const basicFormats = [{
      quality: format.qualityLabel || 'auto',
      qualityNum: parseInt(format.qualityLabel) || 0,
      url: format.url,
      type: format.mimeType?.split(';')[0] || 'video/mp4',
      extension: format.container || 'mp4',
      hasAudio: format.hasAudio || false,
      hasVideo: format.hasVideo || false,
      filesize: format.contentLength || 'unknown',
      isCombined: format.hasAudio && format.hasVideo
    }];

    return {
      title: info.videoDetails.title,
      url: format.url,
      thumbnail: this.getBestThumbnail(info.videoDetails.thumbnails),
      duration: parseInt(info.videoDetails.lengthSeconds) || 0,
      formats: basicFormats,
      allFormats: basicFormats,
      selectedQuality: basicFormats[0],
      audioGuaranteed: format.hasAudio || false
    };
  }

  /**
   * Build a clean format list from raw formats
   */
  buildFormatList(rawFormats) {
    const formats = [];
    const seenQualities = new Set();

    // Filter and map formats
    rawFormats
      .filter(f => f.qualityLabel && f.url)
      .forEach(format => {
        const quality = format.qualityLabel;
        
        // Avoid duplicates
        if (!seenQualities.has(quality)) {
          seenQualities.add(quality);
          
          formats.push({
            quality: quality,
            qualityNum: parseInt(quality) || 0,
            url: format.url,
            type: format.mimeType?.split(';')[0] || 'video/mp4',
            extension: format.container || 'mp4',
            hasAudio: format.hasAudio || false,
            hasVideo: format.hasVideo || false,
            filesize: format.contentLength || 'unknown',
            isCombined: format.hasAudio && format.hasVideo
          });
        }
      });

    return formats.sort((a, b) => b.qualityNum - a.qualityNum);
  }

  /**
   * Get combined audio+video formats
   */
  getCombinedFormats(formats) {
    return formats
      .filter(format => 
        format.hasVideo && 
        format.hasAudio && 
        format.qualityLabel &&
        format.url &&
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

  /**
   * Get separate audio and video formats
   */
  getSeparateFormats(formats) {
    // Video formats
    const videoFormats = formats
      .filter(format => format.hasVideo && format.qualityLabel && format.url)
      .map(format => ({
        quality: format.qualityLabel,
        qualityNum: parseInt(format.qualityLabel) || 0,
        url: format.url,
        type: format.mimeType?.split(';')[0] || 'video/mp4',
        extension: format.container || 'mp4',
        hasAudio: format.hasAudio || false,
        hasVideo: true,
        filesize: format.contentLength || 'unknown',
        isCombined: false
      }))
      .filter(f => f.qualityNum > 0)
      .sort((a, b) => b.qualityNum - a.qualityNum);

    // Audio formats
    const audioFormats = formats
      .filter(format => format.hasAudio && format.url)
      .map(format => ({
        quality: 'audio',
        qualityNum: 0,
        url: format.url,
        type: format.mimeType?.split(';')[0] || 'audio/mp4',
        extension: format.container || 'mp4',
        hasAudio: true,
        hasVideo: false,
        bitrate: format.audioBitrate || 0,
        filesize: format.contentLength || 'unknown',
        isCombined: false
      }))
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

    return [...videoFormats, ...audioFormats];
  }

  /**
   * Select the best format from available formats
   */
  selectBestFormat(formats) {
    // Prefer combined formats
    const combinedFormats = formats.filter(f => f.isCombined);
    if (combinedFormats.length > 0) {
      return combinedFormats.find(f => f.qualityNum === 720) ||
             combinedFormats.find(f => f.qualityNum === 480) ||
             combinedFormats.find(f => f.qualityNum === 360) ||
             combinedFormats[0];
    }

    // Fallback to video formats
    const videoFormats = formats.filter(f => f.hasVideo);
    if (videoFormats.length > 0) {
      return videoFormats.find(f => f.qualityNum === 720) ||
             videoFormats.find(f => f.qualityNum === 480) ||
             videoFormats.find(f => f.qualityNum === 360) ||
             videoFormats[0];
    }

    // Last resort
    return formats[0];
  }

  /**
   * Get the best quality thumbnail
   */
  getBestThumbnail(thumbnails) {
    if (!thumbnails || thumbnails.length === 0) {
      return 'https://via.placeholder.com/1280x720?text=YouTube+Video';
    }
    
    return thumbnails
      .sort((a, b) => (b.width || 0) - (a.width || 0))
      [0].url;
  }

  /**
   * Validate YouTube URL
   */
  validateURL(url) {
    return ytdl.validateURL(url);
  }
}

module.exports = new YouTubeService();
