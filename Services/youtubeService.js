const axios = require("axios");
const { URL } = require("url");

// Enhanced YouTube ID extraction
function extractYouTubeId(url) {
  try {
    // Parse URL properly
    const urlObj = new URL(url);
    const videoId = urlObj.searchParams.get('v');

    if (videoId && videoId.length === 11) return videoId;

    // Check pathname for alternative patterns
    const path = urlObj.pathname;

    // youtu.be/ID
    if (path.includes('youtu.be/')) {
      const id = path.split('youtu.be/')[1]?.split(/[?&\/]/)[0];
      if (id && id.length === 11) return id;
    }

    // shorts/ID
    if (path.includes('shorts/')) {
      const id = path.split('shorts/')[1]?.split(/[?&\/]/)[0];
      if (id && id.length === 11) return id;
    }

    // embed/ID
    if (path.includes('embed/')) {
      const id = path.split('embed/')[1]?.split(/[?&\/]/)[0];
      if (id && id.length === 11) return id;
    }

    // Last resort: regex search
    const regexPatterns = [
      /(?:v=|\/)([0-9A-Za-z_-]{11})/,
      /youtu\.be\/([0-9A-Za-z_-]{11})/,
      /embed\/([0-9A-Za-z_-]{11})/,
      /shorts\/([0-9A-Za-z_-]{11})/
    ];

    for (const pattern of regexPatterns) {
      const match = url.match(pattern);
      if (match && match[1]) return match[1];
    }

    return null;
  } catch (error) {
    console.error("URL parsing error:", error.message);
    return null;
  }
}

// Primary: Use yt-dlp or ytdl-core style approach
async function fetchYouTubeData(url) {
  const videoId = extractYouTubeId(url);
  if (!videoId) {
    throw new Error("Invalid YouTube URL - Could not extract video ID");
  }

  console.log(`🎬 Processing YouTube video: ${videoId}`);

  // Strategy 1: Direct YouTube API with signature deciphering
  try {
    const result = await fetchWithDirectAPI(videoId);
    if (result.items.length > 0) {
      console.log(`✅ Direct API success: ${result.items.length} formats`);
      return processFormats(result);
    }
  } catch (error) {
    console.log("⚠️ Direct API failed:", error.message);
  }

  // Strategy 2: Piped API (Invidious alternative)
  try {
    const result = await fetchWithPipedAPI(videoId);
    if (result.items.length > 0) {
      console.log(`✅ Piped API success: ${result.items.length} formats`);
      return processFormats(result);
    }
  } catch (error) {
    console.log("⚠️ Piped API failed:", error.message);
  }

  // Strategy 3: YouTube MP3 API (works for most videos)
  try {
    const result = await fetchWithYouTubeMP3(videoId);
    if (result.items.length > 0) {
      console.log(`✅ YouTubeMP3 success: ${result.items.length} formats`);
      return processFormats(result);
    }
  } catch (error) {
    console.log("⚠️ YouTubeMP3 failed:", error.message);
  }

  // Strategy 4: y2mate API fallback
  try {
    const result = await fetchWithY2Mate(videoId);
    if (result.items.length > 0) {
      console.log(`✅ Y2Mate success: ${result.items.length} formats`);
      return processFormats(result);
    }
  } catch (error) {
    console.log("⚠️ Y2Mate failed:", error.message);
  }

  // Strategy 5: Return metadata only with download links
  try {
    const metadata = await fetchVideoMetadata(videoId);
    return {
      ...metadata,
      error: "Direct download formats unavailable. Use alternative services.",
      alternative_links: [
        `https://ssyoutube.com/watch?v=${videoId}`,
        `https://en.savefrom.net/watch?v=${videoId}`,
        `https://ytmp3.cc/youtube-to-mp3/${videoId}`
      ]
    };
  } catch (error) {
    throw new Error(`All download methods failed. Video may be age-restricted or private.`);
  }
}

