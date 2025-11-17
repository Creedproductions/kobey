// AudioMergerService.js
const { spawn } = require("child_process");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");

class AudioMergerService {

  /**
   * ============================================================
   *  PRIMARY MERGE FUNCTION (tries streaming → falls back to temp)
   * ============================================================
   */
  async mergeVideoAudio(videoUrl, audioUrl, res) {
    console.log("🎬 Incoming merge request:", {
      video: videoUrl.substring(0, 80) + "...",
      audio: audioUrl.substring(0, 80) + "..."
    });

    try {
      // Try fast stream merging first
      await this.mergeStreamMode(videoUrl, audioUrl, res);
    } catch (streamErr) {
      console.warn("⚠ Stream merging failed, falling back to temp method…", streamErr.message);

      // Fallback to temp-file method
      await this.mergeWithTempFiles(videoUrl, audioUrl, res);
    }
  }

  /**
   * ============================================================
   *     STREAM MODE  (FASTEST — NO TEMP FILES)
   * ============================================================
   */
  async mergeStreamMode(videoUrl, audioUrl, res) {
    return new Promise((resolve, reject) => {
      console.log("⚡ Using STREAM mode merge…");

      const ffmpegArgs = [
        "-i", "pipe:0",
        "-i", "pipe:1",
        "-c:v", "copy",
        "-c:a", "aac",
        "-shortest",
        "-f", "mp4",
        "-movflags", "frag_keyframe+empty_moov",
        "pipe:2"
      ];

      const ffmpegProcess = spawn("ffmpeg", ffmpegArgs);
      let hadError = false;

      // FFmpeg logging
      ffmpegProcess.stderr.on("data", d => console.log("FFmpeg:", d.toString()));

      ffmpegProcess.on("error", err => {
        hadError = true;
        reject(new Error("FFmpeg crashed: " + err.message));
      });

      ffmpegProcess.on("close", code => {
        if (!hadError && code === 0) resolve();
        else reject(new Error("FFmpeg exited with code " + code));
      });

      // Output to client
      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Content-Disposition", "attachment; filename=merged_video.mp4");
      res.setHeader("Cache-Control", "no-cache");

      ffmpegProcess.stdout.pipe(res);

      // Pipe Video
      this.pipeUrlToFFmpeg(videoUrl, ffmpegProcess.stdin)
        .catch(err => reject(new Error("Video pipe failed: " + err.message)));

      // Pipe Audio
      this.pipeUrlToFFmpeg(audioUrl, ffmpegProcess.stdin)
        .catch(err => reject(new Error("Audio pipe failed: " + err.message)));
    });
  }

  /**
   * Pipe remote stream → FFmpeg stdin
   */
  async pipeUrlToFFmpeg(url, ffmpegInput) {
    return new Promise((resolve, reject) => {
      axios({
        method: "GET",
        url,
        responseType: "stream",
        timeout: 30000,
        headers: { "User-Agent": "Mozilla/5.0" }
      })
        .then(resp => {
          resp.data.pipe(ffmpegInput, { end: false });
          resp.data.on("end", resolve);
          resp.data.on("error", reject);
        })
        .catch(reject);
    });
  }

  /**
   * ============================================================
   *   TEMP-FILE FALLBACK MODE (100% RELIABLE, HANDLES ALL CODECS)
   * ============================================================
   */
  async mergeWithTempFiles(videoUrl, audioUrl, res) {
    console.log("💾 Using TEMP FILE fallback merge…");

    const tempDir = path.join(__dirname, "../temp");
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

    const videoPath = path.join(tempDir, "video_" + Date.now() + ".mp4");
    const audioPath = path.join(tempDir, "audio_" + Date.now() + ".m4a");
    const outputPath = path.join(tempDir, "merged_" + Date.now() + ".mp4");

    try {
      // Download files
      await this.downloadStream(videoUrl, videoPath);
      await this.downloadStream(audioUrl, audioPath);

      // MERGE FILES USING FLUENT-FFMPEG
      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(videoPath)
          .input(audioPath)
          .videoCodec("copy")  // keep VP9 / H264 / AV1
          .audioCodec("aac")
          .outputOptions(["-shortest"])
          .save(outputPath)
          .on("end", resolve)
          .on("error", reject);
      });

      // Send to user
      res.download(outputPath, "video.mp4", () => {
        fs.unlinkSync(videoPath);
        fs.unlinkSync(audioPath);
        fs.unlinkSync(outputPath);
      });

    } catch (err) {
      console.error("❌ Temp-file merge failed:", err.message);
      res.status(500).json({ error: "Merge failed", details: err.message });
    }
  }

  /**
   * Download remote file → local path
   */
  async downloadStream(url, pathOut) {
    return new Promise(async (resolve, reject) => {
      try {
        const writer = fs.createWriteStream(pathOut);
        const response = await axios({ url, method: "GET", responseType: "stream" });
        response.data.pipe(writer);
        writer.on("finish", resolve);
        writer.on("error", reject);
      } catch (e) {
        reject(e);
      }
    });
  }
}

module.exports = new AudioMergerService();
