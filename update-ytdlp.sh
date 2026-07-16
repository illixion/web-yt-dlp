#!/bin/bash
# Manual yt-dlp update script for Docker container

set -e

echo "🔄 Updating yt-dlp in Docker container..."

# Check if container is running
if ! docker ps | grep -q web-yt-dlp; then
    echo "❌ Container 'web-yt-dlp' is not running"
    exit 1
fi

# Update yt-dlp in the running container.
# Must run as root (-u root): the app runs as the non-root 'appuser', and the
# yt-dlp binary lives in /usr/local/bin. As of the current Dockerfile the binary
# is chowned to appuser so this works either way, but -u root is kept as a safe
# default for older images where it is still root-owned.
docker exec -u root web-yt-dlp yt-dlp -U

echo "✅ yt-dlp updated successfully"
echo ""
echo "Current version:"
docker exec web-yt-dlp yt-dlp --version
