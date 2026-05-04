const express = require('express');
const router = express.Router();
const { downloadMedia } = require('../Controllers/downloaderController');
const { proxyDownload } = require('../Controllers/proxyController');
const mockController = require('../Controllers/mockController');
const telegram = require('../Services/telegramService');

router.post('/download',      downloadMedia);
router.get('/proxy-download', proxyDownload);
router.get('/mock-videos',    mockController.getMockVideos);

// ── App-side failure reporting ─────────────────────────────────────────────
// Thin relay so the Flutter client can forward failures it observes locally
// (network blips, expired download URLs, decoder errors, etc.) into the
// admin Telegram channel using the bot token already configured on the
// server. Dedup + rate-limit is enforced by telegramService — the same
// per-platform notifyDownloadFailure path that catches server-side errors,
// so admin sees a unified feed.
//
// POST /api/report-failure
//   body: { platform, url, error, source?, meta? }
// Response: { ok: true, sent: <bool> }
//
// Auth: this endpoint is intentionally public (no key) — the rate-limiter
// caps it at 20 alerts/min globally, and dedup suppresses identical errors
// for 5 min, so abuse boils down to "annoy admin a little before being
// silenced". If that ever matters, swap to a shared-secret header.
router.post('/report-failure', express.json({ limit: '32kb' }), async (req, res) => {
  try {
    const { platform = 'unknown', url = '', error = '', source = 'app', meta = {} } =
      req.body || {};
    const errStr = typeof error === 'string' ? error : (error?.message || JSON.stringify(error));
    const tag = source === 'app' ? `app/${platform}` : platform;
    const sent = await telegram.notifyDownloadFailure(tag, url, new Error(errStr));
    if (Object.keys(meta || {}).length > 0) {
      // Append non-PII diagnostic context (device model, sdk version,
      // timing markers) on its own line so admin can correlate. Wrapped
      // in notifyAdmin so dedup applies the same way.
      const lines = Object.entries(meta).map(([k, v]) => `<b>${k}:</b> ${String(v).slice(0, 200)}`);
      await telegram.notifyAdmin(`📱 <b>Client report meta</b>\n${lines.join('\n')}`, {
        tags:     ['client-meta', platform],
        dedupKey: `meta:${platform}:${(errStr || '').slice(0, 80)}`,
        silent:   true,
      });
    }
    res.status(200).json({ ok: true, sent });
  } catch (e) {
    // Never throw — alerting is best-effort.
    console.warn('[report-failure] failed:', e.message);
    res.status(200).json({ ok: false, error: e.message });
  }
});

router.get('/test', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Download API is working',
    timestamp: new Date().toISOString(),
    supportedPlatforms: [
      'instagram', 'tiktok', 'facebook', 'twitter', 'youtube', 'pinterest',
      'threads', 'linkedin', 'douyin', 'reddit', 'vimeo', 'dailymotion',
      'streamable', 'twitch', 'pornhub', 'xvideos', 'universal'
    ],
    features: ['media_download', 'multiple_qualities', 'universal_downloader']
  });
});

router.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

module.exports = router;