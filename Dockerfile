FROM node:20.18.1-slim

WORKDIR /app

# Install system dependencies with additional useful packages
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      ffmpeg \
      curl \
      python3 \
      python3-venv \
      python3-pip \
      tini \
      # Additional useful packages
      git \
      build-essential \
      && \
    rm -rf /var/lib/apt/lists/*

# Create virtual environment and install yt-dlp with all dependencies
RUN python3 -m venv /opt/yt && \
    /opt/yt/bin/pip install --no-cache-dir -U pip setuptools wheel && \
    /opt/yt/bin/pip install --no-cache-dir -U yt-dlp && \
    # Create symlink
    ln -s /opt/yt/bin/yt-dlp /usr/local/bin/yt-dlp && \
    # Verify installation
    yt-dlp --version && \
    # Update yt-dlp to latest (optional but recommended)
    yt-dlp -U || true

# Copy dependency files
COPY package*.json ./

# Install production dependencies
RUN npm ci --omit=dev --ignore-scripts && \
    npm cache clean --force

# Copy application code
COPY . .

# Create necessary directories with proper permissions
RUN mkdir -p /tmp/yt-dlp /tmp/yt-merge /tmp/yt-cache && \
    chmod 1777 /tmp/yt-dlp /tmp/yt-merge /tmp/yt-cache

# Create non-root user with home directory
RUN useradd -m -u 1001 -s /bin/bash appuser && \
    chown -R appuser:appuser /app && \
    chown -R appuser:appuser /tmp/yt-dlp /tmp/yt-merge /tmp/yt-cache

# Switch to non-root user
USER appuser

# Environment variables for yt-dlp optimization
ENV NODE_ENV=production \
    YT_DLP_CACHE_DIR=/tmp/yt-cache \
    YT_DLP_CONFIG=/app/yt-dlp.conf

# Create yt-dlp config file for optimal performance
RUN echo "# yt-dlp configuration\n\
--no-playlist\n\
--no-warnings\n\
--no-check-certificate\n\
--extractor-args youtube:player-client=android\n\
--concurrent-fragments 5\n\
--cache-dir /tmp/yt-cache\n\
--no-cache-dir\n" > /app/yt-dlp.conf

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "\
    const http=require('http'); \
    const options={ \
      hostname:'127.0.0.1', \
      port:8000, \
      path:'/health', \
      timeout:5000 \
    }; \
    const req=http.get(options, r=>process.exit(r.statusCode===200?0:1)); \
    req.on('error',()=>process.exit(1)); \
    req.end(); \
  "

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "App.js"]