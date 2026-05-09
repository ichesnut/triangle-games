# Tests

Triangle Games uses Node's built-in test runner with `c8` for coverage.

## Run tests

```bash
npm test               # Run all tests
npm run coverage       # Run tests + print coverage summary, write lcov to coverage/
npm run coverage:check # Same, but fail if coverage thresholds aren't met
```

## Layout

Test files live under `tests/` and mirror the source tree:

```
tests/
  server/
    multiplayer/
      challenges.test.js
  shared/
```

Use the `.test.js` suffix so the runner picks them up.

## Coverage scope

Configured in `.c8rc.json`. The targets are `server/**/*.js` and `shared/**/*.js`.

Excluded:
- `server/index.js`, `server/seed.js` — entry points / side-effect modules.
- `shared/canvas.js`, `shared/gameloop.js`, `shared/touch.js` — DOM/browser-only modules. Move to a jsdom-based test job if/when needed.

Thresholds: 85% lines / functions / statements, 75% branches.

## Conventions

- Pure-logic modules: import directly and assert outputs.
- DB-touching modules: set `DATA_DIR` to a fresh temp dir per test (`fs.mkdtempSync`) so each test gets its own SQLite file.
- HTTP routes: import the router, mount on a fresh Express app, and use `node:http` + `fetch` (or the `supertest` pattern) for request/response assertions.
- WebSocket / `rooms.js`: exercise the exported functions directly with fake `ws` objects (`{ send: () => {} }`).
