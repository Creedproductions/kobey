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
// Robust Douyin downloader with multiple independent methods
async function downloadDouyin(url) {
  console.log('🎵 Starting Douyin download process...');
  
  // Method 1: Direct video extraction from HTML
  try {
    console.log('🔄 Method 1: HTML video extraction...');
    const htmlData = await extractDouyinFromHTML(url);
    if (htmlData && htmlData.url) {
      console.log('✅ HTML extraction successful');
      return htmlData;
    }
  } catch (error) {
    console.log(`⚠️ HTML extraction failed: ${error.message}`);
  }

  // Method 2: API endpoint approach
  try {
    console.log('🔄 Method 2: API endpoint...');
    const apiData = await extractDouyinFromAPI(url);
    if (apiData && apiData.url) {
      console.log('✅ API extraction successful');
      return apiData;
    }
  } catch (error) {
    console.log(`⚠️ API extraction failed: ${error.message}`);
  }

  // Method 3: Public Douyin downloader APIs
  try {
    console.log('🔄 Method 3: Public APIs...');
    const publicData = await extractDouyinFromPublicAPI(url);
    if (publicData && publicData.url) {
      console.log('✅ Public API successful');
      return publicData;
    }
  } catch (error) {
    console.log(`⚠️ Public API failed: ${error.message}`);
  }

  throw new Error('All Douyin download methods failed');
}

// Method 1: Extract from HTML
async function extractDouyinFromHTML(url) {
  try {
    // Follow redirects to get final URL
    const finalUrl = await followRedirects(url);
    console.log(`📄 Final URL: ${finalUrl}`);

    const response = await axios.get(finalUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Referer': 'https://www.douyin.com/'
      },
      timeout: 15000
    });

    const html = response.data;

    // Look for JSON data in script tags
    const jsonPatterns = [
      /window\._SSR_HYDRATED_DATA\s*=\s*({[^;]+});?/,
      /"video":\s*({[^}]+})/,
      /"playAddr":\s*"([^"]+)"/,
      /"downloadAddr":\s*"([^"]+)"/
    ];

    for (const pattern of jsonPatterns) {
      const match = html.match(pattern);
      if (match) {
        try {
          // Try to parse JSON or extract URL directly
          if (pattern.toString().includes('{')) {
            const jsonStr = match[1].replace(/undefined/g, 'null');
            const data = JSON.parse(jsonStr);
            
            // Navigate through possible JSON structures
            const videoUrl = findVideoUrlInObject(data);
            if (videoUrl) {
              return {
                title: extractTitleFromHTML(html) || 'Douyin Video',
                url: videoUrl,
                thumbnail: extractThumbnailFromHTML(html) || '',
                sizes: ['Original Quality'],
                source: 'douyin'
              };
            }
          } else {
            // Direct URL match
            const videoUrl = match[1].replace(/\\u002F/g, '/')
                                    .replace(/\\\//g, '/');
            if (videoUrl.includes('.mp4')) {
              return {
                title: extractTitleFromHTML(html) || 'Douyin Video',
                url: videoUrl.startsWith('//') ? 'https:' + videoUrl : videoUrl,
                thumbnail: '',
                sizes: ['Original Quality'],
                source: 'douyin'
              };
            }
          }
        } catch (e) {
          continue;
        }
      }
    }

    // Fallback: Search for mp4 URLs in HTML
    const mp4Regex = /https:[^"']*\.mp4[^"']*/g;
    const mp4Matches = html.match(mp4Regex);
    if (mp4Matches && mp4Matches.length > 0) {
      const videoUrl = mp4Matches[0];
      return {
        title: extractTitleFromHTML(html) || 'Douyin Video',
        url: videoUrl,
        thumbnail: '',
        sizes: ['Original Quality'],
        source: 'douyin'
      };
    }

    throw new Error('No video URL found in HTML');

  } catch (error) {
    throw new Error(`HTML extraction: ${error.message}`);
  }
}

