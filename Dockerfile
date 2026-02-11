# Dockerfile
FROM node:20.18.1-slim

WORKDIR /app

# ========================================
# INSTALL SYSTEM DEPENDENCIES
# ========================================
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      ffmpeg \
      curl \
      wget \
      python3 \
      python3-venv \
      python3-pip \
      tini \
      # Additional useful packages
      git \
      build-essential \
      && \
    # Clean up
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# ========================================
# INSTALL YT-DLP WITH VENV (PEP 668 SAFE)
# ========================================
RUN python3 -m venv /opt/yt && \
    /opt/yt/bin/pip install --no-cache-dir -U pip setuptools wheel && \
    /opt/yt/bin/pip install --no-cache-dir -U yt-dlp && \
    # Create symlink
    ln -s /opt/yt/bin/yt-dlp /usr/local/bin/yt-dlp && \
    # Verify installation
    yt-dlp --version

# ========================================
# CREATE YT-DLP CONFIGURATION
# ========================================
RUN mkdir -p /app/config && \
    echo "# yt-dlp configuration for Unisaver API" > /app/config/yt-dlp.conf && \
    echo "# ----------------------------------------" >> /app/config/yt-dlp.conf && \
    echo "--no-playlist" >> /app/config/yt-dlp.conf && \
    echo "--no-warnings" >> /app/config/yt-dlp.conf && \
    echo "--no-check-certificate" >> /app/config/yt-dlp.conf && \
    echo "--geo-bypass" >> /app/config/yt-dlp.conf && \
    echo "--extractor-args youtube:player_client=android,mweb,web" >> /app/config/yt-dlp.conf && \
    echo "--concurrent-fragments 5" >> /app/config/yt-dlp.conf && \
    echo "--throttled-rate 100K" >> /app/config/yt-dlp.conf && \
    echo "--sleep-interval 3" >> /app/config/yt-dlp.conf && \
    echo "--max-sleep-interval 8" >> /app/config/yt-dlp.conf && \
    echo "--user-agent \"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36\"" >> /app/config/yt-dlp.conf && \
    echo "--add-header \"Accept-Language: en-US,en;q=0.9\"" >> /app/config/yt-dlp.conf

# ========================================
# CREATE COOKIE TEMPLATE
# ========================================
RUN mkdir -p /tmp/yt-dlp && \
    echo "# Netscape HTTP Cookie File" > /tmp/yt-dlp/cookies.txt && \
    echo ".youtube.com	TRUE	/	FALSE	1735689600	CONSENT	YES+cb.20250305-11-p0.en+FX+424" >> /tmp/yt-dlp/cookies.txt && \
    echo ".youtube.com	TRUE	/	FALSE	1735689600	__Secure-3PSIDCC	" >> /tmp/yt-dlp/cookies.txt && \
    echo ".youtube.com	TRUE	/	FALSE	1735689600	__Secure-3PAPISID	" >> /tmp/yt-dlp/cookies.txt && \
    echo ".youtube.com	TRUE	/	FALSE	1735689600	__Secure-3PSID	" >> /tmp/yt-dlp/cookies.txt

# ========================================
# CREATE UPDATE SCRIPT
# ========================================
RUN echo '#!/bin/bash\n\
echo "🔄 Updating yt-dlp..."\n\
/opt/yt/bin/pip install --no-cache-dir -U yt-dlp\n\
echo "✅ yt-dlp updated to: $(yt-dlp --version)"\n\
' > /usr/local/bin/yt-dlp-update.sh && \
    chmod +x /usr/local/bin/yt-dlp-update.sh

# ========================================
# COPY DEPENDENCY FILES
# ========================================
COPY package*.json ./

# ========================================
# INSTALL NODE DEPENDENCIES
# ========================================
RUN npm ci --omit=dev --ignore-scripts && \
    npm cache clean --force

# ========================================
# COPY APPLICATION CODE
# ========================================
COPY . .

# ========================================
# CREATE DIRECTORY STRUCTURE
# ========================================
RUN mkdir -p /tmp/yt-dlp/cache && \
    mkdir -p /tmp/yt-merge && \
    mkdir -p /tmp/yt-dlp/cookies && \
    mkdir -p /app/logs && \
    chmod 1777 /tmp/yt-dlp /tmp/yt-merge /tmp/yt-dlp/cache /tmp/yt-dlp/cookies

# ========================================
# SETUP NON-ROOT USER
# ========================================
RUN useradd -m -u 1001 -s /bin/bash appuser && \
    chown -R appuser:appuser /app && \
    chown -R appuser:appuser /tmp/yt-dlp && \
    chown -R appuser:appuser /tmp/yt-merge && \
    chown -R appuser:appuser /app/config && \
    chown -R appuser:appuser /app/logs

# ========================================
# SWITCH TO NON-ROOT USER
# ========================================
USER appuser

# ========================================
# ENVIRONMENT VARIABLES
# ========================================
ENV NODE_ENV=production \
    YT_DLP_CONFIG=/app/config/yt-dlp.conf \
    YT_DLP_CACHE_DIR=/tmp/yt-dlp/cache \
    YT_DLP_COOKIES_FILE=/tmp/yt-dlp/cookies.txt \
    PORT=8000

# ========================================
# HEALTHCHECK
# ========================================
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "\
    const http=require('http'); \
    const options={ \
      hostname:'127.0.0.1', \
      port:process.env.PORT || 8000, \
      path:'/health', \
      timeout:5000 \
    }; \
    const req=http.get(options, r=>process.exit(r.statusCode===200?0:1)); \
    req.on('error',()=>process.exit(1)); \
    req.end(); \
  "

# ========================================
# EXPOSE PORT
# ========================================
EXPOSE 8000

# ========================================
# ENTRYPOINT AND CMD
# ========================================
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "-c", "yt-dlp-update.sh && node App.js"]