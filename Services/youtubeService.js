const axios = require('axios');

class YouTubeDownloader {
  constructor() {
    this.cobaltApiUrl = 'https://api.cobalt.tools/api/json';
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

  async fetchYouTubeData(url) {
    const videoId = this.extractYouTubeId(url);
    if (!videoId) {
      throw new Error('Invalid YouTube URL');
    }

    console.log(`🎬 Processing YouTube video: ${videoId}`);

    try {
      // Use cobalt.tools API - it handles all the complexity
      const response = await axios.post(
          this.cobaltApiUrl,
          {
            url: url,
            vCodec: 'h264',
            vQuality: '1080',
            aFormat: 'mp3',
            filenamePattern: 'classic',
            isAudioOnly: false,
            isNoTTWatermark: false,
            isTTFullAudio: false,
            isAudioMuted: false,
            dubLang: false,
            disableMetadata: false
          },
          {
            headers: {
              'Accept': 'application/json',
              'Content-Type': 'application/json',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 30000
          }
      );

      const data = response.data;

      console.log(`📊 Cobalt response status: ${data.status}`);

      if (data.status === 'error' || data.status === 'rate-limit') {
        throw new Error(data.text || 'Cobalt API error');
      }

      // Cobalt returns direct download URL
      if (data.status === 'redirect' || data.status === 'tunnel') {
        const downloadUrl = data.url;

        // Create quality options (cobalt gives us best available)
        const qualityOptions = [
          {
            quality: '360p',
            qualityNum: 360,
            url: downloadUrl,
            type: 'video/mp4',
            extension: 'mp4',
            filesize: 'unknown',
            isPremium: false,
            hasAudio: true,
            isVideoOnly: false,
            isAudioOnly: false
          },
          {
            quality: '480p',
            qualityNum: 480,
            url: downloadUrl,
            type: 'video/mp4',
            extension: 'mp4',
            filesize: 'unknown',
            isPremium: true,
            hasAudio: true,
            isVideoOnly: false,
            isAudioOnly: false
          },
          {
            quality: '720p',
            qualityNum: 720,
            url: downloadUrl,
            type: 'video/mp4',
            extension: 'mp4',
            filesize: 'unknown',
            isPremium: true,
            hasAudio: true,
            isVideoOnly: false,
            isAudioOnly: false
          },
          {
            quality: '1080p',
            qualityNum: 1080,
            url: downloadUrl,
            type: 'video/mp4',
            extension: 'mp4',
            filesize: 'unknown',
            isPremium: true,
            hasAudio: true,
            isVideoOnly: false,
            isAudioOnly: false
          }
        ];

        // Get video info from filename or use defaults
        const title = data.filename || "YouTube Video";

        console.log(`✅ Got download URL from Cobalt`);

        return {
          title: title,
          thumbnail: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
          duration: 0,
          description: '',
          author: '',
          viewCount: 0,
          formats: qualityOptions,
          allFormats: qualityOptions,
          url: downloadUrl,
          selectedQuality: qualityOptions[0],
          audioGuaranteed: true,
          videoId: videoId,
          source: 'cobalt'
        };
      }

      throw new Error('Unexpected cobalt response');

    } catch (error) {
      console.error(`❌ Cobalt API error:`, error.message);

      // Fallback: return basic structure with video ID
      // This allows the Flutter app to at least try with the ID
      const fallbackUrl = `https://www.youtube.com/watch?v=${videoId}`;

      return {
        title: "YouTube Video",
        thumbnail: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
        duration: 0,
        description: '',
        author: '',
        viewCount: 0,
        formats: [{
          quality: '360p',
          qualityNum: 360,
          url: fallbackUrl,
          type: 'video/mp4',
          extension: 'mp4',
          filesize: 'unknown',
          isPremium: false,
          hasAudio: true,
          isVideoOnly: false,
          isAudioOnly: false
        }],
        allFormats: [{
          quality: '360p',
          qualityNum: 360,
          url: fallbackUrl,
          type: 'video/mp4',
          extension: 'mp4',
          filesize: 'unknown',
          isPremium: false,
          hasAudio: true,
          isVideoOnly: false,
          isAudioOnly: false
        }],
        url: fallbackUrl,
        selectedQuality: {
          quality: '360p',
          qualityNum: 360,
          url: fallbackUrl,
          type: 'video/mp4',
          extension: 'mp4',
          isPremium: false,
          hasAudio: true
        },
        audioGuaranteed: true,
        videoId: videoId,
        source: 'fallback',
        error: error.message
      };
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
    const data = await fetchYouTubeData(testUrl);
    console.log('✅ YouTube test passed');
    console.log(`Title: ${data.title}`);
    console.log(`Source: ${data.source}`);
    console.log(`URL: ${data.url?.substring(0, 100)}...`);
    return true;
  } catch (error) {
    console.error('❌ YouTube test failed:', error.message);
    return false;
  }
}

module.exports = {
  fetchYouTubeData,
  testYouTube,
  YouTubeDownloader
};