FROM node:20-slim

WORKDIR /app

# System deps: ffmpeg + curl + certs
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    ca-certificates \
    ffmpeg \
    curl && \
    rm -rf /var/lib/apt/lists/*

# Install yt-dlp binary (fast, no Python needed)
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
      -o /usr/local/bin/yt-dlp && \
    chmod +x /usr/local/bin/yt-dlp && \
    yt-dlp --version

# Copy dependency files first (better layer cache)
COPY package*.json ./

# Install production deps
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev; \
    else \
      npm install --omit=dev; \
    fi && \
    npm cache clean --force

# Copy the rest of the app
COPY . .

# Create non-root user and fix permissions
RUN useradd -m -u 1001 appuser && \
    chown -R appuser:appuser /app && \
    mkdir -p /tmp/yt-merge && \
    chown -R appuser:appuser /tmp/yt-merge

USER appuser

ENV NODE_ENV=production
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "\
    const http=require('http'); \
    const req=http.get('http://127.0.0.1:8000/health', r=>process.exit(r.statusCode===200?0:1)); \
    req.setTimeout(5000, ()=>{req.destroy(); process.exit(1)}); \
    req.on('error', ()=>process.exit(1)); \
  "

CMD ["node", "App.js"]
