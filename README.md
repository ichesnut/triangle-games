# Triangle Games

Simple, fun, mobile-accessible web games. The repo hosts a launcher (`index.html`) plus one or more games under `games/<game>/`, all served from a single Express + SQLite backend with a shared WebSocket layer for multiplayer.

The first shipping game is **Quiz Battle** — a real-time, host-driven quiz where the first correct answer wins the round.

---

## Stack at a glance

| Layer | Choice | Why |
| --- | --- | --- |
| Language | JavaScript (ESM, `"type": "module"`) | No build step on the server; one language end-to-end. |
| Runtime | Node.js 22 | Pinned in `Dockerfile` and CI. |
| Frontend | Vanilla JS + HTML5 Canvas | No framework. One `<script type="module">` per page. |
| Bundler / dev | [Vite 8](https://vitejs.dev/) | Multi-entry build; auto-discovers games (`vite.config.js`). |
| Server | [Express 5](https://expressjs.com/) | Boring, well-known. |
| Realtime | [`ws`](https://github.com/websockets/ws) | Raw WebSocket; session-authenticated via Express upgrade hook. |
| Database | [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) | Synchronous, in-process, fast. WAL mode, FK enforcement. |
| Sessions | `express-session` + [`connect-sqlite3`](https://github.com/rawberg/connect-sqlite3) | Cookies stored in `sessions.db` next to the app DB. |
| Auth | `bcrypt` (12 rounds) | Password hashing for registered users. |
| Tests | `node --test` + [`c8`](https://github.com/bcoe/c8) | No Jest, no Vitest. Built-ins only. |
| Dev orchestration | [`concurrently`](https://github.com/open-cli-tools/concurrently) | Runs Vite + server in one `npm run dev`. |
| Hosting | [Fly.io](https://fly.io) (`iad`) with a 1 GB persistent volume at `/data` | Single VM, auto-stop when idle. |
| Container | Multi-stage `Dockerfile` (Node 22 slim) | Build stage compiles the client and native modules; runtime stage strips build tools. |
| CI | GitHub Actions | Tests + coverage on PR/main; deploy on push to `main`. |
| PWA | `public/manifest.json` + `public/sw.js` | Cache-first for static, network for `/api/`. |

---

## Architecture

```
.
├── index.html              # Game launcher (one card per game)
├── admin/                  # Admin console (own Vite entry)
├── games/
│   └── quiz-battle/        # Each game = its own folder + index.html
├── shared/                 # Browser-side helpers reused across games
│   ├── canvas.js           # DPI-aware canvas + auto-resize
│   ├── gameloop.js         # rAF loop with capped delta-t
│   ├── touch.js            # Pointer/touch event queue
│   └── reset.css
├── public/                 # Vite static assets (manifest, icons, SW)
├── server/
│   ├── index.js            # Express app, session, CSRF, route mounting
│   ├── db.js               # SQLite schema + idempotent migrations
│   ├── seed.js             # Default rewards + admin promotion
│   ├── routes/             # auth, quizzes, rewards, admin
│   └── multiplayer/
│       ├── ws.js           # WebSocket upgrade + connection handler
│       ├── rooms.js        # In-memory room state + game machine
│       └── challenges.js   # Question shaping + answer checking
├── tests/                  # Mirrors source tree; `*.test.js`
├── Dockerfile              # Multi-stage build
├── fly.toml                # Fly.io app config
└── vite.config.js
```

### How the client is built

`vite.config.js` auto-discovers any `games/<name>/index.html` and adds it as a Rollup entry, alongside the launcher (`index.html`) and the admin console (`admin/index.html`). To add a game, drop a folder under `games/` with an `index.html` and a `main.js` — no config changes needed.

In dev, Vite runs on `:3010` and proxies `/api` and `/ws` to the Express server on `:3001`. In production, Express serves the built `dist/` and falls back to the launcher for unknown paths.

### Shared browser modules (`shared/`)

These are deliberately tiny — three small factory functions. Game code imports them directly; there is no framework or component layer.

- `createCanvas(container)` — appends a canvas, handles `devicePixelRatio` and resize.
- `createGameLoop({ update, render })` — `requestAnimationFrame` loop, dt capped at 100 ms to avoid spiral-of-death on tab switch.
- `createTouchInput(element)` — unifies mouse + touch into a queued pointer stream.

### API surface

All API routes are namespaced under `/api/chesnuts/*` (the family in-joke that gave the rewards currency its name). They are CSRF-protected.

- `GET  /api/chesnuts/csrf-token` — returns the per-session token.
- `auth` — register, login, logout, `me`, guest creation, guest→user merge.
- `quizzes` — CRUD on quizzes, categories, questions, with drag-reorder support.
- `rewards` — list rewards, redeem, history.
- `admin` — user management (admin gated by `isAdmin` flag), quiz archive, games view.
- `GET  /api/health` — liveness probe.

### Multiplayer (Quiz Battle)

A single WebSocket endpoint `/ws/quiz-battle` upgraded with the same `express-session` parser used by HTTP, so a connecting browser is already authenticated as either a user or a guest.

- **Room state lives in-memory** (`server/multiplayer/rooms.js`). Rooms are keyed by a 4-char code drawn from an unambiguous alphabet (no `0/O`, `1/I`). No Redis — the server is single-instance.
- **Participant ID convention**: positive integers = registered users (`users.id`), negative = guests (`-guests.id`). One numeric ID identifies any participant; the sign tells you which table to write to.
- **State machine**: `lobby → playing → finished`. Host picks quiz, ≥2 players required to start. First correct answer ends the round; everyone sees the result; the host advances or ends the game early (admins can also end any active game from the admin console).
- **Persistence on game end**: streaks update for both users and guests, chesnut balances update for users, and a row is written to `quiz_battle_games` / `_players` / `_rounds` (only when at least one registered user played, since those tables FK to `users`).
- **Mid-game disconnect**: if remaining players drop below 2, the game ends with `aborted: true` and players still get credit for rounds they helped resolve.

### Database

`better-sqlite3` opens `chesnuts.db` in `DATA_DIR` (default `./data`, `/data` in production via Fly volume). On boot, `db.js`:

1. `CREATE TABLE IF NOT EXISTS …` for the full current schema.
2. Runs idempotent in-place migrations — `PRAGMA table_info(t)` to inspect, then `ALTER TABLE … ADD COLUMN` for new fields. We do not use a migration framework; the file is the source of truth and is always safe to re-run.
3. Renames legacy `math_battle_*` tables to `quiz_battle_*` if present (TRI-35); SQLite ≥3.25 fixes up FKs on rename, indexes are dropped and recreated.
4. Creates indexes (`idx_*`) for hot lookups.

Patterns we use everywhere:

- **Prepared statements** (`db.prepare(...)`) cached at module scope or inside transactions.
- **`db.transaction(fn)`** for any multi-statement write — atomic, faster, and the default way to express invariants.
- **WAL journal mode** + **`foreign_keys = ON`**.

### Auth & security

- Passwords: `bcrypt` with 12 salt rounds.
- Sessions: HTTP-only, `SameSite=Lax`, `Secure` in production, 7-day TTL, stored in `sessions.db`.
- CSRF: a 32-byte hex token is generated per session on first request and required on every `POST/PUT/PATCH/DELETE` via `X-CSRF-Token`. Clients fetch it from `/api/chesnuts/csrf-token`.
- Trust proxy in production (Fly terminates TLS upstream of the app).
- Admin gate: `requireAdmin` middleware checks the `isAdmin` flag on the session user. The first registered user is auto-promoted if no admin exists yet (`server/seed.js`); additional admins can be set via the `ADMIN_EMAILS` env var (comma-separated).

### Mobile-first UI conventions

- `<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">` on every page.
- `min-height: 100dvh` instead of `100vh` so iOS browser chrome doesn't clip.
- 44px minimum tap targets (`--tap: 44px`).
- Inline `<style>` per page — no global stylesheet beyond `shared/reset.css`.
- Color tokens defined per page as CSS custom properties (`--accent`, `--bg`, etc.).
- A service worker provides PWA install + offline shell. API calls are never cached.

---

## Local development

Requires **Node 22**.

```bash
npm install
npm run dev          # Vite (3010) + server (3001) via concurrently
```

Open <http://localhost:3010>. The first user to register is auto-promoted to admin.

### Useful scripts

| Script | Does |
| --- | --- |
| `npm run dev` | Vite + Express, hot reload on the client side. |
| `npm run dev:client` | Vite only. |
| `npm run dev:server` | Express only. |
| `npm run build` | Vite multi-entry build → `dist/`. |
| `npm start` | Run the production server (assumes `dist/` exists). |
| `npm run preview` | Vite preview of the built client. |
| `npm test` | Run the full Node test suite. |
| `npm run coverage` | Tests + c8 coverage summary, lcov + json-summary in `coverage/`. |
| `npm run coverage:check` | Same, but fails if thresholds aren't met. |

### Environment variables

| Var | Default | Notes |
| --- | --- | --- |
| `PORT` | `3001` (dev) / `8080` (Docker) | HTTP port. |
| `NODE_ENV` | `development` | Set to `production` to enable static serving, secure cookies, `trust proxy`. |
| `DATA_DIR` | `./data` | Where SQLite files live. Fly mounts this at `/data`. |
| `SESSION_SECRET` | dev fallback | **Set in production.** Used to sign session cookies. |
| `ADMIN_EMAILS` | — | Comma-separated emails to promote on boot. |

---

## Testing

Node's built-in test runner with c8 for coverage. See `tests/README.md` for full conventions.

- Tests mirror the source tree; files use `.test.js`.
- DB-touching tests call `freshDataDir()` (`tests/server/helpers/db.js`) **before** importing anything that pulls in `db.js`, so each test gets its own SQLite file in a `mkdtemp` directory.
- HTTP route tests use `tests/server/helpers/http.js`: `makeApp(router)` mounts the router on a fresh Express app with a session stub, `startServer(app)` boots an ephemeral `node:http` server and returns a `fetch`-based `request()` helper.
- WebSocket / `rooms.js` tests exercise the exported functions directly with stub `ws` objects (`{ send: () => {} }`).
- Coverage thresholds (in `.c8rc.json`): **85%** lines / functions / statements, **75%** branches, scoped to `server/**` and `shared/**`. Entry points and DOM-only modules are excluded.

---

## CI / CD

Two GitHub Actions workflows in `.github/workflows/`:

- **Tests** — runs on every PR and `main` push. Installs with `npm ci`, runs `npm run coverage:check`, uploads the `coverage/` artifact, and posts/updates a PR comment with the coverage table.
- **Deploy to Fly.io** — runs on every push to `main`, calls `flyctl deploy --remote-only`. Requires `FLY_API_TOKEN` repo secret.

Production runs on Fly.io (`fly.toml`):

- Single VM in `iad`, 1 GB RAM, 1 vCPU.
- `auto_stop_machines = stop`, `min_machines_running = 0` — the app sleeps when idle and wakes on request.
- Persistent volume `data` mounted at `/data` (SQLite files survive deploys).
- HTTPS forced (`force_https = true`); the app trusts one proxy hop (Fly's edge).

---

## Adding a new game

1. Create `games/<game-slug>/index.html` and `games/<game-slug>/main.js`.
2. Add a card to `index.html` linking to `/games/<game-slug>/`.
3. Use modules from `shared/` — don't reinvent canvas/loop/input.
4. Keep dependencies thin. Every dependency is a liability.

Vite picks up the new entry automatically on the next `dev`/`build`.

---

## Conventions and non-obvious choices

- **Boring tech, by design.** No frameworks, no ORM, no migration tool. The whole stack is something a single person can hold in their head.
- **One database file**, one in-memory room map. No Redis, no message broker. The server is meant to scale up before it scales out.
- **Idempotent schema migrations** in `server/db.js` — re-running them is always safe. There is no separate migration directory.
- **Guests are first-class.** Quiz Battle works without registering; on register/login a guest's streaks merge into the user (see `mergeGuestIntoUser` in `routes/auth.js`).
- **CSRF on every mutating call**, even from same-origin. Token is per-session, served once, included in the `X-CSRF-Token` header by the client.
- **Rewards currency** is called *chesnuts*. It's named after the maintainer's family — leave the name, it's load-bearing.
