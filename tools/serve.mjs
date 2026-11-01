// Static dev server with HTTP Range support (needed to stream the 1GB disk image).
//   node tools/serve.mjs [port]   -> http://localhost:8080/web/
// Also serves /api/services (tools/services.mjs) so the page can start and stop minisrv and
// the network relay.
import { createServer } from 'node:http';
import { stat, open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { createServices, handleServicesApi, handleFetchApi, handleBuildsApi } from './services.mjs';

const root = resolve(new URL('..', import.meta.url).pathname);
const port = Number(process.argv[2] || 8080);
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
};

const services = createServices(root);

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (await handleServicesApi(services, req, res, url)) return;
    if (await handleFetchApi(req, res, url)) return;
    if (handleBuildsApi(root, req, res, url)) return;
    let path = normalize(decodeURIComponent(url.pathname));
    if (path.endsWith('/')) path += 'index.html';
    const file = join(root, path);
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    const st = await stat(file);
    if (st.isDirectory()) { res.writeHead(302, { Location: url.pathname + '/' }).end(); return; }
    const headers = {
      'Content-Type': types[extname(file)] || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    };
    const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
      headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
      headers['Content-Length'] = end - start + 1;
      res.writeHead(206, headers);
      if (req.method === 'HEAD') { res.end(); return; }
      createReadStream(file, { start, end }).pipe(res);
      return;
    }
    headers['Content-Length'] = st.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(file).pipe(res);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
  }
}).listen(port, () => console.log(`WebTV emulator dev server: http://localhost:${port}/web/`));
