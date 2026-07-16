import express from 'express';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import os from 'os';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// Load authentication token
let AUTH_TOKEN = process.env.AUTH_TOKEN;

if (!AUTH_TOKEN) {
  try {
    const tokenPath = path.join(path.dirname(__dirname), 'auth_token');
    AUTH_TOKEN = (await fs.readFile(tokenPath, 'utf8')).trim();
    console.log('✅ Loaded auth token from auth_token file');
  } catch (err) {
    console.warn('⚠️  No AUTH_TOKEN environment variable or auth_token file found. Authentication is disabled.');
  }
}

const AUTH_ENABLED = !!AUTH_TOKEN;

if (AUTH_ENABLED) {
  console.log('🔒 Authentication is ENABLED');
} else {
  console.log('⚠️  Authentication is DISABLED');
}

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Authentication middleware
function authenticateRequest(req, res, next) {
  if (!AUTH_ENABLED) {
    return next();
  }

  // Check Authorization header (Bearer token)
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    if (token === AUTH_TOKEN) {
      return next();
    }
  }

  // Check X-Auth-Token header
  const xAuthToken = req.headers['x-auth-token'];
  if (xAuthToken === AUTH_TOKEN) {
    return next();
  }

  // Check token in request body (for POST requests)
  if (req.body && req.body.token === AUTH_TOKEN) {
    return next();
  }

  // Check token in query parameters (for GET requests and downloads)
  if (req.query.token === AUTH_TOKEN) {
    return next();
  }

  return res.status(401).json({ error: 'Unauthorized: Invalid or missing authentication token' });
}

// In-memory job storage (use Redis in production)
const jobs = new Map();
const downloads = new Map();

// --- /stream: cached, Range-served muxed files for direct playback ---------
// The Spatial Stash visionOS app plays these URLs directly in AVPlayer, and its
// pseudo-3D pipeline requires a SEEKABLE source. A live yt-dlp|ffmpeg pipe is
// non-seekable (AVPlayer rejects it as a stream), so instead we mux to a
// faststart MP4 on disk once, cache it by video id, and serve it with HTTP
// Range support. First request for a video pays the conversion cost; repeats
// are instant. Concurrent requests for the same video share one conversion.
const STREAM_CACHE_DIR = process.env.STREAM_CACHE_DIR
  || path.join(os.tmpdir(), 'yt-dlp-stream-cache');
const streamCache = new Map();     // key -> { filePath, size, lastAccess }
const streamInFlight = new Map();  // key -> Promise<string filePath>
const urlIdCache = new Map();      // url -> resolved video id (memoized: AVPlayer
                                   // issues many Range requests per video, and
                                   // each must not re-spawn a yt-dlp metadata call)
const STREAM_TTL_MS = 24 * 60 * 60 * 1000; // evict files unwatched for 24h

// Cleanup task - runs every hour
setInterval(() => {
  const now = Date.now();
  const expiredDownloads = [];
  
  for (const [id, download] of downloads.entries()) {
    if (now > download.expiresAt) {
      expiredDownloads.push(id);
    }
  }
  
  expiredDownloads.forEach(async (id) => {
    const download = downloads.get(id);
    if (download && download.filePath) {
      try {
        await fs.unlink(download.filePath);
        console.log(`Deleted expired file: ${download.filePath}`);
      } catch (err) {
        console.error(`Failed to delete expired file: ${err.message}`);
      }
    }
    downloads.delete(id);
  });
  
  if (expiredDownloads.length > 0) {
    console.log(`Cleaned up ${expiredDownloads.length} expired downloads`);
  }
}, 60 * 60 * 1000); // Every hour

// Cleanup task for the /stream cache - evict files not watched within the TTL
setInterval(async () => {
  const now = Date.now();
  for (const [key, entry] of streamCache.entries()) {
    if (now - entry.lastAccess <= STREAM_TTL_MS) continue;
    streamCache.delete(key);
    try {
      await fs.unlink(entry.filePath);
      console.log(`Evicted idle stream cache: ${entry.filePath}`);
    } catch (err) {
      // Already gone — fine.
    }
  }
}, 60 * 60 * 1000); // Every hour

