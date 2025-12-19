const fetch = require('node-fetch');

class YoutubeServiceNew {
  constructor() {
    this.apiKey = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
    this.baseUrl = 'https://youtubei.googleapis.com/youtubei/v1/player';
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

  async getVideoInfo(videoId) {
    const url = `${this.baseUrl}?key=${this.apiKey}`;

    const headers = {
      'X-YouTube-Client-Name': 'WEB',
      'X-YouTube-Client-Version': '2.20230728.00.00',
      'Content-Type': 'application/json'
    };

    const body = {
      context: {
        client: {
          clientName: "ANDROID",
          clientVersion: "19.17.34"
        }
      },
      videoId: videoId
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body),
        timeout: 30000
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      return data;
    } catch (error) {
      console.error('Error fetching video info:', error);
      throw error;
    }
  }

  parseFormats(data) {
    const formats = [];

    if (data.streamingData) {
      if (data.streamingData.formats) {
        formats.push(...data.streamingData.formats);
      }

      if (data.streamingData.adaptiveFormats) {
        formats.push(...data.streamingData.adaptiveFormats);
      }
    }

    return formats.map(format => {
      const hasVideo = format.mimeType?.includes('video');
      const hasAudio = format.mimeType?.includes('audio');
      const quality = format.qualityLabel || format.quality || 'unknown';
      const isAudioOnly = hasAudio && !hasVideo;
      const isVideoOnly = hasVideo && !hasAudio;

      return {
        itag: format.itag,
        mimeType: format.mimeType,
        quality: quality,
        qualityLabel: format.qualityLabel,
        qualityNum: format.height || 0,
        url: format.url,
        contentLength: format.contentLength,
        bitrate: format.bitrate,
        fps: format.fps,
        audioQuality: format.audioQuality,
        hasVideo: hasVideo,
        hasAudio: hasAudio,
        isAudioOnly: isAudioOnly,
        isVideoOnly: isVideoOnly,
        width: format.width,
        height: format.height,
        needsMerging: isVideoOnly && (format.height >= 480)
      };
    });
  }

  async fetchYouTubeData(url) {
    const videoId = this.extractYouTubeId(url);
    if (!videoId) {
      throw new Error('Invalid YouTube URL');
    }

    console.log(`🎬 Processing YouTube video: ${videoId}`);

    try {
      const videoInfo = await this.getVideoInfo(videoId);

      if (!videoInfo.videoDetails) {
        throw new Error('Video not available or private');
      }

      const allFormats = this.parseFormats(videoInfo);

      console.log(`✅ Found ${allFormats.length} total formats`);

      const videoFormats = allFormats.filter(f => f.hasVideo && !f.isAudioOnly);
      const audioFormats = allFormats.filter(f => f.isAudioOnly);
      const combinedFormats = allFormats.filter(f => f.hasVideo && f.hasAudio);

      console.log(`📹 Video formats: ${videoFormats.length}`);
      console.log(`🎵 Audio formats: ${audioFormats.length}`);
      console.log(`🎬 Combined formats: ${combinedFormats.length}`);

      let selectedQuality = null;
      let defaultUrl = null;

      if (combinedFormats.length > 0) {
        selectedQuality = combinedFormats.find(f =>
            f.qualityLabel?.includes('360') || f.quality?.includes('360')
        ) || combinedFormats[0];
        defaultUrl = selectedQuality.url;
      } else if (videoFormats.length > 0) {
        selectedQuality = videoFormats.find(f =>
            f.qualityLabel?.includes('360') || f.quality?.includes('360')
        ) || videoFormats[0];
        defaultUrl = selectedQuality.url;
      }

      const organizedFormats = [
        ...combinedFormats.map(f => ({
          ...f,
          quality: f.qualityLabel || f.quality || `${f.height}p`,
          type: 'video/mp4',
          extension: 'mp4',
          isPremium: (f.height || 0) > 360,
          isMergedFormat: false
        })),
        ...videoFormats
            .filter(f => f.isVideoOnly && f.height >= 360)
            .map(f => {
              const bestAudio = audioFormats.find(a =>
                  a.audioQuality === 'AUDIO_QUALITY_MEDIUM' ||
                  a.audioQuality === 'AUDIO_QUALITY_HIGH'
              ) || audioFormats[0];

              return {
                ...f,
                quality: f.qualityLabel || `${f.height}p`,
                type: 'video/mp4',
                extension: 'mp4',
                isPremium: f.height > 360,
                needsMerging: true,
                isMergedFormat: true,
                audioUrl: bestAudio?.url,
                originalVideoUrl: f.url
              };
            })
      ];

      organizedFormats.sort((a, b) => {
        const aHeight = a.height || a.qualityNum || 0;
        const bHeight = b.height || b.qualityNum || 0;
        return aHeight - bHeight;
      });

      const audioOnlyFormats = audioFormats.map(f => ({
        ...f,
        quality: `${f.audioQuality || 'audio'} (${Math.round(f.bitrate / 1000)}kb/s)`,
        type: 'audio/mp4',
        extension: 'm4a',
        isPremium: f.bitrate > 150000
      }));

      return {
        title: videoInfo.videoDetails.title || "YouTube Video",
        thumbnail: videoInfo.videoDetails.thumbnail?.thumbnails?.[0]?.url ||
            `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
        duration: videoInfo.videoDetails.lengthSeconds || 0,
        description: videoInfo.videoDetails.shortDescription || '',
        author: videoInfo.videoDetails.author || '',
        viewCount: videoInfo.videoDetails.viewCount || 0,
        formats: organizedFormats,
        allFormats: organizedFormats,
        videoFormats: organizedFormats.filter(f => !f.isAudioOnly),
        audioFormats: audioOnlyFormats,
        url: defaultUrl,
        selectedQuality: selectedQuality,
        audioGuaranteed: combinedFormats.length > 0 || audioFormats.length > 0,
        videoId: videoId
      };

    } catch (error) {
      console.error('❌ YouTube fetch failed:', error.message);

      return {
        title: "YouTube Video",
        thumbnail: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
        duration: 0,
        formats: [],
        allFormats: [],
        url: null,
        selectedQuality: null,
        audioGuaranteed: false,
        error: error.message,
        videoId: videoId
      };
    }
  }
}

const youtubeService = new YoutubeServiceNew();

async function fetchYouTubeData(url) {
  return youtubeService.fetchYouTubeData(url);
}

async function testYouTube() {
  try {
    const data = await fetchYouTubeData('https://youtu.be/dQw4w9WgXcQ');
    console.log('✅ YouTube service test passed');
    console.log(`Title: ${data.title}`);
    console.log(`Formats: ${data.formats.length}`);
    return true;
  } catch (error) {
    console.error('❌ YouTube service test failed:', error.message);
    return false;
  }
}

module.exports = {
  fetchYouTubeData,
  testYouTube,
  youtubeService
};