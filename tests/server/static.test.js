import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startServer } from './helpers/http.js';
import { mountStatic } from '../../server/static.js';

let distDir;
let server;
let request;

before(async () => {
  distDir = mkdtempSync(join(tmpdir(), 'triangle-static-'));
  mkdirSync(join(distDir, 'assets'));
  writeFileSync(
    join(distDir, 'index.html'),
    '<html><body><div id="spa-shell-marker"></div></body></html>',
  );
  writeFileSync(join(distDir, 'assets', 'admin-REAL.js'), 'console.log("ok");');

  const app = express();
  mountStatic(app, distDir);
  const handle = await startServer(app);
  request = handle.request;
  server = handle;
});

after(async () => {
  await server.close();
  rmSync(distDir, { recursive: true, force: true });
});

test('serves existing hashed asset with JS content', async () => {
  const res = await request('GET', '/assets/admin-REAL.js');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /javascript/);
});

test('missing /assets/* returns a real 404, not the SPA shell', async () => {
  const res = await request('GET', '/assets/admin-MISSING.js');
  // Status must be 404 so the browser treats it as a script-load failure
  // instead of executing an HTML body as JS during a multi-build deploy
  // window. (The default Express 404 page is fine — what matters is the
  // status and that the body is not the SPA index.html.)
  assert.equal(res.status, 404);
  const body = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
  assert.doesNotMatch(body, /spa-shell-marker/);
});

test('SPA route falls back to index.html', async () => {
  const res = await request('GET', '/some/client-route');
  assert.equal(res.status, 200);
  assert.match(String(res.body), /spa-shell-marker/);
});

test('root path returns index.html', async () => {
  const res = await request('GET', '/');
  assert.equal(res.status, 200);
  assert.match(String(res.body), /spa-shell-marker/);
});
