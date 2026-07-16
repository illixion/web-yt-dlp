# Use Node.js 22 on Debian 13 (Trixie)
FROM node:22-bookworm-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    wget \
    unzip \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp
RUN wget https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -O /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

# Install deno (JavaScript runtime required by yt-dlp's YouTube extractor / EJS challenge solver)
# yt-dlp auto-detects deno on PATH; without it, some formats are unavailable and extraction is deprecated.
RUN wget -O /tmp/deno.zip https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip \
    && unzip /tmp/deno.zip -d /usr/local/bin \
    && chmod a+rx /usr/local/bin/deno \
    && rm /tmp/deno.zip

# Verify installations
RUN node --version \
    && ffmpeg -version \
    && yt-dlp --version \
    && deno --version

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node.js dependencies
RUN npm ci --only=production

# Copy application files
COPY src/ ./src/

# Create non-root user and set up permissions.
# yt-dlp and deno are chowned to appuser so runtime self-update (AUTO_UPDATE_YTDLP=true)
# can rewrite the binaries — the app runs as non-root and could not do this otherwise.
RUN useradd -r -u 1001 -g root appuser \
    && chown -R appuser:root /app \
    && chmod -R 755 /app \
    && chown appuser:root /usr/local/bin/yt-dlp /usr/local/bin/deno \
    && mkdir -p /tmp/yt-dlp-workdir \
    && chown -R appuser:root /tmp/yt-dlp-workdir \
    && chmod -R 777 /tmp/yt-dlp-workdir

# Switch to non-root user
USER appuser

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1); })"

# Start the server
CMD ["node", "src/server.js"]
