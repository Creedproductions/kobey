require('dotenv').config();  // Load environment variables from .env file

module.exports = {
  // Port configuration (use environment variable or default to 3000)
  PORT: process.env.PORT || 3000,

  // Cache expiration time (in milliseconds, default is 60 seconds)
  CACHE_EXPIRATION_TIME: parseInt(process.env.CACHE_EXPIRATION_TIME) || 60000,

  // CORS Configuration (whitelist origins)
  CORS_ORIGINS: process.env.CORS_ORIGINS || 'http://127.0.0.1:5500,https://savemock2.vercel.app', // Multiple origins allowed

  // API keys and third-party service configurations
  API_KEYS: {
    INSTAGRAM_API_KEY: process.env.INSTAGRAM_API_KEY || 'default-instagram-api-key',
    YOUTUBE_API_KEY: process.env.YOUTUBE_API_KEY || 'default-youtube-api-key',
  },

  // Bitly Configuration
  BITLY_ACCESS_TOKEN: process.env.BITLY_ACCESS_TOKEN,  // Add the Bitly access token from .env

  // Tiny URL configurations
  TINY_URL_API: process.env.TINY_URL_API,

  // Optional: Configure logging settings (to log into a file or use an external service)
  LOGGING: {
    LEVEL: process.env.LOGGING_LEVEL || 'debug',  // You can set this to 'info', 'warn', 'error', etc.
    ENABLE_FILE_LOGGING: process.env.ENABLE_FILE_LOGGING === 'true', // Whether to log to a file
    LOG_FILE_PATH: process.env.LOG_FILE_PATH || './logs/app.log',
  },

  // Optional: Database connection configurations (if you want to use a DB for caching or other data)
  DATABASE: {
    URI: process.env.DATABASE_URI || 'mongodb://localhost:27017/my-downloader-app',
  },

  // Add NeonDB configuration
  NEONDB: {
    CONNECTION_STRING: process.env.DATABASE_URL,  // NeonDB connection string from .env
  }
};
