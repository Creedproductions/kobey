const fetch = require('node-fetch');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

class YouTubeService {
  constructor() {
    this.apiKey = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
    this.baseUrl = 'https://youtubei.googleapis.com/youtubei/v1/player';
    this.tempDir = path.join(os.tmpdir(), 'yt-merge');

    // Ensure temp directory exists
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
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
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
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

        const response = await fetch(url, {
          method: 'POST',
          headers: headers,
          body: JSON.stringify(body),
          timeout: 30000
        });

        if (!response.ok) {
          console.log(`⚠️ ${client.name} client failed: ${response.status}`);
          continue;
        }

        const data = await response.json();

        // Check if this client provides combined formats
        const hasCombinedFormats = data.streamingData?.formats &&
            data.streamingData.formats.length > 0;

        if (hasCombinedFormats) {
          console.log(`✅ ${client.name} client provided combined formats!`);
          return data;
        } else {
          console.log(`⚠️ ${client.name} client: no combined formats`);
        }
      } catch (error) {
        console.error(`❌ ${client.name} client error:`, error.message);
        continue;
      }
    }

    // If no client provided combined formats, use the last response
    console.log('⚠️ No combined formats found from any client, using adaptive formats');

    const body = {
      context: {
        client: {
          clientName: "ANDROID",
          clientVersion: "19.09.36"
        }
      },
      videoId: videoId
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body),
      timeout: 30000
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    return await response.json();
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
        audioBitrate: format.audioBitrate || format.bitrate
      };
    });
  }

  /**
   * Merge video and audio using FFmpeg
   */
  async mergeVideoAudio(videoUrl, audioUrl, outputPath) {
    return new Promise((resolve, reject) => {
      console.log('🔄 Starting FFmpeg merge...');

      const ffmpegArgs = [
        '-i', videoUrl,
        '-i', audioUrl,
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-strict', 'experimental',
        '-y',
        outputPath
      ];

      const ffmpeg = spawn('ffmpeg', ffmpegArgs);

      let stderr = '';

      ffmpeg.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      ffmpeg.on('close', (code) => {
        if (code === 0) {
          console.log('✅ FFmpeg merge successful');
          resolve(true);
        } else {
          console.error('❌ FFmpeg merge failed:', stderr);
          reject(new Error(`FFmpeg failed with code ${code}`));
        }
      });

      ffmpeg.on('error', (error) => {
        console.error('❌ FFmpeg spawn error:', error);
        reject(error);
      });
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

      // Separate formats by type
      const videoFormats = allFormats.filter(f => f.hasVideo && !f.isAudioOnly);
      const audioFormats = allFormats.filter(f => f.isAudioOnly);
      const combinedFormats = allFormats.filter(f => f.hasVideo && f.hasAudio);

      console.log(`📹 Video-only formats: ${videoFormats.filter(f => !f.hasAudio).length}`);
      console.log(`🎵 Audio-only formats: ${audioFormats.length}`);
      console.log(`🎬 Combined formats (video+audio): ${combinedFormats.length}`);

      // Find best audio stream for merging
      const bestAudio = audioFormats.find(a =>
          a.audioQuality === 'AUDIO_QUALITY_MEDIUM' ||
          a.audioQuality === 'AUDIO_QUALITY_HIGH'
      ) || audioFormats[0];

      // Use a Map to deduplicate by quality (height)
      const qualityMap = new Map();

      // Add combined formats first (prioritize these - they have audio!)
      combinedFormats.forEach(f => {
        const height = f.height || 0;
        if (!qualityMap.has(height) || (qualityMap.get(height).hasAudio === false && f.hasAudio === true)) {
          qualityMap.set(height, {
            itag: f.itag,
            quality: f.qualityLabel || `${height}p`,
            qualityNum: height,
            url: f.url,
            type: 'video/mp4',
            extension: 'mp4',
            isPremium: height > 360,
            hasAudio: true,
            hasVideo: true,
            needsMerging: false, // Combined format - no merge needed!
            mimeType: f.mimeType,
            contentLength: f.contentLength,
            bitrate: f.bitrate
          });
        }
      });

      // Add video-only formats ONLY if we don't already have that quality
      videoFormats
          .filter(f => !f.hasAudio && f.height >= 360) // Only 360p and above
          .forEach(f => {
            const height = f.height || 0;
            if (!qualityMap.has(height)) {
              qualityMap.set(height, {
                itag: f.itag,
                quality: f.qualityLabel || `${height}p`,
                qualityNum: height,
                url: f.url,
                videoUrl: f.url,
                audioUrl: bestAudio?.url,
                type: 'video/mp4',
                extension: 'mp4',
                isPremium: height > 360,
                hasAudio: false, // Video-only stream
                hasVideo: true,
                needsMerging: true, // Needs server-side merge
                mimeType: f.mimeType,
                contentLength: f.contentLength,
                bitrate: f.bitrate
              });
            }
          });

      // Convert Map to array and sort by quality
      const organizedFormats = Array.from(qualityMap.values())
          .sort((a, b) => (a.qualityNum || 0) - (b.qualityNum || 0));

      console.log(`🎯 Deduplicated to ${organizedFormats.length} unique qualities`);

      // Prepare audio-only formats
      const audioOnlyFormats = audioFormats.map(f => ({
        itag: f.itag,
        quality: `${f.audioQuality || 'audio'} (${Math.round(f.bitrate / 1000)}kb/s)`,
        url: f.url,
        type: 'audio/mp4',
        extension: 'm4a',
        isPremium: f.bitrate > 150000,
        isAudioOnly: true,
        hasAudio: true,
        hasVideo: false,
        mimeType: f.mimeType,
        bitrate: f.bitrate
      }));

      // CRITICAL: Select default quality - ALWAYS prefer 360p with audio
      let selectedQuality = null;
      let defaultUrl = null;

      // First try: Find 360p with audio (combined format)
      const quality360WithAudio = organizedFormats.find(f =>
          f.qualityNum === 360 && f.hasAudio === true && f.needsMerging === false
      );

      if (quality360WithAudio) {
        selectedQuality = quality360WithAudio;
        defaultUrl = quality360WithAudio.url;
        console.log('✅ Default: 360p with audio (perfect!)');
      } else {
        // Second try: Any format with audio (prefer lower quality)
        const anyWithAudio = organizedFormats.find(f => f.hasAudio === true);

        if (anyWithAudio) {
          selectedQuality = anyWithAudio;
          defaultUrl = anyWithAudio.url;
          console.log(`✅ Default: ${anyWithAudio.quality} with audio (fallback)`);
        } else {
          // Last resort: First format (will need merging)
          selectedQuality = organizedFormats[0];
          defaultUrl = organizedFormats[0]?.url;
          console.log(`⚠️ Default: ${organizedFormats[0]?.quality} without audio (needs merge)`);
        }
      }

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

const youtubeService = new YouTubeService();

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