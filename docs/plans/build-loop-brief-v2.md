# Build-loop brief — resumed (issues #11–#15)

> Continuation. Generated 2026-07-07 14:38 SGT. Parent already shipped #4–#10
> inline after the prior sub-agent lost its exec tool mid-loop.

## Current state (verified by parent)

- **main HEAD:** `fc090f1 feat(ops): GET /cron list + ... (issue #10) (#24)`
- **PRs merged:** #16, #17, #18, #19, #20, #21, #22, #23, #24 (9 this session + 2 prior)
- **vitest baseline:** 85/85 passing (cron added 10). Local install at
  `/root/.openclaw/workspace/dev/projects/skill-admin-dashboard/`
- **pm2:** pid 1645828, healthz 200
- **Open issues:** #11, #12, #13, #14, #15 (5 remaining)

## Your job — ship these 5

| Order | Issue # | Title | Branch slug | Notes |
|-------|---------|-------|-------------|-------|
| 1 | #11 | Phase 3 #10: /sessions list + last message + deep link | `phase-3-issue-10-sessions-list` | Read-only. `openclaw sessions list` subprocess → table with deep-link button → JSONL. |
| 2 | #12 | Phase 3 #11: /logs tail 4 services in tabs | `phase-3-issue-11-logs-tail` | journalctl subprocess, cap each tab to ~200 lines, 4 service names configurable in .env or a constant. |
| 3 | #13 | Phase 4 #12: /chatbot/conversations active list + phone filter | `phase-4-issue-12-chatbot-conversations` | Soft-dep on `bin/chatbot-admin` (see `docs/plans/phase-4-chatbot-contract.md`). 503 fallback wrapper. |
| 4 | #14 | Phase 4 #13: /chatbot/conversations/:phone last 50 messages | `phase-4-issue-13-chatbot-messages` | Same wrapper, same 503 fallback. |
| 5 | #15 | Phase 4 #14: /chatbot/handoff queue + /chatbot/send admin manual send + audit | `phase-4-issue-14-chatbot-handoff-send` | Manual send is a write — CSRF + audit log entry mandatory. 503 fallback for handoff read if wrapper missing. |

## Issue bodies

```
gh issue view <N> --repo A-I-M-S/skill-admin-dashboard --json title,body,labels
```

Issue bodies include acceptance-criteria checklists — treat those as your
contract. Add `[x]` to each item in the PR description when you satisfy it.

## Process (apply every issue)

1. `git fetch origin main && git checkout main && git pull --ff-only`
2. `git checkout -b phase-<phase>-issue-<N>-<slug>`
3. **Implement** following existing patterns in `src/routes/`, `src/lib/`,
   `src/views/`. Mirror #10's `src/routes/ops/cron.ts` structure for the
   other ops routes and the chatbot routes. Mirror existing layouts.
4. **Quality gates — all three MUST pass before PR:**

   ```bash
   npm run typecheck       # zero errors
   npm run lint            # zero errors (no output = pass)
   npm test                # all vitest green, count must grow
   ```

5. **Commit + push + PR + merge** (no CI to wait for; no `.github/workflows/`):

   ```bash
   git add -A
   git commit -m "feat(<area>): <one-line summary> (issue #N)"
   git push -u origin HEAD
   gh pr create --base main --head <branch> \
     --title "<match issue title>" \
     --body "Closes #N\n\n<body with [x] acceptance criteria>"
   gh pr merge --squash --delete-branch \
     --body "Auto-merge: typecheck + lint + vitest green."
   ```

6. **Sync local + redeploy live:**

   ```bash
   git checkout main && git pull --ff-only
   npm run build
   pm2 restart skill-admin-dashboard
   sleep 1
   curl -fsS http://127.0.0.1:4320/healthz   # must return {"ok":true}
   ```

7. **Append progress row** to `docs/plans/build-loop-progress.md`:

   ```
   ## issue #N: <title>
   - branch: <branch>
   - PR: <url>
   - commit: <sha>
   - test result: <N>/<N> green
   - pm2 healthz: 200
   ```

## 🔴 Critical durability rule (the reason prior sub-agent failed)

`exec` / `process` tool calls **may start returning empty results mid-loop.**
This is what killed the previous sub-agent. Protect against it:

- **After every successful quality-gate run**, IMMEDIATELY `git add -A && git
  commit` (even if it's a WIP commit). Don't sit on uncommitted work.
- **After every push**, immediately verify with `git log --oneline origin/<branch> -1`.
- If you see two consecutive `exec` calls in a row return empty/no-output
  responses where you expected text or JSON output: **stop, write a
  checkpoint summary to `docs/plans/build-loop-progress.md`, send a single
  blocker to main session, exit.** Better to leave 2 issues unmerged than
  to lose 5.
- Never silently swallow an exec failure. If `npm test` returns no output,
  retry ONCE. If still empty, stop.

## Phase-4 chatbot contract

Read `docs/plans/phase-4-chatbot-contract.md` once before issue #13. The
dashboard depends on a new `bin/chatbot-admin` wrapper in the `skill-chatbot`
repo (not this repo). Until that wrapper exists at
`/root/.openclaw/workspace/dev/projects/skill-chatbot/bin/chatbot-admin`,
the three chatbot routes should:

- Detect absence of the wrapper (probe with `access()` or `existsSync()`)
- Return 503 with `Retry-After: 60` header
- Show a friendly "skill-chatbot admin wrapper not installed — see Phase 4
  contract" card in the UI

Same pattern as the `bin/secret` 503 fallback from #4 / `bin/secret.ts`.

## Code conventions (locked)

- TypeScript strict; no `any` outside process boundaries (parse JSON)
- EJS extends `src/views/layout.ejs`
- CSRF on every POST form (`<input type="hidden" name="_csrf">`)
- Every mutating route calls `writeAudit(...)` BEFORE the side-effect
- All subprocess via `src/lib/subprocess.ts` (no raw `child_process`)
- All `bin/secret` via `src/lib/bin-secret.ts`
- All `openclaw` CLI via `src/lib/openclaw-bin.ts`
- Never read `.env` (only `.env.example`); never log a secret value
- No `*.env` reads

## What success looks like

- 5 PRs opened, each merged with squash
- `docs/plans/build-loop-progress.md` has 5 new rows
- main HEAD 5 commits past `fc090f1`
- pm2 healthz 200
- Total test count grew by ~30-40 tests
- Emit `<promise>DONE</promise>` with: "Shipped 5/5 (10 + 5 = 15 total
  issues 4-15). pm2 green. Last merge: <sha>."

## When to ping main

Only if:
- You're stuck on an issue for >2 quality-gate attempts
- You need a decision the issue body doesn't cover (e.g., service name for
  #12 logs — propose 2 candidates and ask)
- `exec` starts returning empty (see Critical durability rule)

Send to session: `agent:dev:telegram:direct:920567169`.
Otherwise: stay silent. Finish the queue.
