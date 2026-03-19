import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const proxyRoute = '/__proxy';

function getHeaderValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value.join(',') : value ?? '';
}

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'local-cors-proxy',
      configureServer(server) {
        server.middlewares.use(proxyRoute, async (req, res) => {
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, anthropic-version');

          if (req.method === 'OPTIONS') {
            res.statusCode = 204;
            res.end();
            return;
          }

          const requestUrl = new URL(req.url ?? '', 'http://localhost');
          const target = requestUrl.searchParams.get('url');

          if (!target) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Missing "url" query parameter.' }));
            return;
          }

          let upstreamUrl: URL;

          try {
            upstreamUrl = new URL(target);
          } catch {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Invalid upstream URL.' }));
            return;
          }

          if (!['http:', 'https:'].includes(upstreamUrl.protocol)) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Only http and https URLs are supported.' }));
            return;
          }

          try {
            const bodyChunks: Uint8Array[] = [];

            for await (const chunk of req) {
              bodyChunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
            }

            const upstreamResponse = await fetch(upstreamUrl, {
              method: req.method,
              headers: {
                authorization: getHeaderValue(req.headers.authorization),
                'content-type': getHeaderValue(req.headers['content-type']),
                'x-api-key': getHeaderValue(req.headers['x-api-key']),
                'anthropic-version': getHeaderValue(req.headers['anthropic-version']),
              },
              body:
                req.method && ['GET', 'HEAD'].includes(req.method.toUpperCase())
                  ? undefined
                  : Buffer.concat(bodyChunks),
            });

            res.statusCode = upstreamResponse.status;

            const contentType = upstreamResponse.headers.get('content-type');
            if (contentType) {
              res.setHeader('Content-Type', contentType);
            }

            const responseBody = Buffer.from(await upstreamResponse.arrayBuffer());
            res.end(responseBody);
          } catch (error) {
            res.statusCode = 502;
            res.setHeader('Content-Type', 'application/json');
            res.end(
              JSON.stringify({
                error:
                  error instanceof Error
                    ? error.message
                    : 'Proxy request failed.',
              }),
            );
          }
        });
      },
    },
  ],
});