// Method 1: Direct YouTube API (uses innertube)
async function fetchWithDirectAPI(videoId) {
  try {
    const response = await axios.get(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });

    const html = response.data;

    // Extract ytInitialPlayerResponse
    const ytInitialPlayerResponseMatch = html.match(/ytInitialPlayerResponse\s*=\s*({.+?})\s*;/);
    const ytInitialDataMatch = html.match(/ytInitialData\s*=\s*({.+?})\s*;/);

    let playerResponse, videoDetails, streamingData;

    if (ytInitialPlayerResponseMatch) {
      try {
        playerResponse = JSON.parse(ytInitialPlayerResponseMatch[1]);
        videoDetails = playerResponse.videoDetails;
        streamingData = playerResponse.streamingData;
      } catch (e) {
        console.log("Failed to parse player response");
      }
    }

    // If no streaming data, try to extract from ytInitialData
    if (!streamingData && ytInitialDataMatch) {
      try {
        const initialData = JSON.parse(ytInitialDataMatch[1]);
        // Navigate through the complex structure to find video info
        const contents = initialData?.contents?.twoColumnWatchNextResults?.results?.results?.contents;
        if (contents) {
          for (const content of contents) {
            if (content.videoPrimaryInfoRenderer) {
              videoDetails = videoDetails || {};
              videoDetails.title = content.videoPrimaryInfoRenderer.title?.runs?.[0]?.text || "YouTube Video";
            }
          }
        }
      } catch (e) {
        console.log("Failed to parse initial data");
      }
    }

    const formats = [];
    if (streamingData) {
      if (streamingData.formats) {
        formats.push(...streamingData.formats.map(f => ({
          url: f.url,
          label: f.qualityLabel || `${f.height}p`,
          type: f.mimeType,
          quality: f.height,
          hasAudio: true
        })));
      }

      if (streamingData.adaptiveFormats) {
        formats.push(...streamingData.adaptiveFormats.map(f => ({
          url: f.url,
          label: f.qualityLabel || (f.mimeType.includes('audio') ? 'audio' : `${f.height}p`),
          type: f.mimeType,
          quality: f.height,
          hasAudio: !f.mimeType.includes('video')
        })));
      }
    }

    return {
      title: videoDetails?.title || "YouTube Video",
      thumbnail: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
      duration: videoDetails?.lengthSeconds || 0,
      items: formats
    };
  } catch (error) {
    throw new Error(`Direct API failed: ${error.message}`);
  }
}

