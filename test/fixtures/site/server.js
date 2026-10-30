import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function createBmpBuffer(width = 1200, height = 800) {
  const imageSize = width * height * 4;
  const fileSize = 54 + imageSize;
  const buf = Buffer.alloc(fileSize, 0x88);
  buf.write('BM', 0);
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(32, 28);
  buf.writeUInt32LE(0, 30);
  buf.writeUInt32LE(imageSize, 34);
  return buf;
}

// 3.84 MB valid BMP image buffer (exceeds default 3 MB budget)
const HEAVY_BUFFER = createBmpBuffer(1200, 800);

/**
 * Creates and configures the Express application for the test fixture site.
 */
export function createFixtureApp() {
  const app = express();

  // Disable etag and caching for consistent deterministic tests
  app.set('etag', false);
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    next();
  });

  // 1. Timeout route: deliberately hangs past TestFlow timeout to test page-load failure handling
  app.get('/page-timeout.html', (req, res) => {
    // Deliberately hold request open; do not respond
    // Playwright/TestFlow page.goto will time out
  });

  // 2. Heavy asset route: delivers 3.84 MB binary BMP image asset
  app.get(['/heavy-image.bmp', '/heavy-asset.bin'], (req, res) => {
    res.set('Content-Type', 'image/bmp');
    res.set('Content-Length', String(HEAVY_BUFFER.length));
    res.send(HEAVY_BUFFER);
  });

  // 3. API Route 4: ALWAYS returns 400 regardless of auth / session
  // TestFlow must NOT bucket this as SUSPECTED/unauthenticated — it is a confirmed bug
  app.get('/api/always-400', (req, res) => {
    res.status(400).json({
      error: 'Bad Request',
      code: 'ALWAYS_BROKEN',
      description: 'This endpoint is genuinely broken on both public and authenticated calls',
    });
  });

  // 4. API Route 5: returns 400 WITHOUT session cookie, 200 WITH one
  // TestFlow categorization logic must identify this specific pattern as SUSPECTED / unauthenticated
  app.get('/api/needs-session', (req, res) => {
    const cookieHeader = req.headers.cookie || '';
    const authHeader = req.headers.authorization || '';

    const hasSession = cookieHeader.includes('session=') || authHeader.length > 0;

    if (hasSession) {
      res.status(200).json({
        status: 'ok',
        authenticated: true,
        user: 'test_session_user',
      });
    } else {
      res.status(400).json({
        error: 'Missing session cookie or authentication token',
        authenticated: false,
        hint: 'Expected cookie session=<token>',
      });
    }
  });

  // 5. Healthy API route: returns 200 JSON
  app.get('/api/users', (req, res) => {
    res.status(200).json([
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' },
    ]);
  });

  // Serve static fixture pages
  app.use(express.static(__dirname));

  return app;
}

/**
 * Start fixture server on localhost (127.0.0.1).
 *
 * @param {number} [port=0] - Port to listen on (0 for random ephemeral port)
 * @returns {Promise<{ server: import('node:http').Server, port: number, url: string, close: () => Promise<void> }>}
 */
export function startFixtureServer(port = 0) {
  return new Promise((resolve, reject) => {
    const app = createFixtureApp();
    const server = app.listen(port, '127.0.0.1', () => {
      const actualPort = server.address().port;
      const url = `http://127.0.0.1:${actualPort}`;
      resolve({
        server,
        port: actualPort,
        url,
        close: () => new Promise((res, rej) => {
          server.close((err) => (err ? rej(err) : res()));
        }),
      });
    });
    server.on('error', reject);
  });
}

// CLI direct execution support (`npm run fixture:serve`)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cliPort = parseInt(process.env.FIXTURE_PORT || '3333', 10);
  startFixtureServer(cliPort).then(({ url }) => {
    console.log(`TestFlow Fixture Server listening at ${url}`);
    console.log(`Press Ctrl+C to terminate.`);
  }).catch((err) => {
    console.error(`Failed to start fixture server:`, err);
    process.exit(1);
  });
}