// Auto-update yt-dlp - runs daily
setInterval(() => {
  console.log('Checking for yt-dlp updates...');
  const update = spawn('yt-dlp', ['-U']);
  
  update.stdout.on('data', (data) => {
    console.log(`[yt-dlp update] ${data.toString().trim()}`);
  });
  
  update.stderr.on('data', (data) => {
    console.error(`[yt-dlp update] ${data.toString().trim()}`);
  });
  
  update.on('close', (code) => {
    if (code === 0) {
      console.log('yt-dlp update check completed');
    } else {
      console.log(`yt-dlp update check exited with code ${code}`);
    }
  });
}, 24 * 60 * 60 * 1000); // Every 24 hours

// Run update check on startup if enabled
if (process.env.AUTO_UPDATE_YTDLP !== 'false') {
  console.log('Running initial yt-dlp update check...');
  spawn('yt-dlp', ['-U']).on('close', () => {
    console.log('Initial yt-dlp update check completed');
  });
}

// --- Encoding presets ------------------------------------------------------
// Selected via the `preset` query/body param on downloads and /stream.
//   h264 (default) — AVC/H.264 + AAC. Maximum compatibility: every browser,
//                    older Android/Windows devices, TVs, etc.
//   h265 / hevc    — HEVC + AAC, tagged `hvc1` so Apple platforms accept it.
//                    Smaller files at higher quality, but only plays reliably
//                    on Apple gear (Safari, iOS, macOS, visionOS).
function resolvePreset(name) {
  const p = (name || '').toString().trim().toLowerCase();
  if (p === 'h265' || p === 'hevc') {
    return {
      name: 'h265',
      // Preferred source video codecs (yt-dlp -f vcodec regex).
      srcCodecRe: '^(hev1|hvc1|h265|hevc)',
      // Codecs ffprobe reports that count as "already this preset" (copy, no re-encode).
      matchesCodec: (c) => /hevc|h265/i.test(c),
      // ffmpeg args when stream-copying — retag so Apple's decoder accepts it.
      copyArgs: ['-tag:v', 'hvc1'],
    };
  }
  return {
    name: 'h264',
    srcCodecRe: '^(avc1|h264)',
    matchesCodec: (c) => /avc|h264/i.test(c),
    copyArgs: [],
  };
}

// Detect hardware VideoToolbox encoders once (present on macOS, notably fast on
// Apple Silicon). Cached — the probe is one cheap ffmpeg call.
let _vtEncodersPromise = null;
function videoToolboxEncoders() {
  if (_vtEncodersPromise) return _vtEncodersPromise;
  _vtEncodersPromise = new Promise((resolve) => {
    const proc = spawn('ffmpeg', ['-hide_banner', '-encoders']);
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.on('close', () => {
      const vt = {
        h264: /\bh264_videotoolbox\b/.test(out),
        hevc: /\bhevc_videotoolbox\b/.test(out),
      };
      if (vt.h264 || vt.hevc) console.log(`🎬 VideoToolbox available: ${JSON.stringify(vt)}`);
      resolve(vt);
    });
    proc.on('error', () => resolve({ h264: false, hevc: false }));
  });
  return _vtEncodersPromise;
}

// Build ffmpeg video-encode args for a preset, given detected hardware support.
//   Hardware (VideoToolbox): very fast on M-series, so we run it at higher
//     quality. It has no x264/x265 -preset/-crf; -q:v is its constant-quality
//     knob (higher = better). H.264 gets a generous bump since it's so cheap.
//   Software: keep downloads brisk with the established fast settings; /stream
//     transcodes (`realtime`) bias even harder toward speed to stay near live.
function encodeArgsFor(preset, vt, { realtime } = {}) {
  if (preset.name === 'h265') {
    if (vt.hevc) {
      return ['-c:v', 'hevc_videotoolbox', '-q:v', '55', '-tag:v', 'hvc1', '-allow_sw', '1'];
    }
    return ['-c:v', 'libx265', '-preset', realtime ? 'ultrafast' : 'medium', '-crf', '24', '-tag:v', 'hvc1'];
  }
  if (vt.h264) {
    return ['-c:v', 'h264_videotoolbox', '-q:v', '65', '-allow_sw', '1'];
  }
  return ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23'];
}

