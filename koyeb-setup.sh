#!/bin/bash
# koyeb-setup.sh - Install dependencies for Koyeb deployment

echo "🔧 Setting up Koyeb environment..."

# Update package list and install Python/pip
apt-get update
apt-get install -y python3 python3-pip python3-venv

# Install yt-dlp globally
pip3 install -U yt-dlp

# Install ffmpeg (required for audio/video merging)
apt-get install -y ffmpeg

# Verify installations
echo "✅ Python3 version: $(python3 --version)"
echo "✅ yt-dlp version: $(yt-dlp --version 2>/dev/null || echo 'Not found')"
echo "✅ ffmpeg version: $(ffmpeg -version 2>/dev/null | head -n1 || echo 'Not found')"

echo "🎉 Koyeb setup complete!"