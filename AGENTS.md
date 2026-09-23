# AGENTS.md - TrackTrack Repo Direction

## Purpose

This repo is the standalone home of TrackTrack: a pnpm workspace for a headless
task-tracking service with its own web GUI and an MCP endpoint.

- `packages/track-service`: the headless core — types, zod validation, storage
  adapters (sqlite / s3 / local), auth, numbering, projects, scopes, boards,
  tasks. Framework-free and strongly typed.
- `apps/tracktrack`: the deployable app — REST API server, standalone web GUI
  (Preact + htm), MCP-over-HTTP endpoint, and the supervisor that runs them.

This project used to live inside the `ts-rogue` monorepo as `apps/tracktrack` +
`packages/track-service`. It is now an independent service, deployed as its own
Docker/Portainer stack.

## Source Of Truth Order

1. This file for repo-level rules.
2. `README.md` for setup, endpoints, ports and deployment.
3. `packages/track-service/STORAGE.md` for the authoritative storage-backend
   documentation.
4. `package.json` for canonical commands.
5. The nearest existing implementation and tests.

## Repo Boundaries

### track-service (core)

- Keep domain logic in `packages/track-service/src` (pure, testable, no HTTP).
- Export the public surface through `packages/track-service/src/index.ts`.
- Storage backends implement the adapter in `src/storage/adapter.ts`; keep
  `sqlite` the default primary backend.

### tracktrack (app)

- `apps/tracktrack/server` owns HTTP concerns: REST routes, auth middleware,
  the web-GUI proxy, the MCP handler, and `entrypoint.ts` supervision.
- `apps/tracktrack/src` owns the web GUI (Preact + htm). Views are list, board,
  planning and overview.
- Keep the API self-contained; do not add a second architecture.

## GUI Parity Across Repos

TrackTrack has two equal GUI clients:

1. The built-in web GUI in this repo (`apps/tracktrack/src`).
2. The config-editor GUI in the `ts-rogue` repo.

When you change the API surface, task/board/scope shape, MCP tools, or
`whats-new` behavior, keep both GUIs in sync. If a change cannot be reflected in
the `ts-rogue` GUI immediately, record it in the `ts-rogue` repo (for example in
`planning/TODO.md`) so it is not forgotten.

The REST contract is `/api/tracktrack/...`; the `ts-rogue` config-editor reaches
this service over `TRACKTRACK_URL`.

## Deployment

- `Dockerfile` builds the `tracktrack-runtime` target (API + web GUI + MCP in
  one supervised container).
- `docker-compose.yml` is the deployment interface: standalone
  (`docker compose up -d --build`) or a Portainer stack loaded from this GitHub
  repo. The optional `bucket` profile adds an embedded RustFS S3 bucket.
- All knobs are environment variables; mirror them in `.env.example` whenever
  you add one. Never bake secrets or environment-specific values into code.

## Rules When Coding

- Use `pnpm`, never `npm`.
- Do not hardcode values that belong in configuration or environment: add them
  to `.env.example` and `docker-compose.yml` when they are deployment knobs, or
  to the data model when they are domain values.
- Keep Biome rules; format with tabs, single quotes, no semicolons.
- Prefer targeted reads of the owning module over broad scans.
- Validate with the narrowest command first: `pnpm --filter track-service test`,
  `pnpm --filter tracktrack typecheck`, then `pnpm verify` before finishing.

## Version Bump Rule

Whenever a feature is edited or created, increment the version in the owning
`package.json` (`apps/tracktrack` for app changes, `packages/track-service` for
core changes, root for workspace-level changes) by `0.0.1` unless a larger bump
is recommended.

## Kilo Credit Rules

1. Start from the nearest relevant file, symbol, or failing command.
2. Respect `.gitignore`/`.dockerignore`; do not read `dist/`, `coverage/`,
   `.vite/`, or binary media unless the task is directly about them.
3. Reuse existing patterns before proposing new abstractions.
4. If something is expected to take a large amount of credits, ask first.