// Helper function to run yt-dlp
async function downloadVideo(url, jobId, preset = resolvePreset()) {
  const job = jobs.get(jobId);
  if (!job) throw new Error('Job not found');

  job.status = 'downloading';
  job.progress = 0;

  // Create temp directory - use a writable location
  const tmpBase = process.env.TMP_DIR || path.join(os.tmpdir(), 'yt-dlp-workdir');
  await fs.mkdir(tmpBase, { recursive: true, mode: 0o777 }).catch(() => {});
  const tempDir = await fs.mkdtemp(path.join(tmpBase, 'job-'));
  // Name the file after the video title so Safari / browsers save it with a
  // meaningful name (the Content-Disposition below echoes this basename).
  const outputTemplate = path.join(tempDir, '%(title)s.%(ext)s');

  // Downloads favour quick turnaround (not realtime), using hardware encoding
  // when available and the fast software settings otherwise.
  const vt = await videoToolboxEncoders();
  const encodeArgs = encodeArgsFor(preset, vt, { realtime: false });

  return new Promise((resolve, reject) => {
    // iOS-compatible format selection with 1080p limit
    // Priority: Try to get pre-encoded MP4/H264/AAC that iOS can play natively
    // Fallback: If not available, download best quality and convert
    const formatSelector = [
      // First try: Best iOS-compatible format (MP4 container, H264 video, AAC/M4A audio) up to 1080p
      'bestvideo[ext=mp4][vcodec^=avc][height<=1080]+bestaudio[ext=m4a][acodec^=mp4a]',
      // Second try: Any MP4 video + M4A audio up to 1080p
      'bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]',
      // Third try: Best MP4 up to 1080p (pre-merged)
      'best[ext=mp4][height<=1080]',
      // Fourth try: Any video up to 1080p (will need conversion)
      'bestvideo[height<=1080]+bestaudio',
      // Final fallback: Best available
      'best'
    ].join('/');

    const ytDlpArgs = [
      url,
      '-o', outputTemplate,
      '--no-playlist',
      '--format', formatSelector,
      '--merge-output-format', 'mp4',
      // Convert to the requested preset (h264: fast+compatible, h265: smaller/
      // higher-quality for Apple platforms). Audio normalized to AAC; faststart
      // puts the moov atom up front so the result is progressively streamable.
      '--postprocessor-args', `ffmpeg:${encodeArgs.join(' ')} -c:a aac -b:a 128k -movflags +faststart -f mp4`,
      '--no-check-certificate',
      '--progress',
      '--newline'
    ];

    const ytDlp = spawn('yt-dlp', ytDlpArgs);

    let outputFile = null;

    ytDlp.stdout.on('data', (data) => {
      const output = data.toString();
      console.log(`[Job ${jobId}] ${output}`);

      // Parse progress
      const downloadMatch = output.match(/(\d+\.?\d*)%/);
      if (downloadMatch) {
        job.progress = parseFloat(downloadMatch[1]);
      }

      // Capture output filename
      const destMatch = output.match(/\[download\] Destination: (.+)/);
      if (destMatch) {
        outputFile = destMatch[1].trim();
      }

      const mergeMatch = output.match(/\[Merger\] Merging formats into "(.+)"/);
      if (mergeMatch) {
        outputFile = mergeMatch[1].trim();
      }
    });

    ytDlp.stderr.on('data', (data) => {
      const error = data.toString();
      console.error(`[Job ${jobId}] Error: ${error}`);
      job.error = error;
    });

    ytDlp.on('close', async (code) => {
      if (code === 0) {
        try {
          console.log(`[Job ${jobId}] Process completed, outputFile: ${outputFile}`);
          
          // Find the output file
          if (!outputFile) {
            const files = await fs.readdir(tempDir);
            const videoFiles = files.filter(f => f.endsWith('.mp4'));
            if (videoFiles.length > 0) {
              outputFile = path.join(tempDir, videoFiles[0]);
            }
          }

          // If outputFile doesn't have the temp directory prefix, add it
          if (outputFile && !path.isAbsolute(outputFile)) {
            outputFile = path.join(tempDir, outputFile);
          }

          console.log(`[Job ${jobId}] Checking file exists: ${outputFile}`);
          const exists = outputFile && await fileExists(outputFile);
          console.log(`[Job ${jobId}] File exists: ${exists}`);

          if (exists) {
            job.status = 'completed';
            job.progress = 100;
            job.completedAt = Date.now();

            // Store download info
            const downloadId = uuidv4();
            const expiresAt = Date.now() + (24 * 60 * 60 * 1000); // 24 hours

            downloads.set(downloadId, {
              id: downloadId,
              filePath: outputFile,
              originalUrl: url,
              createdAt: Date.now(),
              expiresAt: expiresAt
            });

            job.downloadId = downloadId;
            job.downloadUrl = `/download/${downloadId}`;
            job.expiresAt = expiresAt;

            resolve(job);
          } else {
            throw new Error('Output file not found after download');
          }
        } catch (err) {
          job.status = 'failed';
          job.error = err.message;
          reject(err);
        }
      } else {
        job.status = 'failed';
        job.error = job.error || `yt-dlp exited with code ${code}`;
        
        // Cleanup temp directory on failure
        try {
          await fs.rm(tempDir, { recursive: true, force: true });
        } catch (err) {
          console.error(`Failed to cleanup temp directory: ${err.message}`);
        }
        
        reject(new Error(job.error));
      }
    });
  });
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// Routes

// Home page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API: Create a download job
app.post('/api/jobs', authenticateRequest, async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  // `preset` may come from the body or the query string (h264 | h265).
  const preset = resolvePreset(req.body.preset ?? req.query.preset);

  const jobId = uuidv4();
  const job = {
    id: jobId,
    url: url,
    preset: preset.name,
    status: 'pending',
    progress: 0,
    createdAt: Date.now()
  };

  jobs.set(jobId, job);

  // Start download asynchronously
  downloadVideo(url, jobId, preset).catch(err => {
    console.error(`Job ${jobId} failed:`, err);
  });

  res.json({
    jobId: jobId,
    status: job.status,
    statusUrl: `/api/jobs/${jobId}`
  });
});

