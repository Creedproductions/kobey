# Use Node.js 18 image with better FFmpeg support
FROM node:18-bullseye-slim

# Set working directory
WORKDIR /app

# Install system dependencies including FFmpeg and required libraries
RUN apt-get update && \
    apt-get install -y \
    ffmpeg \
    ca-certificates \
    curl \
    wget \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Verify FFmpeg installation and version
RUN ffmpeg -version && \
    ffmpeg -codecs 2>/dev/null | grep -E "aac|h264" && \
    echo "✅ FFmpeg installed successfully with required codecs"

# Copy package files
COPY package*.json ./

# Install Node.js dependencies with longer timeout
RUN npm config set fetch-timeout 600000 && \
    npm install --production && \
    npm cache clean --force

# Copy application files
COPY . .

# Create a non-root user for security
RUN useradd -m -u 1001 appuser && \
    chown -R appuser:appuser /app

# Create temp directory for FFmpeg operations
RUN mkdir -p /tmp/ffmpeg && \
    chown -R appuser:appuser /tmp

# Switch to non-root user
USER appuser

# Set environment variables
ENV NODE_ENV=production \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    PORT=8080

# Expose application port
EXPOSE 8080

# Health check with longer timeout for merge operations
HEALTHCHECK --interval=30s --timeout=30s --start-period=60s --retries=3 \
    CMD node -e "require('http').get('http://localhost:8080/api/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})" || exit 1

# Start the application with increased memory
CMD ["node", "--max-old-space-size=2048", "App.js"]
