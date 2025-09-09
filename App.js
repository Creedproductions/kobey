const express = require('express');
const cors = require('cors');
const downloaderRoutes = require('./Routes/downloaderRoutes');
const config = require('./Config/config');
const axios = require('axios');

const app = express();

// Middleware to parse JSON
app.use(express.json());

// CORS
const corsOptions = {
  origin: ['https://savedownloader.vercel.app','https://savedownloaderweb.vercel.app','http://localhost:5173'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Range'],
};
app.use(cors(corsOptions));

/**
 * Range-aware proxy to stream remote media via YOUR domain.
 * Fixes blocked hosts (googlevideo, twmate), and “starts then stalls”.
 * Usage: GET /api/proxy?u=<encoded-remote-url>
 */
app.get('/api/proxy', async (req, res) => {
  try {
    const remote = req.query.u;
    if (!remote || typeof remote !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid u param' });
    }
    if (!/^https?:\/\//i.test(remote)) {
      return res.status(400).json({ error: 'Only http/https URLs allowed' });
    }

    const range = req.headers.range;
    const headers = {
      'Accept-Encoding': 'identity',
      ...(range ? { Range: range } : {})
    };

    // Optional HEAD to detect size/type (some hosts block HEAD – ignore failures)
    let headLen = null, headType = null;
    try {
      const head = await axios.head(remote, { timeout: 10000, maxRedirects: 5 });
      headLen = head.headers['content-length'] || null;
      headType = head.headers['content-type'] || null;
    } catch {}

    const upstream = await axios({
      method: 'GET',
      url: remote,
      headers,
      responseType: 'stream',
      timeout: 30000,
      maxRedirects: 5
    });

    // Preserve 206 if partial content
    if (upstream.status === 206 && upstream.headers['content-range']) {
      res.status(206);
      res.set('Content-Range', upstream.headers['content-range']);
    } else {
      res.status(200);
    }

    res.set('Content-Type', headType || upstream.headers['content-type'] || 'application/octet-stream');
    if (upstream.headers['content-length']) res.set('Content-Length', upstream.headers['content-length']);
    else if (headLen) res.set('Content-Length', headLen);

    res.set('Content-Disposition', 'inline; filename="media.mp4"');

    upstream.data.on('error', (e) => {
      console.error('Proxy upstream error:', e.message);
      if (!res.headersSent) res.sendStatus(502);
      try { upstream.data.destroy(); } catch {}
    });

    upstream.data.pipe(res);
  } catch (err) {
    console.error('Proxy error:', err.message);
    if (!res.headersSent) res.status(502).json({ error: 'Proxy failed', details: err.message });
  }
});

// Routes
app.use('/api', downloaderRoutes);

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    features: ['downloads', 'proxy'],
    database: 'disabled'
  });
});

// Root
app.get('/', (req, res) => {
  res.status(200).json({
    message: 'Media Downloader API',
    status: 'running',
    endpoints: {
      health: '/health',
      download: '/api/download',
      mockVideos: '/api/mock-videos',
      proxy: '/api/proxy?u=<encoded-url>'
    }
  });
});

// Global error handlers
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  if (process.env.NODE_ENV !== 'production') process.exit(1);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('SIGTERM', () => {
  console.log('👋 SIGTERM received, shutting down gracefully');
  process.exit(0);
});

// Start
const PORT = config.PORT || process.env.PORT || 8000;
const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`📥 Download API: http://localhost:${PORT}/api/download`);
  console.log(`🔁 Proxy: http://localhost:${PORT}/api/proxy?u=<encoded-url>`); // <-- expect this line at boot
  console.log(`⚠️  Database features disabled - downloads only`);
});
server.on('error', (error) => {
  console.error('❌ Server error:', error);
});

module.exports = app;
