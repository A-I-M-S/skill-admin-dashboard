# skill-admin-dashboard

Native OpenClaw admin dashboard. A single-page TypeScript web app that gives admins a GUI for the things that currently live in CLI + memory:

- **`skill-secret`** — vault browse / search / init (read-only metadata, audited init)
- **`skill-rag-qdrant`** — ingest (file upload, text paste, chunking), collection stats, admin search
- **Ops** — cron jobs (list / pause / resume / run-now / remove), agent sessions, service logs
- **`skill-chatbot`** — active conversations, message history per phone, handoff queue, admin manual send

## Status

Phase 0 — planning. See `docs/plans/phase-0-bootstrap.md` once opencode Plan agent completes.

## Stack

Node 20 · Fastify · TypeScript strict · EJS + Alpine.js · pino · vitest · supertest · argon2 · systemd.

## Repo layout

```
skill-admin-dashboard/
├── README.md
├── .gitignore
├── brief.md              # locked spec for the opencode Plan agent
├── package.json
├── tsconfig.json
├── Makefile
├── docs/
│   └── plans/
│       └── phase-0-bootstrap.md   # Plan agent deliverable (in progress)
├── src/
│   ├── server.ts         # Fastify boot
│   ├── config.ts         # env loading + safety defaults
│   ├── auth/             # session cookies + CSRF
│   ├── routes/
│   │   ├── index.ts      # / status dashboard
│   │   ├── vault/        # Phase 1 — skill-secret
│   │   ├── rag/          # Phase 2 — skill-rag-qdrant
│   │   ├── ops/          # Phase 3 — cron / sessions / logs
│   │   └── chatbot/      # Phase 4 — skill-chatbot
│   ├── views/            # EJS layout + partials
│   └── lib/              # subprocess wrappers, audit log
├── test/                 # vitest + supertest
└── systemd/
    └── skill-admin-dashboard.service
```

## License

Private — internal to A-I-M-S.
