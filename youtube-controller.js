const fs = require('fs');
const path = require('path');
const { ytdown } = require('nayan-videos-downloader');
const fetch = require('node-fetch');

const TEMP_DIR = path.join(__dirname, '../temp');
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

const videoCache = new Map();
const CACHE_TTL = 3600000;

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
];

const PLAYER_PATTERNS = [
    /ytInitialPlayerResponse\s*=\s*({.*?});/s,
    /playerResponse\s*=\s*({.*?});/s,
    /"PLAYER_CONFIG":({.*?}),"PLAYER/,
    /ytPlayerConfig\s*=\s*({.*?});/s
];

async function fetchWithBackoff(url, options, maxRetries = 3) {
    let retries = 0;
    while (retries < maxRetries) {
        try {
            const response = await fetch(url, options);
            if (response.status !== 429 || retries === maxRetries - 1) {
                return response;
            }
            const delay = Math.pow(2, retries) * 1000 + Math.random() * 1000;
            console.log(`Rate limited (429). Retrying in ${delay}ms`);
            await new Promise(resolve => setTimeout(resolve, delay));
            retries++;
        } catch (error) {
            if (retries === maxRetries - 1) throw error;
            retries++;
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
    throw new Error(`Failed after ${maxRetries} retries`);
}

async function getCachedOrFetch(videoId, fetchFn) {
    const cacheKey = `yt_${videoId}`;
    const cached = videoCache.get(cacheKey);
    
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
        console.log(`Using cached data for video ${videoId}`);
        return cached.data;
    }
    
    try {
        console.log(`Fetching fresh data for video ${videoId}`);
        const data = await fetchFn();
        videoCache.set(cacheKey, {
            timestamp: Date.now(),
            data
        });
        return data;
    } catch (error) {
        if (cached) {
            console.warn(`Using stale cache due to fetch error: ${error.message}`);
            return cached.data;
        }
        throw error;
    }
}

function classifyYouTubeError(errorMessage) {
    if (!errorMessage) return { type: "UNKNOWN_ERROR", userMessage: "An unknown error occurred." };
    
    if (errorMessage.includes("content isn't available") || errorMessage.includes("isn't available anymore")) {
        return { type: "VIDEO_UNAVAILABLE", userMessage: "This video is unavailable, private, or deleted." };
    } else if (errorMessage.includes("429") || errorMessage.includes("Too many requests")) {
        return { type: "RATE_LIMITED", userMessage: "Too many requests to YouTube. Please try again later." };
    } else if (errorMessage.includes("403") || errorMessage.includes("Forbidden")) {
        return { type: "ACCESS_DENIED", userMessage: "Access denied. This video may be region-restricted." };
    } else if (errorMessage.includes("Internet") || errorMessage.includes("network") || 
              errorMessage.includes("timeout") || errorMessage.includes("ETIMEDOUT")) {
        return { type: "NETWORK_ERROR", userMessage: "Network error. Please check your connection." };
    }
    
    return { type: "GENERAL_ERROR", userMessage: "Failed to process this YouTube video." };
}

async function getYouTubeEmbedData(videoId) {
    const embedUrl = `https://www.youtube.com/embed/${videoId}`;
    const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    
    try {
        const response = await fetchWithBackoff(embedUrl, {
            headers: {
                'User-Agent': userAgent,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Cache-Control': 'no-cache'
            }
        });
        
        if (!response.ok) throw new Error(`Failed to fetch embed page: ${response.status}`);
        
        const html = await response.text();
        
        if (html.includes('VIDEO_UNAVAILABLE') || html.includes('Video unavailable')) {
            throw new Error("This content isn't available");
        }
        
        let playerResponse = null;
        for (const pattern of PLAYER_PATTERNS) {
            const match = html.match(pattern);
            if (match && match[1]) {
                try {
                    playerResponse = JSON.parse(match[1]);
                    break;
                } catch (e) {}
            }
        }
        
        if (!playerResponse) throw new Error('Could not find player response data in embed page');
        
        const title = playerResponse.videoDetails?.title || 
                     playerResponse.title || 
                     playerResponse.player?.args?.title || 
                     'YouTube Video';
        
        let hlsManifestUrl = null;
        let dashManifestUrl = null;
        
        if (playerResponse.streamingData) {
            hlsManifestUrl = playerResponse.streamingData.hlsManifestUrl || null;
            dashManifestUrl = playerResponse.streamingData.dashManifestUrl || null;
        } else if (playerResponse.player && playerResponse.player.args) {
            const args = playerResponse.player.args;
            hlsManifestUrl = args.hlsvp || args.hls_manifest || null;
            dashManifestUrl = args.dashmpd || null;
        } else if (playerResponse.args) {
            hlsManifestUrl = playerResponse.args.hlsvp || playerResponse.args.hls_manifest || null;
            dashManifestUrl = playerResponse.args.dashmpd || null;
        }
        
        if (!hlsManifestUrl && !dashManifestUrl) {
            throw new Error('No streaming URLs found in player response');
        }
        
        return { title, hlsManifestUrl, dashManifestUrl };
    } catch (error) {
        console.error(`Error extracting data from embed page: ${error.message}`);
        throw error;
    }
}

function extractVideoId(url) {
    if (!url) return '';
    
    const standardMatch = url.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|v\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i);
    if (standardMatch && standardMatch[1]) return standardMatch[1];
    
    const musicMatch = url.match(/music\.youtube\.com\/watch\?(?:.*&)?v=([a-zA-Z0-9_-]{11})/i);
    if (musicMatch && musicMatch[1]) return musicMatch[1];
    
    const shortsMatch = url.match(/youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/i);
    if (shortsMatch && shortsMatch[1]) return shortsMatch[1];
    
    const shortUrlMatch = url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/i);
    if (shortUrlMatch && shortUrlMatch[1]) return shortUrlMatch[1];
    
    const vParamMatch = url.match(/[?&]v=([a-zA-Z0-9_-]{11})(&|$)/i);
    if (vParamMatch && vParamMatch[1]) return vParamMatch[1];
    
    return '';
}

