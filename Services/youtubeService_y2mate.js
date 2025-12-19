const axios = require('axios');

class YouTubeDownloader {
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

  async tryYouTubeTranscript(videoId) {
    try {
      console.log('🔄 Trying YouTube Transcript API...');

      // This API provides video info and download links
      const response = await axios.get(
          `https://youtube-transcript3.p.rapidapi.com/api/youtube/video/${videoId}`,
          {
            headers: {
              'X-RapidAPI-Host': 'youtube-transcript3.p.rapidapi.com',
              'X-RapidAPI-Key': 'your-key-here' // Free tier available
            },
            timeout: 15000
          }
      );

      if (response.data && response.data.video) {
        console.log('✅ Got video data from API');
        const video = response.data.video;

        // Build quality options
        const qualities = [];

        // Add standard qualities pointing to video ID
        // These will be handled by your existing download logic
        qualities.push(
            {
              quality: '360p',
              qualityNum: 360,
              url: `https://www.youtube.com/watch?v=${videoId}`,
              type: 'video/mp4',
              extension: 'mp4',
              isPremium: false,
              hasAudio: true
            },
            {
              quality: '480p',
              qualityNum: 480,
              url: `https://www.youtube.com/watch?v=${videoId}`,
              type: 'video/mp4',
              extension: 'mp4',
              isPremium: true,
              hasAudio: true
            },
            {
              quality: '720p',
              qualityNum: 720,
              url: `https://www.youtube.com/watch?v=${videoId}`,
              type: 'video/mp4',
              extension: 'mp4',
              isPremium: true,
              hasAudio: true
            }
        );

        return {
          title: video.title || "YouTube Video",
          thumbnail: video.thumbnail || `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
          duration: video.duration || 0,
          description: video.description || '',
          author: video.channelTitle || '',
          viewCount: video.viewCount || 0,
          formats: qualities,
          allFormats: qualities,
          url: `https://www.youtube.com/watch?v=${videoId}`,
          selectedQuality: qualities[0],
          audioGuaranteed: true,
          videoId: videoId,
          source: 'youtube_api',
          requiresBrowser: true // Signal to Flutter to open in browser
        };
      }

      throw new Error('No video data received');
    } catch (error) {
      console.error('❌ YouTube API failed:', error.message);
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
      return await this.tryYouTubeTranscript(videoId);
    } catch (error) {
      console.error('❌ All methods failed:', error.message);

      // Fallback: Return browser-based solution
      const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;

      return {
        title: "YouTube Video",
        thumbnail: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
        duration: 0,
        description: 'Open in browser to download',
        author: '',
        viewCount: 0,
        formats: [
          {
            quality: '360p',
            qualityNum: 360,
            url: watchUrl,
            type: 'video/mp4',
            extension: 'mp4',
            isPremium: false,
            hasAudio: true,
            requiresBrowser: true
          },
          {
            quality: '480p',
            qualityNum: 480,
            url: watchUrl,
            type: 'video/mp4',
            extension: 'mp4',
            isPremium: true,
            hasAudio: true,
            requiresBrowser: true
          },
          {
            quality: '720p',
            qualityNum: 720,
            url: watchUrl,
            type: 'video/mp4',
            extension: 'mp4',
            isPremium: true,
            hasAudio: true,
            requiresBrowser: true
          }
        ],
        allFormats: [
          {
            quality: '360p',
            qualityNum: 360,
            url: watchUrl,
            type: 'video/mp4',
            extension: 'mp4',
            isPremium: false,
            hasAudio: true,
            requiresBrowser: true
          },
          {
            quality: '480p',
            qualityNum: 480,
            url: watchUrl,
            type: 'video/mp4',
            extension: 'mp4',
            isPremium: true,
            hasAudio: true,
            requiresBrowser: true
          },
          {
            quality: '720p',
            qualityNum: 720,
            url: watchUrl,
            type: 'video/mp4',
            extension: 'mp4',
            isPremium: true,
            hasAudio: true,
            requiresBrowser: true
          }
        ],
        url: watchUrl,
        selectedQuality: {
          quality: '360p',
          qualityNum: 360,
          url: watchUrl,
          isPremium: false,
          hasAudio: true,
          requiresBrowser: true
        },
        audioGuaranteed: true,
        videoId: videoId,
        source: 'browser_fallback',
        requiresBrowser: true
      };
    }
  }
}

const youtubeDownloader = new YouTubeDownloader();

async function fetchYouTubeData(url) {
  return youtubeDownloader.fetchYouTubeData(url);
}

module.exports = {
  fetchYouTubeData,
  YouTubeDownloader
};