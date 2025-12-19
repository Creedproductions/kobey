#!/bin/bash
# install-yt-dlp.sh
echo "🔧 Installing yt-dlp..."

# Check if Python 3 is installed
if ! command -v python3 &> /dev/null; then
    echo "Installing Python 3..."
    if [[ "$OSTYPE" == "linux-gnu"* ]]; then
        sudo apt update && sudo apt install -y python3 python3-pip
    elif [[ "$OSTYPE" == "darwin"* ]]; then
        brew install python3
    fi
fi

# Install yt-dlp
echo "Installing yt-dlp..."
pip3 install -U yt-dlp

# Also install ffmpeg for merging audio/video
if ! command -v ffmpeg &> /dev/null; then
    echo "Installing ffmpeg..."
    if [[ "$OSTYPE" == "linux-gnu"* ]]; then
        sudo apt install -y ffmpeg
    elif [[ "$OSTYPE" == "darwin"* ]]; then
        brew install ffmpeg
    elif [[ "$OSTYPE" == "msys"* ]] || [[ "$OSTYPE" == "win32"* ]]; then
        echo "Please install ffmpeg from: https://ffmpeg.org/download.html"
    fi
fi

# Create symbolic link for easy access
if [[ "$OSTYPE" != "msys"* ]] && [[ "$OSTYPE" != "win32"* ]]; then
    ln -sf $(which yt-dlp) /usr/local/bin/yt-dlp 2>/dev/null || true
fi

echo "✅ Installation complete!"
echo "yt-dlp version: $(yt-dlp --version)"
echo "ffmpeg version: $(ffmpeg -version 2>/dev/null | head -n1 || echo 'Not installed')"