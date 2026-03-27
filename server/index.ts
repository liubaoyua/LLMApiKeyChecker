import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
// Parse raw body for proxying
app.use(express.raw({ type: '*/*', limit: '10mb' }));

function getHeaderValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join(',') : value ?? '';
}

app.get('/healthz', (_req, res) => {
  res.json({
    status: 'ok',
    port: Number(PORT),
    mode: process.env.NODE_ENV || 'development',
  });
});

// Proxy Route
app.all('/__proxy', async (req, res) => {
  const targetUrl = req.query.url as string;

  if (!targetUrl) {
    return res.status(400).json({ error: 'Missing "url" query parameter.' });
  }

  let upstreamUrl: URL;

  try {
    upstreamUrl = new URL(targetUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid upstream URL.' });
  }

  if (!['http:', 'https:'].includes(upstreamUrl.protocol)) {
    return res.status(400).json({ error: 'Only http and https URLs are supported.' });
  }

  try {
    const headers: Record<string, string> = {};
    
    // Forward relevant headers
    if (req.headers.authorization) headers['authorization'] = getHeaderValue(req.headers.authorization);
    if (req.headers['content-type']) headers['content-type'] = getHeaderValue(req.headers['content-type']);
    if (req.headers['x-api-key']) headers['x-api-key'] = getHeaderValue(req.headers['x-api-key']);
    if (req.headers['anthropic-version']) headers['anthropic-version'] = getHeaderValue(req.headers['anthropic-version']);
    if (req.headers['x-subscription-token']) headers['x-subscription-token'] = getHeaderValue(req.headers['x-subscription-token']);

    const fetchOptions: RequestInit = {
      method: req.method,
      headers,
    };

    // Forward body if not GET/HEAD
    if (!['GET', 'HEAD'].includes(req.method.toUpperCase()) && Buffer.isBuffer(req.body) && req.body.length > 0) {
      fetchOptions.body = new Uint8Array(req.body);
    }

    const upstreamResponse = await fetch(upstreamUrl.toString(), fetchOptions);
    
    res.status(upstreamResponse.status);
    res.setHeader('Access-Control-Expose-Headers', '*');

    upstreamResponse.headers.forEach((value, key) => {
      if (key.toLowerCase().startsWith('x-ratelimit') || key.toLowerCase() === 'content-type') {
        res.setHeader(key, value);
      }
    });

    const responseBody = Buffer.from(await upstreamResponse.arrayBuffer());
    res.send(responseBody);
  } catch (error) {
    console.error('Proxy Error:', error);
    res.status(502).json({
      error: error instanceof Error ? error.message : 'Proxy request failed.',
    });
  }
});

// Serve static frontend files in production
if (process.env.NODE_ENV === 'production') {
  // __dirname in dist-server/server is <root>/dist-server/server
  // so dist is at <root>/dist -> ../../dist
  const distPath = path.join(__dirname, '../../dist');
  app.use(express.static(distPath));
  
  app.get(/(.*)/, (req, res, next) => {
    if (req.path === '/__proxy') return next();
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Mode: ${process.env.NODE_ENV || 'development'}`);
});
