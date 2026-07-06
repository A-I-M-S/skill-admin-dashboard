# Phase 0 bootstrap plan — `skill-admin-dashboard`

> Synthesized from `brief.md` (locked spec) + opencode Plan agent's read-only analysis. This is the canonical plan. Issues will be filed against this document.

## Goals

Native OpenClaw admin dashboard — a single-page TypeScript web app for the things that currently live in CLI + memory:

- **`skill-secret`** — vault browse / search / init (read-only metadata + audited init)
- **`skill-rag-qdrant`** — ingest (file upload, text paste, chunking), collection stats, admin search
- **Ops** — cron jobs (list / pause / resume / run-now / remove), agent sessions, service logs
- **`skill-chatbot`** — active conversations, message history per phone, handoff queue, admin manual send

Out of scope for v1: public exposure, mobile-first, multi-user / RBAC, WebSocket live tails, settings editor.

## Stack (locked)

| Layer | Choice | Version | Why (one sentence) |
|---|---|---|---|
| Runtime | Node.js | 20 LTS | Matches `openclaw-control-center`; current LTS |
| Framework | Fastify | ^4.28 | Same as reference; faster + better plugin model than Express |
| Language | TypeScript | ^5.8 strict | Catches config + API mismatches at build time |
| View | EJS | ^3.1 (server-rendered) + Alpine.js (sprinkles) | SSR is simpler for auth (cookie session + CSRF); no React/Vite build chain |
| Auth | `@fastify/cookie` + `@fastify/session` + `argon2` | argon2id | Same primitives as reference; argon2id wins over bcrypt on memory hardness |
| CSRF | `@fastify/csrf-protection` (double-submit cookie) | latest | Independent of SameSite; fail-closed |
| Logging | `pino` + `pino-pretty` (dev only) | ^9 | Same as reference; structured JSON + redact list |
| Tests | `vitest` + `supertest` | latest | Same as reference; native TS support, no transpile step |
| Lint / fmt | `eslint` + `prettier` | latest | Standard |
| Process | systemd | n/a | Matches `aoa` + `openclaw-control-center` patterns |
| HTTP basic fallback | `LOCAL_TOKEN_AUTH_REQUIRED=true` env gate | n/a | Same model as reference; gated behind explicit env |

**Explicitly excluded from v1:** React, Vite, WebSockets, Tailwind, Prisma, TypeORM. EJS + Alpine + raw CSS is enough for admin UI.

## Project layout