// API: Get job status
app.get('/api/jobs/:jobId', authenticateRequest, (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  const response = {
    id: job.id,
    url: job.url,
    status: job.status,
    progress: job.progress,
    createdAt: job.createdAt
  };

  if (job.status === 'completed') {
    response.downloadUrl = job.downloadUrl;
    response.downloadId = job.downloadId;
    response.expiresAt = job.expiresAt;
    response.completedAt = job.completedAt;
  } else if (job.status === 'failed') {
    response.error = job.error;
  }

  res.json(response);
});

// API: Wait for job completion (for iOS Shortcuts)
app.get('/api/jobs/:jobId/wait', authenticateRequest, async (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  // Poll until completion or timeout (5 minutes)
  const timeout = 5 * 60 * 1000; // 5 minutes
  const pollInterval = 1000; // 1 second
  const startTime = Date.now();

  const checkStatus = () => {
    return new Promise((resolve, reject) => {
      const interval = setInterval(() => {
        const currentJob = jobs.get(jobId);
        
        if (!currentJob) {
          clearInterval(interval);
          reject(new Error('Job not found'));
          return;
        }

        if (currentJob.status === 'completed' || currentJob.status === 'failed') {
          clearInterval(interval);
          resolve(currentJob);
          return;
        }

        if (Date.now() - startTime > timeout) {
          clearInterval(interval);
          reject(new Error('Timeout waiting for job completion'));
          return;
        }
      }, pollInterval);
    });
  };

  try {
    const completedJob = await checkStatus();
    
    const response = {
      id: completedJob.id,
      url: completedJob.url,
      status: completedJob.status,
      progress: completedJob.progress,
      createdAt: completedJob.createdAt
    };

    if (completedJob.status === 'completed') {
      response.downloadUrl = `https://${req.get('host')}${completedJob.downloadUrl}`;
      response.downloadId = completedJob.downloadId;
      response.expiresAt = completedJob.expiresAt;
      response.completedAt = completedJob.completedAt;
    } else if (completedJob.status === 'failed') {
      response.error = completedJob.error;
    }

    res.json(response);
  } catch (err) {
    res.status(408).json({ error: err.message });
  }
});

