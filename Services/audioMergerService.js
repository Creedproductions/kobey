const { spawn } = require("child_process");
const axios = require("axios");

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
        
        return 2;
    }

    /**
     * Merge video + audio URLs using FFmpeg with improved error handling
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
                timeout: 120000,
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': '*/*',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Connection': 'keep-alive',
                    'Range': 'bytes=0-'
                }
            });

            console.log("📥 Fetching audio stream...");
            audioResponse = await axios({
                method: 'get',
                url: audioUrl,
                responseType: 'stream',
                timeout: 120000,
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': '*/*',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Connection': 'keep-alive',
                    'Range': 'bytes=0-'
                }
            });

            const videoStream = videoResponse.data;
            const audioStream = audioResponse.data;

            console.log("🔧 Spawning FFmpeg process...");
            
            // Optimized FFmpeg command for streaming and merging
            const ffmpegArgs = [
                '-i', 'pipe:3',                   // Video from pipe:3 (fd 3)
                '-i', 'pipe:4',                   // Audio from pipe:4 (fd 4)
                '-c:v', 'copy',                   // Copy video (no re-encode)
                '-c:a', 'aac',                    // Encode audio as AAC
                '-b:a', '192k',                   // Audio bitrate
                '-ar', '44100',                   // Sample rate
                '-ac', '2',                       // Stereo
                '-map', '0:v:0',                  // Map video from first input
                '-map', '1:a:0',                  // Map audio from second input
                '-movflags', 'frag_keyframe+empty_moov+faststart',
                '-fflags', '+genpts',
                '-avoid_negative_ts', 'make_zero',
                '-max_muxing_queue_size', '9999',
                '-threads', '0',                  // Use all CPU cores
                '-preset', 'ultrafast',           // Fastest preset
                '-f', 'mp4',
                '-loglevel', 'info',              // More detailed logging
                'pipe:1'                          // Output to stdout
            ];

            ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
                stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
                windowsHide: true
            });

            // Enhanced error logging
            let errorBuffer = '';
            let lastProgressTime = Date.now();
            
            ffmpegProcess.stderr.on('data', (data) => {
                const message = data.toString();
                errorBuffer += message;
                
                // Log progress indicators
                if (message.includes('frame=') || message.includes('time=')) {
                    const now = Date.now();
                    if (now - lastProgressTime > 5000) { // Log every 5 seconds
                        console.log('FFmpeg progress:', message.substring(0, 100));
                        lastProgressTime = now;
                    }
                } else if (message.toLowerCase().includes('error') || 
                          message.toLowerCase().includes('warning')) {
                    console.error('FFmpeg:', message.substring(0, 200));
                }
            });

            // Handle FFmpeg errors
            ffmpegProcess.on('error', (error) => {
                if (!hasError) {
                    hasError = true;
                    console.error('❌ FFmpeg process error:', error.message);
                    console.error('FFmpeg error buffer:', errorBuffer.substring(0, 500));
                    this.cleanup(videoStream, audioStream, ffmpegProcess);
                    if (!res.headersSent) {
                        res.status(500).json({ 
                            error: 'FFmpeg process failed', 
                            details: error.message,
                            ffmpegOutput: errorBuffer.substring(0, 500)
                        });
                    }
                }
            });

            // Handle FFmpeg exit
            ffmpegProcess.on('exit', (code, signal) => {
                console.log(`FFmpeg exited with code ${code}, signal: ${signal}`);
                
                if (code === 0) {
                    console.log('✅ Audio merge completed successfully');
                } else if (!hasError && code !== null) {
                    hasError = true;
                    console.error(`❌ FFmpeg failed with code ${code}`);
                    console.error('FFmpeg error output:', errorBuffer);
                    if (!res.headersSent) {
                        res.status(500).json({ 
                            error: 'Merge failed', 
                            code: code,
                            details: errorBuffer.substring(0, 500)
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

            // Pipe video to FFmpeg pipe:3 (fd 3)
            console.log("📤 Piping video stream to FFmpeg...");
            videoStream.pipe(ffmpegProcess.stdio[3]);

            // Pipe audio to FFmpeg pipe:4 (fd 4)
            console.log("📤 Piping audio stream to FFmpeg...");
            audioStream.pipe(ffmpegProcess.stdio[4]);

            // Pipe FFmpeg output to response
            console.log("📤 Piping FFmpeg output to response...");
            ffmpegProcess.stdout.pipe(res);

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

            // Monitor first data chunk
            let dataReceived = false;
            ffmpegProcess.stdout.once('data', () => {
                dataReceived = true;
                console.log('✅ Started sending merged video data to client');
            });

            // Timeout check for first data
            setTimeout(() => {
                if (!dataReceived && !hasError) {
                    console.warn('⚠️ No data received from FFmpeg after 30 seconds');
                    console.warn('FFmpeg output:', errorBuffer.substring(0, 500));
                }
            }, 30000);

        } catch (error) {
            console.error('❌ Merge setup failed:', error.message);
            console.error('Error stack:', error.stack);
            
            this.cleanup(
                videoResponse?.data, 
                audioResponse?.data, 
                ffmpegProcess
            );
            
            if (!res.headersSent) {
                res.status(500).json({ 
                    error: 'Audio merge failed', 
                    details: error.message,
                    stack: error.stack
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
                
                // Force kill after 2 seconds
                setTimeout(() => {
                    if (ffmpegProcess && !ffmpegProcess.killed) {
                        console.warn('Force killing FFmpeg process');
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
