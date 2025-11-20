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

// Douyin downloader using TikTok service
async function downloadDouyin(url) {
  try {
    console.log('🎵 Processing Douyin URL...');
    
    // Since Douyin is Chinese TikTok, use the same service
    const { ttdl } = require('btch-downloader');
    
    // Convert Douyin URL to standard format if needed
    let processedUrl = url;
    if (url.includes('v.douyin.com')) {
      // Follow the redirect to get the actual video URL
      try {
        const response = await axios.get(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
          },
          maxRedirects: 5,
          timeout: 10000
        });
        processedUrl = response.request.res.responseUrl || url;
      } catch (redirectError) {
        console.log('⚠️ Could not resolve Douyin redirect, using original URL');
      }
    }
    
    console.log('🔄 Using TikTok service for Douyin download...');
    const data = await ttdl(processedUrl);
    
    if (!data || !data.video) {
      throw new Error('No video data found');
    }
    
    return {
      title: data.title || 'Douyin Video',
      url: data.video[0] || data.video,
      thumbnail: data.thumbnail || '',
      sizes: ['Original Quality'],
      source: 'douyin',
      audio: data.audio ? data.audio[0] : null
    };
    
  } catch (error) {
    console.error(`❌ Douyin download failed: ${error.message}`);
    
    // Alternative method: Try to extract video directly
    try {
      console.log('🔄 Trying alternative Douyin download method...');
      const alternativeData = await downloadDouyinAlternative(url);
      if (alternativeData) {
        return alternativeData;
      }
    } catch (altError) {
      console.log(`⚠️ Alternative method also failed: ${altError.message}`);
    }
    
    throw new Error(`Douyin download failed: ${error.message}`);
  }
}

// Alternative Douyin download method
async function downloadDouyinAlternative(url) {
  try {
    // Use axios to get the page and extract video URL
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Referer': 'https://www.douyin.com/'
      },
      timeout: 15000
    });
    
    const html = response.data;
    
    // Try to find video URL in the HTML
    const videoUrlMatch = html.match(/"playAddr":\s*"([^"]+)"/) || 
                         html.match(/src="([^"]+\.mp4[^"]*)"/) ||
                         html.match(/video_url[^=]*=\s*"([^"]+)"/);
    
    if (videoUrlMatch && videoUrlMatch[1]) {
      let videoUrl = videoUrlMatch[1].replace(/\\u002F/g, '/');
      
      // Ensure URL is absolute
      if (videoUrl.startsWith('//')) {
        videoUrl = 'https:' + videoUrl;
      } else if (videoUrl.startsWith('/')) {
        videoUrl = 'https://www.douyin.com' + videoUrl;
      }
      
      // Try to find title
      const titleMatch = html.match(/desc[^>]*>([^<]+)</) || 
                        html.match(/title[^>]*>([^<]+)</) ||
                        html.match(/"desc":\s*"([^"]+)"/);
      
      const title = titleMatch ? titleMatch[1].substring(0, 100) : 'Douyin Video';
      
      return {
        title: title,
        url: videoUrl,
        thumbnail: '',
        sizes: ['Original Quality'],
        source: 'douyin'
      };
    }
    
    throw new Error('Could not extract video URL from page');
    
  } catch (error) {
    throw new Error(`Alternative method: ${error.message}`);
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
