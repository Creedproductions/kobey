const { spawn } = require("child_process");
const axios = require("axios");
const stream = require("stream");

class AudioMergerService {
    
    /**
     * Find compatible audio stream based on quality and format
     */
    findCompatibleAudio(videoFormat, audioFormats) {
        if (!audioFormats || audioFormats.length === 0) {
            console.warn("⚠️ No audio formats available");
            return null;
        }

        console.log(`🔍 Finding audio for video quality: ${videoFormat.label || videoFormat.quality}`);
        
        // Sort by quality/bitrate (highest first)
        const sortedAudio = [...audioFormats].sort((a, b) => {
            const aQuality = this.extractAudioQuality(a);
            const bQuality = this.extractAudioQuality(b);
            return bQuality - aQuality;
        });

        const selected = sortedAudio[0];
        console.log(`✅ Selected audio: ${selected.label || 'best available'}`);
        
        return selected;
    }

    /**
     * Extract audio quality ranking
     */
    extractAudioQuality(audioFormat) {
        const label = (audioFormat.label || '').toLowerCase();
        
        if (label.includes('high') || label.includes('best') || label.includes('320')) return 3;
        if (label.includes('medium') || label.includes('192')) return 2;
        if (label.includes('low') || label.includes('128')) return 1;
        
        // Default to medium
        return 2;
    }

    /**
     * Merge video + audio URLs using FFmpeg with proper streaming
     */
    async merge(videoUrl, audioUrl, res) {
        console.log("🎬 Starting audio merge process");
        console.log(`📹 Video URL length: ${videoUrl?.length || 0}`);
        console.log(`🎵 Audio URL length: ${audioUrl?.length || 0}`);

        // Validate inputs
        if (!videoUrl || !audioUrl) {
            throw new Error("Missing video or audio URL");
        }

        if (!res) {
            throw new Error("Response object is required");
        }

        let videoStream = null;
        let audioStream = null;
        let ffmpegProcess = null;
        let hasError = false;

        try {
            // Set response headers BEFORE starting any streams
            res.setHeader('Content-Type', 'video/mp4');
            res.setHeader('Content-Disposition', 'attachment; filename="merged_video.mp4"');
            res.setHeader('Transfer-Encoding', 'chunked');
            res.setHeader('Cache-Control', 'no-cache');

            console.log("📥 Downloading video stream...");
            videoStream = await this.createDownloadStream(videoUrl);
            
            console.log("📥 Downloading audio stream...");
            audioStream = await this.createDownloadStream(audioUrl);

            console.log("🔧 Spawning FFmpeg process...");
            
            // FFmpeg command with proper input handling
            const ffmpegArgs = [
                '-loglevel', 'warning',           // Show warnings but not too verbose
                '-i', 'pipe:0',                   // Video from stdin
                '-i', 'pipe:3',                   // Audio from pipe 3
                '-c:v', 'copy',                   // Copy video codec (no re-encode)
                '-c:a', 'aac',                    // Encode audio to AAC
                '-b:a', '192k',                   // Audio bitrate
                '-map', '0:v:0',                  // Map video from first input
                '-map', '1:a:0',                  // Map audio from second input
                '-shortest',                       // End when shortest stream ends
                '-movflags', '+faststart',        // Enable fast start for streaming
                '-f', 'mp4',                      // Output format
                'pipe:1'                          // Output to stdout
            ];

            ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
                stdio: ['pipe', 'pipe', 'pipe', 'pipe'] // stdin, stdout, stderr, pipe3
            });

            // Handle FFmpeg stderr (logs)
            ffmpegProcess.stderr.on('data', (data) => {
                const message = data.toString();
                console.log('FFmpeg:', message);
            });

            // Handle FFmpeg errors
            ffmpegProcess.on('error', (error) => {
                if (!hasError) {
                    hasError = true;
                    console.error('❌ FFmpeg process error:', error);
                    this.cleanup(videoStream, audioStream, ffmpegProcess);
                    if (!res.headersSent) {
                        res.status(500).json({ 
                            error: 'FFmpeg process failed', 
                            details: error.message 
                        });
                    }
                }
            });

