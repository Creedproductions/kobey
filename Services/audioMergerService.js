const { spawn } = require("child_process");
const axios = require("axios");
const stream = require("stream");
const { promisify } = require("util");

const pipeline = promisify(stream.pipeline);

class AudioMergerService {
    
    /**
     * Find compatible audio stream based on same container type
     */
    findCompatibleAudio(videoFormat, audioFormats) {
        const videoExt = this.getExt(videoFormat.url);
        
        // 1. Try to find same container (best)
        const match = audioFormats.find(a => this.getExt(a.url) === videoExt);
        if (match) return match;

        // 2. Otherwise return best quality audio
        return audioFormats[0];
    }

    /**
     * Extract extension from URL
     */
    getExt(url) {
        try {
            const path = new URL(url).pathname;
            return path.split(".").pop().toLowerCase();
        } catch {
            return "mp4";
        }
    }

    /**
     * Merge video + audio URLs using FFmpeg
     */
    async merge(videoUrl, audioUrl, res) {
        console.log("🎬 Starting merge:");
        console.log("📹 Video:", videoUrl);
        console.log("🎵 Audio:", audioUrl);

        try {
            // Create readable streams
            const videoStream = await this.downloadStream(videoUrl);
            const audioStream = await this.downloadStream(audioUrl);

            // ffmpeg command (ALWAYS produces MP4)
            const ffmpeg = spawn("ffmpeg", [
                "-loglevel", "error",  // suppress useless logs
                "-i", "pipe:3",        // video input
                "-i", "pipe:4",        // audio input
                "-c:v", "copy",        // copy video
                "-c:a", "aac",         // convert audio to AAC
                "-map", "0:v:0",
                "-map", "1:a:0",
                "-shortest",
                "-f", "mp4",
                "pipe:1"
            ], {
                stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"]
            });

            // Pipe input streams
            videoStream.pipe(ffmpeg.stdio[3]);
            audioStream.pipe(ffmpeg.stdio[4]);

            // Handle output
            ffmpeg.stdout.pipe(res);

            ffmpeg.stderr.on("data", (d) => {
                console.log("FFmpeg:", d.toString());
            });

            ffmpeg.on("close", (code) => {
                if (code !== 0) {
                    console.error("❌ FFmpeg merge failed:", code);
                    if (!res.headersSent) {
                        res.status(500).send("FFmpeg merging error");
                    }
                } else {
                    console.log("✅ Merge complete");
                }
            });

        } catch (err) {
            console.error("❌ Merge error:", err);
            if (!res.headersSent) {
                res.status(500).send("Audio merge failed");
            }
        }
    }

    /**
     * Download a remote file as a stream
     */
    async downloadStream(url) {
        const response = await axios({
            method: "get",
            url,
            responseType: "stream",
            timeout: 30000,
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        });

        return response.data;
    }
}

module.exports = new AudioMergerService();