```
skill-admin-dashboard/
├── README.md
├── .gitignore
├── .env.example
├── brief.md                          # locked spec for the Plan agent
├── package.json
├── tsconfig.json
├── eslint.config.js
├── .prettierrc
├── Makefile                           # 18 targets
├── docs/
│   └── plans/
│       └── phase-0-bootstrap.md       # this file
├── src/
│   ├── index.ts                       # entrypoint — boots config + server
│   ├── config.ts                      # env loading + safety defaults
│   ├── server.ts                      # Fastify instance + route registration
│   ├── types.ts                       # shared TS types (Session, SecretMeta, RagStats, …)
│   ├── auth/
│   │   ├── session.ts                 # argon2id cookie sessions + id rotation on login
│   │   ├── csrf.ts                    # CSRF double-submit, rotated on login
│   │   └── local-token.ts             # LOCAL_TOKEN_AUTH_REQUIRED basic-auth fallback
│   ├── routes/
│   │   ├── index.ts                   # GET / status dashboard (vault backend, recent secrets, cron count, agent count)
│   │   ├── vault/
│   │   │   ├── list.ts                # GET /vault — list + search, read-only metadata
│   │   │   ├── show.ts                # GET /vault/:id — metadata + whoami
│   │   │   └── init.ts                # POST /vault/init — form → bin/secret init
│   │   ├── rag/
│   │   │   ├── stats.ts               # GET /rag — collection stats + source-file listing
│   │   │   ├── ingest.ts              # POST /rag/ingest (multipart) + POST /rag/ingest/text
│   │   │   └── search.ts              # POST /rag/search — admin-only rag.ask()
│   │   ├── ops/
│   │   │   ├── cron.ts                # GET /cron + POST /cron/:id/{pause,resume,run,remove}
│   │   │   ├── sessions.ts            # GET /sessions + deep-link to JSONL
│   │   │   └── logs.ts                # GET /logs — tail 4 services in tabs
│   │   └── chatbot/
│   │       ├── conversations.ts       # GET /chatbot/conversations + /chatbot/conversations/:phone
│   │       ├── handoff.ts             # GET /chatbot/handoff — queue view
│   │       └── send.ts                # POST /chatbot/send — admin manual send + audit
│   ├── views/
│   │   ├── layout.ejs                 # header + nav + footer
│   │   ├── partials/
│   │   │   ├── csrf-input.ejs         # <input type="hidden" name="_csrf">
│   │   │   ├── confirm-modal.ejs      # generic confirm for destructive ops
│   │   │   ├── audit-row.ejs          # audit-log table row
│   │   │   ├── error-toast.ejs
│   │   │   └── pagination.ejs
│   │   ├── index.ejs
│   │   ├── vault/{list,show,init}.ejs
│   │   ├── rag/{stats,ingest,search}.ejs
│   │   ├── ops/{cron,sessions,logs}.ejs
│   │   └── chatbot/{conversations,show,handoff,send}.ejs
│   ├── lib/
│   │   ├── subprocess.ts              # spawn() wrapper, JSON parse, timeout, exit-code handling
│   │   ├── audit.ts                   # append-only 0o600 audit log (runtime/audit.log)
│   │   ├── tmp.ts                     # project-local runtime/tmp/<uuid>/ helper
│   │   ├── bin-secret.ts              # wraps `bin/secret` — inherits env, never logs keys
│   │   ├── rag-subprocess.ts          # lazy Python subprocess wrapper for rag_qdrant
│   │   ├── openclaw-bin.ts            # resolves `cron`, `sessions_list` via OPENCLAW_BIN env
│   │   └── journal.ts                 # journalctl tail + ANSI strip
│   └── styles/
│       ├── app.css                    # single bundle, no preprocessor
│       └── theme.css                  # dark / light toggle (cookie-stored)
├── test/
│   ├── helpers/
│   │   ├── login.ts                   # POST /login + capture session cookie
│   │   ├── csrf.ts                    # fetch CSRF token from a session
│   │   └── mock-subprocess.ts         # intercepts child_process.spawn for tests
│   ├── auth.test.ts                   # session rotation, CSRF fail-closed, local-token fallback
│   ├── vault.test.ts                  # list / search / init happy paths + error paths
│   ├── rag.test.ts                    # ingest multipart + text + search happy + 503 on missing deps
│   ├── ops.test.ts                    # cron / sessions / logs
│   ├── chatbot.test.ts                # conversations / handoff / send + audit
│   ├── audit.test.ts                  # append-only, 0o600, JSON-line shape
│   └── integration.test.ts            # full smoke: login → navigate → init → ingest → send
├── systemd/
│   └── skill-admin-dashboard.service  # v1: 127.0.0.1:4320, no public exposure
└── references/
    └── upstream/                      # snapshot of reference skills (already committed)
```

## 18 Makefile targets

| # | Target | Command |
|---|---|---|
| 1 | `install` | `npm ci` |
| 2 | `dev` | `npm run dev` (tsx watch src/index.ts) |
| 3 | `build` | `npm run build` (tsc → dist/) |
| 4 | `start` | `node dist/index.js` |
| 5 | `test` | `npm test` (vitest run) |
| 6 | `test:watch` | `npm run test:watch` |
| 7 | `test:coverage` | `vitest run --coverage` |
| 8 | `lint` | `npm run lint` |
| 9 | `typecheck` | `tsc --noEmit` |
| 10 | `fmt` | `prettier --write .` |
| 11 | `fmt:check` | `prettier --check .` |
| 12 | `init` | `cp -n .env.example .env && (grep -q LOCAL_API_TOKEN .env || (echo "LOCAL_API_TOKEN=$(openssl rand -hex 32)" >> .env))` |
| 13 | `service:install` | `sudo cp systemd/skill-admin-dashboard.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable skill-admin-dashboard.service` |
| 14 | `service:start` | `sudo systemctl start skill-admin-dashboard.service` |
| 15 | `service:stop` | `sudo systemctl stop skill-admin-dashboard.service` |
| 16 | `service:status` | `systemctl status skill-admin-dashboard.service` |
| 17 | `service:logs` | `journalctl -u skill-admin-dashboard.service -f` |
| 18 | `verify:no-tmp` | `! grep -rnE '/tmp\|os\.tmpdir\(\)\|0\.0\.0\.0' src/ && echo OK` (CI gate — fails on any forbidden pattern) |

## systemd unit (v1)

`systemd/skill-admin-dashboard.service`:

