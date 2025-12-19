const axios = require("axios");

class YouTubeDownloader {
  constructor() {
    this.youtubeApiKey = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
    this.youtubeBaseUrl = 'https://youtubei.googleapis.com/youtubei/v1/player';
    this.vidFlyApiUrl = "https://api.vidfly.ai/api/media/youtube/download";
  }

  /**
   * Extract YouTube video ID from various URL formats
   */
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

      if (pathname.includes('embed/')) {
        const id = pathname.split('embed/')[1]?.split(/[?&/#]/)[0];
        if (id && id.length === 11) return id;
      }

      const regexPatterns = [
        /(?:v=|\/)([0-9A-Za-z_-]{11})/,
        /youtu\.be\/([0-9A-Za-z_-]{11})/,
        /embed\/([0-9A-Za-z_-]{11})/,
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

  /**
   * Normalize various YouTube URL formats
   */
  normalizeYouTubeUrl(url) {
    if (url.includes('youtu.be/')) {
      const videoId = url.split('youtu.be/')[1].split('?')[0].split('&')[0];
      return `https://www.youtube.com/watch?v=${videoId}`;
    }

    if (url.includes('m.youtube.com')) {
      return url.replace('m.youtube.com', 'www.youtube.com');
    }

    if (url.includes('/shorts/')) {
      return url;
    }

    if (url.includes('youtube.com/watch') && !url.includes('www.youtube.com')) {
      return url.replace('youtube.com', 'www.youtube.com');
    }

    return url;
  }

  /**
   * Get random user agent to avoid rate limiting
   */
  getRandomUserAgent() {
    const userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.1 Safari/605.1.15',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:94.0) Gecko/20100101 Firefox/94.0',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 15_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.1 Mobile/15E148 Safari/604.1'
    ];

    return userAgents[Math.floor(Math.random() * userAgents.length)];
  }

  /**
   * Extract quality number from quality label
   */
  extractQualityNumber(qualityLabel) {
    if (!qualityLabel) return 0;

    const match = qualityLabel.match(/(\d+)p/);
    if (match) return parseInt(match[1]);

    if (qualityLabel.includes('1440') || qualityLabel.includes('2k')) return 1440;
    if (qualityLabel.includes('2160') || qualityLabel.includes('4k')) return 2160;
    if (qualityLabel.includes('1080')) return 1080;
    if (qualityLabel.includes('720')) return 720;
    if (qualityLabel.includes('480')) return 480;
    if (qualityLabel.includes('360')) return 360;
    if (qualityLabel.includes('240')) return 240;
    if (qualityLabel.includes('144')) return 144;

    return 0;
  }

  /**
   * Get file extension from MIME type
   */
  getExtensionFromType(mimeType) {
    if (!mimeType) return 'mp4';

    const typeMap = {
      'video/mp4': 'mp4',
      'video/webm': 'webm',
      'video/x-flv': 'flv',
      'audio/mp4': 'm4a',
      'audio/mpeg': 'mp3',
      'audio/webm': 'webm',
      'audio/ogg': 'ogg'
    };

    for (const [type, ext] of Object.entries(typeMap)) {
      if (mimeType.includes(type)) return ext;
    }

    return 'mp4';
  }

  /**
   * Method 1: Fetch using YouTube's internal API (more reliable for 360p+)
   */
  async fetchWithYouTubeApi(videoId, attempts = 1) {
    const url = `${this.youtubeBaseUrl}?key=${this.youtubeApiKey}`;

    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': this.getRandomUserAgent()
    };

    // Try multiple clients to get combined formats
    const clients = [
      {
        name: 'WEB',
        clientName: 'WEB',
        clientVersion: '2.20231219.01.00'
      },
      {
        name: 'ANDROID',
        clientName: 'ANDROID',
        clientVersion: '19.09.36'
      },
      {
        name: 'IOS',
        clientName: 'IOS',
        clientVersion: '19.09.3'
      }
    ];

    for (const client of clients) {
      try {
        const body = {
          context: {
            client: {
              clientName: client.clientName,
              clientVersion: client.clientVersion,
              hl: 'en',
              gl: 'US'
            }
          },
          videoId: videoId
        };

        const response = await axios.post(url, body, {
          headers: headers,
          timeout: 30000 + ((attempts - 1) * 10000)
        });

        const data = response.data;

        // Check if this client provides combined formats
        const hasCombinedFormats = data.streamingData?.formats &&
            data.streamingData.formats.length > 0;

        if (hasCombinedFormats) {
          console.log(`✅ YouTube API (${client.name}): Combined formats available`);
          return this.processYouTubeApiData(data, videoId);
        } else if (data.streamingData?.adaptiveFormats) {
          console.log(`⚠️ YouTube API (${client.name}): Only adaptive formats available`);
          return this.processYouTubeApiData(data, videoId);
        }
      } catch (error) {
        console.error(`❌ YouTube API (${client.name}) error:`, error.message);
        continue;
      }
    }

    throw new Error('All YouTube API clients failed');
  }

  /**
   * Process YouTube API data into uniform format
   */
  processYouTubeApiData(data, videoId) {
    const formats = [];

    if (data.streamingData) {
      if (data.streamingData.formats) {
        formats.push(...data.streamingData.formats);
      }

      if (data.streamingData.adaptiveFormats) {
        formats.push(...data.streamingData.adaptiveFormats);
      }
    }

    // Parse formats
    const parsedFormats = formats.map(format => {
      const hasVideo = format.mimeType?.includes('video');
      const hasAudio = format.mimeType?.includes('audio');
      const qualityLabel = format.qualityLabel || '';
      const qualityNum = this.extractQualityNumber(qualityLabel);

      return {
        itag: format.itag,
        label: qualityLabel || `${qualityNum}p` || 'unknown',
        qualityNum: qualityNum,
        url: format.url,
        mimeType: format.mimeType,
        type: format.mimeType?.includes('audio') ? 'audio only' :
            format.mimeType?.includes('video') ? 'video only' : 'unknown',
        filesize: format.contentLength,
        bitrate: format.bitrate,
        hasAudio: hasAudio && !hasVideo ? false : hasAudio,
        hasVideo: hasVideo,
        isVideoOnly: hasVideo && !hasAudio,
        isAudioOnly: hasAudio && !hasVideo,
        width: format.width,
        height: format.height
      };
    }).filter(f => f.url); // Only keep formats with URLs

    // Group by quality and prioritize combined formats
    const qualityMap = new Map();

    parsedFormats.forEach(format => {
      const quality = format.qualityNum;

      if (!qualityMap.has(quality)) {
        qualityMap.set(quality, format);
      } else {
        // Prefer formats with audio
        const existing = qualityMap.get(quality);
        if (!existing.hasAudio && format.hasAudio) {
          qualityMap.set(quality, format);
        }
        // If both have audio, prefer higher bitrate
        else if (existing.hasAudio && format.hasAudio && format.bitrate > existing.bitrate) {
          qualityMap.set(quality, format);
        }
      }
    });

    // Convert to array and sort
    const organizedFormats = Array.from(qualityMap.values())
        .sort((a, b) => a.qualityNum - b.qualityNum);

    // Get audio-only formats
    const audioFormats = parsedFormats.filter(f => f.isAudioOnly);

    // Create quality options
    const qualityOptions = organizedFormats.map(format => {
      const isPremium = format.qualityNum > 360;

      return {
        quality: format.label,
        qualityNum: format.qualityNum,
        url: format.url,
        type: format.mimeType,
        extension: this.getExtensionFromType(format.mimeType),
        filesize: format.filesize || 'unknown',
        isPremium: isPremium,
        hasAudio: format.hasAudio,
        isVideoOnly: format.isVideoOnly,
        isAudioOnly: format.isAudioOnly,
        bitrate: format.bitrate
      };
    });

    // Add audio formats at the end
    audioFormats.forEach(audio => {
      qualityOptions.push({
        quality: audio.label,
        qualityNum: 0,
        url: audio.url,
        type: audio.mimeType,
        extension: this.getExtensionFromType(audio.mimeType),
        filesize: audio.filesize || 'unknown',
        isPremium: false,
        hasAudio: true,
        isVideoOnly: false,
        isAudioOnly: true,
        bitrate: audio.bitrate
      });
    });

    // Select default format (prioritize 360p with audio)
    let selectedFormat = qualityOptions.find(opt =>
            !opt.isAudioOnly && opt.qualityNum === 360 && opt.hasAudio
        ) || qualityOptions.find(opt => !opt.isAudioOnly && opt.hasAudio) ||
        qualityOptions[0];

    return {
      title: data.videoDetails?.title || "YouTube Video",
      thumbnail: data.videoDetails?.thumbnail?.thumbnails?.[0]?.url ||
          `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
      duration: data.videoDetails?.lengthSeconds || 0,
      description: data.videoDetails?.shortDescription || '',
      author: data.videoDetails?.author || '',
      viewCount: data.videoDetails?.viewCount || 0,
      formats: qualityOptions,
      allFormats: qualityOptions,
      url: selectedFormat?.url || null,
      selectedQuality: selectedFormat,
      audioGuaranteed: selectedFormat?.hasAudio || false,
      videoId: videoId,
      source: 'youtube_api'
    };
  }

  /**
   * Method 2: Fallback to VidFly API
   */
  async fetchWithVidFlyApi(url, attemptNum) {
    try {
      const timeout = 30000 + ((attemptNum - 1) * 10000);

      const res = await axios.get(
          this.vidFlyApiUrl,
          {
            params: { url },
            headers: {
              accept: "*/*",
              "content-type": "application/json",
              "x-app-name": "vidfly-web",
              "x-app-version": "1.0.0",
              Referer: "https://vidfly.ai/",
              "User-Agent": this.getRandomUserAgent(),
            },
            timeout: timeout,
          }
      );

      const data = res.data?.data;
      if (!data || !data.items || !data.title) {
        throw new Error("Invalid response from VidFly API");
      }

      return this.processVidFlyData(data, url);
    } catch (error) {
      console.error(`❌ VidFly API error:`, error.message);
      throw error;
    }
  }

  /**
   * Process VidFly API data
   */
  processVidFlyData(data, url) {
    const isShorts = url.includes('/shorts/');
    const availableFormats = data.items.filter(item => item.url && item.url.length > 0);

    // Map formats
    const formatWithAudioInfo = availableFormats.map(item => {
      const label = (item.label || '').toLowerCase();
      const type = (item.type || '').toLowerCase();

      const isVideoOnly = label.includes('video only') ||
          label.includes('vid only') ||
          label.includes('without audio') ||
          type.includes('video only');

      const isAudioOnly = label.includes('audio only') ||
          type.includes('audio only') ||
          label.includes('audio') && !label.includes('video');

      return {
        ...item,
        hasAudio: !isVideoOnly && !isAudioOnly,
        isVideoOnly: isVideoOnly,
        isAudioOnly: isAudioOnly,
        qualityNum: this.extractQualityNumber(item.label || '')
      };
    });

    // Create quality options
    const qualityOptions = formatWithAudioInfo.map(format => {
      const qualityNum = format.qualityNum;
      const isPremium = !format.isAudioOnly && qualityNum > 360;

      return {
        quality: format.label || 'unknown',
        qualityNum: qualityNum,
        url: format.url,
        type: format.type || 'video/mp4',
        extension: format.ext || format.extension || this.getExtensionFromType(format.type),
        filesize: format.filesize || 'unknown',
        isPremium: isPremium,
        hasAudio: format.hasAudio,
        isVideoOnly: format.isVideoOnly,
        isAudioOnly: format.isAudioOnly
      };
    });

    // Sort by quality
    qualityOptions.sort((a, b) => {
      if (a.isAudioOnly && !b.isAudioOnly) return 1;
      if (!a.isAudioOnly && b.isAudioOnly) return -1;
      return a.qualityNum - b.qualityNum;
    });

    // Select default format
    let selectedFormat = qualityOptions.find(opt => !opt.isAudioOnly && opt.qualityNum === 360) ||
        qualityOptions.find(opt => !opt.isAudioOnly) ||
        qualityOptions[0];

    return {
      title: data.title,
      thumbnail: data.cover,
      duration: data.duration,
      isShorts: isShorts,
      formats: qualityOptions,
      allFormats: qualityOptions,
      url: selectedFormat?.url || null,
      selectedQuality: selectedFormat,
      audioGuaranteed: selectedFormat?.hasAudio || false,
      source: 'vidfly_api'
    };
  }

  /**
   * Main fetch function with fallback strategies
   */
  async fetchYouTubeData(url) {
    const normalizedUrl = this.normalizeYouTubeUrl(url);
    const videoId = this.extractYouTubeId(normalizedUrl);

    if (!videoId) {
      throw new Error('Invalid YouTube URL');
    }

    console.log(`🎬 Processing YouTube video: ${videoId}`);

    let attempts = 0;
    const maxAttempts = 3;
    let lastError = null;

    // Strategy 1: Try YouTube API first (best for 360p+ with audio)
    while (attempts < maxAttempts) {
      attempts++;
      try {
        console.log(`🔄 Attempt ${attempts}/${maxAttempts} with YouTube API...`);
        const result = await this.fetchWithYouTubeApi(videoId, attempts);
        console.log(`✅ YouTube API succeeded with ${result.formats.length} formats`);
        return result;
      } catch (error) {
        lastError = error;
        console.error(`❌ YouTube API attempt ${attempts} failed:`, error.message);

        if (attempts < maxAttempts) {
          const backoffMs = Math.min(1000 * Math.pow(2, attempts - 1), 8000);
          console.log(`⏳ Waiting ${backoffMs/1000}s before retry...`);
          await new Promise(resolve => setTimeout(resolve, backoffMs));
        }
      }
    }

    // Strategy 2: Fallback to VidFly API
    attempts = 0;
    while (attempts < maxAttempts) {
      attempts++;
      try {
        console.log(`🔄 Attempt ${attempts}/${maxAttempts} with VidFly API...`);
        const result = await this.fetchWithVidFlyApi(normalizedUrl, attempts);
        console.log(`✅ VidFly API succeeded with ${result.formats.length} formats`);
        return result;
      } catch (error) {
        lastError = error;
        console.error(`❌ VidFly API attempt ${attempts} failed:`, error.message);

        if (attempts < maxAttempts) {
          const backoffMs = Math.min(1000 * Math.pow(2, attempts - 1), 8000);
          console.log(`⏳ Waiting ${backoffMs/1000}s before retry...`);
          await new Promise(resolve => setTimeout(resolve, backoffMs));
        }
      }
    }

    // If all fails, return error
    throw new Error(`All download methods failed after ${maxAttempts * 2} total attempts: ${lastError?.message || 'Unknown error'}`);
  }
}

// Create singleton instance
const youtubeDownloader = new YouTubeDownloader();

// Export main function
async function fetchYouTubeData(url) {
  return youtubeDownloader.fetchYouTubeData(url);
}

// Test function
async function testYouTube() {
  try {
    // Test with a known YouTube URL
    const testUrl = 'https://youtu.be/dQw4w9WgXcQ'; // Rick Astley - Never Gonna Give You Up
    const data = await fetchYouTubeData(testUrl);
    console.log('✅ YouTube downloader test passed');
    console.log(`Title: ${data.title}`);
    console.log(`Formats: ${data.formats.length}`);
    console.log(`Source: ${data.source}`);

    // Log available formats
    console.log('\n📋 Available formats:');
    data.formats.forEach((format, index) => {
      const audioIcon = format.hasAudio ? '🎵' : '🔇';
      const premiumIcon = format.isPremium ? '💰' : '🆓';
      console.log(`${index + 1}. ${format.quality} ${audioIcon} ${premiumIcon} ${format.filesize || '?'} ${format.type?.split(';')[0]}`);
    });

    return true;
  } catch (error) {
    console.error('❌ YouTube downloader test failed:', error.message);
    return false;
  }
}

module.exports = {
  fetchYouTubeData,
  testYouTube,
  YouTubeDownloader
};