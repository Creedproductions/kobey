const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');

const router = express.Router();

const mergeTokenStore = require('../Services/mergeTokenStore');
const { youtubeService } = require('../Services/youtubeServiceNew');

// Token -> Promise (merge in progress)
const inProgress = new Map();

// Token -> { filePath, createdAt }
const completed = new Map();

// Optional cleanup (delete completed files after 30 min)
const COMPLETED_TTL_MS = 30 * 60 * 1000;

function cleanupCompleted() {
    const now = Date.now();
    for (const [token, info] of completed.entries()) {
        if (now - info.createdAt > COMPLETED_TTL_MS) {
            try {
                if (info.filePath && fs.existsSync(info.filePath)) fs.unlinkSync(info.filePath);
            } catch (_) {}
            completed.delete(token);
            mergeTokenStore.deleteToken?.(token); // if you implement deleteToken
        }
    }
}

router.get('/merge/:token', async (req, res) => {
    const { token } = req.params;

    // Clean old cached merges sometimes
    cleanupCompleted();

    // 1) If already merged -> stream file immediately
    const done = completed.get(token);
    if (done?.filePath && fs.existsSync(done.filePath)) {
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Disposition', 'attachment; filename="video.mp4"');
        return fs.createReadStream(done.filePath).pipe(res);
    }

    // 2) If merge already running -> don't start again
    if (inProgress.has(token)) {
        // IMPORTANT: client should retry after a few seconds
        return res.status(202).json({ success: false, status: 'merging', token });
    }

    // 3) Validate token data
    const payload = mergeTokenStore.getToken(token);
    if (!payload?.videoUrl || !payload?.audioUrl) {
        return res.status(404).json({ success: false, error: 'Invalid/expired merge token' });
    }

    // 4) Start merge ONCE
    const outPath = path.join(os.tmpdir(), 'yt-merge', `merged_${token}.mp4`);
    try {
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
    } catch (_) {}

    const mergePromise = (async () => {
        await youtubeService.mergeVideoAudio(payload.videoUrl, payload.audioUrl, outPath);
        completed.set(token, { filePath: outPath, createdAt: Date.now() });
        return outPath;
    })();

    inProgress.set(token, mergePromise);

    try {
        const filePath = await mergePromise;
        inProgress.delete(token);

        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Disposition', 'attachment; filename="video.mp4"');
        return fs.createReadStream(filePath).pipe(res);
    } catch (err) {
        inProgress.delete(token);
        return res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
