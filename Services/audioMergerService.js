const { spawn } = require("child_process");
const axios = require("axios");
const stream = require("stream");
const { PassThrough } = require("stream");

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

        let ffmpegProcess = null;
        let hasError = false;
        let videoResponse = null;
        let audioResponse = null;

        try {
            // Set response headers BEFORE starting any streams
            res.setHeader('Content-Type', 'video/mp4');
            res.setHeader('Content-Disposition', 'attachment; filename="merged_video.mp4"');
            res.setHeader('Transfer-Encoding', 'chunked');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');

            console.log("📥 Fetching video stream...");
            videoResponse = await axios({
                method: 'get',
                url: videoUrl,
                responseType: 'stream',
                timeout: 120000,  // 2 minute timeout
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': '*/*',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Connection': 'keep-alive',
                    'Range': 'bytes=0-'  // Support range requests
                }
            });

            console.log("📥 Fetching audio stream...");
            audioResponse = await axios({
                method: 'get',
                url: audioUrl,
                responseType: 'stream',
                timeout: 120000,  // 2 minute timeout
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': '*/*',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Connection': 'keep-alive',
                    'Range': 'bytes=0-'  // Support range requests
                }
            });

            const videoStream = videoResponse.data;
            const audioStream = audioResponse.data;

            console.log("🔧 Spawning FFmpeg process...");
            
            // FFmpeg command with optimized settings for streaming
            const ffmpegArgs = [
                '-i', 'pipe:0',                   // Video input from stdin
                '-i', 'pipe:1',                   // Audio input from pipe:1
                '-c:v', 'copy',                   // Copy video codec (no re-encoding)
                '-c:a', 'aac',                    // Audio codec AAC
                '-b:a', '192k',                   // Audio bitrate
                '-ar', '44100',                   // Audio sample rate
                '-ac', '2',                       // Audio channels (stereo)
                '-map', '0:v:0',                  // Map video from first input
                '-map', '1:a:0',                  // Map audio from second input
                '-movflags', 'frag_keyframe+empty_moov+default_base_moof+faststart', // Optimize for streaming
                '-fflags', '+genpts',            // Generate presentation timestamps
                '-avoid_negative_ts', 'make_zero', // Handle timestamp issues
                '-max_muxing_queue_size', '9999', // Increase muxing queue size
                '-f', 'mp4',                      // Output format
                '-loglevel', 'warning',           // Log level
                'pipe:2'                          // Output to pipe:2 (stdout)
            ];

            ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
                stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'], // stdin, stdout, stderr, pipe:3, pipe:4
                windowsHide: true
            });

            // Handle FFmpeg stderr (logs)
            let errorBuffer = '';
            ffmpegProcess.stderr.on('data', (data) => {
                const message = data.toString();
                errorBuffer += message;
                if (message.toLowerCase().includes('error')) {
                    console.error('FFmpeg Error:', message);
                } else {
                    console.log('FFmpeg Log:', message.substring(0, 200));
                }
            });

            // Handle FFmpeg errors
            ffmpegProcess.on('error', (error) => {
                if (!hasError) {
                    hasError = true;
                    console.error('❌ FFmpeg process error:', error.message);
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
            ffmpegProcess.on('exit', (code, signal) => {
                if (code === 0) {
                    console.log('✅ Audio merge completed successfully');
                } else if (!hasError && code !== null) {
                    hasError = true;
                    console.error(`❌ FFmpeg exited with code ${code}, signal: ${signal}`);
                    console.error('FFmpeg error output:', errorBuffer);
                    if (!res.headersSent) {
                        res.status(500).json({ 
                            error: 'Merge failed', 
                            code: code,
                            details: errorBuffer
                        });
                    }
                }
                this.cleanup(videoStream, audioStream, null);
            });

            // Setup stream error handlers
            const handleStreamError = (streamName) => (error) => {
                if (!hasError) {
                    hasError = true;
                    console.error(`❌ ${streamName} stream error:`, error.message);
                    this.cleanup(videoStream, audioStream, ffmpegProcess);
                    if (!res.headersSent) {
                        res.status(500).json({ 
                            error: `${streamName} stream failed`, 
                            details: error.message 
                        });
                    }
                }
            };

            videoStream.on('error', handleStreamError('Video'));
            audioStream.on('error', handleStreamError('Audio'));

            // Handle stdin close
            ffmpegProcess.stdin.on('error', (error) => {
                if (!hasError && !error.message.includes('EPIPE')) {
                    console.error('FFmpeg stdin error:', error.message);
                }
            });

            ffmpegProcess.stdio[1].on('error', (error) => {
                if (!hasError && !error.message.includes('EPIPE')) {
                    console.error('FFmpeg audio pipe error:', error.message);
                }
            });

            // Pipe video to FFmpeg stdin
            console.log("📤 Piping video stream to FFmpeg...");
            videoStream.pipe(ffmpegProcess.stdin);

            // Pipe audio to FFmpeg pipe:1
            console.log("📤 Piping audio stream to FFmpeg...");
            audioStream.pipe(ffmpegProcess.stdio[1]);

            // Pipe FFmpeg output to response
            console.log("📤 Piping FFmpeg output to response...");
            ffmpegProcess.stdio[2].pipe(res);

            // Handle response errors
            res.on('error', (error) => {
                if (!hasError) {
                    hasError = true;
                    console.error('❌ Response stream error:', error.message);
                    this.cleanup(videoStream, audioStream, ffmpegProcess);
                }
            });

            // Handle client disconnect
            res.on('close', () => {
                console.log('📡 Client closed connection');
                this.cleanup(videoStream, audioStream, ffmpegProcess);
            });

            // Monitor progress
            let dataReceived = false;
            ffmpegProcess.stdio[2].on('data', () => {
                if (!dataReceived) {
                    dataReceived = true;
                    console.log('✅ Started sending merged video data to client');
                }
            });

        } catch (error) {
            console.error('❌ Merge setup failed:', error.message);
            this.cleanup(
                videoResponse?.data, 
                audioResponse?.data, 
                ffmpegProcess
            );
            
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
     * Cleanup resources
     */
    cleanup(videoStream, audioStream, ffmpegProcess) {
        console.log('🧹 Cleaning up resources...');
        
        try {
            if (videoStream && typeof videoStream.destroy === 'function') {
                videoStream.destroy();
            }
        } catch (e) {
            console.warn('Failed to destroy video stream:', e.message);
        }
        
        try {
            if (audioStream && typeof audioStream.destroy === 'function') {
                audioStream.destroy();
            }
        } catch (e) {
            console.warn('Failed to destroy audio stream:', e.message);
        }
        
        try {
            if (ffmpegProcess && !ffmpegProcess.killed) {
                ffmpegProcess.kill('SIGTERM');
                
                // Force kill after 2 seconds if still running
                setTimeout(() => {
                    if (ffmpegProcess && !ffmpegProcess.killed) {
                        ffmpegProcess.kill('SIGKILL');
                    }
                }, 2000);
            }
        } catch (e) {
            console.warn('Failed to kill FFmpeg process:', e.message);
        }
    }
}

module.exports = new AudioMergerService();
