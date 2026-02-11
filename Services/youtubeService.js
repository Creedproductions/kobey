// Services/youtubeService.js
'use strict';

const ytdl = require('ytdl-core');

/**
 * Extract video ID from various YouTube URL formats
 */
function extractVideoId(url) {
  try {
    // youtu.be format
    if (url.includes('youtu.be/')) {
      return url.split('youtu.be/')[1]?.split(/[?&/#]/)[0];
    }
    
    // youtube.com format
    const u = new URL(url);
    const v = u.searchParams.get('v');
    if (v && v.length === 11) return v;
    
    // shorts format
    const p = u.pathname;
    if (p.includes('/shorts/') || p.includes('/embed/')) {
      return p.split('/').pop()?.split(/[?&/#]/)[0];
    }
  } catch {
    // Fallback regex
    const m = String(url).match(/(?:v=|\/)([0-9A-Za-z_-]{11})/);
    return m ? m[1] : null;
  }
  return null;
}

/**
 * Main function to fetch YouTube video data
 */
async function fetchYouTubeData(url) {
  const videoId = extractVideoId(url);
  if (!videoId) {
    throw new Error('Invalid YouTube URL');
  }

  console.log(`🎬 [ytdl-core] Fetching: ${videoId}`);

  try {
    // Get video info with clean headers - no cookies, no auth
    const info = await ytdl.getInfo(videoId, {
      requestOptions: {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'gzip, deflate, br',
          'DNT': '1',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Cache-Control': 'max-age=0'
        }
      }
    });

    const videoDetails = info.videoDetails;
    
    // Filter for formats with both video and audio (muxed)
    const videoFormats = info.formats
      .filter(f => f.hasVideo && f.hasAudio && f.url)
      .map(f => {
        // Extract height from quality label or directly from height property
        let height = 0;
        if (f.height) {
          height = f.height;
        } else if (f.qualityLabel) {
          const match = f.qualityLabel.match(/(\d+)p/);
          height = match ? parseInt(match[1]) : 0;
        }
        
        return {
          quality: f.qualityLabel || `${height}p`,
          qualityNum: height,
          url: f.url,
          type: 'mp4',
          extension: 'mp4',
          filesize: f.contentLength ? parseInt(f.contentLength) : 0,
          fps: f.fps || 30,
          hasAudio: true,
          hasVideo: true,
          isAudioOnly: false,
          needsMerge: false,
          bitrate: f.bitrate || 0,
          itag: f.itag
        };
      })
      .filter(f => f.qualityNum > 0) // Remove invalid qualities
      .sort((a, b) => b.qualityNum - a.qualityNum); // Highest quality first

    // Filter for audio-only formats
    const audioFormats = info.formats
      .filter(f => f.hasAudio && !f.hasVideo && f.url)
      .map(f => {
        const bitrate = f.bitrate || 128000;
        const kbps = Math.round(bitrate / 1000);
        
        return {
          quality: `${kbps}kbps Audio`,
          qualityNum: 0,
          url: f.url,
          type: f.container === 'webm' ? 'webm' : 'm4a',
          extension: f.container === 'webm' ? 'webm' : 'm4a',
          filesize: f.contentLength ? parseInt(f.contentLength) : 0,
          hasAudio: true,
          hasVideo: false,
          isAudioOnly: true,
          needsMerge: false,
          bitrate: kbps,
          itag: f.itag
        };
      })
      .sort((a, b) => b.bitrate - a.bitrate) // Highest bitrate first
      .slice(0, 3); // Only top 3 audio qualities

    // Get best quality thumbnail
    const thumbnails = videoDetails.thumbnails || [];
    const thumbnail = thumbnails[thumbnails.length - 1]?.url || 
                     `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;

    // Combine all formats
    const allFormats = [...videoFormats, ...audioFormats];
    
    // Default to 360p or highest available
    const defaultQuality = videoFormats.find(f => f.qualityNum === 360) || 
                          videoFormats[0] || 
                          audioFormats[0];

    console.log(`✅ [ytdl-core] Success: "${videoDetails.title}"`);
    console.log(`   📊 ${videoFormats.length} video + ${audioFormats.length} audio formats`);

    return {
      // Basic info
      title: videoDetails.title || 'Unknown',
      thumbnail,
      duration: parseInt(videoDetails.lengthSeconds) || 0,
      description: videoDetails.description || '',
      author: videoDetails.author?.name || 'Unknown',
      viewCount: parseInt(videoDetails.viewCount) || 0,
      
      // Formats
      formats: allFormats,
      allFormats: allFormats,
      videoFormats: videoFormats,
      audioFormats: audioFormats,
      
      // Default download
      url: defaultQuality?.url || '',
      selectedQuality: defaultQuality,
      
      // Metadata
      videoId: videoDetails.videoId,
      isShorts: url.includes('/shorts/'),
      
      metadata: {
        videoId: videoDetails.videoId,
        author: videoDetails.author?.name || 'Unknown',
        title: videoDetails.title || 'Unknown'
      },
      
      // Debug info
      _debug: {
        totalFormats: info.formats.length,
        videoFormats: videoFormats.length,
        audioFormats: audioFormats.length,
        defaultQuality: defaultQuality?.quality || 'None',
        formatCount: allFormats.length
      }
    };

  } catch (error) {
    console.error(`❌ [ytdl-core] Error:`, error.message);
    
    // Handle specific error cases
    if (error.message.includes('Sign in') || 
        error.message.includes('age') || 
        error.message.includes('restricted') ||
        error.message.includes('confirm your age')) {
      throw new Error('This video is age-restricted and cannot be accessed without login. Try a different video.');
    }
    
    if (error.message.includes('private') || error.message.includes('unavailable')) {
      throw new Error('This video is private or unavailable.');
    }
    
    if (error.message.includes('copyright')) {
      throw new Error('This video is unavailable due to copyright claim.');
    }
    
    if (error.message.includes('region') || error.message.includes('country')) {
      throw new Error('This video is not available in your region.');
    }
    
    throw new Error(`YouTube download failed: ${error.message}`);
  }
}

module.exports = { fetchYouTubeData };
