const { Innertube, UniversalCache } = require('youtubei.js');
const { VM } = require('vm2');

/**
 * PRODUCTION-READY YouTube Downloader (2025)
 * Fixes:
 * - Proper URL deciphering with VM2
 * - Format selection that guarantees downloads
 * - Aggressive timeout handling
 * - Fallback quality selection
 * - Better error messages
 */
class YouTubeDownloader {
  constructor() {
    this.innertube = null;
    this.isInitializing = false;
    this.initRetries = 0;
    this.maxInitRetries = 3;
  }

  async init() {
    if (this.innertube) return;
    
    if (this.isInitializing) {
      // Wait for ongoing initialization
      await new Promise(resolve => {
        const check = setInterval(() => {
          if (!this.isInitializing) {
            clearInterval(check);
            resolve();
          }
        }, 100);
      });
      return;
    }

    this.isInitializing = true;
    
    try {
      console.log('🚀 Initializing YouTube Innertube...');
      
      this.innertube = await Innertube.create({
        cache: new UniversalCache(false),
        generate_session_locally: true,
        
        // CRITICAL: Add JavaScript evaluator for URL deciphering
        evaluate: (code) => {
          try {
            const vm = new VM({
              timeout: 5000,
              sandbox: {},
              eval: false,
              wasm: false
            });
            return vm.run(code);
          } catch (error) {
            console.error('❌ VM evaluation error:', error.message);
            throw error;
          }
        }
      });
      
      console.log('✅ YouTube Innertube initialized successfully');
      this.initRetries = 0;
      
    } catch (err) {
      console.error('❌ Failed to initialize Innertube:', err.message);
      this.innertube = null;
      this.initRetries++;
      
      if (this.initRetries < this.maxInitRetries) {
        console.log(`🔄 Retrying initialization (${this.initRetries}/${this.maxInitRetries})...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
        this.isInitializing = false;
        return this.init();
      }
      
      throw new Error(`Failed to initialize YouTube service after ${this.maxInitRetries} attempts`);
    } finally {
      this.isInitializing = false;
    }
  }

  extractYouTubeId(url) {
    try {
      // Handle youtu.be short links
      if (url.includes('youtu.be/')) {
        return url.split('youtu.be/')[1]?.split(/[?&/#]/)[0];
      }
      
      const urlObj = new URL(url);
      
      // Standard watch URL
      let videoId = urlObj.searchParams.get('v');
      if (videoId && videoId.length === 11) return videoId;

      // Shorts or embed
      const pathname = urlObj.pathname;
      if (pathname.includes('/shorts/') || pathname.includes('/embed/')) {
        return pathname.split('/').pop()?.split(/[?&/#]/)[0];
      }
      
      return null;
    } catch {
      // Fallback regex
      const regex = /(?:v=|\/)([0-9A-Za-z_-]{11})/;
      const match = String(url).match(regex);
      return match ? match[1] : null;
    }
  }

  async fetchYouTubeData(url) {
    await this.init();
    
    const videoId = this.extractYouTubeId(url);
    if (!videoId) {
      throw new Error('Invalid YouTube URL - could not extract video ID');
    }

    console.log(`🎬 Processing YouTube video: ${videoId}`);

    try {
      // Fetch video info with extended timeout
      const info = await Promise.race([
        this.innertube.getInfo(videoId),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('YouTube info fetch timeout (60s)')), 60000)
        )
      ]);

      // CRITICAL: Check streaming data exists
      if (!info.streaming_data) {
        throw new Error('No streaming data available. Video may be private, age-restricted, or region-locked.');
      }

      const basic = info.basic_info;
      
      // Get all available formats
      const formats = info.streaming_data.formats || [];
      const adaptiveFormats = info.streaming_data.adaptive_formats || [];
      const allFormatsRaw = [...formats, ...adaptiveFormats];

      console.log(`📊 Found ${allFormatsRaw.length} total formats`);

      if (allFormatsRaw.length === 0) {
        throw new Error('No download formats available for this video');
      }

      const qualityOptions = [];

      // Process formats and decipher URLs
      for (const f of allFormatsRaw) {
        const hasVideo = !!f.has_video || !!f.width;
        const hasAudio = !!f.has_audio || f.mime_type?.includes('audio');

        const quality = f.quality_label || (hasAudio && !hasVideo ? 'Audio' : 'Unknown');

        let finalUrl = null;

        try {
          // Check if URL is already present (not encrypted)
          if (f.url && f.url.startsWith('http')) {
            finalUrl = f.url;
          } else {
            // URL needs deciphering
            console.log(`🔐 Deciphering URL for quality: ${quality}`);
            
            const decipherResult = await Promise.race([
              f.decipher(this.innertube.session.player),
              new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Decipher timeout')), 10000)
              )
            ]);

            // Handle both Promise and direct string return
            if (decipherResult && typeof decipherResult.then === 'function') {
              finalUrl = await decipherResult;
            } else {
              finalUrl = decipherResult;
            }
          }
        } catch (decipherError) {
          console.warn(`⚠️  Failed to decipher ${quality}:`, decipherError.message);
          // Try using the URL directly as fallback
          finalUrl = f.url || null;
        }

        if (finalUrl) {
          qualityOptions.push({
            quality: quality,
            qualityNum: f.height || 0,
            url: finalUrl,
            type: f.mime_type,
            extension: f.mime_type?.split(';')[0]?.split('/')[1] || 'mp4',
            filesize: f.content_length || 'unknown',
            isPremium: (f.height || 0) > 360,
            hasAudio: hasAudio,
            isVideoOnly: hasVideo && !hasAudio,
            isAudioOnly: hasAudio && !hasVideo,
            needsMerge: hasVideo && !hasAudio,
            bitrate: f.bitrate,
          });
        }
      }

      console.log(`✅ Successfully processed ${qualityOptions.length} formats with valid URLs`);

      if (qualityOptions.length === 0) {
        throw new Error('Failed to decipher any download URLs. YouTube may have updated their protection.');
      }

      // Sort: Audio last, then by quality descending
      qualityOptions.sort((a, b) => {
        if (a.isAudioOnly && !b.isAudioOnly) return 1;
        if (!a.isAudioOnly && b.isAudioOnly) return -1;
        return b.qualityNum - a.qualityNum;
      });

      // Smart format selection
      const selectedFormat = 
        // Try 360p with audio first (best for compatibility)
        qualityOptions.find(o => o.qualityNum === 360 && o.hasAudio) ||
        // Any format with audio
        qualityOptions.find(o => o.hasAudio && !o.isAudioOnly) ||
        // Any video format
        qualityOptions.find(o => o.hasVideo) ||
        // Last resort: first available
        qualityOptions[0];

      console.log(`🎯 Selected format: ${selectedFormat.quality} (Has audio: ${selectedFormat.hasAudio})`);

      return {
        title: basic.title,
        thumbnail: basic.thumbnail?.[0]?.url || `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
        duration: basic.duration,
        description: basic.short_description || '',
        author: basic.author,
        viewCount: basic.view_count,
        formats: qualityOptions,
        allFormats: qualityOptions,
        url: selectedFormat?.url || null,
        selectedQuality: selectedFormat,
        videoId,
        source: 'innertube',
        bestAudioUrl: qualityOptions.find(o => o.isAudioOnly)?.url,
        
        // Add metadata for debugging
        _debug: {
          totalFormatsFound: allFormatsRaw.length,
          validUrlsDeciphered: qualityOptions.length,
          selectedQuality: selectedFormat.quality
        }
      };

    } catch (err) {
      console.error('❌ YouTube fetch error:', err.message);
      
      // Provide helpful error messages
      if (err.message.includes('timeout')) {
        throw new Error('YouTube request timeout. The video may be loading slowly or servers are overloaded.');
      }
      if (err.message.includes('private') || err.message.includes('restricted')) {
        throw new Error('Video is private, age-restricted, or not available in your region.');
      }
      if (err.message.includes('not found')) {
        throw new Error('Video not found. It may have been deleted or made private.');
      }
      
      throw new Error(`YouTube extraction failed: ${err.message}`);
    }
  }
}

// Singleton instance
const youtubeDownloader = new YouTubeDownloader();

// Export as function for backward compatibility
async function fetchYouTubeData(url) {
  return youtubeDownloader.fetchYouTubeData(url);
}

module.exports = {
  fetchYouTubeData,
  YouTubeDownloader,
};
