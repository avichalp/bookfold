import { createServer } from 'node:http';
import { DEFAULT_PORT, loadServerConfig } from './config.js';
import { createServerApp } from './app.js';

const config = loadServerConfig();
const app = createServerApp({ config });

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `localhost:${config.port}`}`);
  const body =
    req.method === 'GET' || req.method === 'HEAD'
      ? undefined
      : await new Promise<Buffer>((resolve, reject) => {
          const chunks: Buffer[] = [];
          req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
          req.on('end', () => resolve(Buffer.concat(chunks)));
          req.on('error', reject);
        });

  const requestInit: RequestInit = {
    method: req.method ?? 'GET',
    headers: req.headers as Record<string, string>
  };

  if (body) {
    requestInit.body = new Uint8Array(body);
  }

  const response = await app.fetch(new Request(url, requestInit));

  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  const arrayBuffer = await response.arrayBuffer();
  res.end(Buffer.from(arrayBuffer));
});

server.listen(config.port, () => {
  process.stdout.write(`BookFold server listening on http://localhost:${config.port || DEFAULT_PORT}\n`);
});
