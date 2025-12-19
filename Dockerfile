FROM node:20-slim

WORKDIR /app

# Install FFmpeg and other dependencies
RUN apt-get update && \
    apt-get install -y \
    ca-certificates \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Verify FFmpeg installation
RUN ffmpeg -version

COPY package*.json ./

RUN npm install --production && \
    npm cache clean --force

COPY . .

# Create temp directory for audio merging
RUN mkdir -p /tmp/yt-merge

RUN useradd -m -u 1001 appuser && \
    chown -R appuser:appuser /app && \
    chown -R appuser:appuser /tmp/yt-merge

USER appuser

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD node -e "require('http').get('http://localhost:8000/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

CMD ["node", "App.js"]