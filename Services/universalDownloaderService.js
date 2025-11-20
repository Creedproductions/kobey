const axios = require('axios');
const { Downloader } = require('@tobyg74/tiktok-api-dl');
const savefrom = require('savefrom-api');

async function universalDownload(url) {
  const platform = identifyPlatform(url);
  console.log(`🌐 Universal downloader: ${platform}`);
  
  try {
    // Try multiple downloaders in sequence
    let result = null;
    
    // Method 1: Specific platform handlers
    if (platform === 'douyin') {
      result = await downloadDouyin(url);
    } else if (platform === 'reddit') {
      result = await downloadReddit(url);
    } else if (platform === 'vimeo') {
      result = await downloadVimeo(url);
    } else if (platform === 'dailymotion') {
      result = await downloadDailymotion(url);
    } else if (platform === 'streamable') {
      result = await downloadStreamable(url);
    } else if (platform === 'twitch') {
      result = await downloadTwitch(url);
    } else {
      // Method 2: Universal API fallback
      result = await downloadWithSavefrom(url);
    }
    
    if (result && result.url) {
      return result;
    }
    
    throw new Error('No download URL found');
    
  } catch (error) {
    console.error(`❌ Universal download failed for ${platform}:`, error.message);
    throw new Error(`${platform} download failed: ${error.message}`);
  }
}

// Douyin (Chinese TikTok) downloader
async function downloadDouyin(url) {
  try {
    const result = await Downloader(url, {
      version: "v1"
    });
    
    if (result.status === 'success' && result.result) {
      return {
        title: result.result.desc || 'Douyin Video',
        url: result.result.video?.[0] || result.result.play || '',
        thumbnail: result.result.cover || result.result.origin_cover || '',
        sizes: ['Original Quality'],
        source: 'douyin'
      };
    }
    throw new Error('Douyin API returned no data');
  } catch (error) {
    throw new Error(`Douyin: ${error.message}`);
  }
}

