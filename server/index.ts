import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import http from 'node:http';
import https from 'node:https';
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

function appendForwardHeader(
  headers: Record<string, string>,
  name: string,
  value: string | string[] | undefined,
) {
  const normalizedValue = getHeaderValue(value).trim();

  if (normalizedValue) {
    headers[name] = normalizedValue;
  }
}

type UpstreamRequestOptions = {
  method: string;
  headers: Record<string, string>;
  body?: Buffer;
};

type UpstreamResponseData = {
  status: number;
  headers: Headers;
  body: Buffer;
};

async function fetchUpstream(url: URL, options: UpstreamRequestOptions): Promise<UpstreamResponseData> {
  const response = await fetch(url.toString(), {
    method: options.method,
    headers: options.headers,
    body: options.body as BodyInit | undefined,
  });

  return {
    status: response.status,
    headers: response.headers,
    body: Buffer.from(await response.arrayBuffer()),
  };
}

function requestUpstreamIgnoringTls(url: URL, options: UpstreamRequestOptions): Promise<UpstreamResponseData> {
  const transport = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const request = transport.request(
      url,
      {
        method: options.method,
        headers: options.headers,
        rejectUnauthorized: false,
      },
      (response) => {
        const chunks: Buffer[] = [];

        response.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });

        response.on('end', () => {
          const headers = new Headers();

          Object.entries(response.headers).forEach(([key, value]) => {
            if (Array.isArray(value)) {
              value.forEach((item) => headers.append(key, item));
              return;
            }

            if (typeof value === 'string') {
              headers.set(key, value);
            }
          });

          resolve({
            status: response.statusCode ?? 502,
            headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );

    request.on('error', reject);

    if (options.body && options.body.length > 0) {
      request.write(options.body);
    }

    request.end();
  });
}

function isTlsHandshakeError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  const candidates = [error, 'cause' in error ? error.cause : undefined];
  const retriableCodes = new Set([
    'ECONNRESET',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'CERT_HAS_EXPIRED',
    'ERR_TLS_CERT_ALTNAME_INVALID',
  ]);

  return candidates.some((candidate) => {
    if (!(candidate instanceof Error)) {
      return false;
    }

    const code = 'code' in candidate ? candidate.code : undefined;
    return typeof code === 'string' && retriableCodes.has(code);
  });
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
    let requestBody: Buffer | undefined;

    appendForwardHeader(headers, 'authorization', req.headers.authorization);
    appendForwardHeader(headers, 'content-type', req.headers['content-type']);
    appendForwardHeader(headers, 'x-api-key', req.headers['x-api-key']);
    appendForwardHeader(headers, 'anthropic-version', req.headers['anthropic-version']);
    appendForwardHeader(headers, 'x-subscription-token', req.headers['x-subscription-token']);

    // Forward body if not GET/HEAD
    if (!['GET', 'HEAD'].includes(req.method.toUpperCase()) && Buffer.isBuffer(req.body) && req.body.length > 0) {
      requestBody = Buffer.from(req.body);
    }

    let upstreamResponse: UpstreamResponseData;

    try {
      upstreamResponse = await fetchUpstream(upstreamUrl, {
        method: req.method,
        headers,
        body: requestBody,
      });
    } catch (error) {
      if (upstreamUrl.protocol !== 'https:' || !isTlsHandshakeError(error)) {
        throw error;
      }

      console.warn(`Proxy TLS retry without certificate verification for ${upstreamUrl.host}`);
      upstreamResponse = await requestUpstreamIgnoringTls(upstreamUrl, {
        method: req.method,
        headers,
        body: requestBody,
      });
    }

    res.status(upstreamResponse.status);
    res.setHeader('Access-Control-Expose-Headers', '*');

    upstreamResponse.headers.forEach((value, key) => {
      if (key.toLowerCase().startsWith('x-ratelimit') || key.toLowerCase() === 'content-type') {
        res.setHeader(key, value);
      }
    });

    res.send(upstreamResponse.body);
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
