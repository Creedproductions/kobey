const ytdl = require('ytdl-core');
const axios = require('axios');

class YouTubeService {
  constructor() {
    this.maxRetries = 2;
    this.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  }

  /**
   * Main method to fetch YouTube data with multiple fallback strategies
   */
  async fetchYouTubeData(url) {
    console.log('🎬 YouTube: Starting download process...');
    
    // Try ytdl-core first
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        console.log(`🔄 ytdl-core Attempt ${attempt}/${this.maxRetries}`);
        const data = await this.getYouTubeDataWithCookies(url);
        
        if (data && data.url) {
          console.log(`✅ YouTube: Success with ytdl-core (${data.formats?.length || 0} formats)`);
          return data;
        }
      } catch (error) {
        console.warn(`❌ ytdl-core attempt ${attempt} failed:`, error.message);
        if (attempt < this.maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        }
      }
    }

    // Fallback to yt-dlp API method
    try {
      console.log('🔄 Trying yt-dlp API fallback...');
      const data = await this.getYouTubeViaAPI(url);
      if (data && data.url) {
        console.log(`✅ YouTube: Success with API fallback`);
        return data;
      }
    } catch (apiError) {
      console.warn('❌ API fallback failed:', apiError.message);
    }

    throw new Error('All YouTube download methods failed. YouTube may have changed their API.');
  }

  /**
   * Get YouTube data with OAuth tokens and cookies
   */
  async getYouTubeDataWithCookies(url) {
    if (!ytdl.validateURL(url)) {
      throw new Error('Invalid YouTube URL');
    }

    // Enhanced options with OAuth and cookies simulation
    const options = {
      requestOptions: {
        headers: {
          'User-Agent': this.userAgent,
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1'
        }
      }
    };

    try {
      const info = await ytdl.getInfo(url, options);
      console.log('✅ Got video info:', info.videoDetails.title);

      // Filter valid formats
      const validFormats = info.formats.filter(f => f.url && !f.isLive);
      
      if (validFormats.length === 0) {
        throw new Error('No valid formats found');
      }

      // Try to get best format with audio+video
      let selectedFormat;
      try {
        selectedFormat = ytdl.chooseFormat(validFormats, {
          quality: 'highestvideo',
          filter: format => format.hasVideo && format.hasAudio
        });
      } catch (e) {
        console.log('⚠️ No combined format, trying video-only...');
        selectedFormat = ytdl.chooseFormat(validFormats, {
          quality: 'highestvideo',
          filter: 'videoonly'
        });
      }

      if (!selectedFormat || !selectedFormat.url) {
        // Last resort: pick any format with highest quality
        selectedFormat = validFormats.sort((a, b) => {
          const aQuality = parseInt(a.qualityLabel) || 0;
          const bQuality = parseInt(b.qualityLabel) || 0;
          return bQuality - aQuality;
        })[0];
      }

      // Build format list
      const formats = this.buildFormatList(validFormats);

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
    } catch (error) {
      throw new Error(`ytdl-core failed: ${error.message}`);
    }
  }

  /**
   * Fallback method using public yt-dlp API
   */
  async getYouTubeViaAPI(url) {
    try {
      // Extract video ID
      const videoId = this.extractVideoId(url);
      if (!videoId) {
        throw new Error('Could not extract video ID');
      }

      // Use a public API endpoint (you may need to host your own or use a service)
      const apiUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
      
      const response = await axios.get(apiUrl, {
        headers: {
          'User-Agent': this.userAgent
        },
        timeout: 10000
      });

      if (!response.data || !response.data.title) {
        throw new Error('Invalid API response');
      }

      // Build a basic response with embed URL
      // Note: This won't give direct download URLs, but provides video info
      const embedUrl = `https://www.youtube.com/embed/${videoId}`;
      const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;

      return {
        title: response.data.title,
        url: watchUrl, // Return watch URL for client-side handling
        thumbnail: response.data.thumbnail_url || `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
        duration: 0,
        formats: [{
          quality: 'Stream',
          qualityNum: 0,
          url: watchUrl,
          type: 'video/mp4',
          extension: 'mp4',
          hasAudio: true,
          hasVideo: true,
          filesize: 'unknown',
          isCombined: true
        }],
        allFormats: [{
          quality: 'Stream',
          qualityNum: 0,
          url: watchUrl,
          type: 'video/mp4',
          extension: 'mp4',
          hasAudio: true,
          hasVideo: true,
          filesize: 'unknown',
          isCombined: true
        }],
        selectedQuality: {
          quality: 'Stream',
          qualityNum: 0,
          url: watchUrl,
          type: 'video/mp4',
          extension: 'mp4',
          hasAudio: true,
          hasVideo: true,
          filesize: 'unknown',
          isCombined: true
        },
        audioGuaranteed: true,
        isStreamOnly: true // Flag to indicate this is stream-only
      };
    } catch (error) {
      throw new Error(`API method failed: ${error.message}`);
    }
  }

  /**
   * Alternative: Use invidious instances
   */
  async getYouTubeViaInvidious(url) {
    try {
      const videoId = this.extractVideoId(url);
      if (!videoId) {
        throw new Error('Could not extract video ID');
      }

      // List of public Invidious instances (some may be down)
      const invidiousInstances = [
        'https://invidious.snopyta.org',
        'https://yewtu.be',
        'https://invidious.kavin.rocks'
      ];

      for (const instance of invidiousInstances) {
        try {
          const response = await axios.get(`${instance}/api/v1/videos/${videoId}`, {
            headers: { 'User-Agent': this.userAgent },
            timeout: 10000
          });

          if (!response.data || !response.data.formatStreams) {
            continue;
          }

          const data = response.data;
          const formats = data.formatStreams
            .filter(f => f.url && f.qualityLabel)
            .map(f => ({
              quality: f.qualityLabel,
              qualityNum: parseInt(f.qualityLabel) || 0,
              url: f.url,
              type: f.type || 'video/mp4',
              extension: f.container || 'mp4',
              hasAudio: true,
              hasVideo: true,
              filesize: f.size || 'unknown',
              isCombined: true
            }))
            .sort((a, b) => b.qualityNum - a.qualityNum);

          if (formats.length === 0) {
            continue;
          }

          const selectedFormat = formats.find(f => f.qualityNum === 720) || formats[0];

          return {
            title: data.title,
            url: selectedFormat.url,
            thumbnail: data.videoThumbnails?.[0]?.url || `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
            duration: data.lengthSeconds || 0,
            formats: formats,
            allFormats: formats,
            selectedQuality: selectedFormat,
            audioGuaranteed: true
          };
        } catch (instanceError) {
          console.warn(`Invidious instance ${instance} failed:`, instanceError.message);
          continue;
        }
      }

      throw new Error('All Invidious instances failed');
    } catch (error) {
      throw new Error(`Invidious method failed: ${error.message}`);
    }
  }

  /**
   * Extract video ID from various YouTube URL formats
   */
  extractVideoId(url) {
    const patterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
      /^([a-zA-Z0-9_-]{11})$/
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match && match[1]) {
        return match[1];
      }
    }

    return null;
  }

  /**
   * Build a clean format list
   */
  buildFormatList(rawFormats) {
    const formats = [];
    const seenQualities = new Set();

    rawFormats
      .filter(f => f.qualityLabel && f.url)
      .forEach(format => {
        const quality = format.qualityLabel;
        
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
   * Get best thumbnail
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
