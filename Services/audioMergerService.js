const { spawn } = require("child_process");
const axios = require("axios");

// Prevent ECONNRESET and other errors from crashing the process
process.on('uncaughtException', (error) => {
  if (error.code === 'ECONNRESET' || error.message.includes('ECONNRESET')) {
    console.log('🔌 Client connection reset handled gracefully');
    return;
  }
  if (error.code === 'EPIPE' || error.message.includes('EPIPE')) {
    console.log('🔌 Broken pipe handled gracefully');
    return;
  }
  console.error('❌ Uncaught Exception:', error.message);
  console.error('Stack:', error.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

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
    async merge(videoUrl, audioUrl, res, title = 'video') {
        console.log("🎬 Starting audio merge process");
        console.log(`📹 Video URL length: ${videoUrl?.length || 0}`);
        console.log(`🎵 Audio URL length: ${audioUrl?.length || 0}`);

        if (!videoUrl || !audioUrl) {
            throw new Error("Missing video or audio URL");
        }

        if (!res) {
            throw new Error("Response object is required");
        }

        let ffmpegProcess = null;
        let videoResponse = null;
        let audioResponse = null;
        let clientDisconnected = false;
        let hasError = false;

        // Client disconnect handler
        const onClientDisconnect = () => {
            if (!clientDisconnected) {
                clientDisconnected = true;
                console.log('📡 Client disconnected during merge');
                this.cleanup(videoResponse?.data, audioResponse?.data, ffmpegProcess);
            }
        };

        // Monitor client connection
        res.on('close', onClientDisconnect);
        res.on('error', onClientDisconnect);

        try {
            // Check if client is still connected
            if (res.destroyed || res.writableEnded) {
                throw new Error('Client disconnected before merge started');
            }

            // Clean title for filename
            const safeTitle = title
                .replace(/[^a-z0-9\s\-_]/gi, '')
                .replace(/\s+/g, '_')
                .substring(0, 50) || 'video';
            const filename = `${safeTitle}.mp4`;
            
            console.log(`📝 Output filename: ${filename}`);

            // Set response headers
            res.setHeader('Content-Type', 'video/mp4');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            res.setHeader('Transfer-Encoding', 'chunked');
            res.setHeader('Cache-Control', 'no-cache');

            // Fetch video stream
            console.log("📥 Fetching video stream...");
            videoResponse = await axios({
                method: 'get',
                url: videoUrl,
                responseType: 'stream',
                timeout: 30000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': '*/*'
                }
            });

            if (clientDisconnected) throw new Error('Client disconnected');

            // Fetch audio stream
            console.log("📥 Fetching audio stream...");
            audioResponse = await axios({
                method: 'get',
                url: audioUrl,
                responseType: 'stream',
                timeout: 30000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': '*/*'
                }
            });

            if (clientDisconnected) throw new Error('Client disconnected');

            const videoStream = videoResponse.data;
            const audioStream = audioResponse.data;

            console.log("🔧 Spawning FFmpeg process...");
            
            // Optimized FFmpeg command
            const ffmpegArgs = [
                '-i', 'pipe:3',
                '-i', 'pipe:4',
                '-c:v', 'copy',
                '-c:a', 'aac',
                '-b:a', '192k',
                '-movflags', 'frag_keyframe+empty_moov+faststart',
                '-f', 'mp4',
                '-loglevel', 'error',
                'pipe:1'
            ];

            ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
                stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe']
            });

            // Handle FFmpeg errors
            ffmpegProcess.on('error', (error) => {
                if (!hasError && !clientDisconnected) {
                    hasError = true;
                    console.error('❌ FFmpeg process error:', error.message);
                    if (!res.headersSent) {
                        res.status(500).json({ error: 'FFmpeg process failed' });
                    }
                }
            });

            ffmpegProcess.on('exit', (code) => {
                if (code !== 0 && !hasError && !clientDisconnected) {
                    hasError = true;
                    console.error(`❌ FFmpeg exited with code ${code}`);
                } else if (code === 0) {
                    console.log('✅ FFmpeg process completed successfully');
                }
            });

            // Handle FFmpeg stderr for debugging
            ffmpegProcess.stderr.on('data', (data) => {
                const message = data.toString();
                if (message.includes('Error') || message.includes('error')) {
                    console.error('🔴 FFmpeg error:', message.trim());
                }
            });

            // Pipe streams to FFmpeg
            videoStream.pipe(ffmpegProcess.stdio[3]);
            audioStream.pipe(ffmpegProcess.stdio[4]);

            // Handle stream errors
            videoStream.on('error', (error) => {
                if (!hasError && !clientDisconnected) {
                    hasError = true;
                    console.error('❌ Video stream error:', error.message);
                    this.cleanup(videoStream, audioStream, ffmpegProcess);
                }
            });

            audioStream.on('error', (error) => {
                if (!hasError && !clientDisconnected) {
                    hasError = true;
                    console.error('❌ Audio stream error:', error.message);
                    this.cleanup(videoStream, audioStream, ffmpegProcess);
                }
            });

            // Pipe FFmpeg output to response
            ffmpegProcess.stdout.pipe(res);

            // Handle response errors
            res.on('error', (error) => {
                if (!hasError && !clientDisconnected) {
                    hasError = true;
                    console.error('❌ Response stream error:', error.message);
                    this.cleanup(videoStream, audioStream, ffmpegProcess);
                }
            });

            // Handle stream completion
            ffmpegProcess.stdout.once('data', () => {
                console.log('✅ Started sending merged video data to client');
            });

            // Wait for completion
            await new Promise((resolve, reject) => {
                const completionHandler = (code) => {
                    if (code === 0) {
                        console.log('🎉 Audio merge completed successfully');
                        resolve();
                    } else if (!clientDisconnected) {
                        reject(new Error(`FFmpeg exited with code ${code}`));
                    }
                };

                ffmpegProcess.on('exit', completionHandler);
                ffmpegProcess.on('error', reject);
                
                // If client disconnects, reject the promise
                res.on('close', () => {
                    if (!clientDisconnected) {
                        reject(new Error('Client disconnected during merge'));
                    }
                });
            });

        } catch (error) {
            if (!clientDisconnected && !hasError) {
                console.error('❌ Merge failed:', error.message);
                if (!res.headersSent) {
                    res.status(500).json({ 
                        error: 'Audio merge failed', 
                        details: error.message 
                    });
                }
            }
            // Don't re-throw the error to prevent unhandled rejections
            console.log('⚠️ Merge process ended (this is normal for client disconnections)');
        } finally {
            // Remove listeners to prevent memory leaks
            res.removeListener('close', onClientDisconnect);
            res.removeListener('error', onClientDisconnect);
            
            if (!clientDisconnected) {
                this.cleanup(videoResponse?.data, audioResponse?.data, ffmpegProcess);
            }
        }
    }

    /**
     * Improved cleanup method
     */
    cleanup(videoStream, audioStream, ffmpegProcess) {
        console.log('🧹 Cleaning up resources...');
        
        const streams = [videoStream, audioStream];
        
        streams.forEach((stream, index) => {
            if (stream && typeof stream.destroy === 'function') {
                try {
                    stream.destroy();
                    console.log(`✅ Stream ${index + 1} destroyed`);
                } catch (e) {
                    console.log(`⚠️ Stream ${index + 1} cleanup warning:`, e.message);
                }
            }
        });

        if (ffmpegProcess) {
            try {
                if (!ffmpegProcess.killed) {
                    console.log('🛑 Stopping FFmpeg process...');
                    ffmpegProcess.kill('SIGTERM');
                    
                    // Force kill after 2 seconds if still running
                    setTimeout(() => {
                        if (ffmpegProcess && !ffmpegProcess.killed) {
                            console.log('⚠️ Force killing FFmpeg process');
                            ffmpegProcess.kill('SIGKILL');
                        }
                    }, 2000);
                } else {
                    console.log('✅ FFmpeg process already stopped');
                }
            } catch (e) {
                console.log('⚠️ FFmpeg cleanup warning:', e.message);
            }
        }
        
        console.log('✅ Cleanup completed');
    }
}

module.exports = new AudioMergerService();