async function downloadYouTubeVideo(url) {
    try {
        console.log(`Processing YouTube URL: ${url}`);
        
        if (url === 'https://www.youtube.com/' || url === 'https://m.youtube.com/' || 
            url === 'https://youtube.com/' || url === 'https://youtu.be/') {
            return {
                success: false,
                error: "Please provide a specific YouTube video URL, not the homepage",
                homepage: true
            };
        }
        
        let videoId = extractVideoId(url);
        
        if (url.includes('m.youtube.com')) {
            url = url.replace(/m\.youtube\.com/, 'www.youtube.com');
        }
        
        if (!videoId) {
            return {
                success: false,
                error: "No valid YouTube video ID found in URL. Please provide a direct video URL.",
            };
        }

        const thumbnail = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
        
        const fetchVideoData = async () => {
            try {
                const embedData = await getYouTubeEmbedData(videoId);
                
                if (embedData.title && (embedData.hlsManifestUrl || embedData.dashManifestUrl)) {
                    return {
                        success: true,
                        title: embedData.title,
                        high: embedData.hlsManifestUrl || embedData.dashManifestUrl,
                        low: embedData.dashManifestUrl || embedData.hlsManifestUrl,
                        thumbnail: thumbnail,
                        embed_url: `https://www.youtube.com/embed/${videoId}`,
                        source: 'youtube-embed',
                        is_stream_manifest: true
                    };
                }
            } catch (embedError) {
                console.error(`Embed page data extraction error: ${embedError.message}`);
            }
            
            try {
                console.log("Trying ytdown method...");
                const result = await ytdown(url);
                
                if (result && result.status === false) {
                    throw new Error(result.msg || "ytdown service is offline");
                }
                
                if (result && result.status === true) {
                    if (result.data) {
                        return {
                            success: true,
                            title: result.data.title || 'YouTube Video',
                            high: result.data.video_hd || result.data.video || '',
                            low: result.data.video || '',
                            thumbnail: result.data.thumb || thumbnail,
                            source: 'nayan-videos-downloader'
                        };
                    } 
                    else if (result.media) {
                        return {
                            success: true,
                            title: result.media.title || 'YouTube Video',
                            high: result.media.high || '',
                            low: result.media.low || result.media.high || '',
                            thumbnail: result.media.thumbnail || thumbnail,
                            source: 'nayan-videos-downloader'
                        };
                    }
                }
                
                throw new Error("Invalid response from ytdown");
            } catch (ytdownError) {
                console.error(`ytdown error: ${ytdownError.message}`);
            }
            
            return {
                success: true,
                title: 'YouTube Video',
                url_only: true,
                high: `https://www.youtube.com/embed/${videoId}?autoplay=1`,
                low: `https://www.youtube.com/watch?v=${videoId}`,
                thumbnail: thumbnail,
                embed_url: `https://www.youtube.com/embed/${videoId}`,
                youtube_fallback: true,
                source: 'embed-only'
            };
        };
        
        try {
            return await getCachedOrFetch(videoId, fetchVideoData);
        } catch (error) {
            console.error(`YouTube processing failed: ${error.message}`);
            
            const errorInfo = classifyYouTubeError(error.message);
            
            if (errorInfo.type === "VIDEO_UNAVAILABLE") {
                return {
                    success: false,
                    error: errorInfo.userMessage,
                    errorType: errorInfo.type,
                    embed_url: `https://www.youtube.com/embed/${videoId}`,
                    thumbnail: thumbnail
                };
            }
            
            return {
                success: true,
                title: 'YouTube Video',
                url_only: true,
                high: `https://www.youtube.com/embed/${videoId}?autoplay=1`,
                low: `https://www.youtube.com/watch?v=${videoId}`,
                thumbnail: thumbnail,
                embed_url: `https://www.youtube.com/embed/${videoId}`,
                youtube_fallback: true,
                source: 'embed-only',
                error_info: errorInfo
            };
        }
    } catch (error) {
        const errorInfo = classifyYouTubeError(error.message);
        const videoId = extractVideoId(url);
        
        if (videoId) {
            return {
                success: false,
                error: errorInfo.userMessage,
                errorType: errorInfo.type,
                url_only: true,
                embed_url: `https://www.youtube.com/embed/${videoId}`,
                thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
            };
        } else {
            return {
                success: false,
                error: "Invalid YouTube URL or cannot extract video ID",
                errorType: "INVALID_URL"
            };
        }
    }
}

