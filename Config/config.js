require('dotenv').config();  // Load environment variables from .env file

module.exports = {
  // Port configuration (use environment variable or default to 8000)
  PORT: process.env.PORT || 8000,

  // Cache expiration time (in milliseconds, default is 60 seconds)
  CACHE_EXPIRATION_TIME: parseInt(process.env.CACHE_EXPIRATION_TIME) || 60000,

  // CORS Configuration (whitelist origins)
  CORS_ORIGINS: process.env.CORS_ORIGINS || 'http://127.0.0.1:5500,https://savemock2.vercel.app',

  // API keys and third-party service configurations
  API_KEYS: {
    INSTAGRAM_API_KEY: process.env.INSTAGRAM_API_KEY || 'default-instagram-api-key',
    YOUTUBE_API_KEY: process.env.YOUTUBE_API_KEY || 'default-youtube-api-key',
  },

  // Bitly Configuration
  BITLY_ACCESS_TOKEN: process.env.BITLY_ACCESS_TOKEN,

  // Tiny URL configurations
  TINY_URL_API: process.env.TINY_URL_API,

  // Optional: Configure logging settings
  LOGGING: {
    LEVEL: process.env.LOGGING_LEVEL || 'debug',
    ENABLE_FILE_LOGGING: process.env.ENABLE_FILE_LOGGING === 'true',
    LOG_FILE_PATH: process.env.LOG_FILE_PATH || './logs/app.log',
  },

  // Database connection configurations (optional - only used if DATABASE_URL exists)
  DATABASE: {
    URI: process.env.DATABASE_URI || null,
  },

  // NeonDB configuration (optional - only used if DATABASE_URL exists)
  NEONDB: {
    CONNECTION_STRING: process.env.DATABASE_URL || null,
  }
};