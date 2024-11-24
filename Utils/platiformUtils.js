// Function to identify platform
const identifyPlatform = (url) => {
    const platformRegex = {
      instagram: /instagram\.com/,
      tiktok: /tiktok\.com/,
      facebook: /facebook\.com|fb\.watch/,
      twitter: /twitter\.com|x\.com/,
      youtube: /youtube\.com|youtu\.be/,
      pinterest: /pinterest\.com|pin\.it/,
    };
  
    for (const platform in platformRegex) {
      if (platformRegex[platform].test(url)) {
        return platform;
      }
    }
  
    return null;
  };
  
  // Standardizing the response for different platforms
  const formatData = (platform, data) => {
    // Placeholder for standardizing logic as per different platforms.
    if (platform === 'youtube') {
      return {
        title: data.title || 'Untitled Video',
        url: data.mp4 || data.mp3 || '',
        thumbnail: data.thumbnail || 'https://via.placeholder.com/300x150',
        sizes: ['Original Quality'],
        source: platform,
      };
    }
    
    if (platform === 'tiktok') {
      return {
        title: data.title || 'Untitled Video',
        url: data.video && data.video[0] || '',
        thumbnail: data.thumbnail || 'https://via.placeholder.com/300x150',
        sizes: ['Original Quality'],
        audio: data.audio && data.audio[0] || '',
        source: platform,
      };
    }
  
    if (platform === 'instagram') {
      return {
        title: data[0].wm || 'Untitled Video',
        url: data[0].url || '',
        thumbnail: data[0].thumbnail || 'https://via.placeholder.com/300x150',
        sizes: ['Original Quality'],
        source: platform,
      };
    }
  
    if (platform === 'twitter') {
      return {
        title: data.title || 'Untitled Video',
        url: data.url ? data.url.find(v => v.hd) ? data.url.find(v => v.hd).hd : '' : '',
        thumbnail: data.thumbnail || 'https://via.placeholder.com/300x150',
        sizes: ['Original Quality'],
        source: platform,
      };
    }
  
    if (platform === 'facebook') {
      return {
        title: data.title || 'Untitled Video',
        url: data.result.links.HD || data.result.links.SD || '',
        thumbnail: data.result.thumbnail || 'https://via.placeholder.com/300x150',
        sizes: ['Original Quality'],
        source: platform,
      };
    }
  
    if (platform === 'pinterest') {
      return {
        title: data.imran.title || 'Untitled Image',
        url: data.imran.url || '',
        thumbnail: data.imran.url || 'https://via.placeholder.com/300x150',
        sizes: ['Original Quality'],
        source: platform,
      };
    }
  
    return {
      title: data.title || 'Untitled Media',
      url: data.url || '',
      thumbnail: data.thumbnail || 'https://via.placeholder.com/300x150',
      sizes: data.sizes || ['Original Quality'],
      source: platform,
    };
  };
  
  module.exports = { identifyPlatform, formatData };
  