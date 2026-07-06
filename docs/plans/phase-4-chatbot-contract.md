# Phase 4 — skill-chatbot integration contract

> Closes discovery issue #1. Locks the integration approach and the exact
> CLI surface the dashboard will invoke. Implementation of dashboard
> routes lives in #13 / #14 / #15 (this repo). Implementation of the new
> `bin/chatbot-admin` subcommands lives in the
> [`skill-chatbot`](https://github.com/A-I-M-S/skill-chatbot) repo.

## Decision — **Option A: extend `skill-chatbot` with `bin/chatbot-admin` subcommands**

The dashboard invokes a new dispatcher binary inside the
`skill-chatbot` repo. Each subcommand:

- reads the orchestrator's existing SQLite DB (no schema duplication),
- returns one JSON line on stdout,
- inherits `CHATBOT_REPO`, `ORCHESTRATOR_DB`, `WA_BRIDGE_URL`,
  `WA_BRIDGE_TOKEN`, `WA_NOTIFY`, `ADMIN_CONTACT_NUMBER` from the
  dashboard's own env (via the dashboard's systemd `EnvironmentFile=`)
  — never from the request body,
- exits non-zero on error with an error envelope (see below).

### Why A, not B or C

| Option | Verdict | Reason |
|---|---|---|
| **A — `bin/chatbot-admin <subcmd>`** | ✅ **Chosen** | Keeps the source of truth inside the orchestrator repo. New auth boundary = OS-level (subprocess inherits env). Mirrors the project's existing `scripts/` pattern. |
| B — dashboard reads `state.sqlite` directly | ❌ rejected | Brittle to schema migrations in the orchestrator. No abstraction over the WA-bridge transport. The dashboard would need to replicate the flock + WAL semantics. |
| C — HTTP endpoints on the orchestrator | ❌ rejected | Would require new auth (bearer / local token) on a service whose `/health` is intentionally unauthenticated. Expands the orchestrator's attack surface for read-only admin UI. |

### Why we accept the cross-repo coupling

The dashboard already depends on `bin/secret` (a Python wrapper inside
the `skill-secret` repo) for the vault. Adding one more wrapper of the
same shape is consistent with the established pattern. The contract is
stable; the orchestrator's internal schema can change freely as long as
the JSON envelope holds.

## Binary location & invocation

```bash
# Dashboard resolves the binary via CHATBOT_ADMIN_BIN env var
# (defaults to: $CHATBOT_REPO/bin/chatbot-admin)
# CHATBOT_REPO defaults to ~/projects/skill-chatbot (same as skill-chatbot
# SKILL.md convention). The dashboard's systemd unit sets these.

# Invocation pattern — every subcommand follows it:
"$CHATBOT_ADMIN_BIN" <subcommand> [args...] [--json]
#   --json is implicit; one JSON line on stdout, optional human logs on stderr
```

The wrapper script at `bin/chatbot-admin` (new file, lives inside the
`skill-chatbot` repo) is a thin shell script that activates the
orchestrator venv and dispatches to the right Python entry point — same
shape as `references/upstream/skill-secret/bin-secret`.

## Subcommand surface (v1)

All subcommands:

- print **one JSON line** on stdout,
- print optional human logs on stderr,
- never echo the bearer token / api key / phone message body in errors,
- exit `0` on success, `1` internal error, `2` bad args, `3` transport
  error (wa-bridge down), `4` DB error / not initialized, `5` not
  authorized (e.g. handoff queue entry is from a different tenant).

### 1. `list-conversations`

```bash
bin/chatbot-admin list-conversations \
    [--limit 50] [--phone-prefix +65] [--active-within-min 60] [--json]
```

Stdout (one line):

```json
{
  "ok": true,
  "conversations": [
    {
      "phone": "+6591234567",
      "last_message_id": "ABC123",
      "last_message_at": "2026-07-06T15:30:00Z",
      "last_image": null,
      "flow": "idle",
      "language": "en",
      "message_count_24h": 12,
      "handoff_open": false,
      "handoff_reason": null,
      "handoff_since": null
    }
  ],
  "count": 1
}
```

Derivation:

