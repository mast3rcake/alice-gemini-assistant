import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import handler from '../api/index.js';
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1..65535');
const jobs = new Set();
const schedule = promise => {
  jobs.add(promise);
  promise.catch(() => console.error('Background job failed')).finally(() => jobs.delete(promise));
};
const server = createServer(async (req, res) => {
  res.status = code => { res.statusCode = code; return res; };
  res.json = value => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(value)); };
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/' && req.method === 'GET') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(await readFile(new URL('../public/index.html', import.meta.url)));
    }
    if (!['/api', '/api/'].includes(path)) return res.status(404).json({ error: 'Not found' });
    let size = 0; const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 16384) return res.status(413).json({ error: 'Request too large' });
      chunks.push(chunk);
    }
    req.body = Buffer.concat(chunks).toString('utf8');
    await handler(req, res, { schedule });
  } catch {
    if (!res.headersSent) res.status(500).json({ error: 'Local server error' });
    else res.end();
  }
});
server.listen(port, '127.0.0.1', () => console.log(`Local server: http://127.0.0.1:${port}; webhook: /api`));
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  const timer = setTimeout(() => process.exit(1), 30000); timer.unref();
  server.close(async () => { await Promise.allSettled([...jobs]); clearTimeout(timer); });
};
process.on('SIGINT', stop); process.on('SIGTERM', stop);
