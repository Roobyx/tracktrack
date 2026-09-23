# TrackTrack ingest API — requirements (for the TrackTrack repo)

## Goal

Expose a small, tolerant **REST ingest API** so Dodo (and other external tools) can push tasks,
notes, projects and ideas into TrackTrack with an **API key**. TrackTrack stays the lenient
receiver: it handles auth, idempotency, tag auto-creation and destination resolution. Dodo owns
formatting.

## Non-goals (for this plan)

- MCP tool changes (the MCP tools keep their existing `login` + token flow).
- Pulling TrackTrack tasks back into external tools.
- Replacing TrackTrack's existing task/board/scope data model.

---

## 1. API key system

- **Header:** `Authorization: Bearer <api_key>` on every ingest endpoint.
- **Storage:** hash the key (SHA-256), never store plaintext. Store `id`, `owner_id`, `name`,
  `key_hash`, `created_at`, `last_used_at`, optional `expires_at`.
- **Invalid/missing key** → `401 { "error": "unauthorized" }`.
- Admin UI to create/list/revoke keys.
- Keep API-key auth **separate** from MCP `login`+token for now.

## 2. Core endpoint

### `POST /api/v1/tasks`
Create a task; if the `sourceRef` already exists, **update** it instead.

Request:
```json
{
  "title": "Call dentist",            // required
  "description": "plain text",        // optional
  "status": "todo",                   // optional; omitted = todo (see enum)
  "priority": "high",                 // optional: low|medium|high|urgent
  "tags": ["health"],                 // optional
  "scope": "void",                    // optional; default from connection/key
  "board": "board-id-or-null",        // optional; null = Inbox
  "type": "task",                     // optional: task|note|project|idea
  "sourceRef": "dodo:<uuid>"          // REQUIRED — idempotency key
}
```

Response: `201` on create, `200` on update.
```json
{ "id": "tt-task-id", "created": true, "title": "Call dentist", "status": "todo" }
```

### `POST /api/v1/tasks/batch`
Array body of the same objects (cap the size). Returns per-item results:
```json
{ "results": [ { "id": "tt-task-id", "ok": true, "created": true, "error": null } ] }
```
A single failing item must not abort the batch.

## 3. Idempotency via `sourceRef` (critical)

- Store `sourceRef` in a **globally-unique** column.
- First send → create; later send with the same `sourceRef` → return the existing task updated.
- This is what makes Dodo's re-export safe without a local mapping table.
- Define `409` semantics if a caller reuses a `sourceRef` that exists (recommend returning the
  updated task with `200` rather than an error).

## 4. Closed status enum

Document exactly what `status` accepts:
`todo | in_progress | done | cancelled`
- Unknown/missing `status` → default `todo`.
- Notes/projects/ideas simply omit `status`.

## 5. Supporting endpoints

- `GET /api/v1/scopes` → list scopes (for Dodo's destination dropdown).
- `GET /api/v1/scopes/{id}/boards` → boards in a scope (for Dodo's board dropdown).
- `GET /api/v1/tasks?sourceRef=…` → lookup by idempotency key (optional but cheap).
- `GET /api/v1/tasks?scope=…` → list tasks in a scope (useful for Dodo verification).

## 6. Tag auto-creation

- If a `tags` value isn't already in the scope's tag catalog, **auto-register it** on create (or
  accept `"autoCreateTags": true`). This avoids a separate `create_tag` round-trip from Dodo.

## 7. Errors & contract

- `401` unauthorized, `422 { "errors": { "title": "required" } }` for validation, `429` rate
  limit, `500` internal.
- Accept `description` as plain text (Dodo sends `contentText`). Optionally also accept markdown;
  do **not** require a rich block-JSON format.
- Publish the contract as OpenAPI (`/api/v1/openapi.json`).

---

## Data model changes (TrackTrack)

- `api_keys` table (as above).
- Add `source_ref` (nullable, globally unique) + `external_type` (nullable) to the task table,
  or a separate `ingest_refs` table keyed on `source_ref` → `task_id`.
- `last_ingest_at`/`last_ingest_error` on tasks is optional.

## Validation

- Unit tests for: key auth, idempotent re-create (same `sourceRef` → update, no duplicate),
  tag auto-creation, status defaults, batch partial failure.
- Contract tests for the documented OpenAPI spec.

## Open questions

- Exact status enum values (settle before Dodo maps them).
- `sourceRef` globally unique vs per-scope (recommend global).
- Whether API keys are per-user or per-scope (recommend per-user, with a default scope on the key).
- Batch size cap.
