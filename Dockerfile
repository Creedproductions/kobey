FROM node:20-slim

WORKDIR /app

# Install FFmpeg + certs
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates ffmpeg && \
    rm -rf /var/lib/apt/lists/*

# Copy dependency files first (better layer cache)
COPY package*.json ./

# Install production deps (prefer npm ci if lockfile exists)
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

# Healthcheck with timeout so it can't hang
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "\
    const http=require('http'); \
    const req=http.get('http://127.0.0.1:8000/health', r=>process.exit(r.statusCode===200?0:1)); \
    req.setTimeout(5000, ()=>{req.destroy(); process.exit(1)}); \
    req.on('error', ()=>process.exit(1)); \
  "

CMD ["node", "App.js"]
