const { spawn } = require('child_process');
const axios = require('axios');
const stream = require('stream');

/**
 * Merges video and audio streams using FFmpeg
 */
class AudioMergerService {
  
  /**
   * Merge video URL with audio URL and return merged stream
   */
  async mergeVideoAudio(videoUrl, audioUrl, res) {
    return new Promise((resolve, reject) => {
      try {
        console.log(`🎬 Starting audio merge:`, {
          videoUrl: videoUrl?.substring(0, 100) + '...',
          audioUrl: audioUrl?.substring(0, 100) + '...'
        });

        // Create FFmpeg process
        const ffmpegArgs = [
          '-i', 'pipe:0',           // Video input from stdin
          '-i', 'pipe:1',           // Audio input from stdin
          '-c:v', 'copy',           // Copy video stream (no re-encode)
          '-c:a', 'aac',            // Encode audio to AAC
          '-shortest',              // Match shortest stream duration
          '-f', 'mp4',              // Output format
          '-movflags', 'frag_keyframe+empty_moov', // For streaming
          'pipe:2'                  // Output to stdout
        ];

        const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);
        
        let hasError = false;

        // Handle FFmpeg errors
        ffmpegProcess.stderr.on('data', (data) => {
          console.log('FFmpeg:', data.toString());
        });

        ffmpegProcess.on('error', (error) => {
          if (!hasError) {
            hasError = true;
            console.error('❌ FFmpeg process error:', error);
            reject(new Error(`FFmpeg processing failed: ${error.message}`));
          }
        });

        ffmpegProcess.on('close', (code) => {
          if (code !== 0 && !hasError) {
            hasError = true;
            console.error(`❌ FFmpeg process exited with code ${code}`);
            reject(new Error(`FFmpeg process failed with code ${code}`));
          } else if (!hasError) {
            console.log('✅ Audio merge completed successfully');
            resolve();
          }
        });

        // Set response headers for video streaming
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Disposition', 'attachment; filename="merged_video.mp4"');
        res.setHeader('Cache-Control', 'no-cache');

        // Pipe FFmpeg output to response
        ffmpegProcess.stdout.pipe(res);

        // Stream video and audio to FFmpeg
        this.streamToFFmpeg(videoUrl, ffmpegProcess.stdin, 0)
          .catch(error => {
            if (!hasError) {
              hasError = true;
              reject(new Error(`Video stream failed: ${error.message}`));
            }
          });

        this.streamToFFmpeg(audioUrl, ffmpegProcess.stdin, 1)
          .catch(error => {
            if (!hasError) {
              hasError = true;
              reject(new Error(`Audio stream failed: ${error.message}`));
            }
          });

      } catch (error) {
        console.error('❌ Audio merge setup failed:', error);
        reject(new Error(`Merge setup failed: ${error.message}`));
      }
    });
  }

  /**
   * Stream URL to FFmpeg stdin
   */
  async streamToFFmpeg(url, writableStream, inputIndex) {
    return new Promise((resolve, reject) => {
      axios({
        method: 'get',
        url: url,
        responseType: 'stream',
        timeout: 30000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      })
      .then(response => {
        response.data.pipe(writableStream, { end: false });
        response.data.on('end', resolve);
        response.data.on('error', reject);
      })
      .catch(reject);
    });
  }

  /**
   * Find compatible audio format for video
   */
  findCompatibleAudio(videoFormat, audioFormats) {
    if (!audioFormats || audioFormats.length === 0) return null;

    // Prefer formats with similar quality characteristics
    const videoQuality = this.extractQualityTier(videoFormat.qualityNum);
    
    // Sort audio formats by quality (higher first)
    const sortedAudio = [...audioFormats].sort((a, b) => {
      const aQuality = this.extractAudioQuality(a);
      const bQuality = this.extractAudioQuality(b);
      return bQuality - aQuality;
    });

    return sortedAudio[0];
  }

  extractQualityTier(qualityNum) {
    if (qualityNum >= 1080) return 'high';
    if (qualityNum >= 720) return 'medium';
    return 'low';
  }

  extractAudioQuality(audioFormat) {
    // Extract audio quality from label or use default
    const label = (audioFormat.label || '').toLowerCase();
    if (label.includes('high') || label.includes('best')) return 3;
    if (label.includes('medium')) return 2;
    if (label.includes('low')) return 1;
    return 2; // Default medium quality
  }
}

module.exports = new AudioMergerService();
