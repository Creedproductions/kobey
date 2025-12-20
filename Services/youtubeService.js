const axios = require("axios");

class YouTubeDownloader {
  constructor() {
    this.youtubeApiKey = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
    this.youtubeBaseUrl = 'https://youtubei.googleapis.com/youtubei/v1/player';
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

  normalizeYouTubeUrl(url) {
    if (url.includes('youtu.be/')) {
      const videoId = url.split('youtu.be/')[1].split('?')[0].split('&')[0];
      return `https://www.youtube.com/watch?v=${videoId}`;
    }
    if (url.includes('m.youtube.com')) {
      return url.replace('m.youtube.com', 'www.youtube.com');
    }
    return url;
  }

  /**
   * CRITICAL FIX: Better response inspection
   */
  async fetchWithYouTubeApi(videoId, attempts = 1) {
    const url = `${this.youtubeBaseUrl}?key=${this.youtubeApiKey}`;

    const clients = [
      {
        name: 'ANDROID_TESTSUITE',
        clientName: 'ANDROID_TESTSUITE',
        clientVersion: '1.9',
        androidSdkVersion: 30,
        headers: {
          'Content-Type': 'application/json',
          'X-YouTube-Client-Name': '30',
          'X-YouTube-Client-Version': '1.9',
          'User-Agent': 'com.google.android.youtube/'
        }
      },
      {
        name: 'ANDROID_EMBEDDED',
        clientName: 'ANDROID_EMBEDDED_PLAYER',
        clientVersion: '19.13.36',
        headers: {
          'Content-Type': 'application/json',
          'X-YouTube-Client-Name': '55',
          'X-YouTube-Client-Version': '19.13.36',
          'User-Agent': 'com.google.android.youtube/19.13.36'
        }
      },
      {
        name: 'ANDROID',
        clientName: 'ANDROID',
        clientVersion: '19.17.34',
        androidSdkVersion: 30,
        headers: {
          'Content-Type': 'application/json',
          'X-YouTube-Client-Name': '3',
          'X-YouTube-Client-Version': '19.17.34',
          'User-Agent': 'com.google.android.youtube/19.17.34 (Linux; U; Android 13) gzip'
        }
      },
      {
        name: 'IOS',
        clientName: 'IOS',
        clientVersion: '19.09.3',
        deviceModel: 'iPhone14,3',
        headers: {
          'Content-Type': 'application/json',
          'X-YouTube-Client-Name': '5',
          'X-YouTube-Client-Version': '19.09.3',
          'User-Agent': 'com.google.ios.youtube/19.09.3 (iPhone14,3; U; CPU iOS 15_6 like Mac OS X)'
        }
      },
      {
        name: 'WEB',
        clientName: 'WEB',
        clientVersion: '2.20230728.00.00',
        headers: {
          'Content-Type': 'application/json',
          'X-YouTube-Client-Name': '1',
          'X-YouTube-Client-Version': '2.20230728.00.00',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
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

        // Add Android SDK version if present
        if (client.androidSdkVersion) {
          body.context.client.androidSdkVersion = client.androidSdkVersion;
        }

        // Add device model if present
        if (client.deviceModel) {
          body.context.client.deviceModel = client.deviceModel;
        }

        console.log(`🔄 Trying ${client.name} client...`);

        const response = await axios.post(url, body, {
          headers: client.headers,
          timeout: 30000
        });

        const data = response.data;

        // CRITICAL: Log what we actually got
        console.log(`📦 ${client.name} Response keys:`, Object.keys(data));

        if (data.playabilityStatus) {
          console.log(`📊 Playability: ${data.playabilityStatus.status}`);
          if (data.playabilityStatus.reason) {
            console.log(`⚠️ Reason: ${data.playabilityStatus.reason}`);
          }
        }

        // Check for streaming data
        if (data.streamingData) {
          const formats = data.streamingData.formats || [];
          const adaptiveFormats = data.streamingData.adaptiveFormats || [];

          console.log(`✅ ${client.name} HAS streaming data!`);
          console.log(`   Combined formats: ${formats.length}`);
          console.log(`   Adaptive formats: ${adaptiveFormats.length}`);

          if (formats.length > 0 || adaptiveFormats.length > 0) {
            return this.processYouTubeApiData(data, videoId);
          }
        } else {
          console.warn(`❌ ${client.name}: NO streamingData in response`);

          // Log what we got instead
          if (data.videoDetails) {
            console.log(`   BUT we have videoDetails: "${data.videoDetails.title}"`);
          }
        }

      } catch (error) {
        console.error(`❌ ${client.name} failed:`, error.message);
        if (error.response) {
          console.error(`   Status: ${error.response.status}`);
          console.error(`   Keys:`, Object.keys(error.response.data || {}));
        }
        continue;
      }
    }

    throw new Error('All YouTube API clients failed - no streaming data available');
  }

  processYouTubeApiData(data, videoId) {
    const formats = [];

    if (data.streamingData) {
      if (data.streamingData.formats) formats.push(...data.streamingData.formats);
      if (data.streamingData.adaptiveFormats) formats.push(...data.streamingData.adaptiveFormats);
    }

    // If we got video details but no formats, create a browser fallback
    if (formats.length === 0 && data.videoDetails) {
      console.warn('⚠️ No formats available - creating browser fallback');
      return {
        title: data.videoDetails.title || "YouTube Video",
        thumbnail: data.videoDetails.thumbnail?.thumbnails?.[0]?.url ||
            `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
        duration: data.videoDetails.lengthSeconds || 0,
        description: data.videoDetails.shortDescription || '',
        author: data.videoDetails.author || '',
        viewCount: data.videoDetails.viewCount || 0,
        formats: [{
          quality: 'Browser',
          qualityNum: 360,
          url: `https://www.youtube.com/watch?v=${videoId}`,
          type: 'text/html',
          extension: 'browser',
          isPremium: false,
          hasAudio: true,
          isVideoOnly: false,
          isAudioOnly: false
        }],
        allFormats: [{
          quality: 'Browser',
          qualityNum: 360,
          url: `https://www.youtube.com/watch?v=${videoId}`,
          type: 'text/html',
          extension: 'browser',
          isPremium: false,
          hasAudio: true,
          isVideoOnly: false,
          isAudioOnly: false
        }],
        url: `https://www.youtube.com/watch?v=${videoId}`,
        selectedQuality: {
          quality: 'Browser',
          url: `https://www.youtube.com/watch?v=${videoId}`
        },
        audioGuaranteed: false,
        videoId: videoId,
        source: 'youtube_browser_fallback'
      };
    }

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
    }).filter(f => f.url);

    const qualityMap = new Map();
    parsedFormats.forEach(format => {
      const quality = format.qualityNum;
      if (!qualityMap.has(quality)) {
        qualityMap.set(quality, format);
      } else {
        const existing = qualityMap.get(quality);
        if (!existing.hasAudio && format.hasAudio) {
          qualityMap.set(quality, format);
        } else if (existing.hasAudio && format.hasAudio && format.bitrate > existing.bitrate) {
          qualityMap.set(quality, format);
        }
      }
    });

    const organizedFormats = Array.from(qualityMap.values()).sort((a, b) => a.qualityNum - b.qualityNum);
    const audioFormats = parsedFormats.filter(f => f.isAudioOnly);

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

    let selectedFormat = qualityOptions.find(opt => !opt.isAudioOnly && opt.qualityNum === 360 && opt.hasAudio) ||
        qualityOptions.find(opt => !opt.isAudioOnly && opt.hasAudio) ||
        qualityOptions[0];

    return {
      title: data.videoDetails?.title || "YouTube Video",
      thumbnail: data.videoDetails?.thumbnail?.thumbnails?.[0]?.url || `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
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

  getExtensionFromType(mimeType) {
    if (!mimeType) return 'mp4';
    const typeMap = {
      'video/mp4': 'mp4',
      'video/webm': 'webm',
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

    while (attempts < maxAttempts) {
      attempts++;
      try {
        console.log(`🔄 Attempt ${attempts}/${maxAttempts}...`);
        const result = await this.fetchWithYouTubeApi(videoId, attempts);
        console.log(`✅ SUCCESS with ${result.formats.length} formats (source: ${result.source})`);
        return result;
      } catch (error) {
        lastError = error;
        console.error(`❌ Attempt ${attempts} failed:`, error.message);

        if (attempts < maxAttempts) {
          const backoffMs = Math.min(1000 * Math.pow(2, attempts - 1), 8000);
          console.log(`⏳ Waiting ${backoffMs/1000}s before retry...`);
          await new Promise(resolve => setTimeout(resolve, backoffMs));
        }
      }
    }

    throw new Error(`All ${maxAttempts} attempts failed: ${lastError?.message || 'Unknown error'}`);
  }
}

const youtubeDownloader = new YouTubeDownloader();

async function fetchYouTubeData(url) {
  return youtubeDownloader.fetchYouTubeData(url);
}

async function testYouTube() {
  try {
    const testUrl = 'https://youtu.be/dQw4w9WgXcQ';
    console.log(`\n🧪 Testing YouTube downloader with: ${testUrl}\n`);

    const data = await fetchYouTubeData(testUrl);

    console.log('\n✅ TEST PASSED');
    console.log(`📺 Title: ${data.title}`);
    console.log(`📊 Formats: ${data.formats.length}`);
    console.log(`🎯 Source: ${data.source}`);

    return true;
  } catch (error) {
    console.error('\n❌ TEST FAILED:', error.message);
    return false;
  }
}

module.exports = {
  fetchYouTubeData,
  testYouTube,
  YouTubeDownloader
};