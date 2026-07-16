#!/bin/bash
# Deployment script for yt-dlp Web Frontend on Debian 13

set -e

echo "🚀 yt-dlp Web Frontend - Debian 13 Deployment Script"
echo "======================================================"
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
   echo "❌ Please run as root (use sudo)"
   exit 1
fi

# Update system
echo "📦 Updating system packages..."
apt update

# Install dependencies
echo "📦 Installing system dependencies..."
apt install -y curl ffmpeg python3-pip

# Install yt-dlp
echo "📦 Installing yt-dlp..."
if ! command -v yt-dlp &> /dev/null; then
    wget https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -O /usr/local/bin/yt-dlp
    chmod a+rx /usr/local/bin/yt-dlp
    echo "✅ yt-dlp installed"
else
    echo "✅ yt-dlp already installed"
    yt-dlp -U
fi

# Install Node.js 22 if not installed
echo "📦 Checking Node.js version..."
if ! command -v node &> /dev/null; then
    echo "Installing Node.js 22..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt install -y nodejs
    echo "✅ Node.js 22 installed"
else
    NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VERSION" -lt 22 ]; then
        echo "⚠️  Node.js version $NODE_VERSION detected. Upgrading to Node.js 22..."
        curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
        apt install -y nodejs
    else
        echo "✅ Node.js $(node -v) already installed"
    fi
fi

# Create application directory
APP_DIR="/opt/web-yt-dlp"
echo "📁 Setting up application directory at $APP_DIR..."
mkdir -p $APP_DIR

# Copy files (assumes script is run from project root)
if [ -f "package.json" ]; then
    echo "📋 Copying application files..."
    cp -r src package.json package-lock.json README.md $APP_DIR/
    
    # Install npm dependencies
    echo "📦 Installing npm dependencies..."
    cd $APP_DIR
    npm install --production
    
    # Set permissions
    echo "🔒 Setting permissions..."
    chown -R www-data:www-data $APP_DIR
    
    # Install systemd service
    echo "🔧 Installing systemd service..."
    cp yt-dlp-web.service /etc/systemd/system/ 2>/dev/null || true
    
    if [ -f "/etc/systemd/system/yt-dlp-web.service" ]; then
        # Update WorkingDirectory in service file
        sed -i "s|WorkingDirectory=.*|WorkingDirectory=$APP_DIR|" /etc/systemd/system/yt-dlp-web.service
        
        # Reload systemd
        systemctl daemon-reload
        
        # Enable service
        systemctl enable yt-dlp-web.service
        
        # Start service
        systemctl restart yt-dlp-web.service
        
        # Check status
        sleep 2
        if systemctl is-active --quiet yt-dlp-web.service; then
            echo "✅ Service is running"
        else
            echo "⚠️  Service failed to start. Checking logs..."
            systemctl status yt-dlp-web.service
        fi
    fi
else
    echo "❌ package.json not found. Please run this script from the project root."
    exit 1
fi

echo ""
echo "✅ Deployment complete!"
echo ""
echo "📝 Useful commands:"
echo "  - Check status:  systemctl status yt-dlp-web"
echo "  - View logs:     journalctl -u yt-dlp-web -f"
echo "  - Restart:       systemctl restart yt-dlp-web"
echo "  - Stop:          systemctl stop yt-dlp-web"
echo ""
echo "🌐 Server should be running on http://0.0.0.0:3000"
echo ""
echo "🔒 Security recommendations:"
echo "  - Set up a reverse proxy (nginx/apache)"
echo "  - Enable HTTPS with Let's Encrypt"
echo "  - Configure firewall rules"
echo "  - Add rate limiting"
echo ""
