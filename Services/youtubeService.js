const { spawn, execSync } = require('child_process');
const { URL } = require('url');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

// Cache to avoid repeated requests
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

class YouTubeService {
  constructor() {
    this.ytDlpPath = this.findYtDlpPath();
    this.checkRequirements();
  }

  // Find yt-dlp in system
  findYtDlpPath() {
    try {
      // Check if yt-dlp is in PATH
      if (process.platform === 'win32') {
        execSync('where yt-dlp', { stdio: 'ignore' });
        return 'yt-dlp';
      } else {
        execSync('which yt-dlp', { stdio: 'ignore' });
        return 'yt-dlp';
      }
    } catch (error) {
      // Try alternative names
      const alternatives = ['yt-dlp', 'ytdlp', './yt-dlp', './ytdlp'];
      for (const alt of alternatives) {
        try {
          execSync(`${alt} --version`, { stdio: 'ignore' });
          return alt;
        } catch (e) { continue; }
      }
      throw new Error('yt-dlp not found. Install it first: pip install yt-dlp');
    }
  }

  checkRequirements() {
    try {
      execSync(`${this.ytDlpPath} --version`, { stdio: 'pipe' });
      console.log('✅ yt-dlp found:', execSync(`${this.ytDlpPath} --version`).toString().trim());
    } catch (error) {
      console.error('❌ yt-dlp check failed:', error.message);
      throw error;
    }
  }

