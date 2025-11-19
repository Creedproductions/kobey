FROM node:20-slim

WORKDIR /app

# Install FFmpeg
RUN apt-get update && \
    apt-get install -y ffmpeg ca-certificates && \
    rm -rf /var/lib/apt/lists/* && \
    apt-get clean

# Verify FFmpeg
RUN ffmpeg -version && echo "✅ FFmpeg installed successfully"

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production && \
    npm cache clean --force

# Copy app files
COPY . .

# Create non-root user
RUN useradd -m -u 1001 appuser && \
    chown -R appuser:appuser /app

USER appuser

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD node -e "require('http').get('http://localhost:8000/api/test', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

CMD ["node", "App.js"]
