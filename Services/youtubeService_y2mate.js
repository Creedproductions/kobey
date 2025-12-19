const axios = require('axios');

class YouTubeDownloader {
  constructor() {
    // Multiple API fallbacks for reliability
    this.apis = [
      { name: 'y2mate', url: 'https://www.y2mate.com/mates/analyzeV2/ajax' },
      { name: 'ytdl-core-proxy', url: 'https://ytdl-core-proxy.onrender.com/api/info' }
    ];
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
        /youtu\.be\/([0-9A-Za-z_-]{11})/,
        /shorts\/([0-9A-Za-z_-]{11})/
      ];

      for (const pattern of regexPatterns) {
        const match = url.match(pattern);
        if (match && match[1]) return match[1];
      }
      return null;
    } catch (error) {
      console.error("URL parsing error:", error.message);
      return null;
    }
  }

  async tryY2Mate(videoId) {
    try {
      console.log('🔄 Trying Y2Mate API...');
      
      const response = await axios.post(
        'https://www.y2mate.com/mates/analyzeV2/ajax',
        new URLSearchParams({
          k_query: `https://www.youtube.com/watch?v=${videoId}`,
          k_page: 'home',
          hl: 'en',
          q_auto: '0'
        }),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          timeout: 15000
        }
      );

      if (response.data && response.data.status === 'ok') {
        console.log('✅ Y2Mate returned data');
        
        // Parse the HTML response to get download links
        const links = response.data.links;
        if (!links || !links.mp4) {
          throw new Error('No MP4 links found');
        }

        // Convert Y2Mate format data to our format
        const qualities = [];
        
        // Add video qualities (360p free, others premium)
        for (const [quality, data] of Object.entries(links.mp4)) {
          const qualityNum = parseInt(quality) || 360;
          
          qualities.push({
            quality: `${quality}p`,
            qualityNum: qualityNum,
            url: `Y2MATE:${videoId}:${quality}:mp4:${data.k}`,  // Special format for conversion
            type: 'video/mp4',
            extension: 'mp4',
            filesize: data.size || 'unknown',
            isPremium: qualityNum > 360,
            hasAudio: true,
            isVideoOnly: false,
            isAudioOnly: false
          });
        }

        // Add audio formats
        if (links.mp3) {
          for (const [quality, data] of Object.entries(links.mp3)) {
            qualities.push({
              quality: `audio (${quality}kbps)`,
              qualityNum: 0,
              url: `Y2MATE:${videoId}:${quality}:mp3:${data.k}`,
              type: 'audio/mpeg',
              extension: 'mp3',
              filesize: data.size || 'unknown',
              isPremium: false,
              hasAudio: true,
              isVideoOnly: false,
              isAudioOnly: true
            });
          }
        }

        const defaultQuality = qualities.find(q => q.quality === '360p') || qualities[0];

        return {
          title: response.data.title || "YouTube Video",
          thumbnail: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
          duration: response.data.t || 0,
          description: '',
          author: '',
          viewCount: 0,
          formats: qualities,
          allFormats: qualities,
          url: defaultQuality.url,
          selectedQuality: defaultQuality,
          audioGuaranteed: true,
          videoId: videoId,
          source: 'y2mate'
        };
      }

      throw new Error('Y2Mate returned invalid response');
    } catch (error) {
      console.error('❌ Y2Mate failed:', error.message);
      throw error;
    }
  }

  async convertY2MateUrl(videoId, quality, format, k) {
    try {
      console.log(`🔄 Converting Y2Mate URL for ${quality}${format}...`);
      
      const response = await axios.post(
        'https://www.y2mate.com/mates/convertV2/index',
        new URLSearchParams({
          vid: videoId,
          k: k
        }),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          timeout: 30000
        }
      );

      if (response.data && response.data.status === 'ok') {
        // Extract download URL from response
        const dlink = response.data.dlink;
        if (dlink) {
          console.log('✅ Got direct download URL from Y2Mate');
          return dlink;
        }
      }

      throw new Error('Failed to get download URL');
    } catch (error) {
      console.error('❌ Y2Mate conversion failed:', error.message);
      throw error;
    }
  }

  async fetchYouTubeData(url) {
    const videoId = this.extractYouTubeId(url);
    if (!videoId) {
      throw new Error('Invalid YouTube URL');
    }

    console.log(`🎬 Processing YouTube video: ${videoId}`);

    try {
      // Try Y2Mate first
      return await this.tryY2Mate(videoId);
    } catch (error) {
      console.error('❌ All methods failed:', error.message);
      
      // Ultimate fallback: return structure that tells Flutter to open in browser
      return {
        title: "YouTube Video",
        thumbnail: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
        duration: 0,
        description: 'Unable to extract direct download link. Please use browser.',
        author: '',
        viewCount: 0,
        formats: [{
          quality: 'Browser',
          qualityNum: 0,
          url: `https://www.youtube.com/watch?v=${videoId}`,
          type: 'video/mp4',
          extension: 'mp4',
          filesize: 'unknown',
          isPremium: false,
          hasAudio: true,
          isVideoOnly: false,
          isAudioOnly: false,
          requiresBrowser: true
        }],
        allFormats: [{
          quality: 'Browser',
          qualityNum: 0,
          url: `https://www.youtube.com/watch?v=${videoId}`,
          type: 'video/mp4',
          extension: 'mp4',
          filesize: 'unknown',
          isPremium: false,
          hasAudio: true,
          isVideoOnly: false,
          isAudioOnly: false,
          requiresBrowser: true
        }],
        url: `https://www.youtube.com/watch?v=${videoId}`,
        selectedQuality: {
          quality: 'Browser',
          qualityNum: 0,
          url: `https://www.youtube.com/watch?v=${videoId}`,
          requiresBrowser: true
        },
        audioGuaranteed: false,
        videoId: videoId,
        source: 'fallback',
        error: 'Please use browser to download'
      };
    }
  }

  // Endpoint to convert Y2Mate URLs
  async getDownloadUrl(url) {
    if (url.startsWith('Y2MATE:')) {
      const parts = url.split(':');
      // Format: Y2MATE:videoId:quality:format:k
      const videoId = parts[1];
      const quality = parts[2];
      const format = parts[3];
      const k = parts[4];
      
      return await this.convertY2MateUrl(videoId, quality, format, k);
    }
    
    return url; // Already a direct URL
  }
}

const youtubeDownloader = new YouTubeDownloader();

async function fetchYouTubeData(url) {
  return youtubeDownloader.fetchYouTubeData(url);
}

async function getDownloadUrl(url) {
  return youtubeDownloader.getDownloadUrl(url);
}

module.exports = {
  fetchYouTubeData,
  getDownloadUrl,
  YouTubeDownloader
};
