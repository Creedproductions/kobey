FROM node:20.18.1-slim

WORKDIR /app

# Install ffmpeg + python + yt-dlp
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      ffmpeg \
      python3 \
      python3-pip && \
    pip3 install --no-cache-dir -U yt-dlp && \
    rm -rf /var/lib/apt/lists/* && \
    yt-dlp --version && \
    ffmpeg -version

COPY package*.json ./

RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev; \
    else \
      npm install --omit=dev; \
    fi && \
    npm cache clean --force

COPY . .

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