- one row per phone in `phone_state`,
- `last_message_at` ← `state_log.at` of latest row for that phone (or
  `processed_messages.processed_at` joined on a phone ↔ message_id
  mapping; this is the reason we add a `messages` table — see "Schema
  addition" below),
- `last_image` ← `last_image.saved_at` if present,
- `message_count_24h` ← `COUNT(*)` of inbound rows from the new
  `messages` table in the last 24 h,
- `handoff_open` / `handoff_reason` / `handoff_since` ← derived from
  the most recent `state_log` row whose `new_flow = 'handoff'` and
  where no later row has `new_flow = 'idle'` (i.e. handoff still
  active).

### 2. `list-messages <phone>`

```bash
bin/chatbot-admin list-messages <phone> --limit 50 [--include-admin 0] [--json]
```

- `<phone>` is required, must match `^\+?\d{6,15}$`,
- `--limit` defaults to 50, capped at 500,
- `--include-admin` (default `0`) — when `1`, also returns rows written
  by `admin-send` (i.e. admin interventions).

Stdout (one line):

```json
{
  "ok": true,
  "phone": "+6591234567",
  "messages": [
    {
      "message_id": "ABC123",
      "direction": "inbound",
      "text": "what is this?",
      "image": null,
      "timestamp": "2026-07-06T15:30:00Z",
      "tool": "faq",
      "flow_at_send": "idle",
      "is_fallback": false,
      "is_admin": false
    },
    {
      "message_id": "wa-msg-xyz",
      "direction": "outbound",
      "text": "Got the photo.",
      "image": null,
      "timestamp": "2026-07-06T15:30:01Z",
      "tool": "image_ack",
      "flow_at_send": "idle",
      "is_fallback": false,
      "is_admin": false
    }
  ],
  "count": 2
}
```

### 3. `handoff-queue`

```bash
bin/chatbot-admin handoff-queue [--include-resolved 0] [--json]
```

- `--include-resolved` (default `0`) — when `1`, also returns handoffs
  that have been resolved (an `idle` flow row exists after the handoff).

Stdout (one line):

```json
{
  "ok": true,
  "queue": [
    {
      "phone": "+6591234567",
      "reason": "complaint",
      "summary": "Customer reports overcharge on last tour.",
      "since": "2026-07-06T15:00:00Z",
      "is_fallback": false,
      "last_message_at": "2026-07-06T15:25:00Z",
      "language": "en"
    }
  ],
  "count": 1
}
```

### 4. `admin-send <phone> --text <text>`

```bash
bin/chatbot-admin admin-send <phone> --text <text> \
    [--actor "aloycwl"] [--reply-to <message_id>] [--json]
```

- `<phone>` is required, must match `^\+?\d{6,15}$`,
- `--text` is required, max 4096 chars (matches WhatsApp's outbound
  text limit),
- `--actor` defaults to the env `CHATBOT_ADMIN_ACTOR` if set, else
  `"unknown"`,
- `--reply-to` is optional — when set, references an inbound
  `message_id` (used by the dashboard's "reply" UI to thread the
  intervention).

**Side effects (in this order, transactional where possible):**

1. **Append a row to `state_log`** with
   `old_flow = <current phone_state.flow>`,
   `new_flow = 'admin_send'`, `new_draft = {"actor": <actor>,
   "reply_to": <message_id or null>}`. This is the source of truth.
2. **POST to `WA_BRIDGE_URL/send`** with body
   `{"to": <phone>, "text": <text>, "metadata": {"admin": true,
   "actor": <actor>, "reply_to": <message_id>}}`. Wait for 200 +
   `message_id`. If the bridge is down, return error envelope
   (exit 3) and **rollback** the `state_log` row (delete by
   `id = last_insert_rowid()`). v1 uses best-effort: if the
   rollback itself fails, the state_log row is left in
   `new_flow='admin_send'` and a follow-up
   `bin/chatbot-admin reconcile-admin-sends` (out of scope for
   v1 dashboard) cleans it up.
3. **Append a row to the new `messages` table** with
   `direction='outbound'`, `text=<text>`, `is_admin=true`,
   `tool='admin_send'`, `message_id=<bridge response>`.

Stdout (one line):

```json
{
  "ok": true,
  "phone": "+6591234567",
  "message_id": "wa-msg-xyz",
  "sent_at": "2026-07-06T15:30:00Z",
  "actor": "aloycwl",
  "audit_ref": "state_log:42"
}
```

## Schema addition in the orchestrator's SQLite

To support message-history + handoff-queue derivation, the orchestrator
schema gains one new table (`messages`). All other tables are unchanged.

```sql
CREATE TABLE IF NOT EXISTS messages (
    message_id    TEXT PRIMARY KEY,         -- wa-bridge message_id (inbound) or our generated id (outbound / admin_send)
    phone         TEXT NOT NULL,
    direction     TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound', 'admin_send')),
    text          TEXT NOT NULL,
    image_path    TEXT,                      -- nullable; matches last_image.path when inbound had an image
    tool          TEXT,                      -- faq | book_new | book_edit | book_cancel | handoff | image_ack | admin_send | echo
    flow_at_send  TEXT,                      -- phone_state.flow at the time the message was written
    is_fallback   INTEGER NOT NULL DEFAULT 0,
    is_admin      INTEGER NOT NULL DEFAULT 0,
    actor         TEXT,                      -- who sent (admin-send only); null otherwise
    reply_to      TEXT,                      -- inbound message_id this is a reply to (admin-send only)
    timestamp     REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_phone_ts ON messages(phone, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_messages_admin ON messages(is_admin, timestamp) WHERE is_admin = 1;
```

**Writes:**

- `inbound` — added by the existing `main.handle_message` right after
  `state.is_processed(message_id)` returns False.
- `outbound` — added by the dispatcher (`_dispatch_decision`) right
  before `post_reply` returns, OR by `image_handler.process_inbound_image`
  for the ack.
- `admin_send` — added by the new `bin/chatbot-admin admin-send`
  subcommand as part of step 3 (after the wa-bridge POST succeeds).

**Migration:** the table is added in the existing
`executescript(SCHEMA)` block in `state.py` — `CREATE TABLE IF NOT
EXISTS` is idempotent. No version bump is needed for v1.

## Error envelope

Every subcommand prints errors as one JSON line and exits non-zero:

```json
{"ok": false, "error": "db_uninitialized", "code": 4, "hint": "Run init first."}
{"ok": false, "error": "bad_phone", "code": 2, "hint": "phone must match ^\\+?\\d{6,15}$"}
{"ok": false, "error": "bridge_unreachable", "code": 3, "hint": "wa-bridge not responding at http://127.0.0.1:7788"}
{"ok": false, "error": "internal", "code": 1, "hint": "see stderr for traceback"}
```

The dashboard surfaces `error` + `hint` in the toast and never logs
the raw envelope (it may contain phone numbers in some cases —
e.g. `phone_not_found`).

## Environment inheritance

The dashboard's systemd unit (`/etc/systemd/system/skill-admin-dashboard.service`)
must export:

| Env | Source | Purpose |
|---|---|---|
| `CHATBOT_REPO` | `.env` | Repo root (default `~/projects/skill-chatbot`) |
| `CHATBOT_ADMIN_BIN` | `.env` | Absolute path to the wrapper (default `$CHATBOT_REPO/bin/chatbot-admin`) |
| `ORCHESTRATOR_DB` | `.env` | Path to `state.sqlite` (default `$CHATBOT_REPO/orchestrator/state.sqlite`) |
| `WA_BRIDGE_URL` | `.env` | wa-bridge base URL (default `http://127.0.0.1:7788`) |
| `WA_BRIDGE_TOKEN` | `.env` | Bearer token (kept in `.env`, mode 0o600; never in argv) |
| `WA_NOTIFY` | `.env` | Admin DM phones (handoff alert recipients) |
| `ADMIN_CONTACT_NUMBER` | `.env` | Phone the bot tells customers to call on handoff |
| `CHATBOT_ADMIN_ACTOR` | `.env` (optional) | Default actor for `admin-send` if `--actor` not passed |

`bin/chatbot-admin` is invoked as a subprocess by the dashboard's
`lib/chatbot-admin.ts` (new file, mirrors `lib/bin-secret.ts`). All env
vars above are inherited from the dashboard's process env — the
dashboard's systemd unit is the source of truth, **never the request
body**.

## Dashboard-side implementation outline

> Implementation of these three files lives in issues #13, #14, #15 of
> this repo. The contract here is the spec the implementation will
> follow.

### `src/lib/chatbot-admin.ts` (new)

Subprocess wrapper. Mirrors `src/lib/bin-secret.ts`. Exports:

```ts
export type Conversation = { ... };
export type ChatbotMessage = { ... };
export type HandoffEntry = { ... };

export async function listConversations(opts: { limit?: number; phonePrefix?: string; activeWithinMin?: number }): Promise<Conversation[]>;
export async function listMessages(phone: string, opts: { limit?: number; includeAdmin?: boolean }): Promise<ChatbotMessage[]>;
export async function handoffQueue(opts: { includeResolved?: boolean }): Promise<HandoffEntry[]>;
export async function adminSend(phone: string, text: string, opts: { actor: string; replyTo?: string }): Promise<{ messageId: string; sentAt: string; auditRef: string }>;
```

If the wrapper binary is missing, every function returns
`{ ok: false, code: 4, error: 'chatbot_admin_unavailable' }` and the
route returns 503 with a clear message. This is the soft-dependency
pattern from `/rag` (issue #7 / #8) and `/cron` (issue #10).

### `src/lib/subprocess.ts` extension

Add a `runJson<Ok, Err>(bin, args, opts)` helper that:

- spawns the subprocess with `env: { ...process.env, ...extraEnv }`,
  no shell,
- captures stdout, awaits exit,
- on exit `0` and non-empty stdout → JSON.parse → return `{ ok: true, ...parsed }`,
- on non-zero exit OR empty stdout → surface as `{ ok: false, code: <exit>, error: 'unreachable' }`,
- **never** logs stdout when the command is `admin-send` (the body
  contains the customer-bound text). Add a `sensitive: true` flag to
  the call site.

### Audit logging

`admin-send` writes two audit lines:

1. `runtime/audit.log` in the dashboard (via `lib/audit.ts`):
   `{"at": ..., "actor": <session user>, "action": "chatbot.admin_send",
   "phone": <phone>, "message_id": <bridge id>, "audit_ref": "state_log:42"}`.
2. The orchestrator's `state_log` row (written by the wrapper).

The dashboard's audit line is the legal record (the dashboard knows
**who** logged in); the `state_log` row is the source-of-truth event
lifecycle. Both are required.

## Acceptance status for this discovery issue

- [x] Read `projects/skill-chatbot/SKILL.md` + `README.md` + `orchestrator/src/`.
- [x] Enumerate existing CLI subcommands (no admin subcommands exist
      yet; `scripts/{ingest_rules,ingest_file,smoke}.py` are
      non-overlapping).
- [x] Document the SQLite schema (no admin-shape tables exist; need to
      add `messages`).
- [x] Document the chosen integration: **Option A** with the exact
      command envelope above.
- [ ] **Out of scope here:** scaffolding `bin/chatbot-admin` inside the
      `skill-chatbot` repo. That's a cross-repo PR. **Fallback for
      v1 dashboard:** if the wrapper is missing, dashboard routes
      return 503 (`chatbot_admin_unavailable`) — same pattern as
      `/rag` 503 when the rag deps are missing.

## Cross-repo follow-up (filed as a separate issue in skill-chatbot)

The `skill-chatbot` repo needs:

1. `bin/chatbot-admin` wrapper script (new file, mirrors
   `references/upstream/skill-secret/bin-secret`).
2. `orchestrator/src/chatbot_admin.py` (new module) — the four
   subcommand handlers, each ~40-60 LoC, all using the existing
   `state.State` API.
3. `orchestrator/src/state.py` — append the `messages` `CREATE TABLE`
   to the existing `SCHEMA` block.
4. `orchestrator/src/main.py` — write to `messages` in
   `handle_message` (inbound + outbound) and in
   `_dispatch_decision` (outbound).
5. Tests in `orchestrator/tests/test_chatbot_admin.py` (vitest-style
   pytest, uses an in-memory `sqlite3` fixture for the `State`).

Once the `skill-chatbot` PR merges, this repo's Phase 4 issues #13,
#14, #15 unblock. Until then, the routes exist but return 503.

## See also

- `docs/plans/phase-0-bootstrap.md` — locked spec for v1 dashboard
- `references/upstream/skill-chatbot-brief.md` — original chatbot brief
- `references/upstream/skill-secret/SKILL.md` — `bin/secret` shape this
  contract mirrors
- Issues #13, #14, #15 — Phase 4 dashboard routes
