# Authentication Guide

This document explains how to set up and use authentication with the yt-dlp web frontend.

## Overview

The server supports optional static token authentication. When enabled, all API endpoints and download links require a valid authentication token.

## Setup

### Option 1: Using auth_token File (Recommended)

1. Generate a secure random token:
   ```bash
   openssl rand -hex 32 > auth_token
   ```

2. The server will automatically load the token from the `auth_token` file on startup.

3. Keep this file secure and **never commit it to version control** (it's already in `.gitignore`).

### Option 2: Using Environment Variable

Set the `AUTH_TOKEN` environment variable:

```bash
export AUTH_TOKEN="your-secure-token-here"
npm start
```

Or in Docker:

```bash
docker run -e AUTH_TOKEN="your-token" -p 3000:3000 web-yt-dlp
```

### Disabling Authentication

If neither `auth_token` file nor `AUTH_TOKEN` environment variable exists, the server runs **without authentication**. This is not recommended for production deployments.

## Using Authentication

### Web Interface

When authentication is enabled:

1. Visit the web interface at `http://your-server:3000`
2. You'll see a "🔐 Authentication Token" field
3. Enter your token once - it's saved in browser localStorage
4. The token is automatically included in all requests

### API Requests

Include the token in one of these ways:

#### 1. Authorization Header (Most Secure)

```bash
curl -X POST http://localhost:3000/api/jobs \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-token-here" \
  -d '{"url": "https://www.youtube.com/watch?v=..."}'
```

#### 2. Custom Header

```bash
curl -X POST http://localhost:3000/api/jobs \
  -H "Content-Type: application/json" \
  -H "X-Auth-Token: your-token-here" \
  -d '{"url": "https://www.youtube.com/watch?v=..."}'
```

#### 3. Request Body (POST requests)

```bash
curl -X POST http://localhost:3000/api/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://www.youtube.com/watch?v=...",
    "token": "your-token-here"
  }'
```

#### 4. Query Parameter (GET requests and downloads)

```bash
# Check job status
curl "http://localhost:3000/api/jobs/job-id?token=your-token-here"

# Download video
curl "http://localhost:3000/download/download-id?token=your-token-here" -o video.mp4
```

### iOS Shortcuts

For iOS Shortcuts, you have two main approaches:

#### Method 1: Header Authentication (Recommended for API calls)

1. Add a "Text" action with your token
2. In "Get Contents of URL" actions, add header:
   - Key: `X-Auth-Token`
   - Value: [Token from step 1]

#### Method 2: Query Parameter (Required for Downloads)

For the `/wait` endpoint and especially for downloads, include the token in the URL:

```
http://your-server:3000/api/jobs/[jobId]/wait?token=your-token-here
```

**Important for Safari/Photos:** When downloading videos to save to Photos app, **always use the query parameter method** as Safari and iOS download managers may not preserve custom headers.

### Complete iOS Shortcut Example

1. **Text Action** - Store your token
   ```
   your-token-here
   ```

2. **Get URL** - From Share Sheet

3. **Get Contents of URL** - Create job
   ```
   URL: http://your-server:3000/api/jobs
   Method: POST
   Headers:
     Content-Type: application/json
     X-Auth-Token: [Token from step 1]
   Request Body: JSON
     {
       "url": "[URL from step 2]"
     }
   ```

4. **Get Dictionary Value** - Extract jobId
   ```
   Key: jobId
   ```

5. **Text Action** - Build wait URL
   ```
   http://your-server:3000/api/jobs/[jobId from step 4]/wait?token=[Token from step 1]
   ```

6. **Get Contents of URL** - Wait for completion
   ```
   URL: [URL from step 5]
   Method: GET
   ```

7. **Get Dictionary Value** - Extract download URL
   ```
   Key: downloadUrl
   ```

8. **Text Action** - Build download URL with token
   ```
   [downloadUrl from step 7]?token=[Token from step 1]
   ```

9. **Get Contents of URL** - Download video
   ```
   URL: [URL from step 8]
   Method: GET
   ```

10. **Save to Photo Album** or **Save File**

## Security Best Practices

### Token Generation

Always use cryptographically secure random tokens:

```bash
# 32-byte hex token (64 characters) - Recommended
openssl rand -hex 32

# 64-byte hex token (128 characters) - Extra secure
openssl rand -hex 64

# UUID-based token (simpler but less secure)
uuidgen | tr '[:upper:]' '[:lower:]'
```

### Token Storage

- ✅ Store in `auth_token` file with restricted permissions
- ✅ Store in environment variable on the server
- ✅ Store in iOS Shortcuts as a variable (it's encrypted)
- ✅ Store in browser localStorage (over HTTPS)
- ❌ Never commit to version control
- ❌ Never share publicly
- ❌ Never embed in client-side code that's publicly accessible

### Transport Security

- **Always use HTTPS in production** to prevent token interception
- If using HTTP (development only), be aware tokens are sent in plaintext
- Consider using a VPN or SSH tunnel for additional security

### Token Rotation

To rotate your token:

1. Generate a new token:
   ```bash
   openssl rand -hex 32 > auth_token
   ```

2. Restart the server:
   ```bash
   # Direct Node.js
   npm start
   
   # Docker
   docker-compose restart
   
   # systemd
   sudo systemctl restart yt-dlp-web
   ```

3. Update all clients (iOS Shortcuts, scripts, etc.) with the new token

## Docker Deployment

### Using auth_token File

Build the Docker image with the auth_token file included:

```bash
# Ensure auth_token file exists
openssl rand -hex 32 > auth_token

# Build and run
docker-compose up -d
```

The Dockerfile copies the `auth_token` file automatically.

### Using Environment Variable

Edit `docker-compose.yml`:

```yaml
services:
  web-yt-dlp:
    environment:
      - AUTH_TOKEN=your-secure-token-here
```

Or use Docker CLI:

```bash
docker run -e AUTH_TOKEN="your-token" -p 3000:3000 web-yt-dlp
```

### Using Docker Secrets (Most Secure)

For production Docker Swarm deployments:

```bash
# Create a secret
echo "your-token" | docker secret create ytdlp_auth_token -

# Update docker-compose.yml
services:
  web-yt-dlp:
    secrets:
      - ytdlp_auth_token
    environment:
      - AUTH_TOKEN_FILE=/run/secrets/ytdlp_auth_token

secrets:
  ytdlp_auth_token:
    external: true
```

## Troubleshooting

### Server Says "Authentication is disabled"

The server couldn't find an auth token. Check:

1. Does `auth_token` file exist in the project root?
2. Is `AUTH_TOKEN` environment variable set?
3. Check file permissions: `ls -la auth_token`

### "Unauthorized" Errors

Common causes:

1. **Wrong token** - Verify your token matches the server's token exactly
2. **Whitespace** - Ensure no extra spaces or newlines in token
3. **Token in wrong place** - Try different authentication methods
4. **Headers not sent** - Some tools/shortcuts may strip headers

### iOS Shortcut Downloads Fail

If the video downloads but then fails:

1. Ensure token is in the download URL as a query parameter
2. Use: `?token=your-token` not headers
3. Check that the download URL includes the token

### Testing Authentication

Check if authentication is enabled:

```bash
curl http://localhost:3000/api/auth/status
```

Response:
```json
{
  "authEnabled": true,
  "message": "Authentication is required"
}
```

Test with a request:

```bash
# Should fail without token
curl -X POST http://localhost:3000/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.youtube.com/watch?v=jNQXAC9IVRw"}'

# Should succeed with token
curl -X POST http://localhost:3000/api/jobs \
  -H "Content-Type: application/json" \
  -H "X-Auth-Token: your-token-here" \
  -d '{"url": "https://www.youtube.com/watch?v=jNQXAC9IVRw"}'
```

## API Reference

### Check Authentication Status

```
GET /api/auth/status
```

Returns:
```json
{
  "authEnabled": true,
  "message": "Authentication is required"
}
```

No authentication required for this endpoint.

### Health Check

```
GET /health
```

Returns:
```json
{
  "status": "ok",
  "timestamp": 1234567890,
  "authEnabled": true
}
```

No authentication required for this endpoint.
