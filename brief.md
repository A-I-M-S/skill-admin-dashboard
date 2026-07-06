# Brief for opencode (Plan agent)

> Read this file end-to-end before doing anything. After reading, your job is to **produce a step-by-step plan only** — do not write code, do not create files outside `docs/plans/`, do not commit.

## Project

**Repo:** https://github.com/A-I-M-S/skill-admin-dashboard
**Local path:** `/root/.openclaw/workspace/dev/projects/skill-admin-dashboard/`
**Issue tracker:** https://github.com/A-I-M-S/skill-admin-dashboard/issues
**Driver model:** `minimax/MiniMax-M3`
**Mode:** Plan (no code yet — switch to Build only after the user approves this plan)

## What we're building

A native OpenClaw admin dashboard — a single-page TypeScript web app that gives admins a GUI for:

1. **`skill-secret`** vault — browse, search, init, whoami. Read-only metadata + audited init.
2. **`skill-rag-qdrant`** ingest — file upload, text paste, chunking params, collection stats, admin search.
3. **Ops** — cron jobs (list / pause / resume / run-now / remove), agent sessions (list + deep link), service logs (tail 4 services).
4. **`skill-chatbot`** admin — conversations list, message history per phone, handoff queue, manual send.

Out of scope for v1: public exposure, mobile-first, multi-user / RBAC, WebSocket live tails, settings editor.

## Stack & key decisions (locked)

- **Runtime:** Node 20 + Fastify. Same model as `openclaw-control-center` (existing reference implementation in the workspace).
- **Language:** TypeScript strict.
- **UI:** Server-rendered EJS + Alpine.js sprinkles. Avoids React / Vite build chain. SSR is simpler for auth (cookie session + CSRF).
- **Auth:** argon2 session cookies + CSRF double-submit. HTTP basic fallback gated by `LOCAL_TOKEN_AUTH_REQUIRED=true` (matches `openclaw-control-center` pattern).
- **Hardening defaults on:** `READONLY_MODE=true`, `APPROVAL_ACTIONS_ENABLED=false`, `IMPORT_MUTATION_ENABLED=false`. Mutating routes (init / ingest / send / cron control) require explicit POST + CSRF token.
- **Logging:** pino.
- **Tests:** vitest + supertest.
- **Process:** systemd unit at `/etc/systemd/system/skill-admin-dashboard.service`. `Restart=on-failure`. Binds `127.0.0.1:4320` in v1. No public exposure in v1.
- **No `/tmp` usage anywhere** — use `tempfile.TemporaryDirectory(dir=os.getcwd())` analogue for any temp paths (project convention from skill-secret v4).
- **No `*.env` reads** — `opencode` agent permission is "ask" for `*.env` / `*.env.*`. Read `.env.example` only.

## Reuses (do not reinvent)