// Download endpoint
app.get('/download/:downloadId', authenticateRequest, async (req, res) => {
  const { downloadId } = req.params;
  const download = downloads.get(downloadId);

  if (!download) {
    return res.status(404).send('Download not found or expired');
  }

  if (Date.now() > download.expiresAt) {
    downloads.delete(downloadId);
    try {
      await fs.unlink(download.filePath);
    } catch (err) {
      console.error(`Failed to delete expired file: ${err.message}`);
    }
    return res.status(410).send('Download expired');
  }

  try {
    // Use the real video-title filename so Safari saves it with a meaningful
    // name instead of "video.mp4". Provide both an ASCII-sanitized `filename`
    // (RFC 2616 fallback) and a UTF-8 `filename*` (RFC 5987) for Unicode titles.
    const filename = path.basename(download.filePath);
    const asciiName = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '') || 'video.mp4';
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(filename)}`
    );
    
    const stat = await fs.stat(download.filePath);
    res.setHeader('Content-Length', stat.size);
    
    const fileStream = (await import('fs')).createReadStream(download.filePath);
    fileStream.pipe(res);
  } catch (err) {
    console.error(`Download error: ${err.message}`);
    res.status(500).send('Error downloading file');
  }
});

// --- /stream helpers -------------------------------------------------------

/// Sanitize a video id for safe use as a filename.
function sanitizeKey(s) {
  return s.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
}

/// Fallback identity when yt-dlp can't print an id.
function urlHashKey(url) {
  return 'u' + crypto.createHash('sha256').update(url).digest('hex').slice(0, 16);
}

/// Resolve a stable id for cache keying: the extractor's video id (e.g. the
/// YouTube id), or a hash of the URL as a fallback. Memoized per URL — a single
/// playback triggers many Range requests, and re-spawning yt-dlp per request
/// would stall playback. Metadata-only, fast on the first call.
function resolveVideoId(url) {
  if (urlIdCache.has(url)) return Promise.resolve(urlIdCache.get(url));
  return new Promise((resolve) => {
    const p = spawn('yt-dlp', ['--no-playlist', '--skip-download', '--print', '%(id)s', url]);
    let out = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.on('close', (code) => {
      const id = out.trim().split('\n').filter(Boolean).pop();
      const resolved = code === 0 && id ? sanitizeKey(id) : urlHashKey(url);
      urlIdCache.set(url, resolved);
      resolve(resolved);
    });
    p.on('error', () => {
      const fallback = urlHashKey(url);
      urlIdCache.set(url, fallback);
      resolve(fallback);
    });
  });
}

/// Probe the first video stream's codec name (e.g. "h264", "hevc"). Empty
/// string if ffprobe is unavailable or the file has no video stream.
function probeVideoCodec(filePath) {
  return new Promise((resolve) => {
    const p = spawn('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name',
      '-of', 'default=nw=1:nk=1', filePath,
    ]);
    let out = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.on('close', () => resolve(out.trim().split('\n')[0] || ''));
    p.on('error', () => resolve(''));
  });
}

/// Download the best track matching `preset` (up to `height`p) and mux to a
/// seekable faststart MP4 in the stream cache. If the source already uses the
/// preset's codec we stream-copy (source quality, no re-encode); otherwise we
/// transcode to the preset. Returns the cached file path. Concurrent callers
/// for the same key share one conversion.
async function ensureMuxedStream(url, height, key, preset = resolvePreset()) {
  const finalPath = path.join(STREAM_CACHE_DIR, `${key}.mp4`);

  const cached = streamCache.get(key);
  if (cached && await fileExists(cached.filePath)) {
    cached.lastAccess = Date.now();
    return cached.filePath;
  }
  // Disk cache survives restarts: adopt an existing file without reconverting.
  if (await fileExists(finalPath)) {
    const stat = await fs.stat(finalPath);
    streamCache.set(key, { filePath: finalPath, size: stat.size, lastAccess: Date.now() });
    return finalPath;
  }
  if (streamInFlight.has(key)) return streamInFlight.get(key);

  const promise = (async () => {
    await fs.mkdir(STREAM_CACHE_DIR, { recursive: true, mode: 0o777 }).catch(() => {});
    const dlTemplate = path.join(STREAM_CACHE_DIR, `${key}.dl-${uuidv4()}.%(ext)s`);

    // Prefer the preset's video codec + AAC audio: AVPlayer's native path
    // rejects VP9/AV1/Opus, which would disable pseudo-3D on the client. Fall
    // back progressively to any best track (transcoded below if needed).
    const fmt = [
      `bv*[height<=${height}][vcodec~='${preset.srcCodecRe}']+ba[acodec~='^(mp4a|aac)']`,
      `bv*[height<=${height}][vcodec~='${preset.srcCodecRe}']+ba`,
      `b[height<=${height}][vcodec~='${preset.srcCodecRe}']`,
      `bv*[height<=${height}]+ba`,
      `b[height<=${height}]`,
      `b`
    ].join('/');

    const dlArgs = [
      url,
      '-o', dlTemplate,
      '--no-playlist',
      '--format', fmt,
      '--merge-output-format', 'mp4',
      '--no-check-certificate',
      '--no-progress'
    ];
    await runProcess('yt-dlp', dlArgs);

    // Find the file yt-dlp produced (merge/single -> some .ext).
    const prefix = path.basename(dlTemplate).replace('.%(ext)s', '');
    const produced = (await fs.readdir(STREAM_CACHE_DIR))
      .find((f) => f.startsWith(prefix));
    if (!produced) throw new Error('yt-dlp produced no output file');
    const producedPath = path.join(STREAM_CACHE_DIR, produced);

    // Mux with the moov atom up front (+faststart) so playback and Range
    // seeking work immediately. If the source already matches the preset codec,
    // stream-copy for source quality (retagging as needed); otherwise transcode
    // to the requested preset so /stream can emit higher-quality h264/h265.
    try {
      const srcCodec = await probeVideoCodec(producedPath);
      // Copy path (source already the preset codec): keep video AND audio
      // untouched for source quality — the AAC-preferring format selector means
      // audio is almost always already AAC. Transcode path: encode both, using
      // hardware VideoToolbox when available and realtime-biased software
      // settings otherwise, so /stream stays close to live.
      const vt = await videoToolboxEncoders();
      const codecArgs = preset.matchesCodec(srcCodec)
        ? ['-c', 'copy', ...preset.copyArgs]
        : [...encodeArgsFor(preset, vt, { realtime: true }), '-c:a', 'aac', '-b:a', '160k'];
      await runProcess('ffmpeg', [
        '-y', '-i', producedPath,
        ...codecArgs,
        '-movflags', '+faststart',
        '-f', 'mp4', finalPath
      ]);
    } finally {
      await fs.unlink(producedPath).catch(() => {});
    }

    const stat = await fs.stat(finalPath);
    streamCache.set(key, { filePath: finalPath, size: stat.size, lastAccess: Date.now() });
    return finalPath;
  })();

  streamInFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    streamInFlight.delete(key);
  }
}

/// Spawn a process and resolve on exit code 0, else reject with stderr.
function runProcess(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => code === 0
      ? resolve()
      : reject(new Error(`${cmd} exited ${code}: ${err.trim().split('\n').slice(-3).join(' ')}`)));
  });
}

/// Serve a local file with HTTP Range support (206 Partial Content). Required
/// so AVPlayer treats the source as seekable (pseudo-3D depends on seeking).
async function serveFileWithRange(req, res, filePath) {
  const stat = await fs.stat(filePath);
  const total = stat.size;
  const { createReadStream } = await import('fs');

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', 'video/mp4');

  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : total - 1;
    if (isNaN(start) || start < 0) start = 0;
    if (isNaN(end) || end >= total) end = total - 1;
    if (start > end) {
      res.setHeader('Content-Range', `bytes */${total}`);
      return res.status(416).end();
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
    res.setHeader('Content-Length', end - start + 1);
    const stream = createReadStream(filePath, { start, end });
    stream.on('error', () => { if (!res.headersSent) res.status(500).end(); });
    req.on('close', () => stream.destroy());
    stream.pipe(res);
  } else {
    res.status(200);
    res.setHeader('Content-Length', total);
    const stream = createReadStream(filePath);
    stream.on('error', () => { if (!res.headersSent) res.status(500).end(); });
    req.on('close', () => stream.destroy());
    stream.pipe(res);
  }
}

// API: Direct playback stream (construct-and-play). The client plays
// {endpoint}/stream?url=<page>&token=<tok> directly; we resolve, mux to a
// seekable MP4 (cached), and serve it with Range.
app.get('/stream', authenticateRequest, async (req, res) => {
  const url = req.query.url;
  if (!url) {
    return res.status(400).json({ error: 'url query parameter is required' });
  }
  const requested = parseInt(req.query.height, 10);
  const height = Math.min(Number.isFinite(requested) ? requested : 1080, 2160);
  const preset = resolvePreset(req.query.preset);

  try {
    const id = await resolveVideoId(url);
    // Preset is part of the key so h264 and h265 variants cache separately.
    const key = `${id}_${height}_${preset.name}`;
    const filePath = await ensureMuxedStream(url, height, key, preset);
    await serveFileWithRange(req, res, filePath);
  } catch (err) {
    console.error(`[stream] ${err.message}`);
    if (!res.headersSent) {
      res.status(502).json({ error: `Failed to prepare stream: ${err.message}` });
    }
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: Date.now(),
    authEnabled: AUTH_ENABLED
  });
});

// Auth status endpoint
app.get('/api/auth/status', (req, res) => {
  res.json({ 
    authEnabled: AUTH_ENABLED,
    message: AUTH_ENABLED ? 'Authentication is required' : 'Authentication is disabled'
  });
});

// Start server
app.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
  console.log(`Node version: ${process.version}`);
  console.log(`Platform: ${process.platform}`);
});

export default app;
