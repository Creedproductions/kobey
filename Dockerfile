FROM node:20-alpine

WORKDIR /app

# Install only FFmpeg for audio/video merging (if needed for client-side merging)
# Python and yt-dlp are no longer needed with InnerTube API approach
RUN apk add --no-cache \
    ffmpeg \
    curl \
    bash

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --omit=dev

# Copy application code
COPY . .

# Create temp directory for any temporary files
RUN mkdir -p /tmp/media-temp

# Create non-root user
RUN adduser -D -u 1001 appuser && \
    chown -R appuser:appuser /app /tmp/media-temp

USER appuser

EXPOSE 8000

# Healthcheck
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD node -e "require('http').get('http://localhost:8000/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

CMD ["node", "App.js"]