const { spawn } = require('child_process');
const { URL } = require('url');
const os = require('os');
const path = require('path');

class YouTubeService {
  constructor() {
    this.ytDlpPath = this.findYtDlp();
    this.tempDir = path.join(os.tmpdir(), 'yt-merge');
  }

  findYtDlp() {
    // Try to find yt-dlp in the system
    try {
      require('child_process').execSync('yt-dlp --version', { stdio: 'pipe' });
      return 'yt-dlp';
    } catch (error) {
      throw new Error('yt-dlp not found. Make sure it is installed in the Docker container.');
    }
  }

  extractYouTubeId(url) {
    try {
      const urlObj = new URL(url);
      let videoId = urlObj.searchParams.get('v');

      if (videoId && videoId.length === 11) return videoId;

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

      // Last resort: regex
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

  async fetchYouTubeData(url) {
    const videoId = this.extractYouTubeId(url);
    if (!videoId) {
      throw new Error('Invalid YouTube URL');
    }

    console.log(`🎬 Processing YouTube video: ${videoId}`);

    // Try yt-dlp first
    try {
      return await this.fetchWithYTDLP(videoId);
    } catch (error) {
      console.log('⚠️ yt-dlp failed, trying fallback:', error.message);

      // Fallback to metadata
      return {
        title: "YouTube Video",
        thumbnail: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
        duration: 0,
        formats: [],
        allFormats: [],
        url: null,
        selectedQuality: null,
        audioGuaranteed: false,
        error: "Direct download unavailable. Video may be age-restricted or private.",
        videoId: videoId,
        alternative_links: [
          `https://ssyoutube.com/watch?v=${videoId}`,
          `https://en.savefrom.net/watch?v=${videoId}`
        ]
      };
    }
  }

  async fetchWithYTDLP(videoId) {
    return new Promise((resolve, reject) => {
      console.log(`🔄 Fetching with yt-dlp for: ${videoId}`);

      const args = [
        `https://www.youtube.com/watch?v=${videoId}`,
        '--dump-json',
        '--no-warnings',
        '--ignore-errors',
        '--no-playlist',
        '--geo-bypass'
      ];

      const ytDlpProcess = spawn(this.ytDlpPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30000
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
        if (code === 0) {
          try {
            const info = JSON.parse(stdout);
            const formats = this.parseFormats(info, videoId);

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
            console.error('Raw output (first 500 chars):', stdout.substring(0, 500));
            console.error('yt-dlp stderr:', stderr);
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

  parseFormats(info, videoId) {
    if (!info.formats || !Array.isArray(info.formats)) {
      console.log('⚠️ No formats array in yt-dlp output');
      return [];
    }

    const formats = info.formats
        .filter(format => {
          if (!format.url && !format.fragments) return false;
          if (format.format_id && format.format_id.includes('storyboard')) return false;
          return true;
        })
        .map(format => {
          const isAudio = format.vcodec === 'none' && format.acodec !== 'none';
          const isVideo = format.vcodec !== 'none';
          const qualityNum = format.height || format.width || 0;

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

          let extension = format.ext || 'mp4';
          if (isAudio && extension === 'webm') {
            extension = 'webm';
          }

          let mimeType = format.mime_type || `video/${extension}`;
          if (isAudio) {
            mimeType = `audio/${extension}`;
          }

          let url = format.url;
          if (!url && format.fragments && videoId) {
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
            vcodec: format.vcodec || null,
            acodec: format.acodec || null
          };
        })
        .filter(format => format.url)
        .sort((a, b) => {
          if (a.isAudioOnly && !b.isAudioOnly) return 1;
          if (!a.isAudioOnly && b.isAudioOnly) return -1;
          return b.quality - a.quality;
        });

    return formats;
  }
}

// Create singleton instance
const youtubeService = new YouTubeService();

// Main exported function
async function fetchYouTubeData(url) {
  return youtubeService.fetchYouTubeData(url);
}

// Test function
async function testYouTube() {
  try {
    const data = await fetchYouTubeData('https://youtu.be/dQw4w9WgXcQ');
    console.log('✅ YouTube service test passed');
    console.log(`Title: ${data.title}`);
    console.log(`Formats: ${data.formats.length}`);
    return true;
  } catch (error) {
    console.error('❌ YouTube service test failed:', error.message);
    return false;
  }
}

module.exports = {
  fetchYouTubeData,
  testYouTube
};