async function downloadYouTubeMusic(url) {
    try {
        console.log(`Processing YouTube Music URL: ${url}`);
        
        if (url === 'https://www.youtube.com/' || url === 'https://m.youtube.com/' || 
            url === 'https://youtube.com/' || url === 'https://youtu.be/' || 
            url === 'https://music.youtube.com/') {
            return {
                success: false,
                error: "Please provide a specific YouTube video URL, not the homepage",
                homepage: true
            };
        }
        
        let videoId = extractVideoId(url);
        
        if (url.includes('music.youtube.com') && videoId) {
            url = `https://www.youtube.com/watch?v=${videoId}`;
        }
        
        if (url.includes('youtu.be/') && !videoId) {
            const shortUrlMatch = url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
            if (shortUrlMatch && shortUrlMatch[1]) {
                videoId = shortUrlMatch[1];
                url = `https://www.youtube.com/watch?v=${videoId}`;
            }
        }
        
        if (!videoId) {
            return {
                success: false,
                error: "No valid YouTube video ID found in URL. Please provide a direct video URL.",
            };
        }
        
        const thumbnail = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
        
        const fetchMusicData = async () => {
            try {
                const embedData = await getYouTubeEmbedData(videoId);
                
                if (embedData.title && (embedData.hlsManifestUrl || embedData.dashManifestUrl)) {
                    return {
                        success: true,
                        title: embedData.title,
                        high: embedData.hlsManifestUrl || embedData.dashManifestUrl,
                        low: embedData.dashManifestUrl || embedData.hlsManifestUrl,
                        thumbnail: thumbnail,
                        embed_url: `https://www.youtube.com/embed/${videoId}`,
                        isAudio: true,
                        source: 'youtube-embed',
                        is_stream_manifest: true
                    };
                }
            } catch (embedError) {
                console.error(`Embed page error: ${embedError.message}`);
            }
            
            try {
                const result = await ytdown(url);
                
                if (result && result.status === false) {
                    throw new Error(result.msg || "ytdown service is offline");
                }
                
                if (result && result.status === true) {
                    if (result.data) {
                        return {
                            success: true,
                            title: result.data.title || 'YouTube Music',
                            high: result.data.audio || result.data.video || '',
                            low: result.data.audio || result.data.video || '',
                            thumbnail: result.data.thumb || thumbnail,
                            isAudio: true,
                            source: 'nayan-videos-downloader'
                        };
                    } 
                    else if (result.media) {
                        return {
                            success: true,
                            title: result.media.title || 'YouTube Music',
                            high: result.media.audio || result.media.high || '',
                            low: result.media.audio || result.media.low || result.media.high || '',
                            thumbnail: result.media.thumbnail || thumbnail,
                            isAudio: true,
                            source: 'nayan-videos-downloader'
                        };
                    }
                }
                
                throw new Error("Invalid response from ytdown");
            } catch (ytdownError) {
                console.error(`ytdown music error: ${ytdownError.message}`);
            }
            
            return {
                success: true,
                title: 'YouTube Music',
                url_only: true,
                high: `https://www.youtube.com/embed/${videoId}?autoplay=1`,
                low: `https://www.youtube.com/watch?v=${videoId}`,
                thumbnail: thumbnail,
                embed_url: `https://www.youtube.com/embed/${videoId}`,
                youtube_fallback: true,
                isAudio: true,
                source: 'embed-only'
            };
        };
        
        try {
            return await getCachedOrFetch(videoId, fetchMusicData);
        } catch (error) {
            const errorInfo = classifyYouTubeError(error.message);
            
            if (errorInfo.type === "VIDEO_UNAVAILABLE") {
                return {
                    success: false,
                    error: errorInfo.userMessage,
                    errorType: errorInfo.type,
                    isAudio: true,
                    embed_url: `https://www.youtube.com/embed/${videoId}`,
                    thumbnail: thumbnail
                };
            }
            
            return {
                success: true,
                title: 'YouTube Music',
                url_only: true,
                high: `https://www.youtube.com/embed/${videoId}?autoplay=1`,
                low: `https://www.youtube.com/watch?v=${videoId}`,
                thumbnail: thumbnail,
                embed_url: `https://www.youtube.com/embed/${videoId}`,
                youtube_fallback: true,
                isAudio: true,
                source: 'embed-only',
                error_info: errorInfo
            };
        }
    } catch (error) {
        const errorInfo = classifyYouTubeError(error.message);
        const videoId = extractVideoId(url);
        
        if (videoId) {
            return {
                success: false,
                error: errorInfo.userMessage,
                errorType: errorInfo.type,
                url_only: true,
                embed_url: `https://www.youtube.com/embed/${videoId}`,
                thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
                isAudio: true
            };
        } else {
            return {
                success: false,
                error: "Invalid YouTube URL or cannot extract video ID",
                errorType: "INVALID_URL",
                isAudio: true
            };
        }
    }
}

