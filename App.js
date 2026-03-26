const express = require('express');
const cors = require('cors');
const downloaderRoutes = require('./Routes/downloaderRoutes');
const config = require('./Config/config');

const app = express();

const PORT = config.PORT || process.env.PORT || 8000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Allowed origins — Creed Motions web app + local dev
const WEB_ORIGINS = [
  'https://creedmotions.store',
  'https://www.creedmotions.store',
  'http://localhost:3000',
  'http://localhost:5173',
];

const setupMiddleware = () => {
  app.use(express.json());

  // These routes need open CORS so the browser can call them directly
  app.use('/api/proxy-download', cors());
  app.use('/api/proxy-test',     cors());
  app.use('/api/proxy',          cors());  // used by web downloader blob streaming
  app.use('/api/download',       cors());  // Instagram / TikTok / Facebook / Pinterest

  // All other /api routes restricted to allowed origins
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
      message: 'Media Downloader API',
      status: 'running',
      endpoints: {
        health:        '/health',
        download:      '/api/download',
        proxyDownload: '/api/proxy-download',
        proxy:         '/api/proxy',
      }
    });
  });
};

const setupErrorHandling = () => {
  process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    if (NODE_ENV !== 'production') {
      process.exit(1);
    }
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  });

  process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    if (server) {
      server.close(() => { process.exit(0); });
    } else {
      process.exit(0);
    }
  });

  process.on('SIGINT', () => {
    console.log('SIGINT received, shutting down gracefully');
    if (server) {
      server.close(() => { process.exit(0); });
    } else {
      process.exit(0);
    }
  });
};

const startServer = () => {
  const server = app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`💡 Environment: ${NODE_ENV}`);
    console.log(`📋 Health check: http://localhost:${PORT}/health`);
    console.log(`📥 Download API: http://localhost:${PORT}/api/download`);
    console.log(`🔄 Proxy route:  http://localhost:${PORT}/api/proxy-download`);
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
if (require.main === module) {
  server = initializeApp();
}

module.exports = app;