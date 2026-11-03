// Entry point of the cleaningplan sidecar. Environment:
//   PORT                 listen port (default 3100)
//   DB_PATH              SQLite file (default /data/cleaningplan.db)
//   YUVOMI_INTERNAL_URL  where this service reaches Yuvomi (required, e.g. http://yuvomi:3000)
//   PUBLIC_ORIGIN        the origin browsers use for both apps (required, e.g. https://home.example)
import http from 'node:http';
import { openDb } from './app/db.mjs';
import { createAuth } from './app/auth.mjs';
import { createHandler, DEFAULT_PREFIX } from './app/routes.mjs';

const PORT = Number(process.env.PORT || 3100);
const DB_PATH = process.env.DB_PATH || '/data/cleaningplan.db';
const YUVOMI_INTERNAL_URL = process.env.YUVOMI_INTERNAL_URL;
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN;

for (const [name, value] of [['YUVOMI_INTERNAL_URL', YUVOMI_INTERNAL_URL], ['PUBLIC_ORIGIN', PUBLIC_ORIGIN]]) {
  if (!value) { console.error(`${name} is required`); process.exit(1); }
}

const db = openDb(DB_PATH);
const auth = createAuth({ yuvomiUrl: YUVOMI_INTERNAL_URL, publicOrigin: PUBLIC_ORIGIN });
const handler = createHandler({ db, auth });

const server = http.createServer((req, res) => {
  const started = performance.now();
  res.on('finish', () => {
    if (req.url === `${DEFAULT_PREFIX}/health`) return;
    console.log(JSON.stringify({ ts: new Date().toISOString(), method: req.method, path: req.url, status: res.statusCode, ms: Math.round(performance.now() - started) }));
  });
  handler(req, res);
});

server.listen(PORT, () => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), msg: `cleaningplan sidecar listening on ${PORT}`, prefix: DEFAULT_PREFIX, yuvomi: YUVOMI_INTERNAL_URL }));
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
