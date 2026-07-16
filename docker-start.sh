#!/bin/bash
# Quick Docker deployment script

set -e

echo "🐳 yt-dlp Web Frontend - Docker Quick Start"
echo "==========================================="
echo ""

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo "❌ Docker is not installed. Please install Docker first."
    echo "   Visit: https://docs.docker.com/get-docker/"
    exit 1
fi

# Check if Docker Compose is installed
if ! command -v docker-compose &> /dev/null; then
    echo "⚠️  docker-compose not found. Using 'docker compose' instead."
    DOCKER_COMPOSE="docker compose"
else
    DOCKER_COMPOSE="docker-compose"
fi

echo "✅ Docker is installed"
echo ""

# Check if container is already running
if docker ps | grep -q web-yt-dlp; then
    echo "⚠️  Container 'web-yt-dlp' is already running"
    echo ""
    read -p "Do you want to restart it? (y/n) " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo "🔄 Stopping existing container..."
        $DOCKER_COMPOSE down
    else
        echo "ℹ️  Keeping existing container running"
        exit 0
    fi
fi

# Build and start
echo "🏗️  Building Docker image..."
$DOCKER_COMPOSE build

echo ""
echo "🚀 Starting container..."
$DOCKER_COMPOSE up -d

# Wait for container to be healthy
echo ""
echo "⏳ Waiting for server to be ready..."
sleep 5

# Check if container is running
if docker ps | grep -q web-yt-dlp; then
    echo ""
    echo "✅ Server is running!"
    echo ""
    echo "📍 URLs:"
    echo "   - Web UI:    http://localhost:3000"
    echo "   - Health:    http://localhost:3000/health"
    echo "   - API Docs:  See README.md"
    echo ""
    echo "📝 Useful commands:"
    echo "   - View logs:     docker-compose logs -f"
    echo "   - Stop server:   docker-compose down"
    echo "   - Restart:       docker-compose restart"
    echo "   - View status:   docker ps"
    echo ""
    
    # Test health endpoint
    if command -v curl &> /dev/null; then
        echo "🔍 Testing health endpoint..."
        sleep 2
        if curl -s http://localhost:3000/health | grep -q "ok"; then
            echo "✅ Health check passed!"
        else
            echo "⚠️  Health check failed, but container is running"
        fi
    fi
else
    echo ""
    echo "❌ Failed to start container"
    echo "   Check logs: docker-compose logs"
    exit 1
fi

echo ""
echo "🎉 Ready to use! Open http://localhost:3000 in your browser"
