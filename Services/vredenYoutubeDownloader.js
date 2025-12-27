const yt = require('@vreden/youtube_scraper');

class VredenYouTubeDownloader {

  constructor() {
    this.availableQualities = [1080, 720, 480, 360, 144];
    this.availableAudioQualities = [320, 256, 128, 92];
  }

  async downloadVideo(url) {
    try {
      console.log(`Fetching YouTube video: ${url}`);

      const normalizedUrl = this.normalizeYouTubeUrl(url);
      const metadata = await yt.metadata(normalizedUrl);

      const formatPromises = this.availableQualities.map(async (quality) => {
        try {
          const result = await yt.ytmp4(normalizedUrl, quality);
          return {
            quality: `${quality}p`,
            qualityNumber: quality,
            url: result.download?.url || null,
            filename: result.download?.filename || null,
            status: result.status,
            availableQualities: result.download?.availableQuality || []
          };
        } catch (err) {
          console.log(`${quality}p not available: ${err.message}`);
          return null;
        }
      });

      const audioPromise = yt.ytmp3(normalizedUrl, 128).catch(err => {
        console.log(`Audio not available: ${err.message}`);
        return null;
      });

      const [formatsRaw, audioResult] = await Promise.all([
        Promise.all(formatPromises),
        audioPromise
      ]);

      const formats = formatsRaw.filter(f => f && f.url);
      const cleanData = this.processVideoData(metadata, formats, audioResult, normalizedUrl);

      console.log(`Successfully fetched: ${cleanData.video.title}`);
      console.log(`Found ${formats.length} video formats + ${audioResult ? '1' : '0'} audio format`);

      return cleanData;

    } catch (error) {
      console.error(`Error downloading YouTube video: ${error.message}`);

      return {
        success: false,
        error: {
          message: error.message,
          details: this.getErrorDetails(error),
        }
      };
    }
  }

  processVideoData(metadata, formats, audioResult, url) {
    const videoFormats = formats.map(format => ({
      quality: format.quality,
      qualityNumber: format.qualityNumber,
      resolution: format.quality,
      url: format.url,
      filename: format.filename,
      mimeType: 'video/mp4',
      container: 'mp4',
      extension: 'mp4',
      fileSize: null,
      fileSizeFormatted: 'unknown',
      hasVideo: true,
      hasAudio: true,
      type: 'video+audio',
      isPremium: format.qualityNumber > 360,
      tier: this.getTier(format.qualityNumber),
      needsMerge: false,
      status: 'ready',
      downloadable: true,
      note: 'Direct download - audio already included',
      requiresFFmpeg: false,
      source: 'vreden'
    }));

    const allFormats = [...videoFormats];
    if (audioResult && audioResult.download?.url) {
      allFormats.push({
        quality: 'Audio Only',
        qualityNumber: 0,
        resolution: '128kbps',
        url: audioResult.download.url,
        filename: audioResult.download.filename,
        mimeType: 'audio/mpeg',
        container: 'mp3',
        extension: 'mp3',
        fileSize: null,
        fileSizeFormatted: 'unknown',
        hasVideo: false,
        hasAudio: true,
        type: 'audio',
        isPremium: false,
        tier: 'audio',
        needsMerge: false,
        status: 'ready',
        downloadable: true,
        note: 'Audio only MP3',
        requiresFFmpeg: false,
        source: 'vreden'
      });
    }

    allFormats.sort((a, b) => b.qualityNumber - a.qualityNumber);

    const bestQuality = videoFormats[0] || null;

    return {
      success: true,
      video: {
        title: metadata.title || 'Unknown Title',
        url: bestQuality?.url || null,
        thumbnail: metadata.image || metadata.thumbnail || null,
        duration: metadata.duration?.timestamp || 'unknown',
        sizes: allFormats.map(f => f.quality),
        source: 'youtube',
      },
      formats: allFormats,
      allFormats: allFormats,
      selectedQuality: bestQuality,
      recommended: {
        best: videoFormats[0] || null,
        fastest: videoFormats[videoFormats.length - 1] || null,
        sd: videoFormats.find(f => f.qualityNumber === 360) || videoFormats[videoFormats.length - 1]
      },
      stats: {
        totalFormats: allFormats.length,
        videoFormats: videoFormats.length,
        audioFormats: audioResult ? 1 : 0,
        withAudioFormats: videoFormats.length,
        directDownloads: allFormats.length,
        mergeDownloads: 0,
        allDownloadable: allFormats.length
      },
      metadata: {
        videoId: metadata.id,
        channelId: metadata.channel_id,
        channelTitle: metadata.channel_title,
        views: metadata.views,
        timestamp: metadata.duration?.timestamp,
        seconds: metadata.duration?.seconds,
        author: metadata.author,
      },
      isShorts: false,
      ffmpegRequired: false
    };
  }

  getTier(qualityNumber) {
    if (qualityNumber >= 1080) return 'premium-hd';
    if (qualityNumber >= 720) return 'premium';
    if (qualityNumber >= 480) return 'standard';
    return 'free';
  }

  normalizeYouTubeUrl(url) {
    if (url.includes('youtu.be/')) {
      const videoId = url.split('youtu.be/')[1].split('?')[0].split('&')[0];
      return `https://www.youtube.com/watch?v=${videoId}`;
    }

    if (url.includes('youtube.com/watch')) {
      return url;
    }

    if (url.includes('youtube.com/shorts/')) {
      const videoId = url.split('shorts/')[1].split('?')[0].split('&')[0];
      return `https://www.youtube.com/watch?v=${videoId}`;
    }

    return url;
  }

  getErrorDetails(error) {
    if (error.response) {
      return {
        status: error.response.status,
        statusText: error.response.statusText,
        data: error.response.data
      };
    }

    if (error.code) {
      return {
        code: error.code,
        message: error.message
      };
    }

    return {
      message: error.message,
      stack: error.stack
    };
  }

  getRandomUserAgent() {
    const userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0'
    ];
    return userAgents[Math.floor(Math.random() * userAgents.length)];
  }
}

module.exports = VredenYouTubeDownloader;
