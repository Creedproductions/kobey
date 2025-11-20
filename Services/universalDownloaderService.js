const axios = require('axios');

async function universalDownload(url) {
  const platform = identifyPlatform(url);
  console.log(`🌐 Universal downloader: ${platform}`);
  
  try {
    let result = null;
    
    if (platform === 'reddit') {
      result = await downloadReddit(url);
    } else if (platform === 'vimeo') {
      result = await downloadVimeo(url);
    } else if (platform === 'dailymotion') {
      result = await downloadDailymotion(url);
    } else if (platform === 'streamable') {
      result = await downloadStreamable(url);
    } else if (platform === 'douyin') {
      result = await downloadDouyin(url);
    } else {
      throw new Error(`${platform} not yet supported`);
    }
    
    if (result && result.url) {
      return result;
    }
    
    throw new Error('No download URL found');
    
  } catch (error) {
    console.error(`❌ ${platform} download failed:`, error.message);
    throw new Error(`${platform} download failed: ${error.message}`);
  }
}

// Reddit video downloader
async function downloadReddit(url) {
  try {
    let jsonUrl = url.endsWith('.json') ? url : url + '.json';
    jsonUrl = jsonUrl.replace('www.reddit.com', 'www.reddit.com');
    
    const response = await axios.get(jsonUrl, {
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 10000
    });
    
    if (response.data && response.data[0]?.data?.children?.[0]?.data) {
      const postData = response.data[0].data.children[0].data;
      const videoData = postData.secure_media?.reddit_video || postData.media?.reddit_video;
      
      if (videoData?.fallback_url) {
        return {
          title: postData.title || 'Reddit Video',
          url: videoData.fallback_url,
          thumbnail: postData.thumbnail || '',
          sizes: ['Original Quality'],
          source: 'reddit'
        };
      }
      
      // Try cross-post
      if (postData.crosspost_parent_list && postData.crosspost_parent_list.length > 0) {
        const crosspost = postData.crosspost_parent_list[0];
        const crosspostVideo = crosspost.secure_media?.reddit_video || crosspost.media?.reddit_video;
        
        if (crosspostVideo?.fallback_url) {
          return {
            title: crosspost.title || 'Reddit Video',
            url: crosspostVideo.fallback_url,
            thumbnail: crosspost.thumbnail || '',
            sizes: ['Original Quality'],
            source: 'reddit'
          };
        }
      }
    }
    
    throw new Error('No video found in Reddit post');
  } catch (error) {
    throw new Error(`Reddit: ${error.message}`);
  }
}

// Vimeo downloader
async function downloadVimeo(url) {
  try {
    const videoId = url.match(/vimeo\.com\/(\d+)/)?.[1];
    if (!videoId) throw new Error('Invalid Vimeo URL');
    
    const response = await axios.get(`https://player.vimeo.com/video/${videoId}/config`, {
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://player.vimeo.com/'
      },
      timeout: 10000
    });
    
    if (response.data?.request?.files?.progressive) {
      const files = response.data.request.files.progressive;
      const bestQuality = files.sort((a, b) => (b.width || 0) - (a.width || 0))[0];
      
      return {
        title: response.data.video?.title || 'Vimeo Video',
        url: bestQuality.url,
        thumbnail: response.data.video?.thumbs?.base || '',
        sizes: files.map(f => `${f.quality || f.width}p`),
        source: 'vimeo'
      };
    }
    
    throw new Error('No video files found');
  } catch (error) {
    throw new Error(`Vimeo: ${error.message}`);
  }
}

// Dailymotion downloader
async function downloadDailymotion(url) {
  try {
    const videoId = url.match(/video\/([a-z0-9]+)/i)?.[1];
    if (!videoId) throw new Error('Invalid Dailymotion URL');
    
    const response = await axios.get(
      `https://api.dailymotion.com/video/${videoId}?fields=title,thumbnail_url,stream_h264_hd_url,stream_h264_url`,
      {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        timeout: 10000
      }
    );
    
    if (response.data) {
      const videoUrl = response.data.stream_h264_hd_url || response.data.stream_h264_url;
      if (!videoUrl) throw new Error('No video stream found');
      
      return {
        title: response.data.title || 'Dailymotion Video',
        url: videoUrl,
        thumbnail: response.data.thumbnail_url || '',
        sizes: ['HD', 'SD'],
        source: 'dailymotion'
      };
    }
    
    throw new Error('No video data found');
  } catch (error) {
    throw new Error(`Dailymotion: ${error.message}`);
  }
}

// Streamable downloader
async function downloadStreamable(url) {
  try {
    const videoId = url.match(/streamable\.com\/([a-z0-9]+)/i)?.[1];
    if (!videoId) throw new Error('Invalid Streamable URL');
    
    const response = await axios.get(`https://api.streamable.com/videos/${videoId}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 10000
    });
    
    if (response.data?.files) {
      const mp4 = response.data.files.mp4 || response.data.files.mp4_mobile;
      if (!mp4) throw new Error('No MP4 file found');
      
      return {
        title: response.data.title || 'Streamable Video',
        url: mp4.url.startsWith('//') ? `https:${mp4.url}` : mp4.url,
        thumbnail: response.data.thumbnail_url ? 
                   (response.data.thumbnail_url.startsWith('//') ? `https:${response.data.thumbnail_url}` : response.data.thumbnail_url) : '',
        sizes: ['Original Quality'],
        source: 'streamable'
      };
    }
    
    throw new Error('No video files found');
  } catch (error) {
    throw new Error(`Streamable: ${error.message}`);
  }
}

// Douyin (use existing TikTok service as fallback)
async function downloadDouyin(url) {
  try {
    // Douyin shares similar structure with TikTok
    // For now, return error - user should use TikTok downloader
    throw new Error('Douyin requires TikTok service - please use TikTok downloader');
  } catch (error) {
    throw new Error(`Douyin: ${error.message}`);
  }
}

function identifyPlatform(url) {
  const lower = url.toLowerCase();
  
  if (lower.includes('reddit.com') || lower.includes('redd.it')) return 'reddit';
  if (lower.includes('vimeo.com')) return 'vimeo';
  if (lower.includes('dailymotion.com')) return 'dailymotion';
  if (lower.includes('streamable.com')) return 'streamable';
  if (lower.includes('douyin.com')) return 'douyin';
  
  return 'universal';
}

module.exports = { universalDownload };
