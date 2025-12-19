const ytdlp = require('yt-dlp-exec');

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

  async fetchYouTubeData(url) {
    const videoId = this.extractYouTubeId(url);
    if (!videoId) {
      throw new Error('Invalid YouTube URL');
    }

    console.log(`🎬 Processing YouTube video with yt-dlp: ${videoId}`);

    try {
      // Get video info using yt-dlp
      const info = await ytdlp(url, {
        dumpSingleJson: true,
        noCheckCertificates: true,
        noWarnings: true,
        preferFreeFormats: true,
        addHeader: [
          'referer:youtube.com',
          'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        ]
      });

      console.log(`✅ yt-dlp fetched video info: ${info.title}`);

      // Process formats
      const formats = info.formats || [];

      // Separate video and audio formats
      const videoFormats = formats.filter(f =>
          f.vcodec && f.vcodec !== 'none' &&
          f.acodec === 'none' && // Video only
          f.url &&
          f.height // Has resolution
      );

      const audioFormats = formats.filter(f =>
          f.acodec && f.acodec !== 'none' &&
          f.vcodec === 'none' && // Audio only
          f.url
      );

      const combinedFormats = formats.filter(f =>
          f.vcodec && f.vcodec !== 'none' &&
          f.acodec && f.acodec !== 'none' &&
          f.url
      );

      console.log(`📊 Formats found - Video: ${videoFormats.length}, Audio: ${audioFormats.length}, Combined: ${combinedFormats.length}`);

      // Build quality options
      const qualityOptions = [];

      // Add combined formats first (360p and below usually have audio)
      combinedFormats.forEach(format => {
        if (format.height <= 360) {
          qualityOptions.push({
            quality: `${format.height}p`,
            qualityNum: format.height,
            url: format.url,
            type: format.ext || 'mp4',
            extension: format.ext || 'mp4',
            filesize: format.filesize || 'unknown',
            isPremium: false,
            hasAudio: true,
            isVideoOnly: false,
            isAudioOnly: false,
            bitrate: format.tbr || 0
          });
        }
      });

      // Add video-only formats (480p and above) - these need server merging
      videoFormats.forEach(format => {
        if (format.height >= 480) {
          // Find best matching audio
          const bestAudio = audioFormats.sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];

          qualityOptions.push({
            quality: `${format.height}p`,
            qualityNum: format.height,
            url: bestAudio ? `MERGE:${format.url}:${bestAudio.url}` : format.url,
            type: format.ext || 'mp4',
            extension: format.ext || 'mp4',
            filesize: format.filesize || 'unknown',
            isPremium: format.height > 360,
            hasAudio: !!bestAudio,
            isVideoOnly: !bestAudio,
            isAudioOnly: false,
            bitrate: format.tbr || 0,
            needsMerge: !!bestAudio
          });
        }
      });

      // Add audio-only formats
      audioFormats.slice(0, 3).forEach(format => {
        qualityOptions.push({
          quality: `${format.acodec} (${Math.round(format.abr || 128)}kbps)`,
          qualityNum: 0,
          url: format.url,
          type: format.ext || 'm4a',
          extension: format.ext || 'm4a',
          filesize: format.filesize || 'unknown',
          isPremium: false,
          hasAudio: true,
          isVideoOnly: false,
          isAudioOnly: true,
          bitrate: format.abr || 128
        });
      });

      // Sort by quality
      qualityOptions.sort((a, b) => {
        if (a.isAudioOnly && !b.isAudioOnly) return 1;
        if (!a.isAudioOnly && b.isAudioOnly) return -1;
        return a.qualityNum - b.qualityNum;
      });

      // Remove duplicates by quality
      const uniqueQualities = [];
      const seenQualities = new Set();

      for (const opt of qualityOptions) {
        const key = `${opt.quality}-${opt.isAudioOnly}`;
        if (!seenQualities.has(key)) {
          seenQualities.add(key);
          uniqueQualities.push(opt);
        }
      }

      // Select default (360p or first available with audio)
      const defaultQuality = uniqueQualities.find(q =>
          !q.isAudioOnly && q.qualityNum === 360 && q.hasAudio
      ) || uniqueQualities.find(q => !q.isAudioOnly && q.hasAudio) || uniqueQualities[0];

      console.log(`✅ Processed ${uniqueQualities.length} unique quality options`);
      console.log(`🎯 Default quality: ${defaultQuality.quality}`);

      return {
        title: info.title || "YouTube Video",
        thumbnail: info.thumbnail || `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
        duration: info.duration || 0,
        description: info.description || '',
        author: info.uploader || info.channel || '',
        viewCount: info.view_count || 0,
        formats: uniqueQualities,
        allFormats: uniqueQualities,
        url: defaultQuality?.url || null,
        selectedQuality: defaultQuality,
        audioGuaranteed: defaultQuality?.hasAudio || false,
        videoId: videoId,
        source: 'ytdlp'
      };

    } catch (error) {
      console.error(`❌ yt-dlp error:`, error.message);
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
    console.log('✅ yt-dlp test passed');
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
    console.error('❌ yt-dlp test failed:', error.message);
    return false;
  }
}

module.exports = {
  fetchYouTubeData,
  testYouTube,
  YouTubeDownloader
};