async function getYouTubeVideoInfo(url) {
    try {
        const videoId = extractVideoId(url);
        
        if (!videoId) {
            return {
                success: false,
                error: "Invalid YouTube URL or cannot extract video ID"
            };
        }
        
        try {
            const embedData = await getYouTubeEmbedData(videoId);
            
            return {
                success: true,
                title: embedData.title,
                videoId: videoId,
                thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
                available: true
            };
        } catch (embedError) {
            if (embedError.message.includes("content isn't available")) {
                return {
                    success: false,
                    error: "This video appears to be unavailable, private, or deleted.",
                    videoId: videoId,
                    thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
                    available: false
                };
            }
            
            return {
                success: true,
                title: 'YouTube Video',
                videoId: videoId,
                thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
                available: true,
                note: "Only basic info available"
            };
        }
    } catch (error) {
        return {
            success: false,
            error: error.message
        };
    }
}

function isValidYouTubeUrl(url) {
    if (!url) return false;
    const isYouTubeDomain = url.includes('youtube.com') || url.includes('youtu.be') || url.includes('music.youtube.com');
    return isYouTubeDomain && extractVideoId(url) !== '';
}

function clearExpiredCache() {
    const now = Date.now();
    for (const [key, value] of videoCache.entries()) {
        if (now - value.timestamp > CACHE_TTL) {
            videoCache.delete(key);
        }
    }
}

setInterval(clearExpiredCache, 3600000);

module.exports = { 
    downloadYouTubeVideo,
    downloadYouTubeMusic,
    getYouTubeVideoInfo,
    isValidYouTubeUrl,
    extractVideoId
};