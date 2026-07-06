#!/usr/bin/env bash
# File the 14 implementation issues + 1 discovery issue for skill-admin-dashboard.
# Run from the project root.
set -euo pipefail

REPO="A-I-M-S/skill-admin-dashboard"

file_issue() {
  local title="$1"
  local body="$2"
  local labels="$3"
  gh issue create \
    --repo "$REPO" \
    --title "$title" \
    --body "$body" \
    --label "$labels" \
    --assignee aloycwl
}

# ───────────────────────────── Discovery ─────────────────────────────

file_issue \
  "discovery: skill-chatbot CLI surface for /chatbot admin routes" \
"## Why
Phase 4 (Issues #12–#14) cannot be planned in detail until we know the \`skill-chatbot\` CLI surface. The dashboard needs to list active conversations, show last-N messages per phone, view the handoff queue, and send admin messages — but we don't yet know which \`skill-chatbot\` subcommands (if any) expose this, or whether the dashboard needs to read the SQLite DB directly.

## Tasks
- [ ] Read \`projects/skill-chatbot/SKILL.md\` + \`projects/skill-chatbot/README.md\` + \`projects/skill-chatbot/orchestrator/\` source.
- [ ] Enumerate existing CLI subcommands (\`bin/...\` or \`orchestrator.py ...\`). For each: what does it do, what does it return, what env vars does it need?
- [ ] Check the SQLite schema (\`state.db\` or equivalent). Tables: \`conversations\`, \`messages\`, \`handoff_queue\`, \`bookings\`, etc.
- [ ] Determine the cleanest dashboard integration:
  - **Option A:** extend \`skill-chatbot\` with new \`bin/chatbot-admin list-conversations|list-messages|handoff-queue|admin-send\` subcommands (preferred — keeps the surface inside the source-of-truth repo)
  - **Option B:** dashboard reads the SQLite DB directly (acceptable if the schema is stable)
  - **Option C:** dashboard talks to the orchestrator over HTTP (only if \`/admin/\` endpoints already exist)
- [ ] Document the decision + the exact CLI/DB contract in \`docs/plans/phase-4-chatbot-contract.md\` (new file, written as part of this issue).

## Acceptance criteria
- [ ] \`docs/plans/phase-4-chatbot-contract.md\` committed, with the chosen integration option spelled out + the exact command(s) the dashboard will invoke.
- [ ] If Option A: a draft PR linked from this issue with the new subcommands scaffolded.

## Out of scope
- Implementing the dashboard Phase 4 routes — those are #12, #13, #14.

## References
- \`projects/skill-chatbot/SKILL.md\`
- \`projects/skill-chatbot/orchestrator/\`
- \`references/upstream/skill-chatbot-brief.md\` (the original brief that defined the chatbot)" \
  "phase:4-chatbot,discovery"

# ───────────────────────────── Phase 1: Vault ─────────────────────────────

file_issue \
  "Phase 1 #1: project scaffold (layout, build chain, TS strict, Fastify boot, pino, systemd)" \
"## Goal
Bare-bones Fastify server boots, builds, runs under systemd on 127.0.0.1:4320, logs to pino with a redact list. No routes yet beyond \`GET /healthz\`.

## Plan reference
\`docs/plans/phase-0-bootstrap.md\` — Project layout + Stack + systemd unit sections.

## Files
- \`package.json\` — fastify ^4.28, tsx, typescript ^5.8, pino ^9, pino-pretty (dev), @types/node, vitest, supertest, eslint, prettier, argon2, @fastify/cookie, @fastify/session, @fastify/csrf-protection, @fastify/multipart, ejs, @fastify/static, @fastify/formbody
- \`tsconfig.json\` — strict, ES2022, target Node 20, \`outDir: dist\`
- \`eslint.config.js\` — flat config, typescript-eslint, prettier
- \`.prettierrc\` — defaults + 100 cols
- \`.env.example\` — all env vars from \`references/upstream/openclaw-control-center/.env.example\` + this project's additions (\`HOST\`, \`PORT\`, \`LOCAL_API_TOKEN\`)
- \`src/index.ts\` — entrypoint
- \`src/config.ts\` — env loading + safety defaults (\`READONLY_MODE=true\`, \`APPROVAL_ACTIONS_ENABLED=false\`, \`IMPORT_MUTATION_ENABLED=false\`)
- \`src/server.ts\` — Fastify instance, register pino, register healthz, listen
- \`src/types.ts\` — \`AppConfig\`, \`Session\`, \`CsrfToken\` types
- \`test/healthz.test.ts\` — 200 OK on \`/\`
- \`systemd/skill-admin-dashboard.service\` — see plan section 'systemd unit'
- \`Makefile\` — all 18 targets per plan section '18 Makefile targets'

## Acceptance criteria
- [ ] \`npm ci && npm run build && npm start\` boots cleanly on 127.0.0.1:4320
- [ ] \`GET /healthz\` returns \`{ok:true}\` with HTTP 200
- [ ] pino logs to stdout in JSON; redact list covers cookie/authorization/apiKey/passphrase/token
- [ ] \`make verify:no-tmp\` passes (no \`/tmp\`, \`os.tmpdir()\`, or \`0.0.0.0\` in \`src/\`)
- [ ] \`sudo make service:install && sudo systemctl start skill-admin-dashboard.service\` works; \`journalctl -u skill-admin-dashboard.service\` shows clean startup
- [ ] vitest green: \`test/healthz.test.ts\`

## Out of scope
- Auth, CSRF, layout, vault routes — those are #2–#5." \
  "phase:0-bootstrap"

file_issue \
  "Phase 1 #2: auth + CSRF + layout shell + nav + safety defaults" \
"## Goal
Argon2id cookie sessions + CSRF double-submit + HTTP basic-auth fallback gated by \`LOCAL_TOKEN_AUTH_REQUIRED\`. EJS layout shell with nav links (greyed out, no routes yet). Session id rotation on login.

## Plan reference
\`docs/plans/phase-0-bootstrap.md\` — Risks #3, #10, #12 + layout section.

## Files
- \`src/auth/session.ts\` — @fastify/cookie + @fastify/session, argon2id for password hashes, session id rotation
- \`src/auth/csrf.ts\` — @fastify/csrf-protection, token bound to session, rotated on login
- \`src/auth/local-token.ts\` — HTTP basic fallback when \`LOCAL_TOKEN_AUTH_REQUIRED=true\`
- \`src/views/layout.ejs\` — header + nav + footer
- \`src/views/partials/csrf-input.ejs\` — \`<input type=\"hidden\" name=\"_csrf\">\`
- \`src/routes/login.ts\` — \`GET /login\` (form), \`POST /login\` (auth + rotate session + rotate CSRF)
- \`src/routes/logout.ts\` — \`POST /logout\` (destroy session)
- \`src/lib/audit.ts\` — append-only 0o600 audit log at \`runtime/audit.log\` (write helpers, JSON-line shape)
- \`test/auth.test.ts\` — session rotation, CSRF fail-closed (POST without token = 403), basic-auth fallback, redirect-to-login for unauthenticated requests

## Acceptance criteria
- [ ] \`GET /login\` shows form, \`POST /login\` with valid creds sets cookie + redirects, with invalid creds shows 401
- [ ] Any mutating POST without a valid CSRF token returns 403, regardless of \`READONLY_MODE\`
- [ ] \`LOCAL_TOKEN_AUTH_REQUIRED=true\` enables HTTP basic; \`curl -u admin:\$TOKEN http://127.0.0.1:4320/healthz\` returns 200
- [ ] Session id changes on login (test asserts cookie value differs before/after)
- [ ] EJS layout renders with nav links to \`/\`, \`/vault\`, \`/rag\`, \`/cron\`, \`/sessions\`, \`/logs\`, \`/chatbot\` (all 404 except \`/\`)
- [ ] \`<%= %>\` (escaped) used for all user data; no \`<%- %>\` for user data (XSS guard)
- [ ] vitest green: \`test/auth.test.ts\` + \`test/healthz.test.ts\` (no regression)

## Out of scope
- Vault / rag / ops / chatbot routes — #3–#14." \
  "phase:0-bootstrap"

file_issue \
  "Phase 1 #3: / status dashboard + bin/secret subprocess wrapper + env inheritance" \
"## Goal
\`GET /\` shows a status dashboard: vault backend (\`skill-secret\` mode), recent secrets (last 5 by mtime), cron count, agent count. \`bin/secret\` subprocess wrapper with env inheritance from the dashboard's own env (NOT the request body).

## Plan reference
\`docs/plans/phase-0-bootstrap.md\` — Routes > \`routes/index.ts\` + Risks #1, #4.

## Files
- \`src/lib/subprocess.ts\` — generic spawn wrapper, JSON parse, timeout (10s default), exit-code handling
- \`src/lib/bin-secret.ts\` — wraps \`bin/secret whoami|list\` + \`bin/secret\` binary path resolution (env \`SKILL_SECRET_BIN\`, default \`/root/.openclaw/workspace/dev/projects/skill-secret/bin/secret\`)
- \`src/lib/openclaw-bin.ts\` — resolves \`cron\`, \`sessions_list\`, etc. via \`OPENCLAW_BIN\` env
- \`src/routes/index.ts\` — \`GET /\` aggregates: vault whoami + recent secrets + cron count + agent count
- \`src/views/index.ejs\` — status cards layout
- \`test/vault.test.ts\` (start) — stub \`bin/secret\` via mock-subprocess helper; assert whoami + list calls go through with inherited env

## Acceptance criteria
- [ ] \`GET /\` returns 200 with the status dashboard for an authenticated user
- [ ] \`bin/secret\` subprocess inherits \`SKILL_SECRET_KMS_BACKEND\`, \`SKILL_SECRET_KMS_PROJECT_URL\`, \`SKILL_SECRET_KMS_API_BLOB\` from the dashboard's env (test asserts via spawn-args mock)
- [ ] Non-zero exit + empty stdout surfaces as \"vault unreachable\" — NOT 500
- [ ] vitest green: \`test/vault.test.ts\` + existing auth/healthz

## Out of scope
- \`/vault\` list UI, \`/vault/init\` form — #4, #5." \
  "phase:1-vault"

file_issue \
  "Phase 1 #4: /vault list + search (read-only metadata only)" \
"## Goal
\`GET /vault\` lists secrets (metadata only — name, tags, mtime — NO plaintext) with a search box. \`GET /vault/:id\` shows metadata + whoami context.

## Plan reference
\`docs/plans/phase-0-bootstrap.md\` — Routes > \`routes/vault/list.ts\`, \`routes/vault/show.ts\` + Risk #1 (Q1 decision: NO reveal in v1).

## Files
- \`src/lib/bin-secret.ts\` — add \`list()\` + \`get(id)\` functions returning \`{name, tags, mtime, sha}\` (NEVER plaintext)
- \`src/routes/vault/list.ts\` — \`GET /vault\` with \`?q=\` query param for search
- \`src/routes/vault/show.ts\` — \`GET /vault/:id\` metadata + whoami
- \`src/views/vault/list.ejs\` — table with search box
- \`src/views/vault/show.ejs\` — metadata table
- \`test/vault.test.ts\` (extend) — list, search, show; assert no plaintext in response body

## Acceptance criteria
- [ ] \`GET /vault\` shows table of secrets; \`?q=foo\` filters to matching names/tags
- [ ] \`GET /vault/:id\` shows metadata + whoami context for that secret
- [ ] Response body NEVER contains the plaintext secret value (test asserts by fuzzing)
- [ ] vitest green: \`test/vault.test.ts\` + all previous

## Out of scope
- \`/vault/init\` form — #5." \
  "phase:1-vault"

file_issue \
  "Phase 1 #5: /vault/init form + audit log entry for init" \
"## Goal
\`GET /vault/init\` shows a form (project URL + API key paste). \`POST /vault/init\` writes the API key to a repo-local temp file, invokes \`bin/secret init --url --api-key-file\`, immediately deletes the temp file, and writes an audit log entry.

## Plan reference
\`docs/plans/phase-0-bootstrap.md\` — Risks #2, #4, #13 + Routes > \`routes/vault/init.ts\`.

## Files
- \`src/lib/tmp.ts\` — \`runtime/tmp/<uuid>/\` helper; auto-cleanup on process exit
- \`src/lib/bin-secret.ts\` — extend with \`init({url, apiKey})\` using \`--api-key-file\` flow
- \`src/routes/vault/init.ts\` — \`GET /vault/init\` (form), \`POST /vault/init\` (CSRF-gated, audit-logged)
- \`src/views/vault/init.ejs\` — form with CSRF token + paste field + confirm checkbox
- \`test/vault.test.ts\` (extend) — init happy path; assert API key never appears in logs, response body, or persisted state; assert audit log entry shape

## Acceptance criteria
- [ ] \`GET /vault/init\` shows form (CSRF token embedded)
- [ ] \`POST /vault/init\` without CSRF token = 403
- [ ] \`POST /vault/init\` with valid form: writes key to \`runtime/tmp/<uuid>/key\` (mode 0o600), invokes \`bin/secret init --url <url> --api-key-file <path>\`, deletes the temp file, writes audit log entry \`{ts, actor, action: 'vault.init', vault: '...', url_hash: '...'}\`
- [ ] API key NEVER appears in: pino logs (redact list covers it), response body, audit log, persisted state
- [ ] \`make verify:no-tmp\` passes (uses \`runtime/tmp/\` not \`/tmp\`)
- [ ] vitest green: \`test/vault.test.ts\` + \`test/audit.test.ts\` (new) + all previous" \
  "phase:1-vault"

# ───────────────────────────── Phase 2: RAG ─────────────────────────────

file_issue \
  "Phase 2 #6: /rag collection stats + source-file listing" \
"## Goal
\`GET /rag\` shows collection stats: point count, vector dims, last ingest timestamp, list of source files (filename + size, no content).

## Plan reference
\`docs/plans/phase-0-bootstrap.md\` — Routes > \`routes/rag/stats.ts\` + Risk #5 (lazy rag subprocess).

## Files
- \`src/lib/rag-subprocess.ts\` — Python subprocess wrapper around \`rag_qdrant.stats()\` + \`rag_qdrant.list_sources()\`; if \`rag_qdrant\` import fails, returns \`{ok:false, reason:'rag_unavailable'}\` (NOT crash)
- \`src/routes/rag/stats.ts\` — \`GET /rag\` with 503 fallback if rag unavailable
- \`src/views/rag/stats.ejs\` — stats cards + source file table
- \`test/rag.test.ts\` (start) — happy path with mocked rag subprocess; 503 path when rag import fails

## Acceptance criteria
- [ ] \`GET /rag\` returns 200 with stats when rag is available
- [ ] \`GET /rag\` returns 503 with \`{ok:false, reason:'rag_unavailable'}\` when rag_qdrant can't be imported (test asserts)
- [ ] Source file list shows filename + size, never content
- [ ] vitest green: \`test/rag.test.ts\` + all previous" \
  "phase:2-rag"

file_issue \
  "Phase 2 #7: /rag/ingest file upload + /rag/ingest/text + chunking params" \
"## Goal
\`GET /rag/ingest\` shows a form with: file upload OR text paste, chunk size (default 800), overlap (default 200), source tag. \`POST /rag/ingest\` (multipart) and \`POST /rag/ingest/text\` invoke rag_qdrant ingest.

## Plan reference
\`docs/plans/phase-0-bootstrap.md\` — Routes > \`routes/rag/ingest.ts\` + Risks #5, #8 (multipart caps).

## Files
- \`src/lib/rag-subprocess.ts\` — add \`ingest_file(path, {chunk_size, overlap, source_tag})\` + \`ingest_text(text, {chunk_size, overlap, source_tag})\`
- \`src/routes/rag/ingest.ts\` — \`GET /rag/ingest\` (form), \`POST /rag/ingest\` (multipart, 10 MiB cap), \`POST /rag/ingest/text\` (form-encoded)
- \`src/views/rag/ingest.ejs\` — form with file input + text paste + chunking params + CSRF
- \`test/rag.test.ts\` (extend) — happy paths for both; 413 on oversize multipart; audit log entry

## Acceptance criteria
- [ ] \`GET /rag/ingest\` shows form (CSRF + chunking defaults 800/200)
- [ ] \`POST /rag/ingest\` accepts \`.md\`, \`.txt\`, \`.json\`, \`.yaml\`; rejects others with 415
- [ ] \`POST /rag/ingest\` with file > 10 MiB returns 413
- [ ] \`POST /rag/ingest/text\` accepts text up to 1 MiB
- [ ] Both routes write audit log entry \`{ts, actor, action: 'rag.ingest', source: '...'|'text', chunks: N}\`
- [ ] vitest green: \`test/rag.test.ts\` + all previous" \
  "phase:2-rag"

file_issue \
  "Phase 2 #8: /rag/search admin-only rag.ask() + top-3 hits + scores" \
"## Goal
\`GET /rag/search\` shows a search form (question input). \`POST /rag/search\` invokes rag_qdrant.ask() and returns top-3 hits with scores.

## Plan reference
\`docs/plans/phase-0-bootstrap.md\` — Routes > \`routes/rag/search.ts\`.

## Files
- \`src/lib/rag-subprocess.ts\` — add \`ask(question, top_k=3)\`
- \`src/routes/rag/search.ts\` — \`GET /rag/search\` (form), \`POST /rag/search\` (form-encoded, audit-logged)
- \`src/views/rag/search.ejs\` — form + results table
- \`test/rag.test.ts\` (extend) — happy path; 503 when rag unavailable; audit log entry

## Acceptance criteria
- [ ] \`GET /rag/search\` shows form (CSRF)
- [ ] \`POST /rag/search\` returns top-3 hits with scores in descending order
- [ ] Audit log entry: \`{ts, actor, action: 'rag.search', question_hash: '...', top_k: 3}\` (question hash, not question text — privacy)
- [ ] 503 when rag unavailable (consistent with #6)
- [ ] vitest green: \`test/rag.test.ts\` + all previous" \
  "phase:2-rag"

# ───────────────────────────── Phase 3: Ops ─────────────────────────────

file_issue \
  "Phase 3 #9: /cron list + pause + resume + run-now + remove" \
"## Goal
\`GET /cron\` lists cron jobs (id, name, schedule, last run, enabled). \`POST /cron/:id/pause|resume|run|remove\` mutates via the \`cron\` tool.

## Plan reference
\`docs/plans/phase-0-bootstrap.md\` — Routes > \`routes/ops/cron.ts\` + Risk #11 (OPENCLAW_BIN resolution).

## Files
- \`src/lib/openclaw-bin.ts\` — resolve \`cron\` binary via \`OPENCLAW_BIN\` env
- \`src/lib/subprocess.ts\` — add \`list\` (used here for \`cron list\`)
- \`src/routes/ops/cron.ts\` — \`GET /cron\`, \`POST /cron/:id/pause\`, \`POST /cron/:id/resume\`, \`POST /cron/:id/run\`, \`POST /cron/:id/remove\` (all CSRF-gated, audit-logged)
- \`src/views/ops/cron.ejs\` — table with action buttons + CSRF
- \`test/ops.test.ts\` (start) — list happy path; each action happy + 404 paths

## Acceptance criteria
- [ ] \`GET /cron\` returns table with id, name, schedule, last run, enabled
- [ ] All four mutating routes CSRF-gated, audit-logged
- [ ] Audit log entries: \`{ts, actor, action: 'cron.{pause,resume,run,remove}', job_id}\`
- [ ] \`cron\` binary path resolved via \`OPENCLAW_BIN\` (test asserts)
- [ ] vitest green: \`test/ops.test.ts\` + all previous" \
  "phase:3-ops"

file_issue \
  "Phase 3 #10: /sessions list + last message + deep link to session JSONL" \
"## Goal
\`GET /sessions\` lists visible sessions (key, kind, channel, last message, started, updated) with a deep link to the session JSONL transcript path.

## Plan reference
\`docs/plans/phase-0-bootstrap.md\` — Routes > \`routes/ops/sessions.ts\` + Risk #11.

## Files
- \`src/lib/openclaw-bin.ts\` — add \`sessions_list\` resolution (or invoke via subprocess if no binary)
- \`src/routes/ops/sessions.ts\` — \`GET /sessions\` (read-only)
- \`src/views/ops/sessions.ejs\` — table with deep link (\`file://<transcript_path>\` — won't open in browser, just shows path)
- \`test/ops.test.ts\` (extend) — list happy path

## Acceptance criteria
- [ ] \`GET /sessions\` returns table with the listed columns
- [ ] Deep link shows the transcript path (read-only — no streaming)
- [ ] vitest green: \`test/ops.test.ts\` + all previous

## Out of scope
- Reading the JSONL contents in the dashboard (would need streaming + sanitization). Deep link only in v1." \
  "phase:3-ops"

file_issue \
  "Phase 3 #11: /logs tail 4 services in tabs" \
"## Goal
\`GET /logs\` shows 4 tabs (aoa, openclaw-control-center, wa-bridge, orchestrator). Each tab loads the last 200 lines of \`journalctl -u <service>\` and polls every 5s.

## Plan reference
\`docs/plans/phase-0-bootstrap.md\` — Routes > \`routes/ops/logs.ts\` + Risk #9 (ANSI strip).

## Files
- \`src/lib/journal.ts\` — \`journalctl -u <service> -n 200 --no-pager\` subprocess with \`SYSTEMD_COLORS=0 TERM=dumb\`, ANSI strip
- \`src/routes/ops/logs.ts\` — \`GET /logs\` (initial load), \`GET /logs/:service?since=<cursor>\` (poll endpoint, returns new lines only)
- \`src/views/ops/logs.ejs\` — Alpine.js tabs + 5s polling
- \`test/ops.test.ts\` (extend) — initial load + poll; ANSI stripped in response body

## Acceptance criteria
- [ ] \`GET /logs\` shows 4 tabs
- [ ] Initial tab load returns last 200 lines (per Q3 default)
- [ ] Polling endpoint \`/logs/:service?since=\` returns only new lines (cursor = byte offset of last delivered line)
- [ ] ANSI escapes stripped from response body (test asserts by including known escape sequences in mock journalctl output)
- [ ] vitest green: \`test/ops.test.ts\` + all previous

## Out of scope
- WebSocket streaming (v2). Polling is the v1 mechanism." \
  "phase:3-ops"

# ───────────────────────────── Phase 4: Chatbot ─────────────────────────────

file_issue \
  "Phase 4 #12: /chatbot/conversations active list + phone filter" \
"## Goal
\`GET /chatbot/conversations\` lists active conversations (phone, last message ts, handoff flag, message count) with a phone filter input.

## Plan reference
\`docs/plans/phase-0-bootstrap.md\` — Routes > \`routes/chatbot/conversations.ts\` + depends on the discovery issue for the CLI/DB contract.

## Blocker
**Must wait for the discovery issue** to land \`docs/plans/phase-4-chatbot-contract.md\`. The integration approach (CLI subcommand vs. SQLite read vs. HTTP) determines the implementation here.

## Files (TBD based on discovery)
- \`src/lib/chatbot-admin.ts\` — chosen integration wrapper
- \`src/routes/chatbot/conversations.ts\` — \`GET /chatbot/conversations\` with \`?phone=\` filter
- \`src/views/chatbot/conversations.ejs\` — table with phone filter
- \`test/chatbot.test.ts\` (start) — happy path; phone filter

## Acceptance criteria
- [ ] \`GET /chatbot/conversations\` returns table with phone, last_ts, handoff, msg_count
- [ ] \`?phone=6591234567\` filters to that phone only
- [ ] vitest green: \`test/chatbot.test.ts\` + all previous" \
  "phase:4-chatbot"

file_issue \
  "Phase 4 #13: /chatbot/conversations/:phone last 50 messages" \
"## Goal
\`GET /chatbot/conversations/:phone\` shows the last 50 messages for that phone (inbound + outbound, with timestamps and direction).

## Plan reference
\`docs/plans/phase-0-bootstrap.md\` — Routes > \`routes/chatbot/conversations.ts\` (the \`:phone\` sub-route).

## Blocker
Same as #12 — depends on the discovery issue.

## Files (TBD)
- Extend \`src/routes/chatbot/conversations.ts\` with the \`:phone\` handler
- Extend \`src/views/chatbot/conversations.ejs\` with a detail partial
- Extend \`test/chatbot.test.ts\`

## Acceptance criteria
- [ ] \`GET /chatbot/conversations/:phone\` returns last 50 messages, oldest first
- [ ] Direction (inbound / outbound) clearly marked
- [ ] 404 for unknown phone
- [ ] vitest green: \`test/chatbot.test.ts\` + all previous" \
  "phase:4-chatbot"

file_issue \
  "Phase 4 #14: /chatbot/handoff queue + /chatbot/send admin manual send + audit" \
"## Goal
\`GET /chatbot/handoff\` shows the handoff queue. \`POST /chatbot/send\` sends an admin message to a phone, flagged as an admin intervention (per Q4 default).

## Plan reference
\`docs/plans/phase-0-bootstrap.md\` — Routes > \`routes/chatbot/handoff.ts\`, \`routes/chatbot/send.ts\` + Q4 (flagged intervention).

## Blocker
Same as #12 — depends on the discovery issue.

## Files (TBD)
- \`src/routes/chatbot/handoff.ts\` — \`GET /chatbot/handoff\`
- \`src/routes/chatbot/send.ts\` — \`GET /chatbot/send\` (form), \`POST /chatbot/send\` (CSRF-gated, audit-logged)
- \`src/views/chatbot/handoff.ejs\`
- \`src/views/chatbot/send.ejs\`
- Extend \`test/chatbot.test.ts\`

## Acceptance criteria
- [ ] \`GET /chatbot/handoff\` shows the handoff queue
- [ ] \`GET /chatbot/send\` shows form (phone + message + CSRF + confirm checkbox)
- [ ] \`POST /chatbot/send\` with valid form: sends message, flags as admin intervention, writes audit log entry \`{ts, actor, action: 'chatbot.send', phone_hash: '...', length: N}\` (phone hash, not raw phone — privacy)
- [ ] \`POST /chatbot/send\` without CSRF = 403
- [ ] vitest green: \`test/chatbot.test.ts\` + all previous" \
  "phase:4-chatbot"

echo "=== all 15 issues filed ==="
gh issue list --repo "$REPO" --state open --limit 20 --json number,title,labels | jq -r '.[] | \"  #\\(.number) \\(.title) [\\([.labels[].name] | join(\\\", \\\"))]\"'
