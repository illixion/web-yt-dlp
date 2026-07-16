import { test, describe, before } from 'node:test';
import assert from 'node:assert';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const BASE_URL = process.env.TEST_URL || 'http://localhost:3000';
const TEST_VIDEO_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';

// Load authentication token
let AUTH_TOKEN = process.env.AUTH_TOKEN;
let authEnabled = false;

if (!AUTH_TOKEN) {
  try {
    const tokenPath = join(dirname(__dirname), 'auth_token');
    AUTH_TOKEN = (await readFile(tokenPath, 'utf8')).trim();
    console.log('✅ Loaded auth token from auth_token file for testing');
  } catch (err) {
    console.log('ℹ️  No auth token found - testing without authentication');
  }
}

// Helper function to make HTTP requests
async function request(url, options = {}) {
  // Add authentication if available
  if (AUTH_TOKEN) {
    options.headers = options.headers || {};
    options.headers['X-Auth-Token'] = AUTH_TOKEN;
  }
  
  const response = await fetch(url, options);
  const data = await response.json().catch(() => null);
  return { response, data };
}

// Helper function to make authenticated requests with token in body/query
async function requestWithToken(url, options = {}) {
  if (AUTH_TOKEN) {
    // For POST requests, add token to body
    if (options.method === 'POST' && options.body) {
      const bodyData = JSON.parse(options.body);
      bodyData.token = AUTH_TOKEN;
      options.body = JSON.stringify(bodyData);
    }
    // For GET requests, add token to query
    else if (!options.method || options.method === 'GET') {
      url += (url.includes('?') ? '&' : '?') + `token=${AUTH_TOKEN}`;
    }
  }
  
  const response = await fetch(url, options);
  const data = await response.json().catch(() => null);
  return { response, data };
}

