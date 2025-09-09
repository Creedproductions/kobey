// ===== ADVANCED THREADS DOWNLOADER - RESEARCH-BASED =====
const axios = require('axios');

// ===== CONSTANTS =====
const THREADS_DOMAINS = ['threads.com', 'threads.net'];
const INSTAGRAM_CDN_PATTERNS = [
  'scontent.cdninstagram.com',
  'scontent-lga3-2.cdninstagram.com',
  'scontent-lax3-2.cdninstagram.com',
  'instagram.fna.fbcdn.net',
  'instagram.famd5-1.fna.fbcdn.net'
];

const USER_AGENTS = [
  // Desktop browsers
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  // Mobile browsers (often get different video formats)
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 10; SM-G973F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.120 Mobile Safari/537.36'
];

// ===== URL PROCESSING =====

/**
 * Normalize Threads URLs to handle both domains and URL formats
 */
function normalizeThreadsUrl(url) {
  let cleanUrl = url.trim();

  // Remove fragments and unnecessary parameters
  cleanUrl = cleanUrl.split('#')[0];

  // Handle both threads.com and threads.net
  if (cleanUrl.includes('threads.net')) {
    cleanUrl = cleanUrl.replace('threads.net', 'threads.com');
  }

  // Ensure HTTPS
  if (!cleanUrl.startsWith('http')) {
    cleanUrl = 'https://' + cleanUrl;
  }

  console.log('Threads URL normalized:', cleanUrl);
  return cleanUrl;
}

/**
 * Extract post ID from Threads URL
 */
function extractPostId(url) {
  const postIdRegex = /\/post\/([a-zA-Z0-9_-]+)/;
  const match = url.match(postIdRegex);
  return match ? match[1] : null;
}

// ===== ADVANCED HTML PARSING =====

/**
 * Parse HTML with multiple extraction strategies
 */
function parseThreadsHtml(html) {
  const results = {
    videos: [],
    images: [],
    metadata: {}
  };

  // Strategy 1: Meta tags (Open Graph)
  const ogVideoRegex = /<meta[^>]+property=["']og:video["'][^>]+content=["']([^"']+)["']/gi;
  const ogImageRegex = /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/gi;
  const ogTitleRegex = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/gi;

  let match;
  while ((match = ogVideoRegex.exec(html)) !== null) {
    results.videos.push({
      url: match[1],
      source: 'og:video',
      quality: 'unknown'
    });
  }

  while ((match = ogImageRegex.exec(html)) !== null) {
    results.metadata.thumbnail = match[1];
  }

  while ((match = ogTitleRegex.exec(html)) !== null) {
    results.metadata.title = match[1];
  }

  // Strategy 2: JSON-LD structured data
  const jsonLdRegex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([^<]+)<\/script>/gi;
  while ((match = jsonLdRegex.exec(html)) !== null) {
    try {
      const data = JSON.parse(match[1]);
      if (data.video && data.video.contentUrl) {
        results.videos.push({
          url: data.video.contentUrl,
          source: 'json-ld',
          quality: data.video.height ? `${data.video.height}p` : 'unknown'
        });
      }
    } catch (e) {
      // Invalid JSON-LD
    }
  }

  // Strategy 3: Inline JavaScript video URLs
  const videoPatterns = [
    /"video_url"\s*:\s*"([^"]+)"/g,
    /"playback_url"\s*:\s*"([^"]+)"/g,
    /"src"\s*:\s*"([^"]*(?:scontent|fbcdn)[^"]*\.mp4[^"]*)"/g,
    /https?:\/\/[^"']*(?:scontent|fbcdn)[^"']*\.mp4[^"']*/g
  ];

  videoPatterns.forEach(pattern => {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const videoUrl = match[1] || match[0];
      if (videoUrl && videoUrl.includes('.mp4')) {
        results.videos.push({
          url: videoUrl.replace(/\\u0026/g, '&').replace(/\\/g, ''),
          source: 'javascript-extraction',
          quality: 'unknown'
        });
      }
    }
  });

  // Strategy 4: Direct video elements
  const videoElementRegex = /<video[^>]+src=["']([^"']+)["'][^>]*>/gi;
  const videoPosterRegex = /<video[^>]+poster=["']([^"']+)["'][^>]*>/gi;

  while ((match = videoElementRegex.exec(html)) !== null) {
    results.videos.push({
      url: match[1],
      source: 'video-element',
      quality: 'unknown'
    });
  }

  while ((match = videoPosterRegex.exec(html)) !== null) {
    if (!results.metadata.thumbnail) {
      results.metadata.thumbnail = match[1];
    }
  }

  // Strategy 5: Source elements within video tags
  const sourceElementRegex = /<source[^>]+src=["']([^"']*\.mp4[^"']*)["'][^>]*>/gi;
  while ((match = sourceElementRegex.exec(html)) !== null) {
    results.videos.push({
      url: match[1],
      source: 'source-element',
      quality: 'unknown'
    });
  }

  return results;
}

// ===== MULTI-ATTEMPT FETCHING =====

/**
 * Fetch Threads page with multiple strategies
 */
