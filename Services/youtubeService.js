const { Innertube, UniversalCache } = require('youtubei.js');
const { VM } = require('vm2');

class YouTubeDownloader {
  constructor() {
    this.innertube = null;
    this.isInitializing = false;
  }

  async init() {
    if (this.innertube) return;
    if (this.isInitializing) {
      while (this.isInitializing) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return;
    }

    this.isInitializing = true;
    try {
      this.innertube = await Innertube.create({
        cache: new UniversalCache(false),
        generate_session_locally: true,
        // Add JavaScript evaluator to decipher YouTube URLs
        evaluate: (code) => {
          const vm = new VM({
            timeout: 5000,
            sandbox: {},
            eval: false,
            wasm: false
          });
          return vm.run(code);
        }
      });
      console.log('✅ YouTube Innertube initialized with URL deciphering');
    } catch (err) {
      console.error('❌ Failed to initialize Innertube:', err);
      throw err;
    } finally {
      this.isInitializing = false;
    }
  }

  extractYouTubeId(url) {
    try {
      if (url.includes('youtu.be/')) {
        return url.split('youtu.be/')[1]?.split(/[?&/#]/)[0];
      }
      const urlObj = new URL(url);
      let videoId = urlObj.searchParams.get('v');
      if (videoId) return videoId;

      const pathname = urlObj.pathname;
      if (pathname.includes('/shorts/') || pathname.includes('/embed/')) {
        return pathname.split('/').pop()?.split(/[?&/#]/)[0];
      }
      return null;
    } catch {
      const regex = /(?:v=|\/)([0-9A-Za-z_-]{11})/;
      const match = String(url).match(regex);
      return match ? match[1] : null;
    }
  }

  async fetchYouTubeData(url) {
    await this.init();
    const videoId = this.extractYouTubeId(url);

    if (!videoId) {
      throw new Error('Invalid YouTube URL');
    }

    console.log(`🎬 Processing YouTube video via Innertube: ${videoId}`);

    try {
      const info = await this.innertube.getInfo(videoId);

      // Safety check for streaming data
      if (!info.streaming_data) {
        throw new Error('No streaming data available for this video.');
      }

      const basic = info.basic_info;

      // Access formats safely using the streaming_data object
      // This fixes the "info.formats is not iterable" error
      const formats = info.streaming_data.formats || [];
      const adaptive_formats = info.streaming_data.adaptive_formats || [];
      const allFormatsRaw = [...formats, ...adaptive_formats];

      const qualityOptions = [];

      // Process all formats and decipher URLs
      for (const f of allFormatsRaw) {
        // In Innertube, f.has_video / f.has_audio are properties
        const hasVideo = !!f.has_video || !!f.width;
        const hasAudio = !!f.has_audio || f.mime_type.includes('audio');

        const quality = f.quality_label || (hasAudio && !hasVideo ? 'Audio' : 'Unknown');

        // Get URL - try direct URL first, then decipher if needed
        let finalUrl = null;

        try {
          // Check if URL is already present (not encrypted)
          if (f.url && f.url.startsWith('http')) {
            finalUrl = f.url;
          } else {
            // URL needs deciphering - decipher() returns a Promise or string
            const decipherResult = f.decipher(this.innertube.session.player);

            // Handle both Promise and direct string return
            if (decipherResult && typeof decipherResult.then === 'function') {
              finalUrl = await decipherResult;
            } else {
              finalUrl = decipherResult;
            }
          }
        } catch (decipherError) {
          console.error(`⚠️  Failed to get URL for ${quality}:`, decipherError.message);
          finalUrl = f.url || null;
        }

        qualityOptions.push({
          quality: quality,
          qualityNum: f.height || 0,
          url: finalUrl,
          type: f.mime_type,
          extension: f.mime_type.split(';')[0].split('/')[1] || 'mp4',
          filesize: f.content_length || 'unknown',
          isPremium: (f.height || 0) > 360,
          hasAudio: hasAudio,
          isVideoOnly: hasVideo && !hasAudio,
          isAudioOnly: hasAudio && !hasVideo,
          needsMerge: hasVideo && !hasAudio,
          bitrate: f.bitrate,
        });
      }

      // Filter out formats that failed to decipher (no URL)
      const validOptions = qualityOptions.filter(o => o.url);

      // Sort: Highest resolution first, then Audio at the bottom
      validOptions.sort((a, b) => {
        if (a.isAudioOnly && !b.isAudioOnly) return 1;
        if (!a.isAudioOnly && b.isAudioOnly) return -1;
        return b.qualityNum - a.qualityNum;
      });

      // Selection logic: Prefer 360p with audio for "fast" preview
      const selectedFormat =
          validOptions.find(o => o.qualityNum === 360 && o.hasAudio) ||
          validOptions.find(o => o.hasAudio) ||
          validOptions[0];

      return {
        title: basic.title,
        thumbnail: basic.thumbnail[0]?.url || `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
        duration: basic.duration,
        description: basic.short_description || '',
        author: basic.author,
        viewCount: basic.view_count,
        formats: validOptions,
        allFormats: validOptions,
        url: selectedFormat?.url || null,
        selectedQuality: selectedFormat,
        videoId,
        source: 'innertube',
        bestAudioUrl: validOptions.find(o => o.isAudioOnly)?.url
      };
    } catch (err) {
      console.error('❌ Innertube error:', err);
      throw new Error(`YouTube extraction failed: ${err.message}`);
    }
  }
}

const youtubeDownloader = new YouTubeDownloader();

async function fetchYouTubeData(url) {
  return youtubeDownloader.fetchYouTubeData(url);
}

module.exports = {
  fetchYouTubeData,
  YouTubeDownloader,
};