            // Handle FFmpeg exit
            ffmpegProcess.on('close', (code) => {
                console.log(`FFmpeg process closed with code: ${code}`);
                if (code !== 0 && !hasError) {
                    hasError = true;
                    console.error(`❌ FFmpeg exited with error code ${code}`);
                    if (!res.headersSent) {
                        res.status(500).json({ 
                            error: 'Merge failed', 
                            code: code 
                        });
                    }
                } else if (code === 0) {
                    console.log('✅ Audio merge completed successfully');
                }
                this.cleanup(videoStream, audioStream, null);
            });

            // Pipe streams to FFmpeg
            console.log("📤 Piping video stream to FFmpeg stdin...");
            videoStream.pipe(ffmpegProcess.stdin);

            console.log("📤 Piping audio stream to FFmpeg pipe:3...");
            audioStream.pipe(ffmpegProcess.stdio[3]);

            // Pipe FFmpeg output to response
            console.log("📤 Piping FFmpeg output to response...");
            ffmpegProcess.stdout.pipe(res);

            // Handle stream errors
            videoStream.on('error', (error) => {
                if (!hasError) {
                    hasError = true;
                    console.error('❌ Video stream error:', error);
                    this.cleanup(videoStream, audioStream, ffmpegProcess);
                    if (!res.headersSent) {
                        res.status(500).json({ 
                            error: 'Video download failed', 
                            details: error.message 
                        });
                    }
                }
            });

            audioStream.on('error', (error) => {
                if (!hasError) {
                    hasError = true;
                    console.error('❌ Audio stream error:', error);
                    this.cleanup(videoStream, audioStream, ffmpegProcess);
                    if (!res.headersSent) {
                        res.status(500).json({ 
                            error: 'Audio download failed', 
                            details: error.message 
                        });
                    }
                }
            });

            res.on('error', (error) => {
                if (!hasError) {
                    hasError = true;
                    console.error('❌ Response stream error:', error);
                    this.cleanup(videoStream, audioStream, ffmpegProcess);
                }
            });

            res.on('close', () => {
                console.log('📡 Client closed connection');
                this.cleanup(videoStream, audioStream, ffmpegProcess);
            });

        } catch (error) {
            console.error('❌ Merge setup failed:', error);
            this.cleanup(videoStream, audioStream, ffmpegProcess);
            
            if (!res.headersSent) {
                res.status(500).json({ 
                    error: 'Audio merge failed', 
                    details: error.message 
                });
            }
            
            throw error;
        }
    }

    /**
     * Create a download stream from URL with proper headers
     */
    async createDownloadStream(url) {
        try {
            const response = await axios({
                method: 'get',
                url: url,
                responseType: 'stream',
                timeout: 60000,  // 60 second timeout
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': '*/*',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Connection': 'keep-alive'
                }
            });

            if (response.status !== 200) {
                throw new Error(`Download failed with status ${response.status}`);
            }

            return response.data;
        } catch (error) {
            console.error('❌ Failed to create download stream:', error.message);
            throw new Error(`Stream creation failed: ${error.message}`);
        }
    }

    /**
     * Cleanup resources
     */
    cleanup(videoStream, audioStream, ffmpegProcess) {
        console.log('🧹 Cleaning up resources...');
        
        if (videoStream) {
            try {
                videoStream.destroy();
            } catch (e) {
                console.warn('Failed to destroy video stream:', e.message);
            }
        }
        
        if (audioStream) {
            try {
                audioStream.destroy();
            } catch (e) {
                console.warn('Failed to destroy audio stream:', e.message);
            }
        }
        
        if (ffmpegProcess && !ffmpegProcess.killed) {
            try {
                ffmpegProcess.kill('SIGTERM');
                
                // Force kill after 2 seconds if still running
                setTimeout(() => {
                    if (!ffmpegProcess.killed) {
                        ffmpegProcess.kill('SIGKILL');
                    }
                }, 2000);
            } catch (e) {
                console.warn('Failed to kill FFmpeg process:', e.message);
            }
        }
    }
}

module.exports = new AudioMergerService();
