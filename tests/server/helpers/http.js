import express from 'express';
import { createServer } from 'node:http';

// Stub session middleware: every request shares the same mutable session
// object, so a test can run multiple requests against the same logical
// session by mutating it between calls (or by setting cookie-equivalents
// directly before the next request).
function sessionStub(state) {
  return (req, _res, next) => {
    req.session = state;
    req.session.destroy = (cb) => {
      for (const k of Object.keys(state)) {
        if (k !== 'destroy') delete state[k];
      }
      if (cb) cb();
    };
    next();
  };
}

// Build a fresh Express app with JSON parsing, a session stub, and the
// supplied router mounted at `mountPath`. Returns { app, session }.
export function makeApp(router, mountPath = '/', initialSession = {}) {
  const app = express();
  app.use(express.json());
  const session = { ...initialSession };
  app.use(sessionStub(session));
  app.use(mountPath, router);
  return { app, session };
}

// Spin up an ephemeral HTTP server backed by `app` and return helpers for
// making requests and shutting it down.
export async function startServer(app) {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  async function request(method, path, body) {
    const init = { method, headers: {} };
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(baseUrl + path, init);
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, body: data, headers: res.headers };
  }

  function close() {
    return new Promise((resolve) => server.close(resolve));
  }

  return { request, close, baseUrl };
}
