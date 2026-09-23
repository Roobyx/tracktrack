# TrackTrack Storage Backends

TrackTrack stores all of its data (scopes, boards, views, tasks, users, sessions) through a
single `StorageAdapter` interface. The backend is chosen by the `TRACKTRACK_STORAGE` environment
variable and is resolved once at startup by `initStorage()`.

| Value           | Backend        | Use case                                              |
| --------------- | -------------- | ----------------------------------------------------- |
| `sqlite` (default) | `node:sqlite` (WAL) | Single-server production / local dev. Instant writes, real indexes, transactions, no external service. |
| `s3`            | S3-compatible  | Off-host durability or S3-primary deployments.        |
| `local`         | Local disk     | Single-process file storage in `TRACKTRACK_DATA_DIR`. |

## Model

The system assumes **one hosted server + one GUI editing online**: a single writer on the server
side. This makes SQLite's single-writer limitation irrelevant and lets S3 act purely as a backup /
durability target rather than the read/write primary.

Tasks are stored **per-entity**: each task is its own stored unit at `tasks/{scopeId}/{id}.json`.
Smaller collections (boards, views) and auth data are stored as whole-list blobs
(`scopes/{scopeId}/boards.json`, `users.json`, `sessions.json`) through the same adapter, so every
backend is uniformly supported. Soft-deleted task files are physically pruned once they age past
`TRACKTRACK_PRUNE_AFTER_DAYS` (default 30; `0` disables pruning).

## Environment

- `TRACKTRACK_STORAGE` — `sqlite` (default), `s3`, or `local`.
- `TRACKTRACK_DATA_DIR` — base directory for `local` files and the SQLite database file.
- `TRACKTRACK_SQLITE_PATH` — explicit SQLite file path (overrides the `TRACKTRACK_DATA_DIR` default).
- `TRACKTRACK_PRUNE_AFTER_DAYS` — days before soft-deleted tasks are pruned (default 30; `0` = keep forever).
- S3 variables (`TRACKTRACK_S3_ENDPOINT`, `TRACKTRACK_S3_ACCESS_KEY`, `TRACKTRACK_S3_SECRET_KEY`,
  `TRACKTRACK_S3_BUCKET`, `TRACKTRACK_S3_PREFIX`, `TRACKTRACK_S3_REGION`) — required only when S3
  is the primary or a backup target.

## Backup sync (optional)

Set `TRACKTRACK_BACKUP_TO_S3=true` to periodically replicate the primary store into S3
(`TRACKTRACK_BACKUP_INTERVAL_MS`, default 15000). This is single-server only; multi-instance
active-active would require making S3 the primary.

## Export / import

The server supports `--export <file>` and `--import <file>` to bundle every key through the active
adapter and restore it (overwrite mode). This works across backends, e.g. export from `sqlite` and
import into a fresh `s3` deployment.

## Legacy migration

If you are switching from an earlier deployment that stored each scope's tasks as a single
`scopes/{scopeId}/tasks.json` blob, `initStorage()` automatically transfers them into the new
per-task layout (`tasks/{scopeId}/{id}.json`) on startup. The migration is idempotent — existing
per-task files are never overwritten — and the inert legacy blob is then removed. It can also be run
explicitly with the `--migrate` server flag.

## Etag contract

Etags are **opaque** and backend-specific (quoted strings for S3, sha256 hex for local disk,
`v{version}` for SQLite). Callers must never assert an etag format; they only use etags for
change-detection (If-Match on writes, If-None-Match on reads).