async function fetchThreadsPage(url) {
  const errors = [];

  // Strategy 1: Direct fetch with multiple user agents
  for (const userAgent of USER_AGENTS) {
    try {
      console.log(`Attempting fetch with user agent: ${userAgent.substring(0, 50)}...`);

      const response = await axios.get(url, {
        timeout: 25000,
        headers: {
          'User-Agent': userAgent,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'Connection': 'keep-alive',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache'
        }
      });

      if (response.data && response.data.length > 1000) {
        console.log(`Success with user agent, HTML length: ${response.data.length}`);
        return response.data;
      }
    } catch (error) {
      errors.push(`User agent ${userAgent.substring(0, 30)}: ${error.message}`);
      continue;
    }
  }

  // Strategy 2: Try with threads.net fallback
  if (url.includes('threads.com')) {
    try {
      const fallbackUrl = url.replace('threads.com', 'threads.net');
      console.log(`Trying threads.net fallback: ${fallbackUrl}`);

      const response = await axios.get(fallbackUrl, {
        timeout: 20000,
        headers: {
          'User-Agent': USER_AGENTS[0],
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.5'
        }
      });

      if (response.data && response.data.length > 1000) {
        console.log(`Success with threads.net fallback, HTML length: ${response.data.length}`);
        return response.data;
      }
    } catch (error) {
      errors.push(`Threads.net fallback: ${error.message}`);
    }
  }

  throw new Error(`All fetch strategies failed: ${errors.join('; ')}`);
}

// ===== VIDEO URL VALIDATION =====

/**
 * Validate and test video URLs
 */
async function validateVideoUrl(url) {
  try {
    // Clean up the URL
    let cleanUrl = url.replace(/\\u0026/g, '&').replace(/\\/g, '');

    // Test if URL is accessible
    const response = await axios.head(cleanUrl, {
      timeout: 10000,
      headers: {
        'User-Agent': USER_AGENTS[0],
        'Accept': 'video/mp4,video/*;q=0.9,*/*;q=0.8'
      }
    });

    const contentType = response.headers['content-type'];
    const contentLength = response.headers['content-length'];

    return {
      url: cleanUrl,
      valid: response.status === 200,
      contentType: contentType || 'unknown',
      size: contentLength ? parseInt(contentLength) : 0,
      isVideo: contentType && contentType.includes('video')
    };
  } catch (error) {
    console.log(`URL validation failed for ${url.substring(0, 100)}: ${error.message}`);
    return {
      url: url,
      valid: false,
      error: error.message
    };
  }
}

// ===== MAIN THREADS DOWNLOADER =====

/**
 * Advanced Threads video downloader
 */
async function advancedThreadsDownloader(originalUrl) {
  console.log('🧵 Advanced Threads Downloader: Starting for URL:', originalUrl);

  try {
    // Step 1: Normalize URL
    const normalizedUrl = normalizeThreadsUrl(originalUrl);
    const postId = extractPostId(normalizedUrl);
    console.log('Post ID extracted:', postId);

    // Step 2: Fetch HTML content
    const html = await fetchThreadsPage(normalizedUrl);
    console.log('HTML fetched successfully, length:', html.length);

    // Step 3: Parse and extract video information
    const extractedData = parseThreadsHtml(html);
    console.log('Extraction results:', {
      videosFound: extractedData.videos.length,
      imagesFound: extractedData.images.length,
      hasMetadata: Object.keys(extractedData.metadata).length > 0
    });

    // Step 4: Remove duplicates and validate videos
    const uniqueVideos = [];
    const seenUrls = new Set();

    for (const video of extractedData.videos) {
      if (!seenUrls.has(video.url)) {
        seenUrls.add(video.url);
        uniqueVideos.push(video);
      }
    }

    console.log(`Found ${uniqueVideos.length} unique video URLs`);

    // Step 5: Validate video URLs
    const validatedVideos = [];
    for (const video of uniqueVideos) {
      try {
        const validation = await validateVideoUrl(video.url);
        if (validation.valid && validation.isVideo) {
          validatedVideos.push({
            ...video,
            ...validation
          });
        }
      } catch (error) {
        console.log(`Validation failed for video: ${error.message}`);
      }
    }

    // Step 6: Select best video
    if (validatedVideos.length === 0) {
      throw new Error('No valid video URLs found. This post may contain only images/text, be private, or use an unsupported video format.');
    }

    // Prioritize by source reliability and file size
    const bestVideo = validatedVideos.sort((a, b) => {
      const sourceOrder = { 'og:video': 1, 'json-ld': 2, 'video-element': 3, 'javascript-extraction': 4, 'source-element': 5 };
      const aScore = sourceOrder[a.source] || 10;
      const bScore = sourceOrder[b.source] || 10;

      if (aScore !== bScore) return aScore - bScore;
      return (b.size || 0) - (a.size || 0); // Prefer larger files (better quality)
    })[0];

    console.log('Best video selected:', {
      source: bestVideo.source,
      size: bestVideo.size,
      contentType: bestVideo.contentType
    });

    // Step 7: Return formatted result
    return {
      title: extractedData.metadata.title || 'Threads Post',
      download: bestVideo.url,
      thumbnail: extractedData.metadata.thumbnail || 'https://via.placeholder.com/300x150',
      quality: bestVideo.quality || 'Best Available',
      metadata: {
        postId: postId,
        source: bestVideo.source,
        fileSize: bestVideo.size,
        contentType: bestVideo.contentType,
        totalVideosFound: extractedData.videos.length,
        validatedVideos: validatedVideos.length
      }
    };

  } catch (error) {
    console.error('Advanced Threads Downloader failed:', error.message);
    throw new Error(`Threads download failed: ${error.message}`);
  }
}

// ===== EXPORT =====
module.exports = {
  advancedThreadsDownloader
};