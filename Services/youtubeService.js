/**
 * youtubeService.js - Working YouTube Service with play-dl
 * 
 * No cookies required for most videos
 * Fast and reliable - better than ytdl-core
 * Actively maintained for 2025
 * 
 * Install: npm install play-dl
 */

const play = require('play-dl');

/**
 * Extract video ID from various YouTube URL formats
 */
function extractVideoId(url) {
  try {
    const urlStr = String(url);
    
    // youtu.be/VIDEO_ID
    if (urlStr.includes('youtu.be/')) {
      return urlStr.split('youtu.be/')[1]?.split(/[?&#]/)[0] || null;
    }
    
    // youtube.com/watch?v=VIDEO_ID
    const urlObj = new URL(urlStr);
    const vParam = urlObj.searchParams.get('v');
    if (vParam && vParam.length === 11) {
      return vParam;
    }
    
    // youtube.com/shorts/VIDEO_ID or youtube.com/embed/VIDEO_ID
    const pathname = urlObj.pathname || '';
    if (pathname.includes('/shorts/') || pathname.includes('/embed/')) {
      return pathname.split('/').pop()?.split(/[?&#]/)[0] || null;
    }
    
    // Fallback: regex match
    const match = urlStr.match(/(?:v=|\/)([0-9A-Za-z_-]{11})/);
    return match ? match[1] : null;
  } catch (error) {
    const match = String(url).match(/(?:v=|\/)([0-9A-Za-z_-]{11})/);
    return match ? match[1] : null;
  }
}

/**
 * Format duration from seconds to HH:MM:SS
 */
function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return '0:00';
  
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

/**
 * Get file extension from format
 */
function getFileExtension(format) {
  if (!format) return 'mp4';
  
  const container = format.container || '';
  if (container.includes('webm')) return 'webm';
  if (container.includes('m4a')) return 'm4a';
  if (container.includes('mp3')) return 'mp3';
  
  return 'mp4';
}

/**
 * Main YouTube fetch function
 */
async function fetchYouTubeData(url) {
  try {
    console.log('🎬 [YouTube] Starting fetch for:', url);
    
    // Extract video ID
    const videoId = extractVideoId(url);
    if (!videoId) {
      throw new Error('Could not extract video ID from URL');
    }
    
    console.log('📹 [YouTube] Video ID:', videoId);
    
    // Get video info using play-dl
    const videoInfo = await play.video_basic_info(url);
    
    if (!videoInfo || !videoInfo.video_details) {
      throw new Error('Failed to fetch video information');
    }
    
    const details = videoInfo.video_details;
    
    // Check if video is available
    if (!details.url) {
      throw new Error('This video is not available (may be private, deleted, or region-restricted)');
    }
    
    console.log('✅ [YouTube] Video info retrieved:', details.title);
    
    // Process available formats
    const formats = [];
    const videoFormats = [];
    const audioFormats = [];
    
    if (videoInfo.format && Array.isArray(videoInfo.format)) {
      for (const format of videoInfo.format) {
        const hasVideo = format.height && format.height > 0;
        const hasAudio = format.audio_codec && format.audio_codec !== null;
        const quality = format.quality_label || `${format.height || 'Audio'}p`;
        const qualityNum = format.height || 0;
        const bitrate = format.bitrate || 0;
        const filesize = format.contentLength || 'unknown';
        const fps = format.fps || 30;
        
        const formatObj = {
          quality: quality,
          qualityNum: qualityNum,
          url: format.url,
          type: getFileExtension(format),
          extension: getFileExtension(format),
          filesize: filesize,
          fps: fps,
          hasAudio: hasAudio,
          hasVideo: hasVideo,
          isAudioOnly: !hasVideo && hasAudio,
          needsMerge: hasVideo && !hasAudio,
          bitrate: Math.round(bitrate / 1000),
          itag: format.itag,
          container: format.container || 'mp4',
          codec: format.codecs || 'unknown'
        };
        
        formats.push(formatObj);
        
        if (hasVideo && !hasAudio) {
          videoFormats.push(formatObj);
        } else if (hasAudio && !hasVideo) {
          audioFormats.push(formatObj);
        } else if (hasVideo && hasAudio) {
          videoFormats.push(formatObj);
        }
      }
    }
    
    // Sort formats by quality
    videoFormats.sort((a, b) => (b.qualityNum || 0) - (a.qualityNum || 0));
    audioFormats.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    formats.sort((a, b) => (b.qualityNum || 0) - (a.qualityNum || 0));
    
    // Select default quality (360p with audio, or best available with audio)
    const muxedFormats = videoFormats.filter(f => f.hasAudio && f.hasVideo && !f.needsMerge);
    const defaultQuality = 
      muxedFormats.find(f => f.qualityNum === 360) || 
      muxedFormats[0] || 
      audioFormats[0] || 
      formats[0];
    
    // Get thumbnail
    let thumbnail = details.thumbnails?.[0]?.url || 
                   `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
    
    if (details.thumbnails && details.thumbnails.length > 0) {
      const bestThumb = details.thumbnails.reduce((prev, current) => {
        return (current.width > prev.width) ? current : prev;
      });
      thumbnail = bestThumb.url;
    }
    
    // Determine if it's a short
    const isShorts = url.includes('/shorts/');
    
    // Calculate statistics
    const stats = {
      totalFormats: formats.length,
      videoFormats: videoFormats.length,
      audioFormats: audioFormats.length,
      withAudioFormats: videoFormats.filter(f => f.hasAudio).length,
      directDownloads: formats.filter(f => !f.needsMerge).length,
      mergeDownloads: formats.filter(f => f.needsMerge).length,
      allDownloadable: formats.length
    };
    
    console.log(`✅ [YouTube] Successfully processed: ${stats.totalFormats} formats available`);
    console.log(`🎯 [YouTube] Selected quality: ${defaultQuality?.quality || 'None'}`);
    
    // Return formatted data
    return {
      title: details.title || 'Unknown Title',
      thumbnail: thumbnail,
      duration: details.durationInSec || 0,
      durationFormatted: formatDuration(details.durationInSec),
      description: details.description || '',
      author: details.channel?.name || 'Unknown Channel',
      viewCount: details.views || 0,
      
      formats: formats,
      allFormats: formats,
      videoFormats: videoFormats,
      audioFormats: audioFormats,
      
      url: defaultQuality?.url || null,
      selectedQuality: defaultQuality,
      
      recommended: {
        best: formats[0] || null,
        fastest: muxedFormats.find(f => f.qualityNum === 360) || muxedFormats[0] || formats[0],
        sd: muxedFormats.find(f => f.qualityNum === 480) || muxedFormats[0] || formats[0],
        hd: muxedFormats.find(f => f.qualityNum === 720) || formats[0],
        fullHd: muxedFormats.find(f => f.qualityNum === 1080) || formats[0]
      },
      
      videoId: videoId,
      isShorts: isShorts,
      stats: stats,
      
      metadata: {
        videoId: videoId,
        author: details.channel?.name || 'Unknown',
        channelId: details.channel?.id || '',
        uploadDate: details.uploadedAt || '',
        private: details.private || false,
        live: details.live || false
      },
      
      ffmpegRequired: stats.mergeDownloads > 0,
      
      _debug: {
        source: 'play-dl',
        videoId: videoId,
        formatCount: formats.length,
        defaultQuality: defaultQuality?.quality || 'None'
      }
    };
    
  } catch (error) {
    console.error(`❌ [YouTube] Error:`, error.message);
    
    if (error.message.includes('Private video')) {
      throw new Error('This video is private and cannot be downloaded');
    }
    
    if (error.message.includes('Video unavailable') || error.message.includes('not available')) {
      throw new Error('This video is not available (may be deleted or region-restricted)');
    }
    
    if (error.message.includes('Sign in to confirm')) {
      throw new Error('This video requires age verification or sign-in');
    }
    
    throw new Error(`YouTube download failed: ${error.message}`);
  }
}

module.exports = { fetchYouTubeData };