- **Reference implementation:** `/root/.openclaw/workspace/dev/projects/openclaw-control-center/src/` — same Fastify + EJS + Alpine + pino stack. Mirror its layout (`config.ts`, `server.ts`, auth middleware, route modules, view partials).
- **Systemd unit template:** `/etc/systemd/system/openclaw-control-center.service` — replicate the public-IP detection pattern ONLY when public exposure is added later (not v1).
- **`skill-secret` v4:** `bin/secret init|take|retrieve|whoami` — invoke as subprocess from the dashboard. Never log the API key. Display only metadata (name, tags, timestamp) by default; "reveal" requires a confirm step + audit log entry (see open question #1).
- **`skill-rag-qdrant`:** `from rag_qdrant import ask, ingest_text, ingest_file, ensure_collection, stats` — invoke via subprocess (Python). Read its SKILL.md to confirm the API surface before planning Phase 2.
- **Cron + sessions:** invoke the `cron` and `sessions_list` tools available in this OpenClaw workspace via subprocess.

## Existing skills — quick reference

**All upstream reference files are snapshotted into `references/upstream/` in this repo. Read from there. Do not read from absolute paths.**

Key files to read end-to-end before planning:

- `references/upstream/openclaw-control-center/src/` — full source tree of the reference implementation (Fastify + EJS + Alpine + pino). Look at `src/index.ts`, `src/config.ts`, `src/runtime/local-token-auth.ts`, `src/ui/server.ts`, `src/runtime/cron-overview.ts` for the closest analogues.
- `references/upstream/openclaw-control-center/package.json` — pinned versions
- `references/upstream/openclaw-control-center/.env.example` — env var pattern (note the `LOCAL_TOKEN_AUTH_REQUIRED` and `READONLY_MODE` patterns)
- `references/upstream/skill-secret/SKILL.md` — vault contract
- `references/upstream/skill-secret/secret.py` + `flows.py` — `bin/secret` CLI to wrap
- `references/upstream/rag-qdrant/SKILL.md` — RAG API surface (ingest helpers + collection stats)
- `references/upstream/systemd/aoa.service` + `openclaw-control-center.service` — systemd unit patterns (templates; do not modify the originals)
- `references/upstream/skill-chatbot-brief.md` — the original skill-chatbot brief this template is mirrored from

If `references/upstream/` is missing a file you need, stop and ask the user.

## Phased delivery (each phase = 1 PR)

The Plan must order issues so Phase 1 unblocks everything (auth + layout + nav shell), then Phases 2-4 each tackle one skill independently.

### Phase 1 — Foundation + Vault (`skill-secret`)

| Issue | Title | Depends on |
|---|---|---|
| #1 | Project layout, build tooling, TS strict, Fastify boot, pino, systemd unit | — |
| #2 | Auth (session cookies + CSRF) + layout shell + nav + safety defaults | #1 |
| #3 | `/` status dashboard (vault backend, recent secrets, cron count, agent count) | #2 |
| #4 | `/vault` list + search (read-only metadata) + `bin/secret` subprocess wrapper | #3 |
| #5 | `/vault/init` form + `/vault/:id` metadata + audit log for init/send | #4 |

### Phase 2 — RAG (`skill-rag-qdrant`)

| Issue | Title | Depends on |
|---|---|---|
| #6 | `/rag` collection stats + source-file listing | #1–5 |
| #7 | `/rag/ingest` file upload (multipart, chunking params) + `/rag/ingest/text` | #6 |
| #8 | `/rag/search` admin-only `rag.ask()` + top-3 hits + scores | #7 |

### Phase 3 — Ops

| Issue | Title | Depends on |
|---|---|---|
| #9 | `/cron` list + pause + resume + run-now + remove (via `cron` tool) | #1–5 |
| #10 | `/sessions` list + last message + deep link to session JSONL | #1–5 |
| #11 | `/logs` tail 4 services in tabs (read-only pipe to `journalctl`) | #1–5 |

### Phase 4 — Chatbot (`skill-chatbot`)

| Issue | Title | Depends on |
|---|---|---|
| #12 | `/chatbot/conversations` active list + phone filter | #1–5 |
| #13 | `/chatbot/conversations/:phone` last 50 messages | #12 |
| #14 | `/chatbot/handoff` queue view + `/chatbot/send` admin manual send + audit | #13 |

## Parallel batches

Per the `opencode-controller` skill, parallel-within-batch (issues opencode should attack in the same session):

- **Batch A (scaffold):** #1 alone — sets the type system, build chain, and boot path. Nothing else compiles until this lands.
- **Batch B (auth + shell):** #2 alone — establishes the security model every page depends on.
- **Batch C (vault):** #3, #4, #5 sequential. Each builds on the previous.
- **Batch D (rag):** #6, #7, #8 sequential.
- **Batch E (ops):** #9, #10, #11 can run in parallel (independent pages).
- **Batch F (chatbot):** #12, #13, #14 sequential.

## Gates (places to stop and surface to user)

- After **#1** ships: pause, verify build chain + systemd unit + first boot. Get user sign-off on the boot story before going further.
- After **#2** ships: pause, verify auth + CSRF + safety defaults. Confirm the hardening posture before adding mutating routes.
- After each phase (Vault, RAG, Ops, Chatbot): pause, PR + merge gate before next phase.
- If you discover the `skill-rag-qdrant` API surface doesn't match what's in `~/.openclaw/skills/rag-qdrant/SKILL.md`, stop and ask the user.

## Risk callouts

- **Subprocess output capturing.** All `bin/secret` + `cron` + `sessions_list` calls return JSON. The dashboard must JSON-parse defensively (non-zero exit + empty stdout = surface as "vault unreachable", not 500).
- **API key handling.** The vault init form accepts a paste. The key must be: (a) passed via stdin or `--api-key ***` flag, never as a CLI arg in argv (process list exposure); (b) never logged; (c) never echoed back to the user in any response body; (d) wiped from any in-memory buffer immediately after use.
- **CSRF on every mutating route.** Even with `READONLY_MODE=true` (which is the v1 default), the init / ingest / send / cron-control routes must require a valid CSRF token. A misconfigured `READONLY_MODE` flag must not silently disable CSRF — fail closed.
- **`bin/secret` env inheritance.** When the dashboard spawns `bin/secret`, it must inherit `SKILL_SECRET_KMS_BACKEND`, `SKILL_SECRET_KMS_PROJECT_URL`, `SKILL_SECRET_KMS_API_BLOB`, `SKILL_SECRET_PASSPHRASE` (if set) from the dashboard's own env, not the user's request body. The dashboard's systemd unit is the source of truth.
- **`rag-qdrant` lazy import pattern.** If you wrap the Python `rag_qdrant` module via a small adapter, mirror the lazy-import + `sys.modules` injection pattern from `skill-secret` v4 tests so the dashboard boots even when `rag-qdrant` deps aren't installed yet.
- **No `/tmp` usage.** Same rule as skill-secret v4: use `os.tmpdir()` is NOT acceptable; use a project-local temp dir.
- **Public exposure is v2.** v1 binds `127.0.0.1`. Don't add iptables pinhole, public-IP env var, or `AOA_EXTRA_ORIGINS`-style patterns until the user explicitly asks for v2.

## Open questions for the user

Decide up-front, before Build starts:

1. **`skill-secret` reveal flow.** When viewing a secret's metadata, can the admin click "reveal" to see the plaintext? If yes, that needs a separate confirm step + audit log entry + per-session rate limit. If no, the dashboard is strictly metadata-only. **Recommended: no reveal in v1.**
2. **RAG chunking defaults.** What's the default chunk size + overlap for `/rag/ingest`? Look at `~/.openclaw/skills/rag-qdrant/` for the existing defaults; if none are documented, pick `800/200` as a safe default and surface both as form fields.
3. **Log tail depth.** `/logs` shows last N lines on each load, then polls every M seconds for refresh? Or initial-load-only + manual "refresh" button? Polling is friendlier but more complex. **Recommended: initial 200 lines + 5s polling.**
4. **Chatbot admin send.** Should the manual send route bypass the LLM router (send as admin user) or be flagged as an admin intervention (visible to the customer)? Per skill-chatbot's existing patterns, this is probably the second one — but confirm.

## Your deliverable for this Plan pass

Produce a single planning document at `docs/plans/phase-0-bootstrap.md` (and only that file — do not create other files). It must contain:

1. **Project layout** — the exact directory tree (down to the file level), with one-line purpose for each file. Mirror `openclaw-control-center`'s structure with one change: add `src/routes/vault/`, `src/routes/rag/`, `src/routes/ops/`, `src/routes/chatbot/` sub-modules.
2. **Tech choices** — locked-in library versions and one-sentence justifications (why Fastify over Express, why EJS over React, why pino over winston, why vitest over jest, why argon2 over bcrypt, why CSRF double-submit over SameSite-only).
3. **Systemd unit catalogue** — the exact `skill-admin-dashboard.service` content for v1 (`127.0.0.1:4320`, no public exposure).
4. **Makefile target catalogue** — every target at the project root, with the exact command each one runs.
5. **Sequencing plan for all 14 issues** — issue order respecting the dependency graph above, grouped into "parallel batches" and "gates".
6. **Risk callouts** — anything from the brief above that could blow up at runtime.
7. **Open questions for the user** — anything you genuinely cannot decide from this brief.

Hard constraints:
- Do not write code, do not commit, do not push.
- Do not open PRs, do not file new issues, do not edit issue bodies.
- Do not create files outside `docs/plans/phase-0-bootstrap.md`.
- If you need to read code from outside the project dir, read it; do not modify it.
- When you're done, print a one-paragraph summary to stdout and exit.