// Method 2: API endpoints
async function extractDouyinFromAPI(url) {
  try {
    const finalUrl = await followRedirects(url);
    const videoId = extractVideoId(finalUrl);
    
    if (!videoId) {
      throw new Error('Could not extract video ID');
    }

    console.log(`📹 Video ID: ${videoId}`);

    // Try different API endpoints
    const endpoints = [
      `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${videoId}`,
      `https://www.iesdouyin.com/web/api/v2/aweme/iteminfo/?item_ids=${videoId}`,
    ];

    for (const endpoint of endpoints) {
      try {
        const response = await axios.get(endpoint, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15',
            'Referer': 'https://www.douyin.com/',
            'Accept': 'application/json'
          },
          timeout: 10000
        });

        const data = response.data;

        if (data.aweme_detail) {
          const video = data.aweme_detail.video;
          const videoUrl = video.play_addr?.url_list?.[0] || 
                          video.download_addr?.url_list?.[0] ||
                          video.play_addr?.url_list?.[0];

          if (videoUrl) {
            return {
              title: data.aweme_detail.desc || 'Douyin Video',
              url: videoUrl.replace(/&watermark=1/g, ''),
              thumbnail: video.cover?.url_list?.[0] || video.dynamic_cover?.url_list?.[0] || '',
              sizes: ['Original Quality'],
              source: 'douyin'
            };
          }
        }

        if (data.item_list && data.item_list[0]) {
          const item = data.item_list[0];
          const videoUrl = item.video?.play_addr?.url_list?.[0];

          if (videoUrl) {
            return {
              title: item.desc || 'Douyin Video',
              url: videoUrl,
              thumbnail: item.video?.cover?.url_list?.[0] || '',
              sizes: ['Original Quality'],
              source: 'douyin'
            };
          }
        }

      } catch (endpointError) {
        console.log(`⚠️ Endpoint failed: ${endpoint}`);
        continue;
      }
    }

    throw new Error('No video data from APIs');

  } catch (error) {
    throw new Error(`API extraction: ${error.message}`);
  }
}

// Method 3: Public downloader APIs
async function extractDouyinFromPublicAPI(url) {
  try {
    const publicApis = [
      {
        url: `https://api.douyin.wtf/api?url=${encodeURIComponent(url)}`,
        extractor: (data) => data.video_data?.nwm_video_url || data.video_data?.nwm_video_url_HQ
      },
      {
        url: `https://api.tik.fail/api/grab?url=${encodeURIComponent(url)}`,
        extractor: (data) => data?.video?.downloadAddr
      }
    ];

    for (const api of publicApis) {
      try {
        const response = await axios.get(api.url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/json'
          },
          timeout: 15000
        });

        const videoUrl = api.extractor(response.data);
        if (videoUrl) {
          return {
            title: response.data?.desc || 'Douyin Video',
            url: videoUrl,
            thumbnail: response.data?.cover || '',
            sizes: ['Original Quality'],
            source: 'douyin'
          };
        }
      } catch (apiError) {
        console.log(`⚠️ Public API failed: ${api.url}`);
        continue;
      }
    }

    throw new Error('No public APIs worked');

  } catch (error) {
    throw new Error(`Public API: ${error.message}`);
  }
}

// Helper functions
async function followRedirects(url) {
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15'
      },
      maxRedirects: 5,
      validateStatus: null,
      timeout: 10000
    });
    return response.request.res.responseUrl || url;
  } catch (error) {
    return url;
  }
}

function extractVideoId(url) {
  const patterns = [
    /video\/(\d+)/,
    /share\/(\d+)/,
    /modal=(\d+)/,
    /v\.douyin\.com\/([A-Za-z0-9]+)\//
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }

  return null;
}

function findVideoUrlInObject(obj) {
  if (!obj || typeof obj !== 'object') return null;

  // Common paths where video URLs might be stored
  const paths = [
    'video.play_addr.url_list[0]',
    'video.download_addr.url_list[0]',
    'aweme_detail.video.play_addr.url_list[0]',
    'item_list[0].video.play_addr.url_list[0]',
    'playAddr',
    'downloadAddr',
    'url'
  ];

  for (const path of paths) {
    const value = getNestedValue(obj, path);
    if (value && typeof value === 'string' && value.includes('.mp4')) {
      return value.replace(/\\u002F/g, '/');
    }
  }

  return null;
}

function getNestedValue(obj, path) {
  return path.split(/[\.\[\]]/).filter(Boolean).reduce((acc, key) => {
    return acc && acc[key] !== undefined ? acc[key] : undefined;
  }, obj);
}

function extractTitleFromHTML(html) {
  const titleMatch = html.match(/<title>([^<]+)<\/title>/) ||
                    html.match(/"desc":\s*"([^"]+)"/) ||
                    html.match(/"description":\s*"([^"]+)"/);
  
  if (titleMatch) {
    return titleMatch[1]
      .replace(/\\u([0-9a-fA-F]{4})/g, (match, grp) => String.fromCharCode(parseInt(grp, 16)))
      .substring(0, 200);
  }
  
  return 'Douyin Video';
}

function extractThumbnailFromHTML(html) {
  const thumbMatch = html.match(/"cover":\s*"([^"]+)"/) ||
                    html.match(/"poster":\s*"([^"]+)"/) ||
                    html.match(/og:image["']?\s*content=["']([^"']+)["']/);
  
  return thumbMatch ? thumbMatch[1].replace(/\\u002F/g, '/') : '';
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
