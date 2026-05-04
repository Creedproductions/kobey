require('dotenv').config();

const express = require('express');
const cors = require('cors');
const downloaderRoutes = require('./Routes/downloaderRoutes');
const config = require('./Config/config');
const telegram = require('./Services/telegramService');

const app = express();

const PORT = config.PORT || process.env.PORT || 8000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Allowed origins for restricted routes
const WEB_ORIGINS = [
  'https://creedmotions.store',
  'https://www.creedmotions.store',
  'http://localhost:3000',
  'http://localhost:5173',
];

const setupMiddleware = () => {
  app.use(express.json());

  // Open CORS for every route the browser calls directly from creedmotions.store.
  // Must be registered BEFORE the restricted cors() middleware below.
  const openCors = cors();
  app.use('/api/proxy-download', openCors);
  app.use('/api/proxy-test',     openCors);
  app.use('/api/proxy',          openCors);
  app.use('/api/download',       openCors);
  app.use('/api/report-failure', openCors);
  app.use('/api/youtube',        openCors);
  app.use('/api/twitter',        openCors);
  app.use('/api/reddit',         openCors);
  app.use('/api/soundcloud',     openCors);
  app.use('/api/dailymotion',    openCors);
  app.use('/api/vimeo',          openCors);
  app.use('/api/streamable',     openCors);
  app.use('/api/tumblr',         openCors);
  app.use('/api/snapchat',       openCors);
  app.use('/api/douyin',         openCors);
  app.use('/api/bilibili',       openCors);
  app.use('/api/ok',             openCors);
  app.use('/api/vk',             openCors);
  app.use('/api/rumble',         openCors);
  app.use('/api/bandcamp',       openCors);
  app.use('/api/twitch',         openCors);
  app.use('/api/linkedin',       openCors);
  app.use('/api/meta',           openCors);
  app.use('/api/tiktok',         openCors);
  app.use('/api/pinterest',      openCors);
  app.use('/api/threads',        openCors);
  app.use('/api/bluesky',        openCors);
  app.use('/api/spotify',        openCors);
  app.use('/api/mixcloud',       openCors);
  app.use('/api/capcut',         openCors);
  app.use('/api/kuaishou',       openCors);
  app.use('/api/terabox',        openCors);
  app.use('/api/likee',          openCors);

  // Restrict any remaining routes to known origins
  app.use(cors({
    origin: WEB_ORIGINS,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }));
};

const setupRoutes = () => {
  app.use('/api', downloaderRoutes);

  app.get('/health', (req, res) => {
    res.status(200).json({
      status: 'OK',
      timestamp: new Date().toISOString(),
      environment: NODE_ENV,
      features: ['downloads'],
      database: 'disabled'
    });
  });

  app.get('/', (req, res) => {
    res.status(200).json({
      message: 'Media Downloader API — Creed Motions',
      status: 'running',
      endpoints: {
        health:        '/health',
        download:      '/api/download',
        proxyDownload: '/api/proxy-download',
        proxy:         '/api/proxy',
        youtube:       '/api/youtube/download',
      }
    });
  });
};

const setupErrorHandling = () => {
  process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    if (NODE_ENV !== 'production') process.exit(1);
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  });

  process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    if (server) server.close(() => process.exit(0));
    else process.exit(0);
  });

  process.on('SIGINT', () => {
    console.log('SIGINT received, shutting down gracefully');
    if (server) server.close(() => process.exit(0));
    else process.exit(0);
  });
};

const startServer = () => {
  const server = app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`💡 Environment: ${NODE_ENV}`);
    console.log(`📋 Health check: http://localhost:${PORT}/health`);
    console.log(`📥 Download API: http://localhost:${PORT}/api/download`);
    console.log(`▶️  YouTube API:  http://localhost:${PORT}/api/youtube/download`);
    console.log(`🔄 Proxy route:  http://localhost:${PORT}/api/proxy-download`);

    // Confirm Telegram alerts are wired up. notifyStartup() is silent on
    // failure, so a missing token won't crash the process.
    telegram.notifyStartup({ port: PORT }).catch(() => {});
  });

  server.on('error', (error) => {
    console.error('Server error:', error);
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use`);
      process.exit(1);
    }
  });

  return server;
};

const initializeApp = () => {
  setupMiddleware();
  setupRoutes();
  setupErrorHandling();
  return startServer();
};

let server;
if (require.main === module) server = initializeApp();

module.exports = app;