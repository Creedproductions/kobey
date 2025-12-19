const axios = require('axios');

class YouTubeDownloader {
  constructor() {
    this.innertubeApiKey = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
    this.innertubeBaseUrl = 'https://www.youtube.com/youtubei/v1/player';
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

  async fetchWithInnertube(videoId) {
    const clients = [
      {
        name: 'WEB',
        context: {
          client: {
            clientName: 'WEB',
            clientVersion: '2.20231219.01.00',
            hl: 'en',
            gl: 'US',
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
          }
        }
      },
      {
        name: 'ANDROID',
        context: {
          client: {
            clientName: 'ANDROID',
            clientVersion: '19.09.37',
            androidSdkVersion: 30,
            hl: 'en',
            gl: 'US',
            userAgent: 'com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip'
          }
        }
      },
      {
        name: 'IOS',
        context: {
          client: {
            clientName: 'IOS',
            clientVersion: '19.09.3',
            deviceMake: 'Apple',
            deviceModel: 'iPhone14,3',
            hl: 'en',
            gl: 'US',
            userAgent: 'com.google.ios.youtube/19.09.3 (iPhone14,3; U; CPU iOS 15_6 like Mac OS X)'
          }
        }
      },
      {
        name: 'MWEB',
        context: {
          client: {
            clientName: 'MWEB',
            clientVersion: '2.20231219.01.00',
            hl: 'en',
            gl: 'US',
            userAgent: 'Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'
          }
        }
      }
    ];

    for (const client of clients) {
      try {
        console.log(`🔄 Trying ${client.name} client...`);

        const response = await axios.post(
            `${this.innertubeBaseUrl}?key=${this.innertubeApiKey}`,
            {
              ...client.context,
              videoId: videoId
            },
            {
              headers: {
                'Content-Type': 'application/json',
                'User-Agent': client.context.client.userAgent,
                'Accept': '*/*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Origin': 'https://www.youtube.com',
                'Referer': 'https://www.youtube.com/'
              },
              timeout: 30000
            }
        );

        const data = response.data;

        if (data.streamingData) {
          console.log(`✅ ${client.name} client succeeded`);
          return this.processInnertubeData(data, videoId);
        }
      } catch (error) {
        console.error(`❌ ${client.name} client failed:`, error.message);
        continue;
      }
    }

    throw new Error('All clients failed to fetch video data');
  }

  processInnertubeData(data, videoId) {
    const formats = [];

    if (data.streamingData) {
      // Combined formats (video+audio, usually 360p and below)
      if (data.streamingData.formats) {
        formats.push(...data.streamingData.formats);
      }

      // Adaptive formats (video-only and audio-only)
      if (data.streamingData.adaptiveFormats) {
        formats.push(...data.streamingData.adaptiveFormats);
      }
    }

    console.log(`📊 Total formats found: ${formats.length}`);

    // Parse and categorize formats
    const videoFormats = [];
    const audioFormats = [];
    const combinedFormats = [];

    formats.forEach(format => {
      if (!format.url) return;

      const hasVideo = format.mimeType?.includes('video');
      const hasAudio = format.mimeType?.includes('audio');
      const quality = format.qualityLabel || '';
      const height = format.height || 0;

      const formatInfo = {
        itag: format.itag,
        quality: quality || `${height}p` || 'unknown',
        qualityNum: height,
        url: format.url,
        type: format.mimeType?.split(';')[0] || 'video/mp4',
        extension: format.mimeType?.includes('webm') ? 'webm' : 'mp4',
        filesize: format.contentLength || 'unknown',
        bitrate: format.bitrate || 0,
        hasVideo: hasVideo,
        hasAudio: hasAudio,
        width: format.width || 0,
        height: height
      };

      if (hasVideo && hasAudio) {
        combinedFormats.push(formatInfo);
      } else if (hasVideo && !hasAudio) {
        videoFormats.push(formatInfo);
      } else if (hasAudio && !hasVideo) {
        audioFormats.push(formatInfo);
      }
    });

    console.log(`🎬 Combined: ${combinedFormats.length}, Video-only: ${videoFormats.length}, Audio: ${audioFormats.length}`);

    // Build quality options
    const qualityOptions = [];

    // Add combined formats (360p and below, free)
    combinedFormats.forEach(format => {
      if (format.qualityNum <= 360) {
        qualityOptions.push({
          quality: format.quality,
          qualityNum: format.qualityNum,
          url: format.url,
          type: format.type,
          extension: format.extension,
          filesize: format.filesize,
          isPremium: false,
          hasAudio: true,
          isVideoOnly: false,
          isAudioOnly: false,
          bitrate: format.bitrate
        });
      }
    });

    // Add video-only formats (480p+, need merging, premium)
    const bestAudio = audioFormats.sort((a, b) => b.bitrate - a.bitrate)[0];

    videoFormats.forEach(format => {
      if (format.qualityNum >= 480 && bestAudio) {
        qualityOptions.push({
          quality: format.quality,
          qualityNum: format.qualityNum,
          url: `MERGE:${format.url}:${bestAudio.url}`,
          type: format.type,
          extension: format.extension,
          filesize: format.filesize,
          isPremium: true,
          hasAudio: true,
          isVideoOnly: false,
          isAudioOnly: false,
          bitrate: format.bitrate,
          needsMerge: true
        });
      }
    });

    // Add audio-only formats
    audioFormats.slice(0, 3).forEach(format => {
      const bitrateKbps = Math.round((format.bitrate || 128000) / 1000);
      qualityOptions.push({
        quality: `audio (${bitrateKbps}kbps)`,
        qualityNum: 0,
        url: format.url,
        type: format.type,
        extension: format.type.includes('webm') ? 'webm' : 'm4a',
        filesize: format.filesize,
        isPremium: false,
        hasAudio: true,
        isVideoOnly: false,
        isAudioOnly: true,
        bitrate: format.bitrate
      });
    });

    // Sort by quality
    qualityOptions.sort((a, b) => {
      if (a.isAudioOnly && !b.isAudioOnly) return 1;
      if (!a.isAudioOnly && b.isAudioOnly) return -1;
      return a.qualityNum - b.qualityNum;
    });

    // Remove duplicates
    const uniqueQualities = [];
    const seen = new Set();

    for (const opt of qualityOptions) {
      const key = `${opt.quality}-${opt.isAudioOnly}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueQualities.push(opt);
      }
    }

    // Select default (360p or first with audio)
    const defaultQuality = uniqueQualities.find(q =>
        !q.isAudioOnly && q.qualityNum === 360 && q.hasAudio
    ) || uniqueQualities.find(q => !q.isAudioOnly && q.hasAudio) || uniqueQualities[0];

    console.log(`✅ Processed ${uniqueQualities.length} unique qualities`);
    console.log(`🎯 Default: ${defaultQuality?.quality}`);

    return {
      title: data.videoDetails?.title || "YouTube Video",
      thumbnail: data.videoDetails?.thumbnail?.thumbnails?.[0]?.url ||
          `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
      duration: data.videoDetails?.lengthSeconds || 0,
      description: data.videoDetails?.shortDescription || '',
      author: data.videoDetails?.author || '',
      viewCount: data.videoDetails?.viewCount || 0,
      formats: uniqueQualities,
      allFormats: uniqueQualities,
      url: defaultQuality?.url || null,
      selectedQuality: defaultQuality,
      audioGuaranteed: defaultQuality?.hasAudio || false,
      videoId: videoId,
      source: 'innertube'
    };
  }

  async fetchYouTubeData(url) {
    const videoId = this.extractYouTubeId(url);
    if (!videoId) {
      throw new Error('Invalid YouTube URL');
    }

    console.log(`🎬 Processing YouTube video: ${videoId}`);

    try {
      return await this.fetchWithInnertube(videoId);
    } catch (error) {
      console.error(`❌ YouTube fetch error:`, error.message);
      throw new Error(`YouTube download failed: ${error.message}`);
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
    console.log(`Formats: ${data.formats.length}`);

    console.log('\n📋 Available formats:');
    data.formats.forEach((format, index) => {
      const audioIcon = format.hasAudio ? '🎵' : '🔇';
      const premiumIcon = format.isPremium ? '💰' : '🆓';
      const mergeIcon = format.needsMerge ? '🔀' : '';
      console.log(`${index + 1}. ${format.quality} ${audioIcon} ${premiumIcon} ${mergeIcon}`);
    });

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