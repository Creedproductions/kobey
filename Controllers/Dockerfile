# Use Node.js 18 slim image
FROM node:18-slim
# Set working directory
WORKDIR /app
# Install system dependencies including FFmpeg
RUN apt-get update && \
    apt-get install -y \
    ffmpeg \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean
# Verify FFmpeg installation
RUN ffmpeg -version && echo "✅ FFmpeg installed successfully"
# Copy package files
COPY package*.json ./
# Install Node.js dependencies
RUN npm install --production && \
    npm cache clean --force
# Copy application files
COPY . .
# Create a non-root user for security
RUN useradd -m -u 1001 appuser && \
    chown -R appuser:appuser /app
# Switch to non-root user
USER appuser
# Expose application port
EXPOSE 8080
# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD node -e "require('http').get('http://localhost:8080/api/test', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"
# Start the application
CMD ["node", "App.js"]
