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

## MCP

- stdio: `pnpm mcp`
- HTTP: `POST http://<host>:4358/` (or `TRACKTRACK_MCP_PORT`), stateless
  JSON-RPC reusing the API's MCP handler. Authenticate with `Authorization:
  Bearer <session token>` or use the `login` tool.

## Related repos

- `ts-rogue` — the game and config editor. Its config-editor app embeds an equal
  TrackTrack GUI client and connects here via `TRACKTRACK_URL`.
