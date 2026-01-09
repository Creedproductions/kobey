FROM node:20.18.1-slim

WORKDIR /app

# System deps
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      ffmpeg \
      curl \
      python3 \
      python3-venv && \
    rm -rf /var/lib/apt/lists/*

# yt-dlp in venv (PEP 668 safe)
RUN python3 -m venv /opt/yt && \
    /opt/yt/bin/pip install --no-cache-dir -U pip yt-dlp && \
    ln -s /opt/yt/bin/yt-dlp /usr/local/bin/yt-dlp && \
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
