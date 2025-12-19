const axios = require("axios");
const fs = require('fs');
const path = require('path');

class YouTubeDownloader {
  constructor() {
    this.youtubeApiKey = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
    this.youtubeBaseUrl = 'https://youtubei.googleapis.com/youtubei/v1/player';
    this.vidFlyApiUrl = "https://api.vidfly.ai/api/media/youtube/download";
    this.alternateApis = [
      "https://api.riverside.rocks/api/v1/youtube/download",
      "https://yt-api.p.rapidapi.com/dl",
      "https://youtube-mp36.p.rapidapi.com/dl"
    ];
  }

  /**
   * Extract YouTube video ID from various URL formats
   */
  extractYouTubeId(url) {
    try {
      // Remove query parameters and fragments first
      const cleanUrl = url.split('?')[0].split('#')[0];

      // Common patterns
      const patterns = [
        /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i,
        /youtube\.com\/shorts\/([^"&?\/\s]{11})/i,
        /youtube\.com\/live\/([^"&?\/\s]{11})/i,
        /youtube\.com\/embed\/([^"&?\/\s]{11})/i
      ];

      for (const pattern of patterns) {
        const match = cleanUrl.match(pattern);
        if (match && match[1]) {
          return match[1];
        }
      }

      // Fallback: Direct video ID extraction
      const directId = cleanUrl.match(/(?:^|\/|v=)([0-9A-Za-z_-]{11})(?:$|\?|&|#)/);
      if (directId && directId[1]) {
        return directId[1];
      }

      return null;
    } catch (error) {
      console.error("URL parsing error:", error.message);
      return null;
    }
  }

  /**
   * Normalize YouTube URL
   */
  normalizeYouTubeUrl(url) {
    if (!url) return url;

    // Ensure it starts with https://
    if (!url.startsWith('http')) {
      url = 'https://' + url;
    }

    // Convert youtu.be to youtube.com
    if (url.includes('youtu.be/')) {
      const videoId = url.split('youtu.be/')[1].split(/[?&#]/)[0];
      return `https://www.youtube.com/watch?v=${videoId}`;
    }

    // Convert mobile URLs
    if (url.includes('m.youtube.com')) {
      return url.replace('m.youtube.com', 'www.youtube.com');
    }

    // Handle shorts
    if (url.includes('/shorts/')) {
      const videoId = url.split('/shorts/')[1].split(/[?&#]/)[0];
      return `https://www.youtube.com/watch?v=${videoId}`;
    }

    // Ensure www prefix
    if (url.includes('youtube.com') && !url.includes('www.youtube.com')) {
      return url.replace('youtube.com', 'www.youtube.com');
    }

    return url;
  }

  /**
   * Get random user agent
   */
  getRandomUserAgent() {
    const userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
      'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.144 Mobile Safari/537.36'
    ];

    return userAgents[Math.floor(Math.random() * userAgents.length)];
  }

  /**
   * Extract quality number from label
   */
  extractQualityNumber(qualityLabel) {
    if (!qualityLabel) return 0;

    // Common patterns
    const patterns = [
      /(\d+)\s*p/i,
      /(\d+)\s*k/i,
      /(\d+)\s*resolution/i,
      /hd\s*(\d+)/i,
      /(\d+)\s*x\s*\d+/i
    ];

    for (const pattern of patterns) {
      const match = qualityLabel.match(pattern);
      if (match && match[1]) {
        const num = parseInt(match[1]);
        if (num > 0) return num;
      }
    }

    // Known quality keywords
    const qualityMap = {
      '4k': 2160,
      '2160p': 2160,
      '2k': 1440,
      '1440p': 1440,
      '1080p': 1080,
      '720p': 720,
      '480p': 480,
      '360p': 360,
      '240p': 240,
      '144p': 144,
      'high': 720,
      'medium': 360,
      'low': 144
    };

    const lowerLabel = qualityLabel.toLowerCase();
    for (const [key, value] of Object.entries(qualityMap)) {
      if (lowerLabel.includes(key)) {
        return value;
      }
    }

    return 0;
  }

  /**
   * Get file extension from type
   */
  getExtensionFromType(mimeType) {
    if (!mimeType) return 'mp4';

    const typeMap = {
      'video/mp4': 'mp4',
      'video/webm': 'webm',
      'video/x-flv': 'flv',
      'video/3gpp': '3gp',
      'video/quicktime': 'mov',
      'video/x-msvideo': 'avi',
      'audio/mp4': 'm4a',
      'audio/mpeg': 'mp3',
      'audio/webm': 'webm',
      'audio/ogg': 'ogg',
      'audio/wav': 'wav'
    };

    for (const [type, ext] of Object.entries(typeMap)) {
      if (mimeType.includes(type)) {
        return ext;
      }
    }

    return 'mp4';
  }

  /**
   * Try YouTube's internal API
   */
  async tryYouTubeApi(videoId, attempt = 1) {
    const url = `${this.youtubeBaseUrl}?key=${this.youtubeApiKey}`;

    const clients = [
      {
        name: 'ANDROID',
        clientName: 'ANDROID',
        clientVersion: '19.09.36',
        androidSdkVersion: 33
      },
      {
        name: 'IOS',
        clientName: 'IOS',
        clientVersion: '19.09.3',
        deviceModel: 'iPhone14,5'
      },
      {
        name: 'WEB',
        clientName: 'WEB',
        clientVersion: '2.20240101.00.00'
      },
      {
        name: 'MWEB',
        clientName: 'MWEB',
        clientVersion: '2.20240101.00.00'
      }
    ];

    for (const client of clients) {
      try {
        const body = {
          context: {
            client: {
              ...client,
              hl: 'en',
              gl: 'US',
              utcOffsetMinutes: 0
            }
          },
          videoId: videoId,
          playbackContext: {
            contentPlaybackContext: {
              html5Preference: "HTML5_PREF_WANTS"
            }
          },
          racyCheckOk: true,
          contentCheckOk: true
        };

        const response = await axios.post(url, body, {
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': this.getRandomUserAgent(),
            'Origin': 'https://www.youtube.com',
            'Referer': `https://www.youtube.com/watch?v=${videoId}`
          },
          timeout: 15000
        });

        const data = response.data;

        if (data.streamingData && (data.streamingData.formats || data.streamingData.adaptiveFormats)) {
          console.log(`✅ YouTube API (${client.name}) succeeded`);
          return data;
        }
      } catch (error) {
        console.log(`⚠️ YouTube API (${client.name}) failed: ${error.message}`);
        continue;
      }
    }

    throw new Error('All YouTube API clients failed');
  }

  /**
   * Process YouTube API data
   */
  processYouTubeData(data, videoId) {
    try {
      const formats = [];

      // Process progressive formats (video + audio)
      if (data.streamingData?.formats) {
        data.streamingData.formats.forEach(format => {
          if (format.url || format.signatureCipher) {
            const qualityLabel = format.qualityLabel || `${format.height}p` || 'unknown';
            const qualityNum = this.extractQualityNumber(qualityLabel);

            formats.push({
              label: qualityLabel,
              qualityNum: qualityNum,
              url: format.url || this.decodeSignatureCipher(format.signatureCipher),
              mimeType: format.mimeType,
              type: 'video',
              filesize: format.contentLength,
              bitrate: format.bitrate,
              hasAudio: true,
              hasVideo: true,
              isVideoOnly: false,
              isAudioOnly: false,
              width: format.width,
              height: format.height,
              fps: format.fps,
              quality: qualityLabel,
              extension: this.getExtensionFromType(format.mimeType)
            });
          }
        });
      }

      // Process adaptive formats
      if (data.streamingData?.adaptiveFormats) {
        data.streamingData.adaptiveFormats.forEach(format => {
          const mimeType = format.mimeType || '';
          const isAudioOnly = mimeType.includes('audio');
          const isVideoOnly = mimeType.includes('video') && !mimeType.includes('audio');

          let qualityLabel = format.qualityLabel || '';
          if (!qualityLabel && format.height) {
            qualityLabel = `${format.height}p`;
          }
          if (!qualityLabel && isAudioOnly) {
            qualityLabel = format.audioQuality || 'Audio';
          }

          const qualityNum = isAudioOnly ? 0 : this.extractQualityNumber(qualityLabel);

          formats.push({
            label: qualityLabel,
            qualityNum: qualityNum,
            url: format.url || this.decodeSignatureCipher(format.signatureCipher),
            mimeType: format.mimeType,
            type: isAudioOnly ? 'audio' : 'video',
            filesize: format.contentLength,
            bitrate: format.bitrate,
            hasAudio: !isVideoOnly,
            hasVideo: !isAudioOnly,
            isVideoOnly: isVideoOnly,
            isAudioOnly: isAudioOnly,
            width: format.width,
            height: format.height,
            fps: format.fps,
            quality: qualityLabel,
            extension: this.getExtensionFromType(format.mimeType)
          });
        });
      }

      // Filter and deduplicate
      const validFormats = formats.filter(f => f.url && f.url.length > 0);
      const uniqueFormats = this.deduplicateFormats(validFormats);

      // Sort formats
      const videoFormats = uniqueFormats
          .filter(f => !f.isAudioOnly)
          .sort((a, b) => b.qualityNum - a.qualityNum);

      const audioFormats = uniqueFormats
          .filter(f => f.isAudioOnly)
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

      // Create quality options for frontend
      const qualityOptions = videoFormats.map(format => {
        const isPremium = format.qualityNum > 360;

        return {
          quality: format.label,
          qualityNum: format.qualityNum,
          url: format.url,
          type: format.mimeType,
          extension: format.extension,
          filesize: format.filesize,
          isPremium: isPremium,
          hasAudio: format.hasAudio,
          isVideoOnly: format.isVideoOnly,
          isAudioOnly: false,
          width: format.width,
          height: format.height,
          fps: format.fps,
          bitrate: format.bitrate
        };
      });

      // Add audio formats
      audioFormats.forEach(audio => {
        qualityOptions.push({
          quality: audio.label,
          qualityNum: 0,
          url: audio.url,
          type: audio.mimeType,
          extension: audio.extension,
          filesize: audio.filesize,
          isPremium: false,
          hasAudio: true,
          isVideoOnly: false,
          isAudioOnly: true,
          bitrate: audio.bitrate
        });
      });

      // Select default format (360p or nearest)
      let selectedFormat = qualityOptions.find(f => !f.isAudioOnly && f.qualityNum === 360);
      if (!selectedFormat) {
        // Find nearest to 360p
        const videoFormats = qualityOptions.filter(f => !f.isAudioOnly);
        selectedFormat = videoFormats.reduce((prev, curr) => {
          return Math.abs(curr.qualityNum - 360) < Math.abs(prev.qualityNum - 360) ? curr : prev;
        });
      }

      return {
        success: true,
        title: data.videoDetails?.title || `YouTube Video ${videoId}`,
        thumbnail: this.getBestThumbnail(data, videoId),
        duration: parseInt(data.videoDetails?.lengthSeconds) || 0,
        description: data.videoDetails?.shortDescription || '',
        author: data.videoDetails?.author || '',
        viewCount: data.videoDetails?.viewCount || '0',
        formats: qualityOptions,
        allFormats: qualityOptions,
        url: selectedFormat?.url || null,
        selectedQuality: selectedFormat,
        audioGuaranteed: selectedFormat?.hasAudio || false,
        videoId: videoId,
        source: 'youtube_api'
      };

    } catch (error) {
      console.error('Error processing YouTube data:', error);
      throw error;
    }
  }

  /**
   * Get best thumbnail
   */
  getBestThumbnail(data, videoId) {
    if (data.videoDetails?.thumbnail?.thumbnails?.length > 0) {
      const thumbnails = data.videoDetails.thumbnail.thumbnails;
      // Prefer maxres, then standard, then default
      return thumbnails.find(t => t.width >= 1280)?.url ||
          thumbnails.find(t => t.width >= 640)?.url ||
          thumbnails[0].url;
    }

    // Fallback thumbnails
    return `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
  }

  /**
   * Deduplicate formats by quality
   */
  deduplicateFormats(formats) {
    const seen = new Map();
    const result = [];

    formats.forEach(format => {
      const key = `${format.qualityNum}-${format.hasAudio}-${format.bitrate}`;

      if (!seen.has(key)) {
        seen.set(key, true);
        result.push(format);
      }
    });

    return result;
  }

  /**
   * Decode signature cipher (simplified)
   */
  decodeSignatureCipher(cipher) {
    if (!cipher) return null;

    try {
      // Simple parsing of signatureCipher
      const params = new URLSearchParams(cipher);
      const url = params.get('url');
      const sp = params.get('sp');
      const sig = params.get('s');

      if (url && sig) {
        return `${url}&${sp || 'signature'}=${sig}`;
      }
      return url;
    } catch (error) {
      console.error('Error decoding cipher:', error);
      return null;
    }
  }

  /**
   * Try alternate YouTube APIs
   */
  async tryAlternateApis(videoId) {
    for (const apiUrl of this.alternateApis) {
      try {
        console.log(`🔄 Trying alternate API: ${apiUrl.split('/')[2]}`);

        const response = await axios.get(apiUrl, {
          params: { id: videoId },
          headers: {
            'User-Agent': this.getRandomUserAgent(),
            'Accept': 'application/json'
          },
          timeout: 10000
        });

        if (response.data && response.data.formats) {
          console.log(`✅ Alternate API succeeded`);
          return response.data;
        }
      } catch (error) {
        console.log(`⚠️ Alternate API failed: ${error.message}`);
        continue;
      }
    }
    return null;
  }

  /**
   * Main fetch function
   */
  async fetchYouTubeData(url) {
    console.log(`🎬 YouTube: Processing URL: ${url}`);

    const normalizedUrl = this.normalizeYouTubeUrl(url);
    const videoId = this.extractYouTubeId(normalizedUrl);

    if (!videoId) {
      throw new Error('Invalid YouTube URL. Could not extract video ID.');
    }

    console.log(`📝 YouTube Video ID: ${videoId}`);

    const strategies = [
      { name: 'YouTube Internal API', method: () => this.tryYouTubeApi(videoId) },
      { name: 'Alternate APIs', method: () => this.tryAlternateApis(videoId) }
    ];

    for (let attempt = 1; attempt <= 3; attempt++) {
      console.log(`🔄 Attempt ${attempt}/3`);

      for (const strategy of strategies) {
        try {
          console.log(`🔍 Trying ${strategy.name}...`);
          const data = await strategy.method();

          if (data) {
            console.log(`✅ ${strategy.name} succeeded`);

            // Process data based on source
            let result;
            if (strategy.name === 'YouTube Internal API') {
              result = this.processYouTubeData(data, videoId);
            } else {
              // Process alternate API data format
              result = {
                success: true,
                title: data.title || `YouTube Video ${videoId}`,
                thumbnail: data.thumbnail || `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
                duration: data.duration || 0,
                formats: data.formats || [],
                allFormats: data.formats || [],
                url: data.url || (data.formats?.[0]?.url),
                selectedQuality: data.formats?.[0],
                audioGuaranteed: true,
                videoId: videoId,
                source: 'alternate_api'
              };
            }

            console.log(`✅ YouTube: Successfully fetched data, formats count: ${result.formats.length}`);
            return result;
          }
        } catch (error) {
          console.log(`⚠️ ${strategy.name} failed: ${error.message}`);
          // Continue to next strategy
        }
      }

      // Wait before next attempt
      if (attempt < 3) {
        const waitTime = 1000 * attempt;
        console.log(`⏳ Waiting ${waitTime}ms before next attempt...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }

    // All attempts failed
    throw new Error('Failed to fetch YouTube data after multiple attempts');
  }

  /**
   * Download video (server-side)
   */
  async downloadVideo(url, quality, outputPath = './downloads') {
    try {
      // Create downloads directory if it doesn't exist
      if (!fs.existsSync(outputPath)) {
        fs.mkdirSync(outputPath, { recursive: true });
      }

      const filename = `youtube_${Date.now()}.${quality.extension || 'mp4'}`;
      const filepath = path.join(outputPath, filename);

      console.log(`⬇️ Downloading video to: ${filepath}`);

      const response = await axios({
        method: 'GET',
        url: quality.url,
        responseType: 'stream',
        headers: {
          'User-Agent': this.getRandomUserAgent(),
          'Referer': 'https://www.youtube.com/',
          'Origin': 'https://www.youtube.com'
        },
        timeout: 300000 // 5 minutes timeout for large files
      });

      const writer = fs.createWriteStream(filepath);
      response.data.pipe(writer);

      return new Promise((resolve, reject) => {
        writer.on('finish', () => {
          console.log(`✅ Download completed: ${filepath}`);
          resolve({
            success: true,
            filepath: filepath,
            filename: filename,
            size: fs.statSync(filepath).size
          });
        });

        writer.on('error', reject);
      });

    } catch (error) {
      console.error('❌ Download failed:', error.message);
      throw error;
    }
  }
}

// Create instance and export
const youtubeDownloader = new YouTubeDownloader();

// Main export function
async function fetchYouTubeData(url) {
  return youtubeDownloader.fetchYouTubeData(url);
}

// Test function
async function testYouTube(url) {
  try {
    console.log('🧪 Testing YouTube downloader...');
    const data = await fetchYouTubeData(url);

    console.log('✅ Test passed!');
    console.log(`Title: ${data.title}`);
    console.log(`Duration: ${data.duration}s`);
    console.log(`Formats: ${data.formats.length}`);

    console.log('\n📊 Available formats:');
    data.formats.forEach((format, i) => {
      const type = format.isAudioOnly ? '🎵 Audio' :
          format.isVideoOnly ? '📹 Video Only' : '🎬 Video+Audio';
      const premium = format.isPremium ? '💰' : '🆓';
      const audio = format.hasAudio ? '🔊' : '🔇';
      console.log(`${i+1}. ${format.quality.padEnd(8)} ${type} ${audio} ${premium} ${format.filesize ? `(${Math.round(format.filesize/1024/1024)}MB)` : ''}`);
    });

    return data;
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    throw error;
  }
}

// Export
module.exports = {
  fetchYouTubeData,
  testYouTube,
  youtubeDownloader,
  downloadVideo: (url, quality) => youtubeDownloader.downloadVideo(url, quality)
};