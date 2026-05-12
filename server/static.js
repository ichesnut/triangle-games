import { join } from 'path';
import express from 'express';

// Mount static asset serving and SPA fallback for the built client.
//
// During a multi-machine deploy, two builds can be briefly in rotation: one
// machine serves an `index.html` referencing `admin-NEW.js`, while another
// machine still on the old build receives the request for `admin-NEW.js`,
// has no such file, and (without this guard) falls through to the SPA
// handler which returns `index.html`. Browsers then try to execute that
// HTML body as JS, breaking the page.
//
// Scoping the SPA fallback to skip `/assets/*` makes missing hashed bundles
// return a real 404 instead, which the browser handles cleanly.
export function mountStatic(app, distPath) {
  app.use(express.static(distPath));
  app.get('/{*splat}', (req, res, next) => {
    if (req.path.startsWith('/assets/')) return next();
    res.sendFile(join(distPath, 'index.html'));
  });
}
