const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { promisify } = require('util');
const unlinkAsync = promisify(fs.unlink);

class MergeService {
    constructor() {
        this.tempDir = path.join(os.tmpdir(), 'yt-merge');

        // Ensure temp directory exists
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }
    }

    /**
     * Merge video and audio streams using FFmpeg
     */
    async mergeStreams(videoUrl, audioUrl) {
        const timestamp = Date.now();
        const outputPath = path.join(this.tempDir, `merged_${timestamp}.mp4`);

        console.log('🔄 Starting server-side merge...');
        console.log(`📹 Video URL: ${videoUrl.substring(0, 100)}...`);
        console.log(`🎵 Audio URL: ${audioUrl.substring(0, 100)}...`);

        return new Promise((resolve, reject) => {
            const ffmpegArgs = [
                '-i', videoUrl,
                '-i', audioUrl,
                '-c:v', 'copy',
                '-c:a', 'aac',
                '-b:a', '192k',
                '-strict', 'experimental',
                '-movflags', '+faststart', // Enable streaming
                '-y',
                outputPath
            ];

            const ffmpeg = spawn('ffmpeg', ffmpegArgs);

            let stderr = '';
            let lastProgress = 0;

            ffmpeg.stderr.on('data', (data) => {
                const text = data.toString();
                stderr += text;

                // Parse FFmpeg progress
                const timeMatch = text.match(/time=(\d+):(\d+):(\d+\.\d+)/);
                if (timeMatch) {
                    const hours = parseInt(timeMatch[1]);
                    const minutes = parseInt(timeMatch[2]);
                    const seconds = parseFloat(timeMatch[3]);
                    const currentTime = hours * 3600 + minutes * 60 + seconds;

                    if (currentTime > lastProgress) {
                        lastProgress = currentTime;
                        console.log(`⏳ Merging... ${currentTime.toFixed(1)}s processed`);
                    }
                }
            });

            ffmpeg.on('close', (code) => {
                if (code === 0) {
                    console.log('✅ FFmpeg merge successful');

                    // Verify output file exists
                    if (fs.existsSync(outputPath)) {
                        const stats = fs.statSync(outputPath);
                        console.log(`📦 Output file size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
                        resolve(outputPath);
                    } else {
                        reject(new Error('Output file not found after merge'));
                    }
                } else {
                    console.error('❌ FFmpeg merge failed with code:', code);
                    console.error('FFmpeg stderr:', stderr);
                    reject(new Error(`FFmpeg failed with code ${code}`));
                }
            });

            ffmpeg.on('error', (error) => {
                console.error('❌ FFmpeg spawn error:', error);
                reject(error);
            });

            // Set timeout (5 minutes)
            setTimeout(() => {
                ffmpeg.kill();
                reject(new Error('FFmpeg merge timeout'));
            }, 5 * 60 * 1000);
        });
    }

    /**
     * Clean up temporary merged file
     */
    async cleanup(filePath) {
        try {
            if (fs.existsSync(filePath)) {
                await unlinkAsync(filePath);
                console.log(`🧹 Cleaned up: ${filePath}`);
            }
        } catch (error) {
            console.error(`⚠️ Failed to cleanup ${filePath}:`, error.message);
        }
    }

    /**
     * Clean up old temporary files (older than 1 hour)
     */
    async cleanupOldFiles() {
        try {
            const files = fs.readdirSync(this.tempDir);
            const now = Date.now();
            const oneHour = 60 * 60 * 1000;

            for (const file of files) {
                const filePath = path.join(this.tempDir, file);
                const stats = fs.statSync(filePath);

                if (now - stats.mtimeMs > oneHour) {
                    await this.cleanup(filePath);
                }
            }
        } catch (error) {
            console.error('⚠️ Failed to cleanup old files:', error.message);
        }
    }
}

// Create singleton instance
const mergeService = new MergeService();

// Clean up old files on startup
mergeService.cleanupOldFiles();

// Schedule periodic cleanup (every hour)
setInterval(() => {
    mergeService.cleanupOldFiles();
}, 60 * 60 * 1000);

module.exports = mergeService;