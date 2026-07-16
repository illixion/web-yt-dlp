# yt-dlp Web Frontend

A Node.js web server that provides a frontend for yt-dlp with iOS Shortcuts support. Download videos from YouTube, Instagram, and 1000+ supported sites with automatic conversion to iOS-compatible MP4 format.

## Features

- 🎥 **Web UI** - Clean, responsive interface for downloading videos
- � **Authentication** - Optional static token authentication for secure access
- �📱 **iOS Shortcuts Support** - API designed for seamless iOS Shortcuts integration ([Get shortcut](https://www.icloud.com/shortcuts/e106385960a34deeaa1dd7e1757f49f8))
- 🔄 **Auto-conversion** - Videos converted to iOS-compatible MP4 with optimized settings
- ⏰ **24-hour expiration** - Download links expire after 24 hours for security
- 🌐 **Multi-site support** - Works with YouTube, Instagram, TikTok, and 1000+ sites
- 🚀 **Job-based processing** - Prevents HTTP timeouts with async job system
- 🥽 **Direct streaming** - `/stream` serves a seekable, Range-capable MP4

## Requirements

- Node.js 22+
- yt-dlp installed and available in PATH
- ffmpeg installed and available in PATH

Runs on Linux, macOS, and Windows (via WSL or native Node.js).

## Installation

### 1. Install System Dependencies

```bash
# Update package list
sudo apt update

# Install ffmpeg
sudo apt install -y ffmpeg

# Install yt-dlp
sudo wget https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -O /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp

# Or install via pip
# pip install -U yt-dlp
```

### 2. Install Node.js Dependencies

```bash
npm install
```

### 3. Configure Authentication (Optional but Recommended)

Generate a secure authentication token:

```bash
# Generate a random 32-byte hex token
openssl rand -hex 32 > auth_token

# Or create your own token
echo "your-secure-token-here" > auth_token
```

**Important:** Keep your `auth_token` file secure and never commit it to version control!

Alternatively, you can set the token as an environment variable:

```bash
export AUTH_TOKEN="your-secure-token-here"
```

If no `auth_token` file or `AUTH_TOKEN` environment variable is found, the server will run **without authentication** (not recommended for production).

📖 **For detailed authentication documentation, see [AUTHENTICATION.md](AUTHENTICATION.md)**

## Usage

### Option 1: Docker (Recommended)

```bash
# Using Docker Compose
docker-compose up -d

# Or using Docker CLI
docker build -t web-yt-dlp .
docker run -d -p 3000:3000 --name web-yt-dlp web-yt-dlp
```

See **[DOCKER.md](DOCKER.md)** for complete Docker documentation.

### Option 2: Direct Node.js

```bash
# Production
npm start

# Development (with auto-reload)
npm run dev
```

The server will start on `http://0.0.0.0:3000` by default.

### Environment Variables

- `PORT` - Server port (default: 3000)
- `HOST` - Server host (default: 0.0.0.0)
- `AUTH_TOKEN` - Authentication token (optional, can also use auth_token file)
- `STREAM_CACHE_DIR` - Directory for `/stream` muxed cache files (default: `<tmp>/yt-dlp-stream-cache`)

```bash
PORT=8080 HOST=localhost AUTH_TOKEN="your-token" npm start
```

## API Documentation

### Authentication

When authentication is enabled (via `auth_token` file or `AUTH_TOKEN` environment variable), all API endpoints require authentication. The token can be provided in multiple ways:

1. **Authorization Header (Recommended):**
   ```
   Authorization: Bearer your-token-here
   ```

2. **Custom Header:**
   ```
   X-Auth-Token: your-token-here
   ```

3. **Request Body (POST requests):**
   ```json
   {
     "url": "https://...",
     "token": "your-token-here"
   }
   ```

4. **Query Parameter (GET requests and downloads):**
   ```
   /api/jobs/job-id?token=your-token-here
   ```

### Web Interface

Navigate to `http://localhost:3000` in your browser to use the web interface. If authentication is enabled, you'll see a token field that stores your token in browser localStorage for convenience.

### REST API

#### 1. Create Download Job

```bash
POST /api/jobs
Content-Type: application/json
X-Auth-Token: your-token-here

{
  "url": "https://www.youtube.com/watch?v=jNQXAC9IVRw"
}
```

Or with token in body:

```bash
POST /api/jobs
Content-Type: application/json

{
  "url": "https://www.youtube.com/watch?v=jNQXAC9IVRw",
  "token": "your-token-here",
  "preset": "h265"
}
```

**Encoding preset** (optional, `preset` in body or query string):

| `preset` | Codec | Use it for |
| --- | --- | --- |
| `h264` (default) | H.264/AVC + AAC | Maximum compatibility — every browser, Android/Windows, TVs |
| `h265` / `hevc` | HEVC + AAC (tagged `hvc1`) | Smaller files at higher quality when sharing **only between Apple platforms** (Safari, iOS, macOS, visionOS) |

Encoding uses hardware **VideoToolbox** automatically when available (notably fast on Apple Silicon, where H.264 is encoded at higher quality); otherwise it falls back to fast software settings so downloads don't drag. The saved file is named after the video's title (browsers like Safari save it with the real name instead of `video.mp4`).

**Response:**
```json
{
  "jobId": "uuid-here",
  "status": "pending",
  "statusUrl": "/api/jobs/uuid-here"
}
```

#### 2. Check Job Status

```bash
GET /api/jobs/:jobId
X-Auth-Token: your-token-here
```

Or with token in query:

```bash
GET /api/jobs/:jobId?token=your-token-here
```

**Response (in progress):**
```json
{
  "id": "uuid-here",
  "url": "https://...",
  "status": "downloading",
  "progress": 45.5,
  "createdAt": 1234567890
}
```

**Response (completed):**
```json
{
  "id": "uuid-here",
  "url": "https://...",
  "status": "completed",
  "progress": 100,
  "downloadUrl": "/download/download-uuid",
  "downloadId": "download-uuid",
  "expiresAt": 1234567890,
  "completedAt": 1234567890,
  "createdAt": 1234567890
}
```

#### 3. Wait for Completion (iOS Shortcuts)

```bash
GET /api/jobs/:jobId/wait?token=your-token-here
```

Or with header:

```bash
GET /api/jobs/:jobId/wait
X-Auth-Token: your-token-here
```

This endpoint polls until the job completes (up to 5 minutes) and returns the result. Perfect for iOS Shortcuts to avoid timeout issues.

**Response:**
```json
{
  "id": "uuid-here",
  "url": "https://...",
  "status": "completed",
  "downloadUrl": "http://server.com/download/download-uuid",
  "downloadId": "download-uuid",
  "expiresAt": 1234567890,
  "completedAt": 1234567890
}
```

#### 4. Download Video

```bash
GET /download/:downloadId?token=your-token-here
```

Returns the MP4 video file. Links expire after 24 hours.

**Note:** When authentication is enabled, the token must be included in the download URL.

#### 5. Stream Video (direct playback)

```bash
GET /stream?url=<page-url>&token=your-token-here[&height=1080][&preset=h264]
```

Resolves the URL with yt-dlp, muxes the best track matching the `preset` (up to `height`, default 1080p) into a **seekable faststart MP4**, and serves it with HTTP **Range** support. Unlike `/download` (job-based, returns a link), this endpoint is meant to be played directly — hand the URL straight to a player.

- `height` (optional) — max video height, default `1080`, capped at `2160`.
- `preset` (optional) — `h264` (default, maximum compatibility) or `h265`/`hevc` (smaller/higher quality, Apple platforms only). Same presets as `/download` (see above).
- **Source quality is preserved when possible:** if the source already uses the requested codec it is stream-copied (no re-encode, source quality) with `+faststart`; otherwise it's transcoded to the preset. Transcodes use hardware **VideoToolbox** when available, and realtime-biased software settings otherwise, so the stream stays close to live.
- The muxed file is **cached by video id + height + preset**: the first request for a variant pays the conversion cost, subsequent requests (and the many Range requests a player makes during playback) are served instantly from disk. Idle cache files are evicted after 24h.
- H.264/HEVC + AAC is preferred so the stream is decodable by Apple's native `AVPlayer` (VP9/AV1/Opus would break native playback and, in Spatial Stash, disable pseudo-3D).

**Why Range support matters:** `AVPlayer` treats a non-seekable stream as unscrubable, which disables Spatial Stash's pseudo-3D pipeline (it seeks to engage). Serving a real file with `Accept-Ranges: bytes` keeps the source fully seekable.

```bash
# Example
curl -D - -o out.mp4 \
  "http://localhost:3000/stream?url=https://youtu.be/dQw4w9WgXcQ&height=1080&token=your-token"
# → HTTP/1.1 206 Partial Content ... Accept-Ranges: bytes
```

## Spatial Stash (Vision Pro) handoff

[Spatial Stash](https://github.com/illixion/spatialstash) can play these streams in 3D. Enable **Settings → Developer → Web yt-dlp Support** in the app and enter this server's endpoint URL and token. Then hand a web page (e.g. a YouTube watch page) to the app from Safari by opening:

```
spatialstash://play?url=<percent-encoded page URL>
```

**Recommended: a Shortcut.** Get shortcut here: <https://www.icloud.com/shortcuts/f81f9f677ef149cb8096e9a39857b0a6>

Manual process: create a Shortcut "Watch in Spatial Stash" that takes the Safari page URL as input (share-sheet or "Current Safari page"), URL-encodes it, and opens `spatialstash://play?url=…`. Run it from the Share sheet on any page.

**Alternative: a bookmarklet.** Save a bookmark whose URL is:

```javascript
javascript:location.href='spatialstash://play?url='+encodeURIComponent(location.href)
```

Tap it while viewing a video page to hand it off. (Direct stream links — a plain `.mp4`/`.m3u8` — can be opened the same way and play without this server.)

## iOS Shortcuts Setup

Get the pre-made shortcut here: <https://www.icloud.com/shortcuts/e106385960a34deeaa1dd7e1757f49f8>

### Simple Download Shortcut

1. **Set Variables** - Set your auth token (if authentication is enabled)
   - Name: `authToken`
   - Value: `your-token-here`

2. **Get URL** - From Share Sheet or Clipboard

3. **Make POST request** to `http://your-server:3000/api/jobs`
   - Method: POST
   - Headers: 
     - `Content-Type: application/json`
     - `X-Auth-Token: [authToken variable]` (if auth is enabled)
   - Body: `{"url": "[URL from step 2]"}`

4. **Get jobId** from response (use "Get Dictionary Value" for key "jobId")

5. **Make GET request** to `http://your-server:3000/api/jobs/[jobId]/wait?token=[authToken]`
   - **Important:** Include token in URL for compatibility with Safari
   - Or use header: `X-Auth-Token: [authToken variable]`

6. **Get downloadUrl** from response

7. **Download file** from downloadUrl
   - **Important:** Append `?token=[authToken]` to the download URL if auth is enabled

8. **Save to Photos** or Files app

### Example Shortcuts Configuration

**POST Request (Create Job):**
```
URL: http://192.168.1.100:3000/api/jobs
Method: POST
Headers: 
  Content-Type: application/json
  X-Auth-Token: your-token-here
Request Body: JSON
  {
    "url": "[Share Sheet Input]"
  }
```

**Alternative POST Request (Token in Body):**
```
URL: http://192.168.1.100:3000/api/jobs
Method: POST
Headers: 
  Content-Type: application/json
Request Body: JSON
  {
    "url": "[Share Sheet Input]",
    "token": "your-token-here"
  }
```

**GET Request (Wait for Completion):**
```
URL: http://192.168.1.100:3000/api/jobs/[jobId from previous step]/wait?token=your-token-here
Method: GET
```

**Download Video:**
```
URL: [downloadUrl from previous step]?token=your-token-here
Method: GET
```

### Safari Compatibility

When using the download link in Safari or saving to Photos, **always use the query parameter method** for authentication:

```
?token=your-token-here
```

This ensures the token is properly passed through redirects and download managers.

## Video Format

All videos are converted to iOS-compatible MP4 with the following settings:

- **Video Codec:** H.264 (libx264)
- **Video Preset:** veryfast
- **Video Quality:** CRF 20
- **Audio Codec:** AAC
- **Audio Bitrate:** 128k
- **Format:** MP4 with faststart flag for streaming

These settings ensure:
- ✅ Compatible with iOS Photos app
- ✅ Compatible with iOS Safari/browser playback
- ✅ Fast seeking and streaming
- ✅ Good balance between quality and file size

## Testing

Run the test suite:

```bash
npm test
```

The tests use `https://www.youtube.com/watch?v=jNQXAC9IVRw` as the test video and verify:
- API endpoints functionality
- Job creation and status tracking
- Full download workflow
- iOS Shortcuts `/wait` endpoint
- Download link generation and expiration

## Production Deployment

### Using systemd (Recommended for Debian)

1. Create a systemd service file:

```bash
sudo nano /etc/systemd/system/yt-dlp-web.service
```

2. Add the following content:

```ini
[Unit]
Description=yt-dlp Web Frontend
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/path/to/web-yt-dlp
Environment=NODE_ENV=production
Environment=PORT=3000
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

3. Enable and start the service:

```bash
sudo systemctl enable yt-dlp-web
sudo systemctl start yt-dlp-web
sudo systemctl status yt-dlp-web
```

### Using PM2

```bash
# Install PM2
npm install -g pm2

# Start the server
pm2 start src/server.js --name yt-dlp-web

# Save PM2 configuration
pm2 save

# Setup PM2 to start on boot
pm2 startup
```

### Nginx Reverse Proxy

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        
        # Increase timeouts for video downloads
        proxy_connect_timeout 600;
        proxy_send_timeout 600;
        proxy_read_timeout 600;
        send_timeout 600;
    }
}
```

## Supported Sites

This server supports all sites that yt-dlp supports, including:

- YouTube
- Instagram
- TikTok
- Twitter/X
- Facebook
- Vimeo
- Dailymotion
- Reddit
- Twitch
- And 1000+ more!

See the [yt-dlp supported sites list](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md) for a complete list.

## Security Considerations

- **Authentication** - Static token authentication protects your server from unauthorized access
- **Token Storage** - Never commit `auth_token` file to version control (add to `.gitignore`)
- **Token Security** - Use a strong random token (32+ bytes recommended)
- **HTTPS Required** - Always use HTTPS in production to protect tokens in transit
- **Download Expiration** - Download links expire after 24 hours
- **Temp Storage** - Files are stored in system temp directory with automatic cleanup
- **Rate Limiting** - Consider adding rate limiting middleware in production
- **Network Security** - Use firewall rules to restrict access if needed

### Generating Secure Tokens

```bash
# Strong 32-byte token (recommended)
openssl rand -hex 32

# Alternative: 64-byte token
openssl rand -hex 64

# UUID-based token
uuidgen | tr '[:upper:]' '[:lower:]'
```

## Troubleshooting

### yt-dlp not found

Make sure yt-dlp is installed and in your PATH:

```bash
which yt-dlp
yt-dlp --version
```

### ffmpeg not found

Install ffmpeg:

```bash
sudo apt install ffmpeg
ffmpeg -version
```

### Permission errors

Ensure the Node.js process has write access to the temp directory:

```bash
ls -la /tmp
```

### Download fails

Check the server logs for detailed error messages. Common issues:
- URL not supported by yt-dlp
- Video is private or geo-restricted
- Network connectivity issues

## License

MIT

## Contributing

Pull requests are welcome! Please ensure tests pass before submitting.
