FROM node:20-alpine

WORKDIR /app

# Install system dependencies
RUN apk add --no-cache \
    ffmpeg \
    python3 \
    py3-pip \
    curl \
    bash

# Install yt-dlp
RUN pip3 install --no-cache-dir -U yt-dlp --break-system-packages

# Create empty cookies file by default
RUN touch /cookies.txt

COPY package*.json ./

RUN npm install --omit=dev

COPY . .

# Create temp directory
RUN mkdir -p /tmp/yt-merge

RUN adduser -D -u 1001 appuser && \
    chown -R appuser:appuser /app /tmp/yt-merge /cookies.txt

USER appuser

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD node -e "require('http').get('http://localhost:8000/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

CMD ["node", "App.js"]