// Method 2: Piped API (Invidious alternative)
async function fetchWithPipedAPI(videoId) {
  const pipedInstances = [
    'https://pipedapi.kavin.rocks',
    'https://pipedapi.moomoo.me',
    'https://pipedapi-libre.kavin.rocks'
  ];

  for (const instance of pipedInstances) {
    try {
      const response = await axios.get(`${instance}/streams/${videoId}`, {
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      const data = response.data;
      const formats = [];

      // Video streams
      if (data.videoStreams) {
        data.videoStreams.forEach(stream => {
          if (stream.url) {
            formats.push({
              url: stream.url,
              label: stream.quality || `${stream.height}p`,
              type: stream.mimeType || 'video/mp4',
              quality: stream.height,
              hasAudio: stream.hasAudio || false
            });
          }
        });
      }

      // Audio streams
      if (data.audioStreams) {
        data.audioStreams.forEach(stream => {
          if (stream.url) {
            formats.push({
              url: stream.url,
              label: 'audio',
              type: stream.mimeType || 'audio/mp4',
              quality: 0,
              hasAudio: true
            });
          }
        });
      }

      return {
        title: data.title || "YouTube Video",
        thumbnail: data.thumbnailUrl || `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
        duration: data.duration || 0,
        items: formats
      };
    } catch (error) {
      console.log(`Piped instance ${instance} failed: ${error.message}`);
      continue;
    }
  }

  throw new Error("All Piped instances failed");
}

// Method 3: YouTube MP3 API
async function fetchWithYouTubeMP3(videoId) {
  try {
    // First get video info
    const infoResponse = await axios.get(`https://www.youtube.com/get_video_info?video_id=${videoId}&el=detailpage&ps=default`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    const videoInfo = new URLSearchParams(infoResponse.data);
    const playerResponse = videoInfo.get('player_response');

    if (playerResponse) {
      const parsed = JSON.parse(playerResponse);
      const streamingData = parsed.streamingData;
      const formats = [];

      if (streamingData?.formats) {
        streamingData.formats.forEach(f => {
          if (f.url) {
            formats.push({
              url: f.url,
              label: f.qualityLabel || `${f.height}p`,
              type: f.mimeType,
              quality: f.height,
              hasAudio: true
            });
          }
        });
      }

      return {
        title: parsed.videoDetails?.title || "YouTube Video",
        thumbnail: parsed.videoDetails?.thumbnail?.thumbnails?.[0]?.url ||
            `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
        duration: parsed.videoDetails?.lengthSeconds || 0,
        items: formats
      };
    }

    throw new Error("No player response");
  } catch (error) {
    // Fallback to external service
    try {
      const response = await axios.get(`https://ytmp3.nu/api/getInfo?id=${videoId}`, {
        timeout: 15000
      });

      if (response.data && response.data.url) {
        return {
          title: response.data.title || "YouTube Video",
          thumbnail: response.data.thumbnail || `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
          duration: response.data.duration || 0,
          items: [{
            url: response.data.url,
            label: 'MP3',
            type: 'audio/mpeg',
            quality: 0,
            hasAudio: true
          }]
        };
      }
    } catch (fallbackError) {
      throw new Error(`YouTubeMP3 failed: ${error.message}`);
    }
  }
}

// Method 4: Y2Mate API
async function fetchWithY2Mate(videoId) {
  try {
    // First request to get analysis ID
    const analyzeResponse = await axios.post('https://www.y2mate.com/mates/analyzeV2/ajax',
        `k_query=https://www.youtube.com/watch?v=${videoId}&k_page=home&hl=en&q_auto=0`,
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Origin': 'https://www.y2mate.com',
            'Referer': 'https://www.y2mate.com/'
          }
        }
    );

    const analyzeData = analyzeResponse.data;
    if (analyzeData.status !== 'ok') throw new Error("Analysis failed");

    // Second request to get download links
    const convertResponse = await axios.post('https://www.y2mate.com/mates/convertV2/index',
        `vid=${videoId}&k=${analyzeData.vid}`,
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Origin': 'https://www.y2mate.com',
            'Referer': 'https://www.y2mate.com/'
          }
        }
    );

    const convertData = convertResponse.data;
    const formats = [];

    // Parse MP4 formats
    if (convertData.links?.mp4) {
      Object.entries(convertData.links.mp4).forEach(([quality, data]) => {
        if (data.q && data.k) {
          formats.push({
            url: `https://www.y2mate.com/mates/download/${data.k}/${videoId}`,
            label: quality,
            type: 'video/mp4',
            quality: parseInt(quality) || 0,
            hasAudio: true
          });
        }
      });
    }

    return {
      title: analyzeData.title || "YouTube Video",
      thumbnail: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
      duration: 0,
      items: formats
    };
  } catch (error) {
    throw new Error(`Y2Mate failed: ${error.message}`);
  }
}

// Metadata fallback
async function fetchVideoMetadata(videoId) {
  try {
    // Try oEmbed first
    const oembedResponse = await axios.get(
        `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
        { timeout: 10000 }
    );

    return {
      title: oembedResponse.data.title || "YouTube Video",
      thumbnail: oembedResponse.data.thumbnail_url,
      duration: 0,
      author: oembedResponse.data.author_name,
      formats: [],
      alternative_download: `https://ssyoutube.com/watch?v=${videoId}`
    };
  } catch (error) {
    // Fallback to direct page scraping
    try {
      const pageResponse = await axios.get(`https://www.youtube.com/watch?v=${videoId}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });

      const html = pageResponse.data;
      const titleMatch = html.match(/<meta name="title" content="([^"]+)"/);
      const thumbnailMatch = html.match(/<meta property="og:image" content="([^"]+)"/);

      return {
        title: titleMatch ? titleMatch[1].replace(' - YouTube', '') : "YouTube Video",
        thumbnail: thumbnailMatch ? thumbnailMatch[1] : `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
        duration: 0,
        formats: [],
        alternative_download: `https://en.savefrom.net/watch?v=${videoId}`
      };
    } catch (pageError) {
      throw new Error("Could not fetch video metadata");
    }
  }
}

// Process formats into consistent structure
function processFormats(data) {
  const qualityOptions = data.items.map(item => {
    const qualityNum = item.quality || 0;
    const isAudio = item.label.toLowerCase().includes('audio') || item.type.includes('audio');
    const isPremium = !isAudio && qualityNum > 360;

    return {
      quality: item.label,
      qualityNum: qualityNum,
      url: item.url,
      type: item.type,
      extension: getExtensionFromType(item.type),
      filesize: 'unknown',
      isPremium: isPremium,
      hasAudio: item.hasAudio,
      isAudioOnly: isAudio
    };
  });

  // Sort by quality
  qualityOptions.sort((a, b) => {
    if (a.isAudioOnly && !b.isAudioOnly) return 1;
    if (!a.isAudioOnly && b.isAudioOnly) return -1;
    return a.qualityNum - b.qualityNum;
  });

  const selectedFormat = qualityOptions.find(opt => !opt.isAudioOnly && opt.qualityNum === 360) ||
      qualityOptions.find(opt => !opt.isAudioOnly) ||
      qualityOptions[0];

  return {
    title: data.title,
    thumbnail: data.thumbnail,
    duration: data.duration,
    isShorts: data.title?.toLowerCase().includes('#shorts') || false,
    formats: qualityOptions,
    allFormats: qualityOptions,
    url: selectedFormat ? selectedFormat.url : null,
    selectedQuality: selectedFormat,
    audioGuaranteed: selectedFormat ? selectedFormat.hasAudio : false
  };
}

function getExtensionFromType(mimeType) {
  if (!mimeType) return 'mp4';

  const typeMap = {
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'audio/mp4': 'm4a',
    'audio/mpeg': 'mp3',
    'audio/webm': 'webm'
  };

  for (const [type, ext] of Object.entries(typeMap)) {
    if (mimeType.includes(type)) return ext;
  }

  return 'mp4';
}

module.exports = { fetchYouTubeData };