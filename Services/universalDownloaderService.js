const axios = require('axios');
const { Downloader } = require('@tobyg74/tiktok-api-dl');

async function universalDownload(url) {
  const platform = identifyPlatform(url);
  console.log(`🌐 Universal downloader: ${platform}`);
  
  try {
    let result = null;
    
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
      result = await downloadGenericVideo(url);
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

// Douyin (Chinese TikTok)
async function downloadDouyin(url) {
  try {
    const result = await Downloader(url, { version: "v1" });
    
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

// Reddit
async function downloadReddit(url) {
  try {
    const apiUrl = url.replace('www.reddit.com', 'www.reddit.com') + '.json';
    const response = await axios.get(apiUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
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
    }
    
    throw new Error('No video found in Reddit post');
  } catch (error) {
    throw new Error(`Reddit: ${error.message}`);
  }
}

// Vimeo
async function downloadVimeo(url) {
  try {
    const videoId = url.match(/vimeo\.com\/(\d+)/)?.[1];
    if (!videoId) throw new Error('Invalid Vimeo URL');
    
    const response = await axios.get(`https://player.vimeo.com/video/${videoId}/config`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
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

// Dailymotion
async function downloadDailymotion(url) {
  try {
    const videoId = url.match(/video\/([a-z0-9]+)/i)?.[1];
    if (!videoId) throw new Error('Invalid Dailymotion URL');
    
    const response = await axios.get(`https://api.dailymotion.com/video/${videoId}?fields=title,thumbnail_url,stream_h264_hd_url,stream_h264_url`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    
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

// Streamable
async function downloadStreamable(url) {
  try {
    const videoId = url.match(/streamable\.com\/([a-z0-9]+)/i)?.[1];
    if (!videoId) throw new Error('Invalid Streamable URL');
    
    const response = await axios.get(`https://api.streamable.com/videos/${videoId}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    
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

// Twitch Clips
async function downloadTwitch(url) {
  try {
    if (!url.includes('clips.twitch.tv') && !url.includes('/clip/')) {
      throw new Error('Only Twitch clips are supported');
    }
    
    const clipSlug = url.match(/clips\.twitch\.tv\/([a-zA-Z0-9_-]+)|clip\/([a-zA-Z0-9_-]+)/)?.[1] || 
                      url.match(/clips\.twitch\.tv\/([a-zA-Z0-9_-]+)|clip\/([a-zA-Z0-9_-]+)/)?.[2];
    
    if (!clipSlug) throw new Error('Invalid Twitch clip URL');
    
    // Use Twitch GQL API
    const response = await axios.post('https://gql.twitch.tv/gql', {
      query: `{
        clip(slug: "${clipSlug}") {
          title
          thumbnailURL
          videoQualities {
            quality
            sourceURL
          }
        }
      }`
    }, {
      headers: {
        'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko',
        'User-Agent': 'Mozilla/5.0'
      }
    });
    
    if (response.data?.data?.clip) {
      const clip = response.data.data.clip;
      const qualities = clip.videoQualities || [];
      const bestQuality = qualities[0];
      
      return {
        title: clip.title || 'Twitch Clip',
        url: bestQuality?.sourceURL || '',
        thumbnail: clip.thumbnailURL || '',
        sizes: qualities.map(q => q.quality),
        source: 'twitch'
      };
    }
    
    throw new Error('Could not fetch clip data');
  } catch (error) {
    throw new Error(`Twitch: ${error.message}`);
  }
}

// Generic video extractor (fallback)
async function downloadGenericVideo(url) {
  try {
    // Try to find video tags in HTML
    const response = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 10000
    });
    
    const html = response.data;
    
    // Look for Open Graph video
    const ogVideoMatch = html.match(/<meta[^>]*property=["']og:video["'][^>]*content=["']([^"']+)["']/i);
    if (ogVideoMatch) {
      return {
        title: 'Video Download',
        url: ogVideoMatch[1],
        thumbnail: '',
        sizes: ['Original Quality'],
        source: 'universal'
      };
    }
    
    // Look for video tags
    const videoMatch = html.match(/<video[^>]*src=["']([^"']+)["']/i);
    if (videoMatch) {
      return {
        title: 'Video Download',
        url: videoMatch[1],
        thumbnail: '',
        sizes: ['Original Quality'],
        source: 'universal'
      };
    }
    
    throw new Error('No video found on page');
  } catch (error) {
    throw new Error(`Generic: ${error.message}`);
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
