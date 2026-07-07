# Build-loop brief — skill-admin-dashboard (unattended continuation)

## Task

You are the **build-loop driver** for `A-I-M-S/skill-admin-dashboard`. Ship the
remaining 12 issues with squash-merge auto-merge, then restart pm2 so the live
`127.0.0.1:4320` instance serves main HEAD.

Project owner has given full auto-merge authority (no per-issue approval ping).
**Ping main session only if blocked.**

## Working directory

`/root/.openclaw/workspace/dev/projects/skill-admin-dashboard/`

You are running on the `phase-1-issue-4-status` branch right now (1 commit
ahead of `main`). Everything you need is committed; do not redo any work.

## Repo facts (already verified)

- **Default branch:** `main` (no `.github/workflows/`, so no CI to wait for — PRs are mergeable once pushed)
- **Merge method:** squash (`gh pr merge --squash`) — past PRs use this
- **`deleteBranchOnMerge`** is off at the repo level, but pass `--delete-branch` anyway so local state stays tidy
- **Auth + safety defaults** are already implemented on main (PR #17):
  - argon2id session cookies + CSRF double-submit
  - `LOCAL_TOKEN_AUTH_REQUIRED=true`, `READONLY_MODE=true`, `APPROVAL_ACTIONS_ENABLED=false`, `IMPORT_MUTATION_ENABLED=false`
  - `LOCAL_API_TOKEN` + `ADMIN_USER=admin` / `ADMIN_PASSWORD=...` already in `.env` (chmod 600)
  - Mirror the same defaults in every new feature

## Process per issue (apply for every one)

```
# 1. Branch from latest main (skip for #4 which already exists)
gh issue view <N> --json title,body  # read the spec
git fetch origin main
git checkout main && git pull --ff-only
git checkout -b phase-<phase>-issue-<N>-<short-slug>

# 2. Implement — exactly per the issue body spec (acceptance criteria are the contract)
# - Follow the patterns in src/routes/, src/lib/, src/views/ from already-merged code
# - Reuse src/lib/subprocess.ts, src/lib/bin-secret.ts, src/lib/openclaw-bin.ts, src/lib/audit.ts
# - tests: use vitest; mock subprocess with test/helpers/mock-subprocess.ts
# - NEVER read *.env/.env.* (use .env.example); NEVER store plaintext in repo

# 3. Quality gates (all three must be green before PR)
npm run typecheck       # must pass clean
npm run lint            # zero errors
npm test                # all vitest green

# 4. Commit + push + PR
git add -A
git commit -m "feat(<area>): <one-line summary> (<issue-N>)"
git push -u origin HEAD
gh pr create \
  --base main --head $(git branch --show-current) \
  --title "<match issue title>" \
  --body "<paste acceptance-criteria-as-checklist>"

# 5. Merge immediately (no CI to wait for)
gh pr merge --squash --delete-branch --body "Auto-merge: issue #N acceptance criteria met, local typecheck+lint+vitest green."

# 6. Sync local main + redeploy live
git checkout main && git pull --ff-only
npm install   # only if package.json/lock changed
npm run build # fresh dist/
pm2 restart skill-admin-dashboard
sleep 1
curl -fsS http://127.0.0.1:4320/healthz  # must return {"ok":true}
pm2 logs skill-admin-dashboard --lines 50 --nostream --raw 2>&1 | grep -iE "error|warn" || true

# 7. Update progress file
echo "## issue #N: <title>
- branch: <branch>
- PR: <url>
- commit: <sha>
- test result: green
- pm2 healthz: 200" >> /root/.openclaw/workspace/dev/projects/skill-admin-dashboard/docs/plans/build-loop-progress.md
```

If any quality gate fails: **do not bypass**. Fix it on the branch, re-run,
amend or new commit, push, then PR. If you can't fix it after one pass, stop
and surface the blocker to main session.

## Issue queue (work in this order)

| Order | Issue # | Title | Branch name | Notes |
|-------|---------|-------|-------------|-------|
| 1 | #4 | Phase 1 #3: / status dashboard + bin/secret subprocess wrapper + env inheritance | `phase-1-issue-4-status` *(already exists locally)* | Just push + PR + merge. Verify `GET /` renders. Don't reimplement. |
| 2 | #5 | Phase 1 #4: /vault list + search (read-only metadata only) | `phase-1-issue-4-vault-list` | "Read-only metadata" = no plaintext in response, ever. Test with fuzz inputs. |
| 3 | #6 | Phase 1 #5: /vault/init form + audit log entry | `phase-1-issue-5-vault-init` | Form POST mutates vault → requires CSRF + writes audit log entry. |
| 4 | #7 | Phase 2 #6: /rag collection stats + source-file listing | `phase-2-issue-6-rag-stats` | Soft-dep on skill-rag-qdrant (503 fallback like skill-secret in #4). |
| 5 | #8 | Phase 2 #7: /rag/ingest + /rag/ingest/text + chunking params | `phase-2-issue-7-rag-ingest` | Mutating — opt-in only when `IMPORT_MUTATION_ENABLED=true`. |
| 6 | #9 | Phase 2 #8: /rag/search admin-only rag.ask() + top-3 hits + scores | `phase-2-issue-8-rag-search` | Read-only search wrapper. |
| 7 | #10 | Phase 3 #9: /cron list + pause + resume + run-now + remove | `phase-3-issue-9-cron-list` | Uses `openclaw cron ...` subprocess wrapper. |
| 8 | #11 | Phase 3 #10: /sessions list + last message + deep link | `phase-3-issue-10-sessions-list` | Read-only metadata + pointer to JSONL. |
| 9 | #12 | Phase 3 #11: /logs tail 4 services in tabs | `phase-3-issue-11-logs-tail` | Use journalctl subprocess; cap each tab to ~200 lines. |
| 10 | #13 | Phase 4 #12: /chatbot/conversations active list + phone filter | `phase-4-issue-12-chatbot-conversations` | Soft-dep on `bin/chatbot-admin` (see contract in `docs/plans/phase-4-chatbot-contract.md`). 503 fallback. |
| 11 | #14 | Phase 4 #13: /chatbot/conversations/:phone last 50 messages | `phase-4-issue-13-chatbot-messages` | Same wrapper. |
| 12 | #15 | Phase 4 #14: /chatbot/handoff queue + /chatbot/send admin manual send + audit | `phase-4-issue-14-chatbot-handoff-send` | Manual send is a write — audit log entry mandatory. |

For issue bodies, run `gh issue view <N> --repo A-I-M-S/skill-admin-dashboard
--json title,body,labels` — they include acceptance criteria as a checklist.

## Phase-4 chatbot contract

Read `docs/plans/phase-4-chatbot-contract.md` once before issue #13. The
dashboard depends on a new `bin/chatbot-admin` wrapper in the `skill-chatbot`
repo (not this repo). Until that wrapper exists in the sibling
`/root/.openclaw/workspace/dev/projects/skill-chatbot/bin/chatbot-admin`, the
three chatbot routes should:
- Detect absence of the wrapper
- Return 503 with `Retry-After` header
- Show a friendly "skill-chatbot admin wrapper not installed — see Phase 4
  contract" card in the UI

This is the same pattern as the `bin/secret` 503 from issue #4.

## Code conventions (locked, follow strictly)

- TypeScript strict, no `any` except at process boundaries (parse JSON output)
- EJS templates extend `src/views/layout.ejs` — look at existing views
- Alpine.js only for small interactivity (toggle button states, tabs)
- CSRF token always on POST forms (`<input type="hidden" name="_csrf" ...>`)
- Every mutating route calls `writeAudit(...)` BEFORE the side-effect happens
- All subprocess calls go through `src/lib/subprocess.ts` (no raw `child_process`)
- All bin/secret calls go through `src/lib/bin-secret.ts`
- All openclaw CLI calls (cron, sessions, logs) go through `src/lib/openclaw-bin.ts`
- Never log a secret value; never accept a secret from a request body that
  gets persisted (Risk #4 from phase-0 bootstrap)
- No `*.env` reads — `.env.example` only for reference

## Restart protocol

After EACH merged PR, in this exact order:

```bash
cd /root/.openclaw/workspace/dev/projects/skill-admin-dashboard
git checkout main
git pull --ff-only
[ -n "$(git diff --name-only main HEAD@{1} | grep -E '^package(-lock)?\.json$')" ] && npm ci
npm run build
pm2 restart skill-admin-dashboard
sleep 1
curl -fsS http://127.0.0.1:4320/healthz
```

If healthz returns anything other than `{"ok":true}`, IMMEDIATELY capture
`pm2 logs skill-admin-dashboard --lines 200 --nostream --raw` to
`docs/plans/build-loop-progress.md` and stop the loop with a blocker.

## Progress log

Append-only `docs/plans/build-loop-progress.md` in this repo. Format per
issue as shown in step 7 of the process. After each merge the row should
include: branch name, PR URL, merge commit SHA, test result, pm2 healthz
status.

## When to ping main session (BLOCK)

Stop and surface a single concise message with:
- which issue number
- error / log excerpt (<20 lines)
- what you already tried

Use `sessions_send` to session key `agent:dev:telegram:direct:920567169`.

Otherwise: stay silent, finish the queue.

## When you finish

Emit a final `<promise>DONE</promise>` tag with a one-line summary: "Shipped
N/12 issues. pm2 green. Last merge: <sha>." Then end your turn.
