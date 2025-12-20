
const { spawn } = require('child_process');
const { promisify } = require('util');
const exec = promisify(require('child_process').exec);

class YouTubeDownloader {
  constructor() {
    this.ytDlpPath = 'yt-dlp';
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
        /youtu\.be\/([0-9A-Za-z_-]{11})/
      ];

      for (const pattern of regexPatterns) {
        const match = url.match(pattern);
        if (match && match[1]) return match[1];
      }

      return null;
    } catch (error) {
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

  async fetchWithYtDlp(url) {
    const normalizedUrl = this.normalizeYouTubeUrl(url);

    console.log('🔧 Using yt-dlp to fetch video info...');

    try {
      const { stdout, stderr } = await exec(
          `${this.ytDlpPath} --dump-json --no-warnings "${normalizedUrl}"`,
          { timeout: 30000, maxBuffer: 10 * 1024 * 1024 }
      );

      if (stderr && !stderr.includes('WARNING')) {
        console.error('yt-dlp stderr:', stderr);
      }

      const info = JSON.parse(stdout);

      console.log(`✅ yt-dlp succeeded: "${info.title}"`);
      console.log(`📊 Formats available: ${info.formats?.length || 0}`);

      return this.processYtDlpData(info);
    } catch (error) {
      console.error('❌ yt-dlp failed:', error.message);
      throw new Error(`yt-dlp extraction failed: ${error.message}`);
    }
  }

  // 🔥 NEW: Process data with separate video and audio URLs for client-side merging
  processYtDlpData(data) {
    const formats = data.formats || [];

    // Get video-only formats
    const videoOnlyFormats = formats.filter(f =>
        f.vcodec && f.vcodec !== 'none' &&
        f.height &&
        (!f.acodec || f.acodec === 'none') &&
        f.url
    );

    // Get video+audio combined formats
    const combinedFormats = formats.filter(f =>
        f.vcodec && f.vcodec !== 'none' &&
        f.acodec && f.acodec !== 'none' &&
        f.height &&
        f.url
    );

    // Get audio-only formats
    const audioOnlyFormats = formats.filter(f =>
        f.acodec && f.acodec !== 'none' &&
        (!f.vcodec || f.vcodec === 'none') &&
        f.url
    );

    console.log(`📊 Video-only: ${videoOnlyFormats.length}, Combined: ${combinedFormats.length}, Audio-only: ${audioOnlyFormats.length}`);

    // Find best audio for merging
    const bestAudio = audioOnlyFormats
        .sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];

    const qualityOptions = [];

    // 🔥 STRATEGY 1: Add combined formats (have audio already - NO MERGE NEEDED)
    combinedFormats.forEach(format => {
      const quality = format.height;
      qualityOptions.push({
        quality: `${quality}p`,
        qualityNum: quality,
        url: format.url,
        type: format.ext === 'mp4' ? 'video/mp4' : `video/${format.ext}`,
        extension: format.ext || 'mp4',
        filesize: format.filesize || 'unknown',
        isPremium: quality > 360,
        hasAudio: true,
        isVideoOnly: false,
        isAudioOnly: false,
        needsMerge: false, // 🔥 No merging needed!
        bitrate: format.tbr || format.abr || 0
      });
    });

    // 🔥 STRATEGY 2: Add video-only formats WITH separate audio URL for client-side merge
    videoOnlyFormats.forEach(format => {
      const quality = format.height;

      if (!qualityOptions.find(q => q.qualityNum === quality)) {
        qualityOptions.push({
          quality: `${quality}p`,
          qualityNum: quality,
          videoUrl: format.url, // 🔥 Separate video URL
          audioUrl: bestAudio?.url, // 🔥 Separate audio URL
          url: format.url, // Fallback (client will merge)
          type: format.ext === 'mp4' ? 'video/mp4' : `video/${format.ext}`,
          extension: format.ext || 'mp4',
          filesize: format.filesize || 'unknown',
          isPremium: quality > 360,
          hasAudio: false,
          isVideoOnly: true,
          isAudioOnly: false,
          needsMerge: true, // 🔥 Client must merge!
          bitrate: format.tbr || 0
        });
      }
    });

    // Add audio-only format
    if (bestAudio) {
      qualityOptions.push({
        quality: `Audio (${Math.round(bestAudio.abr || 128)}kbps)`,
        qualityNum: 0,
        url: bestAudio.url,
        type: 'audio/mp4',
        extension: bestAudio.ext || 'm4a',
        filesize: bestAudio.filesize || 'unknown',
        isPremium: false,
        hasAudio: true,
        isVideoOnly: false,
        isAudioOnly: true,
        needsMerge: false,
        bitrate: bestAudio.abr || 128
      });
    }

    // Sort by quality
    qualityOptions.sort((a, b) => {
      if (a.isAudioOnly && !b.isAudioOnly) return 1;
      if (!a.isAudioOnly && b.isAudioOnly) return -1;
      return a.qualityNum - b.qualityNum;
    });

    // Select default (360p with audio, or 360p that will be merged)
    let selectedFormat = qualityOptions.find(opt =>
            !opt.isAudioOnly && opt.qualityNum === 360 && opt.hasAudio
        ) || qualityOptions.find(opt => !opt.isAudioOnly && opt.qualityNum === 360)
        || qualityOptions.find(opt => !opt.isAudioOnly)
        || qualityOptions[0];

    const videoId = this.extractYouTubeId(data.webpage_url || data.url);

    console.log(`✅ Created ${qualityOptions.length} quality options`);
    console.log(`🎯 Default: ${selectedFormat?.quality} (needsMerge: ${selectedFormat?.needsMerge})`);

    return {
      title: data.title || "YouTube Video",
      thumbnail: data.thumbnail || `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
      duration: data.duration || 0,
      description: data.description || '',
      author: data.uploader || data.channel || '',
      viewCount: data.view_count || 0,
      formats: qualityOptions,
      allFormats: qualityOptions,
      url: selectedFormat?.url || null,
      selectedQuality: selectedFormat,
      videoId: videoId,
      source: 'yt-dlp',
      // 🔥 CRITICAL: Provide best audio URL for client-side merging
      bestAudioUrl: bestAudio?.url,
    };
  }

  async fetchYouTubeData(url) {
    const videoId = this.extractYouTubeId(url);

    if (!videoId) {
      throw new Error('Invalid YouTube URL');
    }

    console.log(`🎬 Processing YouTube video: ${videoId}`);

    try {
      const result = await this.fetchWithYtDlp(url);
      console.log(`✅ SUCCESS with ${result.formats.length} formats (via yt-dlp)`);
      return result;
    } catch (error) {
      console.error('❌ yt-dlp extraction failed:', error.message);
      throw error;
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