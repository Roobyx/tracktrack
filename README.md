# TrackTrack

Standalone task-tracking service: a headless core, a REST API, a built-in web
GUI and an MCP-over-HTTP endpoint.

This repo is the extracted home of TrackTrack, which previously lived inside the
`ts-rogue` monorepo. The `ts-rogue` config editor keeps its own TrackTrack GUI
and talks to this service over `TRACKTRACK_URL`.

## Layout

```
apps/tracktrack/        REST API + web GUI + MCP endpoint + container entrypoint
  server/               HTTP: routes, auth, web-GUI proxy, MCP, supervisor
  src/                  Web GUI (Preact + htm): list / board / planning / overview
packages/track-service/ Headless core: types, validation, storage, auth, tasks
  STORAGE.md            Storage-backend documentation
```

## Quick start

```bash
pnpm install
pnpm dev            # Vite GUI on TRACKTRACK_PORT (4356)
pnpm server         # API only
pnpm mcp            # MCP over stdio
pnpm test           # vitest
pnpm typecheck      # tsc across the workspace
```

Copy `.env.example` to `.env` and adjust as needed. The API is served under
`/api/tracktrack`.

## Ports

| Port | Service            | Environment variable   |
| ---- | ------------------ | ---------------------- |
| 4356 | REST API           | `TRACKTRACK_PORT`      |
| 4357 | Standalone web GUI | `TRACKTRACK_WEB_PORT`  |
| 4358 | MCP over HTTP      | `TRACKTRACK_MCP_PORT`  |

## Storage

`TRACKTRACK_STORAGE` selects the primary backend:

- `sqlite` (default) — a single database file on the `tracktrack_data` volume.
- `s3` — everything directly in an S3 bucket.
- `local` — JSON files on the volume.

When `TRACKTRACK_STORAGE=s3` or `TRACKTRACK_BACKUP_TO_S3=true`, an S3 bucket is
required. Point `BUCKET_SERVER_ENDPOINT` at an external S3, or enable the
embedded RustFS bucket profile. See `packages/track-service/STORAGE.md`.

`BUCKET_SERVER_ENDPOINT` (or `TRACKTRACK_S3_ENDPOINT`) accepts a comma- or
whitespace-separated fallback list, e.g. a LAN address plus a tunneled address:

```bash
BUCKET_SERVER_ENDPOINT=http://192.168.1.2:9004,https://s3.example.com
```

Candidates are probed once and the first reachable endpoint is used; the list is
re-probed whenever the active endpoint stops answering. Every candidate must
address the same bucket, otherwise data forks.

## Planning: create tasks from a knowledge file

The planning tab has two buttons that turn one `ts-rogue` knowledge document into
real tasks:

- **📄 From file** — the model reads the selected document and creates the tasks
  it implies.
- **📄 From file + assess** — the same, followed by a full planning assessment of
  exactly the tasks that were created.

The dialog lists the knowledge base, picks the target board (default: the board
active in the GUI, otherwise the Inbox) and shows the provider/model used. The
split runs on the server with the planning model (`TRACKTRACK_ASSESS_MODEL`, or a
per-request override), never in the browser. Each generated task description
starts with a `@[Name](knowledge://<id>)` reference back to the source document,
which is the link format the `ts-rogue` config editor renders.

Documents are read straight from S3 — the bucket the `ts-rogue` config editor
writes to, under the `knowledge/` prefix. Configure it with
`TRACKTRACK_KNOWLEDGE_S3_*` (each falls back to the `BUCKET_*` value), or leave
it unset and the file picker reports that no knowledge base is configured. Long
documents are split on markdown headings into several model calls, deduplicated
by title; a run is a background job with progress, token usage and cancel, and
the "+ assess" variant chains into an assessment job.

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `GET` | `/scopes/:scopeId/planning/knowledge` | List the `.md` / `.txt` knowledge documents |
| `POST` | `/scopes/:scopeId/planning/split` | Start a split job (`docId`, `boardId`, `provider`, `model`, `assessAfter`) |
| `GET` | `/scopes/:scopeId/planning/split/:jobId` | Split job progress and created task ids |
| `POST` | `/scopes/:scopeId/planning/split/:jobId/cancel` | Cancel a running split job |

## Docker / Portainer

```bash
cp .env.example .env
docker compose up -d --build

# with the embedded S3 bucket
docker compose --profile bucket up -d
```

For Portainer, create a stack from this GitHub repository using
`docker-compose.yml`, then paste the `.env` contents into the stack's
environment-variable editor and deploy.

## Authentication

REST and MCP-over-HTTP calls authenticate with a session token, sent as either
`Authorization: Bearer <token>` or `X-TrackTrack-Token: <token>`. The web GUI
sends both, because some reverse proxies (for example the NetBird proxy) strip
the `Authorization` header before forwarding. Use the mirrored header when such
a proxy sits in front of the service; a missing token yields
`Missing authorization token`, a wrong one `Invalid or expired session`.

## MCP

- stdio: `pnpm mcp`
- HTTP: `POST http://<host>:4358/` (or `TRACKTRACK_MCP_PORT`), stateless
  JSON-RPC reusing the API's MCP handler. Authenticate with `Authorization:
  Bearer <session token>` or `X-TrackTrack-Token: <session token>`, or use the
  `login` tool.

## Related repos

- `ts-rogue` — the game and config editor. Its config-editor app embeds an equal
  TrackTrack GUI client and connects here via `TRACKTRACK_URL`.