```ini
[Unit]
Description=skill-admin-dashboard (127.0.0.1 only)
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/.openclaw/workspace/dev/projects/skill-admin-dashboard
ExecStart=/usr/bin/node dist/index.js
EnvironmentFile=-/root/.openclaw/workspace/dev/projects/skill-admin-dashboard/.env
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

- Binds `127.0.0.1:4320` (set via `HOST=127.0.0.1 PORT=4320` in `.env`)
- **No** public-IP pinhole, **no** `AOA_EXTRA_ORIGINS`-style pattern, **no** `0.0.0.0`
- Public exposure is v2 — separate later phase, explicit user ask

## Sequencing — 14 issues in 6 batches

### Batch A — scaffold (Issue #1)

| # | Title | Depends on |
|---|---|---|
| #1 | Project layout, build tooling, TS strict, Fastify boot, pino, systemd unit | — |

**Gate A1:** verify `npm run dev` boots, `systemctl start` works, journalctl shows clean startup, `make verify:no-tmp` passes.

### Batch B — auth + shell (Issue #2)

| # | Title | Depends on |
|---|---|---|
| #2 | Auth (session cookies + CSRF) + layout shell + nav + safety defaults | #1 |

**Gate A2:** verify session rotation, CSRF fail-closed (POST without token = 403 even with `READONLY_MODE=true`), basic-auth fallback works, redirect-to-login for unauthenticated requests.

### Batch C — Vault (`skill-secret`) (Issues #3–#5, sequential)

| # | Title | Depends on |
|---|---|---|
| #3 | `/` status dashboard + `bin/secret` subprocess wrapper + env inheritance | #2 |
| #4 | `/vault` list + search (read-only metadata only — no plaintext) | #3 |
| #5 | `/vault/init` form (file-paste API key) + `/vault/:id` metadata + audit log entry | #4 |

**Gate C:** PR + merge. v1 Vault surface complete.

### Batch D — RAG (`skill-rag-qdrant`) (Issues #6–#8, sequential)

| # | Title | Depends on |
|---|---|---|
| #6 | `/rag` collection stats + source-file listing (returns 503 if rag deps missing) | #1–#5 |
| #7 | `/rag/ingest` multipart upload (10 MiB cap) + `/rag/ingest/text` + chunking params | #6 |
| #8 | `/rag/search` admin-only `rag.ask()` + top-3 hits + scores (audit-logged) | #7 |

**Gate D:** PR + merge. v1 RAG surface complete.

### Batch E — Ops (Issues #9–#11, can run in parallel)

| # | Title | Depends on |
|---|---|---|
| #9 | `/cron` list / pause / resume / run-now / remove (via `cron` tool) | #1–#5 |
| #10 | `/sessions` list + last message + deep link to session JSONL | #1–#5 |
| #11 | `/logs` tail 4 services in tabs (`aoa`, `openclaw-control-center`, `wa-bridge`, `orchestrator`) | #1–#5 |

**Gate E:** PR + merge. v1 Ops surface complete.

### Batch F — Chatbot (`skill-chatbot`) (Issues #12–#14, sequential)

| # | Title | Depends on |
|---|---|---|
| #12 | `/chatbot/conversations` active list + phone filter (depends on Q6 discovery) | #1–#5 |
| #13 | `/chatbot/conversations/:phone` last 50 messages | #12 |
| #14 | `/chatbot/handoff` queue view + `/chatbot/send` admin manual send + audit | #13 |

**Gate F:** Phase 4 done; v1 complete. Open v2 issues: public exposure, mobile-first, RBAC, WebSocket live tails, settings editor.

## 15 Risk callouts

1. **Subprocess JSON parsing.** All `bin/secret` + `cron` + `sessions_list` calls return JSON. The dashboard must JSON-parse defensively — non-zero exit + empty stdout = surface as "vault unreachable", not 500.
2. **API key handling.** The vault init form accepts a paste. The key must be: (a) passed via a temp file at `runtime/tmp/<uuid>/key` (mode 0o600) using `--api-key-file`, never as a CLI arg in argv (process list exposure); (b) never logged; (c) never echoed back in any response body; (d) wiped immediately after use. `lib/bin-secret.ts` is the only allowed writer.
3. **CSRF fail-closed.** Even with `READONLY_MODE=true` (the v1 default), the init / ingest / send / cron-control routes must require a valid CSRF token. A misconfigured `READONLY_MODE` flag must NOT silently disable CSRF — fail closed.
4. **`bin/secret` env inheritance.** When the dashboard spawns `bin/secret`, it must inherit `SKILL_SECRET_KMS_BACKEND`, `SKILL_SECRET_KMS_PROJECT_URL`, `SKILL_SECRET_KMS_API_BLOB`, `SKILL_SECRET_PASSPHRASE` from the dashboard's own env (loaded from `/root/.openclaw/workspace/dev/projects/skill-admin-dashboard/.env` by systemd `EnvironmentFile=`), NOT the user's request body. The systemd unit is the source of truth.
5. **Lazy rag subprocess.** `lib/rag-subprocess.ts` must spawn a Python interpreter with the rag_qdrant module path. If `rag_qdrant` deps aren't installed, the rag routes return 503 instead of crashing the boot. Mirror the lazy-import + `sys.modules` injection pattern from `skill-secret` v4 tests.
6. **No `/tmp` usage.** Same rule as skill-secret v4: never use `/tmp` or `os.tmpdir()`. Use `runtime/tmp/<uuid>/`. Enforced by `make verify:no-tmp`.
7. **No `0.0.0.0` binding.** v1 binds `127.0.0.1`. Don't add public-IP pinhole or `AOA_EXTRA_ORIGINS`-style patterns until v2. Enforced by `make verify:no-tmp` (also greps `0.0.0.0`).
8. **Multipart size caps.** `MAX_UPLOAD_BYTES=10MiB` enforced server-side. Set Fastify `bodyLimit` AND check the parsed multipart total.
9. **journalctl ANSI strip.** `lib/journal.ts` must strip ANSI escapes before passing to EJS — set `SYSTEMD_COLORS=0` and `TERM=dumb` in the spawn env.
10. **Session id rotation on login.** Generate a new session id after successful login to prevent fixation. Store session id in the cookie, not just the contents.
11. **Tool path resolution.** `lib/openclaw-bin.ts` resolves `cron`, `sessions_list`, and `opencode` paths via `OPENCLAW_BIN` env var with a default of `/usr/local/bin:/usr/bin`. Never hard-code absolute paths.
12. **CSRF token rotation.** Rotate the CSRF token on login + on privilege change. Token bound to session — a new session gets a new token.
13. **Append-only 0o600 audit log.** `runtime/audit.log` opened with `O_APPEND`, mode `0o600`. Writes are atomic via a single `fs.write` of a JSON line. `lib/audit.ts` is the only writer.
14. **EJS auto-escape.** Confirm `<%= %>` (escaped) is used everywhere except for explicit safe HTML in the layout shell. No `<%- %>` for user data — XSS vector.
15. **pino redact list maintenance.** `redact: ['req.headers.cookie', 'req.headers.authorization', '*.apiKey', '*.passphrase', '*.token', 'req.body.apiKey']`. Add to it when new sensitive fields appear — `test/audit.test.ts` greps the redact list for all sensitive env-var names.

## 6 Open questions for the user

1. **Vault reveal flow.** When viewing a secret's metadata, can the admin click "reveal" to see the plaintext? If yes: separate confirm step + audit log entry + per-session rate limit. If no: dashboard is strictly metadata-only. **Recommended: NO in v1.** Easier to add later than to remove.
2. **RAG chunking defaults.** What's the default chunk size + overlap for `/rag/ingest`? Look at `references/upstream/rag-qdrant/SKILL.md` for existing defaults. **Recommended: 800 / 200, both exposed as form fields.**
3. **Log tail depth.** `/logs` shows last N lines on each load, then polls every M seconds for refresh? Or initial-load-only + manual "refresh" button? **Recommended: initial 200 lines + 5 s polling.**
4. **Chatbot admin send semantics.** Manual send: bypass the LLM router (send as admin user) OR flagged as an admin intervention (visible to the customer)? **Recommended: flagged intervention** — matches skill-chatbot's existing admin-notify patterns.
5. **Auto-generate `LOCAL_API_TOKEN` on first install.** `make init` creates `.env` from `.env.example` and, if `LOCAL_API_TOKEN` is missing, appends a fresh 32-byte hex token. **Recommended: yes.**
6. **Phase 0 discovery issue for `skill-chatbot` CLI.** Before Phase 4, open an issue to confirm the `skill-chatbot` CLI surface: does it expose `list conversations` / `list messages`? Does it expose its SQLite? What env vars does the dashboard need to forward? Phase 4 (Issues #12–#14) cannot be planned in detail until this lands.

## Definition of done — Phase 0

- [ ] `docs/plans/phase-0-bootstrap.md` (this file) committed to `main`
- [ ] 14 issues filed against this repo with `phase:0-bootstrap`, `phase:1-vault`, `phase:2-rag`, `phase:3-ops`, `phase:4-chatbot` labels
- [ ] User has signed off on the plan and the 6 open questions (or accepted the recommendations as defaults)
- [ ] User has explicitly approved creating a new opencode Build session for Batch A (Issue #1)

After that, Plan → Build loop begins. One PR per issue. User merges each PR before the next issue starts.
