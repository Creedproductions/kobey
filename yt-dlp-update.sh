#!/bin/bash
# yt-dlp-update.sh - Run this periodically to keep yt-dlp updated

set -e
echo "🔄 Updating yt-dlp..."
/opt/yt/bin/pip install --no-cache-dir -U yt-dlp
echo "✅ yt-dlp updated to: $(yt-dlp --version)"