// Yuvomi >= 2.93.0 lets a module import only its three stable facades;
// any other absolute path 404s in the browser and the page fails to load.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../modules/cleaningplan/', import.meta.url).pathname;
const ALLOWED = new Set(['/api.js', '/i18n.js', '/utils/html.js']);

const jsFiles = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? jsFiles(join(dir, e.name)) : e.name.endsWith('.js') ? [join(dir, e.name)] : []);

test('module imports only the stable Yuvomi facades', () => {
  for (const file of jsFiles(ROOT)) {
    for (const [, spec] of readFileSync(file, 'utf8').matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      if (spec.startsWith('/')) assert.ok(ALLOWED.has(spec), `${file.slice(ROOT.length)} imports ${spec}`);
    }
  }
});