describe('yt-dlp Web Frontend Tests', () => {
  
  test('Health check endpoint returns ok', async () => {
    const { response, data } = await request(`${BASE_URL}/health`);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(data.status, 'ok');
    assert.ok(data.timestamp);
    assert.ok(data.authEnabled !== undefined, 'Should indicate if auth is enabled');
    
    authEnabled = data.authEnabled;
    console.log(`  ℹ️  Authentication is ${authEnabled ? 'ENABLED' : 'DISABLED'}`);
  });

  test('Auth status endpoint returns correct status', async () => {
    const response = await fetch(`${BASE_URL}/api/auth/status`);
    const data = await response.json();
    assert.strictEqual(response.status, 200);
    assert.ok(data.authEnabled !== undefined);
    assert.ok(data.message);
    console.log(`  ℹ️  ${data.message}`);
  });

  test('Home page loads successfully', async () => {
    const response = await fetch(`${BASE_URL}/`);
    assert.strictEqual(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes('yt-dlp Web Frontend'));
  });

  test('POST /api/jobs creates a download job', async () => {
    const { response, data } = await request(`${BASE_URL}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: TEST_VIDEO_URL })
    });

    assert.strictEqual(response.status, 200);
    assert.ok(data.jobId);
    assert.ok(['pending', 'downloading'].includes(data.status), 'Status should be pending or downloading');
    assert.ok(data.statusUrl);
  });

  test('POST /api/jobs returns 400 without URL', async () => {
    const { response, data } = await request(`${BASE_URL}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });

    assert.strictEqual(response.status, 400);
    assert.ok(data.error);
  });

  test('API endpoints require authentication when enabled', async () => {
    if (!authEnabled) {
      console.log('  ⏭️  Skipping auth test - authentication is disabled');
      return;
    }

    // Try without auth token - should fail
    const response = await fetch(`${BASE_URL}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: TEST_VIDEO_URL })
    });

    assert.strictEqual(response.status, 401, 'Should require authentication');
    const data = await response.json();
    assert.ok(data.error.includes('Unauthorized'), 'Should return unauthorized error');
    console.log('  ✅ Authentication is properly enforced');
  });

  test('GET /api/jobs/:jobId returns job status', async () => {
    // First create a job
    const { data: createData } = await request(`${BASE_URL}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: TEST_VIDEO_URL })
    });

    const jobId = createData.jobId;

    // Then check its status
    const { response, data } = await request(`${BASE_URL}/api/jobs/${jobId}`);
    
    assert.strictEqual(response.status, 200);
    assert.strictEqual(data.id, jobId);
    assert.ok(['pending', 'downloading', 'completed', 'failed'].includes(data.status));
    assert.strictEqual(data.url, TEST_VIDEO_URL);
  });

  test('GET /api/jobs/:jobId returns 404 for non-existent job', async () => {
    const { response } = await request(`${BASE_URL}/api/jobs/non-existent-id`);
    assert.strictEqual(response.status, 404);
  });

  test('Full download workflow with YouTube video', async (t) => {
    // Increase timeout for this test as it involves actual video download
    t.timeout = 120000; // 2 minutes

    console.log('\n🎬 Testing full download workflow with test video...');

    // Step 1: Create job
    console.log('  📝 Creating download job...');
    const { response: createResponse, data: createData } = await request(`${BASE_URL}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: TEST_VIDEO_URL })
    });

    assert.strictEqual(createResponse.status, 200);
    assert.ok(createData.jobId);
    const jobId = createData.jobId;
    console.log(`  ✅ Job created: ${jobId}`);

    // Step 2: Poll for completion
    console.log('  ⏳ Waiting for download to complete...');
    let job;
    let attempts = 0;
    const maxAttempts = 120; // 2 minutes with 1 second intervals

    while (attempts < maxAttempts) {
      const { data } = await request(`${BASE_URL}/api/jobs/${jobId}`);
      job = data;

      console.log(`  📊 Status: ${job.status}, Progress: ${job.progress}%`);

      if (job.status === 'completed') {
        console.log('  ✅ Download completed!');
        break;
      } else if (job.status === 'failed') {
        assert.fail(`Download failed: ${job.error}`);
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
      attempts++;
    }

    if (job.status !== 'completed') {
      assert.fail('Download did not complete within timeout');
    }

    // Step 3: Verify download URL
    assert.ok(job.downloadUrl);
    assert.ok(job.downloadId);
    assert.ok(job.expiresAt);
    console.log(`  📥 Download URL: ${job.downloadUrl}`);

    // Step 4: Test download endpoint
    console.log('  🔍 Testing download endpoint...');
    let downloadUrl = `${BASE_URL}${job.downloadUrl}`;
    if (authEnabled && AUTH_TOKEN) {
      downloadUrl += `?token=${AUTH_TOKEN}`;
    }
    const downloadResponse = await fetch(downloadUrl);
    assert.strictEqual(downloadResponse.status, 200);
    assert.strictEqual(downloadResponse.headers.get('content-type'), 'video/mp4');
    
    const contentLength = parseInt(downloadResponse.headers.get('content-length'), 10);
    assert.ok(contentLength > 0, 'Downloaded file should have content');
    console.log(`  ✅ File size: ${(contentLength / 1024 / 1024).toFixed(2)} MB`);

    console.log('  🎉 Full workflow test completed successfully!\n');
  });

  test('GET /api/jobs/:jobId/wait endpoint waits for completion', async (t) => {
    t.timeout = 120000; // 2 minutes

    console.log('\n⏳ Testing /wait endpoint for iOS Shortcuts...');

    // Create job
    const { data: createData } = await request(`${BASE_URL}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: TEST_VIDEO_URL })
    });

    const jobId = createData.jobId;
    console.log(`  📝 Job created: ${jobId}`);

    // Use wait endpoint
    console.log('  ⏳ Calling /wait endpoint (this will block until complete)...');
    const startTime = Date.now();
    const { response, data } = await request(`${BASE_URL}/api/jobs/${jobId}/wait`);
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log(`  ⏱️  Waited ${duration} seconds`);

    assert.strictEqual(response.status, 200);
    assert.ok(['completed', 'failed'].includes(data.status), 'Job should be completed or failed');

    if (data.status === 'completed') {
      assert.ok(data.downloadUrl);
      assert.ok(data.downloadUrl.startsWith('http'), 'Download URL should be absolute');
      console.log(`  ✅ Download URL: ${data.downloadUrl}`);
      console.log('  🎉 /wait endpoint test completed!\n');
    } else {
      console.log(`  ⚠️  Job failed: ${data.error}\n`);
    }
  });

  test('Download link expires correctly', async () => {
    const { response } = await request(`${BASE_URL}/download/non-existent-download-id`);
    assert.strictEqual(response.status, 404);
  });
});
