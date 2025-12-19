FROM node:20-alpine

WORKDIR /app

# Alpine uses apk instead of apt (much smaller)
RUN apk add --no-cache \
    ffmpeg \
    python3 \
    py3-pip \
    curl

# Alpine doesn't have the Debian restrictions
RUN pip3 install --no-cache-dir -U yt-dlp

# Verify installations
RUN echo "✅ Node version: $(node --version)" && \
    echo "✅ Python version: $(python3 --version)" && \
    echo "✅ FFmpeg version: $(ffmpeg -version | head -n1)" && \
    echo "✅ yt-dlp version: $(yt-dlp --version)"

COPY package*.json ./

RUN npm install --production

COPY . .

# Create temp directory
RUN mkdir -p /tmp/yt-merge

RUN adduser -D -u 1001 appuser && \
    chown -R appuser:appuser /app /tmp/yt-merge

USER appuser

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD node -e "require('http').get('http://localhost:8000/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

CMD ["node", "App.js"]