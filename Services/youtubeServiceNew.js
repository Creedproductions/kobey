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
      videoId
    };

    const response = await fetch(url, {
      method: 'POST',
      headers,
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
      if (Array.isArray(data.streamingData.formats)) {
        formats.push(...data.streamingData.formats);
      }
      if (Array.isArray(data.streamingData.adaptiveFormats)) {
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
        quality,
        qualityLabel: format.qualityLabel,
        qualityNum: format.height || 0,
        url: format.url,
        contentLength: format.contentLength,
        bitrate: format.bitrate,
        fps: format.fps,
        audioQuality: format.audioQuality,
        hasVideo,
        hasAudio,
        isAudioOnly,
        isVideoOnly,
        width: format.width,
        height: format.height,
        audioBitrate: format.audioBitrate || format.bitrate
      };
    });
  }

  /**
   * Merge video and audio using FFmpeg (kept for compatibility, but your mergeRoutes/mergeService handles merging)
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

      ffmpeg.stderr.on('data', (data) => { stderr += data.toString(); });

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

  /**
   * Pick best item per height (dedupe repeated qualities)
   * Score: higher fps first, then higher bitrate
   */
  pickBestPerHeight(items) {
    const map = new Map();
    for (const f of items) {
      const h = f.height || 0;
      if (!h) continue;

      const prev = map.get(h);
      if (!prev) {
        map.set(h, f);
        continue;
      }

      const prevScore = (prev.fps || 0) * 1_000_000 + (prev.bitrate || 0);
      const newScore  = (f.fps || 0)   * 1_000_000 + (f.bitrate || 0);

      if (newScore > prevScore) map.set(h, f);
    }
    return Array.from(map.values());
  }

  async fetchYouTubeData(url) {
    const videoId = this.extractYouTubeId(url);
    if (!videoId) throw new Error('Invalid YouTube URL');

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

      console.log(`📹 Video-only formats: ${videoFormats.filter(f => !f.hasAudio).length}`);
      console.log(`🎵 Audio-only formats: ${audioFormats.length}`);
      console.log(`🎬 Combined formats (video+audio): ${combinedFormats.length}`);

      // ✅ Best audio selection: prefer audio/mp4, then highest bitrate
      const audioMp4 = audioFormats
          .filter(a => (a.mimeType || '').includes('audio/mp4'))
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

      const bestAudio =
          audioMp4[0] ||
          audioFormats.slice().sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];

      // Organize formats for client
      let organizedFormats = [];

      // ✅ Combined formats (if any) – dedupe by height
      const combinedMp4 = combinedFormats
          .filter(f => (f.mimeType || '').includes('video/mp4'));

      const bestCombined = this.pickBestPerHeight(combinedMp4);

      bestCombined.forEach(f => {
        organizedFormats.push({
          itag: f.itag,
          quality: f.qualityLabel || `${f.height}p`,
          qualityNum: f.height || 0,
          url: f.url,
          type: 'video/mp4',
          extension: 'mp4',
          isPremium: (f.height || 0) > 360,
          hasAudio: true,
          hasVideo: true,
          needsMerging: false,
          mimeType: f.mimeType,
          contentLength: f.contentLength,
          bitrate: f.bitrate,
          fps: f.fps
        });
      });

      // ✅ Video-only formats (mp4) – dedupe by height, then merge server-side
      const videoOnlyMp4 = videoFormats
          .filter(f => !f.hasAudio)
          .filter(f => (f.mimeType || '').includes('video/mp4'));

      const bestVideoOnly = this.pickBestPerHeight(videoOnlyMp4);

      bestVideoOnly
          .filter(f => (f.height || 0) >= 360) // keep 360+ as options (change to >=480 if you want)
          .forEach(f => {
            organizedFormats.push({
              itag: f.itag,
              quality: f.qualityLabel || `${f.height}p`,
              qualityNum: f.height || 0,

              // IMPORTANT: keep these for controller to create merge token / merge URL
              videoUrl: f.url,
              audioUrl: bestAudio?.url,

              // url stays unset here for merge-needed items (controller will replace it)
              url: f.url, // fallback (but controller should override with /api/merge/<token>.mp4)
              type: 'video/mp4',
              extension: 'mp4',
              isPremium: (f.height || 0) > 360,

              // Final output will have audio after merge endpoint
              hasAudio: true,
              hasVideo: true,
              needsMerging: true,

              mimeType: f.mimeType,
              contentLength: f.contentLength,
              bitrate: f.bitrate,
              fps: f.fps
            });
          });

      // If no audio exists, remove merge-needed formats (can’t guarantee audio)
      if (!bestAudio?.url) {
        organizedFormats = organizedFormats.filter(f => !f.needsMerging);
      }

      // ✅ Deduplicate AGAIN by height in case combined+video-only both present
      // Prefer combined (needsMerging=false) over merge-needed
      const finalMap = new Map();
      for (const f of organizedFormats) {
        const h = f.qualityNum || 0;
        if (!h) continue;

        const prev = finalMap.get(h);
        if (!prev) {
          finalMap.set(h, f);
          continue;
        }

        // prefer non-merging over merging
        if (prev.needsMerging && !f.needsMerging) {
          finalMap.set(h, f);
          continue;
        }

        // otherwise prefer higher fps/bitrate
        const prevScore = (prev.fps || 0) * 1_000_000 + (prev.bitrate || 0);
        const newScore  = (f.fps || 0)   * 1_000_000 + (f.bitrate || 0);
        if (newScore > prevScore) finalMap.set(h, f);
      }

      organizedFormats = Array.from(finalMap.values());

      // Sort by quality
      organizedFormats.sort((a, b) => (a.qualityNum || 0) - (b.qualityNum || 0));

      // Audio-only formats
      const audioOnlyFormats = audioFormats
          .slice()
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))
          .map(f => ({
            itag: f.itag,
            quality: `${f.audioQuality || 'audio'} (${Math.round((f.bitrate || 0) / 1000)}kb/s)`,
            url: f.url,
            type: 'audio/mp4',
            extension: 'm4a',
            isPremium: (f.bitrate || 0) > 150000,
            isAudioOnly: true,
            hasAudio: true,
            hasVideo: false,
            mimeType: f.mimeType,
            bitrate: f.bitrate
          }));

      // Default quality: prefer 360p (either combined or merge-needed)
      let selectedQuality = null;
      let defaultUrl = null;

      const default360 = organizedFormats.find(f => f.qualityNum === 360);
      if (default360) {
        selectedQuality = default360;
        defaultUrl = default360.url;
        console.log('✅ Default: 360p selected');
      } else if (organizedFormats.length > 0) {
        selectedQuality = organizedFormats[0];
        defaultUrl = organizedFormats[0].url;
        console.log(`⚠️ Default fallback: ${organizedFormats[0].quality}`);
      }

      return {
        title: videoInfo.videoDetails.title || "YouTube Video",
        thumbnail:
            videoInfo.videoDetails.thumbnail?.thumbnails?.[0]?.url ||
            `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
        duration: videoInfo.videoDetails.lengthSeconds || 0,
        description: videoInfo.videoDetails.shortDescription || '',
        author: videoInfo.videoDetails.author || '',
        viewCount: videoInfo.videoDetails.viewCount || 0,

        // deliver deduped formats
        formats: organizedFormats,
        allFormats: organizedFormats,
        videoFormats: organizedFormats, // your app expects this sometimes
        audioFormats: audioOnlyFormats,

        url: defaultUrl,
        selectedQuality,
        audioGuaranteed: organizedFormats.length > 0 && (!!bestAudio?.url || bestCombined.length > 0),
        videoId
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
        videoId
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