// Reddit video downloader
async function downloadReddit(url) {
  try {
    const response = await axios.get(`https://www.reddit.com/oembed?url=${encodeURIComponent(url)}`);
    
    if (response.data && response.data.thumbnail_url) {
      // Extract video ID and construct download URL
      const videoMatch = url.match(/comments\/([a-z0-9]+)/i);
      if (videoMatch) {
        const videoId = videoMatch[1];
        const videoUrl = `https://v.redd.it/${videoId}/DASH_720.mp4`;
        
        return {
          title: response.data.title || 'Reddit Video',
          url: videoUrl,
          thumbnail: response.data.thumbnail_url,
          sizes: ['720p', '480p', '360p'],
          source: 'reddit'
        };
      }
    }
    
    // Fallback: try direct API
    const apiUrl = url.replace('www.reddit.com', 'www.reddit.com') + '.json';
    const apiResponse = await axios.get(apiUrl);
    
    if (apiResponse.data && apiResponse.data[0]?.data?.children?.[0]?.data) {
      const postData = apiResponse.data[0].data.children[0].data;
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
    
    const response = await axios.get(`https://player.vimeo.com/video/${videoId}/config`);
    
    if (response.data?.request?.files?.progressive) {
      const files = response.data.request.files.progressive;
      const bestQuality = files.sort((a, b) => b.width - a.width)[0];
      
      return {
        title: response.data.video?.title || 'Vimeo Video',
        url: bestQuality.url,
        thumbnail: response.data.video?.thumbs?.base || '',
        sizes: files.map(f => `${f.quality}`),
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
    
    const response = await axios.get(`https://api.dailymotion.com/video/${videoId}?fields=title,thumbnail_url,stream_h264_hd_url,stream_h264_url`);
    
    if (response.data) {
      return {
        title: response.data.title || 'Dailymotion Video',
        url: response.data.stream_h264_hd_url || response.data.stream_h264_url || '',
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
    
    const response = await axios.get(`https://api.streamable.com/videos/${videoId}`);
    
    if (response.data?.files) {
      const mp4 = response.data.files.mp4 || response.data.files.mp4_mobile;
      
      return {
        title: response.data.title || 'Streamable Video',
        url: `https:${mp4.url}`,
        thumbnail: `https:${response.data.thumbnail_url}` || '',
        sizes: ['Original Quality'],
        source: 'streamable'
      };
    }
    
    throw new Error('No video files found');
  } catch (error) {
    throw new Error(`Streamable: ${error.message}`);
  }
}

// Twitch clips downloader
async function downloadTwitch(url) {
  try {
    if (!url.includes('clips.twitch.tv') && !url.includes('/clip/')) {
      throw new Error('Only Twitch clips are supported');
    }
    
    const clipId = url.match(/clips\.twitch\.tv\/([a-zA-Z0-9_-]+)|clip\/([a-zA-Z0-9_-]+)/)?.[1] || 
                    url.match(/clips\.twitch\.tv\/([a-zA-Z0-9_-]+)|clip\/([a-zA-Z0-9_-]+)/)?.[2];
    
    if (!clipId) throw new Error('Invalid Twitch clip URL');
    
    // Use Twitch embed URL to get video data
    const embedUrl = `https://clips.twitch.tv/embed?clip=${clipId}`;
    const response = await axios.get(embedUrl);
    
    // Extract video URL from embed page
    const videoMatch = response.data.match(/"clipURL":"([^"]+)"/);
    if (videoMatch) {
      return {
        title: 'Twitch Clip',
        url: videoMatch[1].replace(/\\u002F/g, '/'),
        thumbnail: '',
        sizes: ['Original Quality'],
        source: 'twitch'
      };
    }
    
    throw new Error('Could not extract video URL');
  } catch (error) {
    throw new Error(`Twitch: ${error.message}`);
  }
}

// Universal fallback using savefrom-api
async function downloadWithSavefrom(url) {
  try {
    const result = await savefrom.download(url);
    
    if (result && result.data && result.data.length > 0) {
      const bestQuality = result.data.sort((a, b) => (b.quality || 0) - (a.quality || 0))[0];
      
      return {
        title: result.title || 'Universal Download',
        url: bestQuality.url,
        thumbnail: result.thumbnail || '',
        sizes: result.data.map(d => d.quality || 'Original'),
        source: identifyPlatform(url)
      };
    }
    
    throw new Error('Savefrom API returned no data');
  } catch (error) {
    throw new Error(`Savefrom: ${error.message}`);
  }
}

function identifyPlatform(url) {
  const lower = url.toLowerCase();
  
  if (lower.includes('douyin.com')) return 'douyin';
  if (lower.includes('reddit.com') || lower.includes('redd.it')) return 'reddit';
  if (lower.includes('vimeo.com')) return 'vimeo';
  if (lower.includes('dailymotion.com')) return 'dailymotion';
  if (lower.includes('streamable.com')) return 'streamable';
  if (lower.includes('twitch.tv')) return 'twitch';
  if (lower.includes('pornhub.com')) return 'pornhub';
  if (lower.includes('xvideos.com')) return 'xvideos';
  if (lower.includes('likee.video')) return 'likee';
  if (lower.includes('kwai.com')) return 'kwai';
  if (lower.includes('snapchat.com')) return 'snapchat';
  if (lower.includes('9gag.com')) return '9gag';
  if (lower.includes('imgur.com')) return 'imgur';
  if (lower.includes('tumblr.com')) return 'tumblr';
  if (lower.includes('soundcloud.com')) return 'soundcloud';
  if (lower.includes('bandcamp.com')) return 'bandcamp';
  if (lower.includes('mixcloud.com')) return 'mixcloud';
  if (lower.includes('ted.com')) return 'ted';
  if (lower.includes('bilibili.com')) return 'bilibili';
  if (lower.includes('vk.com')) return 'vk';
  
  return 'universal';
}

module.exports = { universalDownload };