  // Enhanced YouTube ID extraction
  extractYouTubeId(url) {
    try {
      const urlObj = new URL(url);
      let videoId = urlObj.searchParams.get('v');

      if (videoId && videoId.length === 11) return videoId;

      // Check pathname patterns
      const pathname = urlObj.pathname;

      // youtu.be/ID
      if (pathname.includes('youtu.be/')) {
        const id = pathname.split('youtu.be/')[1]?.split(/[?&/#]/)[0];
        if (id && id.length === 11) return id;
      }

      // shorts/ID
      if (pathname.includes('shorts/')) {
        const id = pathname.split('shorts/')[1]?.split(/[?&/#]/)[0];
        if (id && id.length === 11) return id;
      }

      // embed/ID
      if (pathname.includes('embed/')) {
        const id = pathname.split('embed/')[1]?.split(/[?&/#]/)[0];
        if (id && id.length === 11) return id;
      }

      // Regex fallback
      const regexPatterns = [
        /(?:v=|youtu\.be\/|embed\/|shorts\/)([a-zA-Z0-9_-]{11})/,
        /^([a-zA-Z0-9_-]{11})$/
      ];

      for (const pattern of regexPatterns) {
        const match = url.match(pattern);
        if (match && match[1]) {
          console.log(`✅ Extracted ID: ${match[1]} from ${url}`);
          return match[1];
        }
      }

      console.error('❌ Could not extract YouTube ID from:', url);
      return null;
    } catch (error) {
      console.error('❌ URL parsing error:', error.message);
      return null;
    }
  }

  // Main function to fetch YouTube data
  async fetchYouTubeData(url) {
    const videoId = this.extractYouTubeId(url);
    if (!videoId) {
      throw new Error('Invalid YouTube URL - Could not extract video ID');
    }

    console.log(`🎬 Processing YouTube video: ${videoId}`);

    // Check cache first
    const cacheKey = `video_${videoId}`;
    const cached = cache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
      console.log('📦 Returning cached data');
      return cached.data;
    }

    // Try yt-dlp first (most reliable)
    try {
      const data = await this.fetchWithYTDLP(videoId);
      if (data.formats && data.formats.length > 0) {
        // Cache successful result
        cache.set(cacheKey, {
          timestamp: Date.now(),
          data: data
        });
        return data;
      }
    } catch (error) {
      console.log('⚠️ yt-dlp failed, trying fallback:', error.message);
    }

    // Fallback: Try to get at least metadata
    try {
      const metadata = await this.fetchVideoMetadata(videoId);
      return {
        ...metadata,
        error: "Direct download unavailable. Video may be age-restricted.",
        alternative_links: [
          `https://ssyoutube.com/watch?v=${videoId}`,
          `https://en.savefrom.net/watch?v=${videoId}`
        ]
      };
    } catch (error) {
      throw new Error(`All methods failed: ${error.message}`);
    }
  }

  // Primary method: Use yt-dlp
  async fetchWithYTDLP(videoId) {
    return new Promise((resolve, reject) => {
      console.log(`🔄 Fetching with yt-dlp for: ${videoId}`);

      const args = [
        `https://www.youtube.com/watch?v=${videoId}`,
        '--dump-json',
        '--no-warnings',
        '--ignore-errors',
        '--no-playlist',
        '--no-check-certificates',
        '--geo-bypass',
        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        '--referer', 'https://www.youtube.com/'
      ];

      const ytDlpProcess = spawn(this.ytDlpPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30000 // 30 second timeout
      });

      let stdout = '';
      let stderr = '';

      ytDlpProcess.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      ytDlpProcess.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      ytDlpProcess.on('close', (code) => {
        if (code === 0 || code === 1) { // yt-dlp sometimes exits with 1 but still works
          try {
            const info = JSON.parse(stdout);
            const formats = this.parseYTDLPFormats(info, videoId);

            if (formats.length === 0 && stderr.includes('Private video') || stderr.includes('Sign in')) {
              reject(new Error('Video is private or requires login'));
              return;
            }

            const result = {
              title: info.title || "YouTube Video",
              thumbnail: info.thumbnail || `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
              duration: info.duration || 0,
              description: info.description || '',
              uploader: info.uploader || '',
              view_count: info.view_count || 0,
              formats: formats,
              allFormats: formats,
              url: formats.length > 0 ? formats[0].url : null,
              selectedQuality: formats.length > 0 ? formats[0] : null,
              audioGuaranteed: formats.length > 0 ? formats[0].hasAudio : false,
              videoId: videoId
            };

            console.log(`✅ yt-dlp found ${formats.length} formats`);
            resolve(result);
          } catch (parseError) {
            console.error('❌ Failed to parse yt-dlp output:', parseError.message);
            if (stdout.trim()) {
              console.error('Raw output:', stdout.substring(0, 500));
            }
            reject(new Error(`Parse error: ${parseError.message}`));
          }
        } else {
          console.error('❌ yt-dlp failed with code:', code);
          console.error('stderr:', stderr);
          reject(new Error(`yt-dlp failed: ${stderr || 'Unknown error'}`));
        }
      });

      ytDlpProcess.on('error', (error) => {
        console.error('❌ Failed to spawn yt-dlp:', error.message);
        reject(new Error(`Spawn failed: ${error.message}`));
      });
    });
  }

  parseYTDLPFormats(info, videoId) {
    if (!info.formats || !Array.isArray(info.formats)) {
      console.log('⚠️ No formats array in yt-dlp output');
      return [];
    }

    console.log(`📊 Processing ${info.formats.length} raw formats`);

    const formats = info.formats
        .filter(format => {
          // Filter out formats without URLs
          if (!format.url && !format.fragments) return false;

          // Filter out storyboard formats
          if (format.format_id && format.format_id.includes('storyboard')) return false;

          return true;
        })
        .map(format => {
          const isAudio = format.vcodec === 'none' && format.acodec !== 'none';
          const isVideo = format.vcodec !== 'none';
          const qualityNum = format.height || format.width || 0;

          // Generate quality label
          let qualityLabel = '';
          if (format.format_note) {
            qualityLabel = format.format_note;
          } else if (qualityNum > 0) {
            qualityLabel = `${qualityNum}p`;
          } else if (isAudio) {
            qualityLabel = format.acodec || 'audio';
          } else {
            qualityLabel = 'unknown';
          }

          // Determine file extension
          let extension = format.ext || 'mp4';
          if (isAudio && extension === 'webm') {
            extension = 'webm';
          }

          // Determine MIME type
          let mimeType = format.mime_type || `video/${extension}`;
          if (isAudio) {
            mimeType = `audio/${extension}`;
          }

          // Generate URL for formats without direct URL
          let url = format.url;
          if (!url && format.fragments && videoId) {
            // This is a DASH format, will need special handling
            url = `dash://${videoId}:${format.format_id}`;
          }

          return {
            id: format.format_id || Math.random().toString(36).substring(7),
            url: url,
            label: qualityLabel,
            type: mimeType,
            extension: extension,
            filesize: format.filesize || format.filesize_approx || 0,
            isPremium: !isAudio && qualityNum > 360,
            hasAudio: format.acodec !== 'none',
            isAudioOnly: isAudio,
            isVideoOnly: format.acodec === 'none' && format.vcodec !== 'none',
            quality: qualityNum,
            fps: format.fps || 0,
            vcodec: format.vcodec || null,
            acodec: format.acodec || null,
            container: format.container || extension,
            protocol: format.protocol || 'https'
          };
        })
        .filter(format => format.url) // Remove formats without URL
        .sort((a, b) => {
          // Sort: video formats first (by quality desc), then audio
          if (a.isAudioOnly && !b.isAudioOnly) return 1;
          if (!a.isAudioOnly && b.isAudioOnly) return -1;
          if (a.isAudioOnly && b.isAudioOnly) {
            return (b.filesize || 0) - (a.filesize || 0); // Higher bitrate audio first
          }
          return b.quality - a.quality; // Higher quality video first
        });

    console.log(`✅ Parsed ${formats.length} usable formats`);
    return formats;
  }

  // Fallback metadata fetch
  async fetchVideoMetadata(videoId) {
    try {
      console.log(`🔍 Fetching metadata for: ${videoId}`);

      // Try oEmbed API first
      const response = await this.makeRequest(
          `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`
      );

      if (response) {
        return {
          title: response.title || "YouTube Video",
          thumbnail: response.thumbnail_url || `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
          duration: 0,
          author: response.author_name || '',
          formats: [],
          videoId: videoId
        };
      }
    } catch (error) {
      console.log('⚠️ oEmbed failed:', error.message);
    }

    // Fallback to scraping page
    try {
      const html = await this.makeRequest(`https://www.youtube.com/watch?v=${videoId}`, true);
      const titleMatch = html.match(/<meta name="title" content="([^"]+)"/) ||
          html.match(/<title>([^<]+)<\/title>/);
      const thumbnailMatch = html.match(/<meta property="og:image" content="([^"]+)"/);

      return {
        title: titleMatch ? titleMatch[1].replace(' - YouTube', '').trim() : "YouTube Video",
        thumbnail: thumbnailMatch ? thumbnailMatch[1] : `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
        duration: 0,
        formats: [],
        videoId: videoId
      };
    } catch (error) {
      throw new Error('Could not fetch video metadata');
    }
  }

  // Helper for HTTP requests
  async makeRequest(url, isText = false) {
    const https = require('https');

    return new Promise((resolve, reject) => {
      const req = https.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': isText ? 'text/html' : 'application/json',
          'Accept-Language': 'en-US,en;q=0.9'
        },
        timeout: 10000
      }, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }

        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (isText) {
            resolve(data);
          } else {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error('Invalid JSON'));
            }
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
    });
  }

  // Download video to file
  async downloadVideo(videoId, formatId, outputPath = './downloads') {
    return new Promise((resolve, reject) => {
      console.log(`⬇️ Downloading ${videoId} format ${formatId}`);

      // Ensure output directory exists
      fs.mkdir(outputPath, { recursive: true }).catch(() => {});

      const args = [
        `https://www.youtube.com/watch?v=${videoId}`,
        '-f', formatId,
        '-o', `${outputPath}/%(title)s.%(ext)s`,
        '--no-warnings',
        '--newline',
        '--progress'
      ];

      const ytDlpProcess = spawn(this.ytDlpPath, args);
      let progress = '';

      ytDlpProcess.stdout.on('data', (data) => {
        const text = data.toString();
        progress += text;
        // Parse progress for real-time updates if needed
        console.log('📥', text.trim());
      });

      ytDlpProcess.stderr.on('data', (data) => {
        console.error('⚠️', data.toString().trim());
      });

      ytDlpProcess.on('close', (code) => {
        if (code === 0) {
          // Parse output to find downloaded file
          const match = progress.match(/\[download\] Destination: (.+)/);
          if (match) {
            resolve({
              success: true,
              filePath: match[1],
              videoId: videoId
            });
          } else {
            resolve({
              success: true,
              filePath: `${outputPath}/video.mp4`,
              videoId: videoId
            });
          }
        } else {
          reject(new Error(`Download failed with code ${code}`));
        }
      });

      ytDlpProcess.on('error', reject);
    });
  }

  // Get available yt-dlp extractors (for debugging)
  async getSupportedSites() {
    return new Promise((resolve, reject) => {
      const process = spawn(this.ytDlpPath, ['--list-extractors']);
      let output = '';

      process.stdout.on('data', data => output += data.toString());
      process.on('close', () => resolve(output.split('\n').filter(line => line.includes('youtube'))));
      process.on('error', reject);
    });
  }

  // Clear cache
  clearCache() {
    const size = cache.size;
    cache.clear();
    console.log(`🧹 Cleared ${size} cache entries`);
    return size;
  }
}

// Export singleton instance
const youtubeService = new YouTubeService();

// Main exported function
async function fetchYouTubeData(url) {
  try {
    const data = await youtubeService.fetchYouTubeData(url);

    // Ensure we always have a valid structure
    if (!data.formats || data.formats.length === 0) {
      console.warn('⚠️ No downloadable formats found');
      return {
        ...data,
        error: data.error || "No downloadable formats available",
        formats: [],
        allFormats: []
      };
    }

    return data;
  } catch (error) {
    console.error('❌ YouTube service error:', error.message);

    // Try to extract video ID for fallback
    const videoId = youtubeService.extractYouTubeId(url);

    return {
      title: "YouTube Video",
      thumbnail: videoId ? `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg` : null,
      duration: 0,
      formats: [],
      allFormats: [],
      url: null,
      selectedQuality: null,
      audioGuaranteed: false,
      error: error.message,
      videoId: videoId,
      alternative_links: videoId ? [
        `https://ssyoutube.com/watch?v=${videoId}`,
        `https://en.savefrom.net/watch?v=${videoId}`,
        `https://ytmp3.cc/youtube-to-mp3/${videoId}`
      ] : []
    };
  }
}

// Additional utility functions
async function getVideoInfo(videoId) {
  return youtubeService.fetchWithYTDLP(videoId);
}

async function downloadYouTubeVideo(videoId, formatId = 'best', outputDir = './downloads') {
  return youtubeService.downloadVideo(videoId, formatId, outputDir);
}

function clearYouTubeCache() {
  return youtubeService.clearCache();
}

// Export everything
module.exports = {
  fetchYouTubeData,
  getVideoInfo,
  downloadYouTubeVideo,
  clearYouTubeCache,
  YouTubeService
};