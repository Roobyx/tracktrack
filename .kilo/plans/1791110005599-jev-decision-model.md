# Jev decision model — replacing hardcoded AI judgments with calibrated decisions

## Goal

TrackTrack contains a handful of decisions that an AI agent encoded as **hardcoded
heuristics** rather than as measurable judgments. The clearest ones:

| Decision | Where | Encoded as |
| --- | --- | --- |
| Idea value | `apps/tracktrack/server/ai-assess.ts:216-225` | prose prompt → parsed int 1-5 |
| Implementation difficulty | same prompt | prose prompt → parsed int 1-5 |
| Prioritization ("what do we build next") | `apps/tracktrack/src/utils.ts:112-118` | `ideaRating / difficultyRating` |
| "Is this task worth rating at all" | *missing* | no gate — every task gets an int |
| "Why did this S3 endpoint fail" | `packages/track-service/src/storage/s3-client.ts:115-123` | `typeof status !== 'number'` |
| "Was this response well-formed" | `ai-assess.ts:240-263`, `:336-363` | fence-strip, brace-slice, one repair re-ask |

These are all **bounded decisions over a declared option set** — exactly the shape the
Jev System One model (TypeSafe AI) is built for. Jev returns typed values (`Choice`,
`Score`, `Noul`) with calibrated probabilities instead of generated text, natively
structured, at ~$0.042/M input tokens and 70-500 ms.

The plan is to put a provider-neutral **decision layer** in front of those call sites,
implement it twice (deterministic heuristic = today's behavior, Jev = opt-in), and only
flip a write path once shadow-mode data says the Jev adapter is actually better on this
repo's data.

## Non-goals

- Replacing the LLM for prose. `effectOnGame` and `implementationNotes`
  (`ai-assess.ts:221-222`) stay on the LLM — Jev is not trained to generate text.
- Letting a model decide auth/security outcomes. Phase 6 is strictly the ambiguous
  case; the unambiguous paths stay in code.
- Adding a second architecture. This reuses the existing provider pattern
  (`PROVIDER_CONFIG`, `callLLM`, request-over-env precedence).
- Changing the storage model or the REST contract shape beyond additive optional fields.

---

## 0. Prerequisites (blocking — do these before any Jev work)

### 0.1 Fix the missing evidence base

`loadReferenceFile` (`ai-assess.ts:148-156`) reads
`planning/{scopeId}/inspirational-references.md` relative to the workspace root. **That
path does not exist in this repo** — there is no `planning/` directory. Every assessment
prompt therefore carries *"No curated reference list is available for this scope"* while
still instructing *"Judge each task against these references"* (`:211-214`). Separately,
`SCOPE_GAME_CONTEXT` (`:130-146`) hardcodes three `ts-rogue` scopes (`void`, `editor`,
`global`) that no longer exist here, and the system prompt still says *"for the ts-rogue
repository"* (`:206`).

Jev's premise is deciding from state that actually describes the answer (arXiv
2610.01834). Judging against an empty reference list and a foreign repo description is
the worst possible input. Fix first:

- Repoint the reference lookup at a path that exists, or create
  `planning/<scopeId>/inspirational-references.md` as a real, maintained file per scope.
- Make the prompt honest when references are missing: drop the "Judge each task against
  these references" sentence instead of contradicting it.
- Make `SCOPE_GAME_CONTEXT` data, not code: a per-scope document, with the built-in map
  as an empty default rather than ts-rogue leftovers.
- Record in `planning/TODO.md` of the ts-rogue repo if scope context is meant to live
  there (AGENTS.md GUI-parity rule).

### 0.2 Deterministic LLM call hygiene

Not Jev work, but it must land first so the Phase 1/2 comparison measures the model and
not the transport:

- `ai-assess.ts:93-107` — no `signal` on `fetch`. A hung connection hangs an assessment
  worker forever; only a manual cancel frees it, and only between tasks.
- `ai-assess.ts:283` — `attempt <= LLM_MAX_RETRIES` performs **4** calls, not 3. Rename
  the constant to `LLM_MAX_ATTEMPTS` or fix the bound; add jitter to
  `LLM_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)` (`:285`).
- `ai-assess.ts:272-274` — `429` is retryable but `Retry-After` is ignored. Honor it.
- `ai-assess.ts:291-293` — only `LLMHttpError` short-circuits, so JSON parse throws and
  DNS failures are retried. Add an `instanceof` guard on the non-HTTP path.

### 0.3 Test coverage where there is none

`ai-assess.ts` and `apps/tracktrack/src/utils.ts` have **no test files**. The rating
pipeline, the JSON recovery ladder, and `computeVe` are all untested. Adding a second
decision adapter without tests would make the comparison unreproducible.

New tests, mirroring `ai-split.test.ts` style:

- `apps/tracktrack/server/ai-assess.test.ts` — `parseAiOutput` (fenced, prose-wrapped,
  both-candidates-fail), `resolveAssessMode`, `isRetryableStatus`, the attempt bound,
  per-mode planning write mapping (`:372-386`).
- `apps/tracktrack/src/utils.test.ts` — `computeVe` / `veToneClass` / `averageRating`
  characterization tests **before** changing them, so the Phase 3 diff is provable.

---

## 1. The decision layer

### 1.1 Provider-neutral primitives

New module `apps/tracktrack/server/decide/types.ts`. Mirror the Jev primitive shapes
without importing Jev vocabulary into the domain:

```ts
export type DecisionChoice = {
	kind: 'choice'
	value: string
	probabilities: Record<string, number>
	confidence: number
}
export type DecisionScore = {
	kind: 'score'
	/** probability-weighted position on a 1-5 rubric */
	value: number
	confidence: number
	distribution: number[]
}
export type DecisionNoul = {
	kind: 'noul'
	probability: number
	confidence: number
}
export type Decision = DecisionChoice | DecisionScore | DecisionNoul

export type DecisionMeta = {
	source: 'heuristic' | 'jev'
	model?: string
	askedAt: string
	threshold?: number
	latencyMs?: number
	promptTokens?: number
}
```

`decide/index.ts` exports one function per question, each taking an explicit `threshold`:

```ts
export async function decideRating(input: RatingQuestion): Promise<{ decision: DecisionScore; meta: DecisionMeta }>
export async function decideCause(input: CauseQuestion): Promise<{ decision: DecisionChoice; meta: DecisionMeta }>
export async function decideGate(input: GateQuestion): Promise<{ decision: DecisionNoul; meta: DecisionMeta }>
```

Every question type declares its own option set / rubric / statement. The domain supplies
the question; the adapter only executes it. This keeps the option sets reviewable in
code and keeps Jev out of the domain.

### 1.2 Heuristic adapter (default)

`decide/heuristic.ts` reproduces today's behavior exactly, wrapped in the new shape:

- `decideRating` → `{ value: <int from existing prompt>, confidence: 0, distribution: [] }`,
  or for pure-HTTP call sites a caller-supplied fixed value.
- `decideCause` → the existing `isS3EndpointTransportError` boolean as a 2-way choice.
- `decideGate` → `probability: 1, confidence: 0` (never gates) until a threshold is tuned.

Confidence `0` is deliberate: it means "no calibrated confidence available", and the GUI
must render that as unknown rather than as certainty.

### 1.3 Jev adapter

`decide/jev.ts`. Configured by env, mirroring the existing provider precedence
(request → env → default, `ai-assess.ts:73-78`):

- `TRACKTRACK_DECISION_PROVIDER` = `heuristic` (default) | `jev`
- `JEV_API_KEY`, `TRACKTRACK_DECISION_MODEL` (default `jev-latest`)

Adapter responsibilities: build the typed question, call the API, map the response to
`Decision`, and **validate the returned distribution** (sums to 1, declared options
present). A malformed response degrades to the heuristic adapter with a logged reason —
a bad decision must never be worse than today's behavior.

### 1.4 Shadow mode

`TRACKTRACK_DECISION_MODE` = `off` | `shadow` | `enforce`.

- `shadow` — call **both**, use the heuristic result, append both outcomes to the
  calibration log (1.4.1). Doubles decision cost, which at ~$0.00006/task is noise.
- `enforce` — use the Jev result; heuristic remains the fallback on adapter failure.

Thresholds are per-question env knobs with documented defaults, never code literals
(AGENTS.md rule):

- `TRACKTRACK_JEV_RATEABLE_THRESHOLD` (default `0.5`, **unvalidated**)
- `TRACKTRACK_JEV_S3_CAUSE_THRESHOLD` (default `0.6`)
- `TRACKTRACK_JEV_VE_HI` / `_MD` (default `1.5` / `1.0`, matching today's hardcoded tone
  cutoffs at `utils.ts:122-123` so Phase 3 is visually stable)

#### 1.4.1 Calibration log

`TRACKTRACK_DECISION_LOG` (default `./decision-log.jsonl`, disabled when empty). One JSON
object per decision: question id, full state sent, both adapters' answers and
probabilities, threshold, latency, token usage, and — where known — the eventual human
outcome (`implementationStatus`, or a later `overwrite` run).

This is what Phase 2 needs. The benchmark (arXiv 2609.37647) found Jev's binary
probabilities rank well but sit poorly against a fixed 0.5 threshold; tuning the
threshold on data moved micro-F1 from 0.50 to 0.75 on a comparable task. **Do not ship a
default threshold as if it were a validated one.**

---

## 2. Phase 2 — ratings as `Score` questions

Replace the rating half of the prose contract (`ai-assess.ts:216-220`) with two typed
Score questions over the *same* rubric anchors, so the comparison is apples-to-apples:

- `idea.value`: *"On a 1-5 scale where 1 = not worth doing, 2 = weak, 3 = decent,
  4 = strong, 5 = must-do and high-impact — where does this task sit?"*
- `difficulty.value`: *"On a 1-5 scale where 1 = trivial, 3 = moderate, 5 = very large or
  risky — where does this task sit?"*

Scope context and references (post-0.1) become the decision **state**, not prompt prose.

Boundaries:

- `bigArchChange` / `bigCodeChange` are booleans — model as two `Noul` gates, since a
  bare boolean is the weakest thing the LLM currently produces and Phase 3 needs them as
  cost inputs.
- `effectOnGame` / `implementationNotes` stay LLM. The split becomes explicit:
  **Jev judges, the LLM writes.**
- Persistence keeps the existing int fields for compatibility; the new probability fields
  are additive. `ideaRating` becomes the rounded probability-weighted position so every
  existing consumer (GUI, MCP, filters) is unchanged.
- **Gate**: do not enable `enforce` for the write path until the shadow log shows the Jev
  ratings are at least as concordant with human `implementationStatus` as the current LLM
  ratings. Jev's own benchmark found all models degrade on rubric-based quality
  judgments — this repo's rubric is exactly that, so it must be measured, not assumed.
- Bump `PROMPT_VERSION` (`ai-assess.ts:10`) to 2 regardless of outcome. It is hardcoded
  and never bumped, so there is currently no way to detect a stale assessment.

---

## 3. Phase 3 — expected value with real uncertainty

`computeVe` (`apps/tracktrack/src/utils.ts:112-118`) divides two ordinal integers as if
they were ratio-scale, ignores `bigArchChange`/`bigCodeChange` entirely, and reports two
decimals of fake precision.

New module `packages/track-service/src/planning.ts` (pure, exported via
`src/index.ts` per AGENTS.md) so the GUI, REST, and MCP all compute identically:

- `computeExpectedValue(planning)` — weighted mean of the idea Score distribution over
  5, divided by the difficulty Score distribution, with the two change flags as cost
  multipliers. Returns `{ value, low, high }` — the spread is the point.
- `expectedValueTone(value, thresholds)` — replaces `veToneClass` (`utils.ts:120-125`),
  thresholds from env.
- `planningConfidence(planning)` — min of the available confidences; `null` when the
  ratings came from the heuristic adapter, so the UI can show "unscored" honestly.

Then:

- `utils.ts:112-125` delegates to core (delete the local math).
- `OverviewView.tsx:52-58, 73` and `PlanningView.tsx:406` render value + range + confidence
  badge. The V/E column gains a sort handler — it is currently display-only despite
  carrying the repo's only prioritization claim.
- GUI-parity obligation: record in `planning/TODO.md` of the **ts-rogue** repo that the
  config-editor GUI must adopt the same expected-value math and the new fields
  (AGENTS.md:44-57).

---

## 4. Phase 4 — validity gate and provenance

Two correctness fixes that stand on their own, independent of Jev:

**4.1 Gate unrateable tasks.** A `Noul` question — *"Is this task description specific
enough to judge value and difficulty?"* — returns a probability. Below
`TRACKTRACK_JEV_RATEABLE_THRESHOLD`: do not write ratings; record the gate result so the
task surfaces in a "needs more detail" queue. This is the abstention path the model
currently has no way to express.

**4.2 Write provenance in every mode.** `aiAssessment` is written **only** in `full` mode
(`ai-assess.ts:400`), so `effects` and `custom` runs leave AI-authored `planning` with no
record of model or time. Consequences to fix together:

- Write metadata for all modes, with the mode recorded in `AiAssessmentMeta`
  (`packages/track-service/src/types.ts:53-61`).
- The `assessed` filter (`packages/track-service/src/tasks.ts:350-352`) keys off metadata
  presence, so `effects`/`custom` tasks currently report as unassessed. Either key the
  filter off provenance presence after the fix, or add an explicit `mode` filter.
- `status: 'ok'` is the only value ever written (`ai-assess.ts:395`); the `'error'`
  variant exists in `types.ts:59` and `validation.ts:116` and is rendered by three views
  (`AssessDialog.tsx:149`, `TaskDrawer.tsx:204`, `PlanningView.tsx:567`) but is never
  produced. A failed assessment leaves no trace on the task. Write it.
- `mergePlanning` (`tasks.ts:18-36`) stores `null` on the three numeric/enum keys but
  *deletes* the four text/boolean keys, so `effects` mode can never blank a stale
  `effectOnGame`. Add `effectOnGame` to the nullable set or accept the asymmetry
  deliberately — either way, pin it with a test (`tasks.test.ts:224-259` has the
  current contract).

---

## 5. Phase 5 — S3 endpoint cause classification

The highest-stakes encoded judgment in the repo is a one-line boolean:
`isS3EndpointTransportError` (`s3-client.ts:115-123`) returns true when
`$metadata.httpStatusCode` is absent. That means a 403 on the wrong bucket or path style
is accepted as "reachable", and any SDK error without a status (credential-shape errors)
is classified as transport failure and **triggers a switch to a different endpoint** —
potentially sending writes to the wrong bucket. The docs warn about this in three places
(`STORAGE.md:57-58`, `docker-compose.yml:74`, `.env.example:69`) and enforce it nowhere.

**Architecture constraint:** `packages/track-service/src` must stay pure and HTTP-free
(AGENTS.md:31). Core therefore gets the deterministic half only:

- `s3-client.ts` — replace the boolean with a pure typed classifier:
  `classifyS3Error(error): S3ErrorCause` where
  `S3ErrorCause = 'unreachable' | 'reachable_wrong_bucket' | 'bad_credentials' | 'unknown'`.
  This is a strict improvement over the boolean and ships regardless of Jev.
- The app layer (`apps/tracktrack/server`) owns the optional model refinement: a `Choice`
  question over the declared causes, using error name, message, status, endpoint, and
  bucket as state. Threshold from `TRACKTRACK_JEV_S3_CAUSE_THRESHOLD`.
- Core accepts an injected optional `refineCause?: (error: unknown, cause: S3ErrorCause) => Promise<S3ErrorCause>` — the same shape as the existing injected `probe` parameter at `s3-client.ts:160-163`. Default undefined = pure classifier.

Behavior change to make explicitly: only `unreachable` invalidates the cached endpoint
(`invalidateS3Endpoint`, `s3-client.ts:228-240`). Today every non-transport error is
ignored there and every transport error drops the cache; with the typed causes,
`bad_credentials` should invalidate the *credentials*, not the endpoint — switching
endpoints on a credential error is the actual bug.

Update `packages/track-service/STORAGE.md:35-58` (the authoritative doc) and
`s3-endpoints.test.ts` — the existing tests pin the fail-open-to-primary rule
(`:110-116`) and candidate ordering (`:94-100`); keep those, add cause cases.

---

## 6. Phase 6 — optional, measure first

- **Auth header ambiguity.** `extractAuthToken` (`routes.ts:1653-1669`) reads
  `Authorization: Bearer`, then falls back to `X-TrackTrack-Token`; the client sends both
  always (`src/api/client.ts:124-130`) and the proxy relays both
  (`api-proxy.ts:107-112`). The *unambiguous* cases stay in code — one header present is
  a fact, not a judgment. Only "both present and values differ" is a candidate for a
  `Choice`. Security regression risk is real; requires labeled proxy-hop data that does
  not exist yet. Defer until the calibration log has been running.
- **Login throttle thresholds.** `MAX_LOGIN_FAILURES=5`, `LOGIN_BACKOFF_MS=30_000` fixed
  single window (`routes.ts:122-123`), loopback-only `X-Forwarded-For` trust (`:375-389`).
  This is exactly the tunable-threshold case from the benchmark, but it is a security
  control with a deliberately chosen bias and no labeled data. Do not touch without data.
- **Split classification.** `ai-split.ts:264-269` and `:446-447` coerce model
  `state`/`priority` values against the scope set and **silently drop unknowns**. A `Choice`
  question over the legal values, with a low-confidence path that keeps the item for human
  review instead of dropping it, is a clean fit. The chunk-boundary strategy
  (headings → paragraphs → lines, `:78-148`) is also a `Choice`, but the current heuristic
  is cheap and correct — low priority.
- **`implementationStatus` stays human-only.** The MCP tool description already says so
  (`mcp-handler.ts:244`). No change; do not let a Noul gate auto-set it.

---

## Data model changes

`packages/track-service/src/types.ts` + `validation.ts`, all optional and additive:

```ts
export type TaskPlanning = {
	// ...existing
	ideaConfidence?: number | null
	difficultyConfidence?: number | null
	bigArchConfidence?: number | null
	bigCodeConfidence?: number | null
	rateable?: { probability: number; threshold: number } | null
}
```

- `AiAssessmentMeta` gains `mode: AssessMode`, `decisionSource: 'heuristic' | 'jev'`, and
  keeps `status: 'ok' | 'error'` now that `'error'` is actually written.
- `NULLABLE_PLANNING_KEYS` (`tasks.ts:18-22`) gains the new keys so `null` clears rather
  than deletes, consistent with the numeric/enum keys.
- Bounds: confidences and probabilities as `z.number().min(0).max(1)`. Every rating stays
  `int 1-5` — `computeVe`'s falsy guard at `utils.ts:116` depends on ratings never being
  0.

Storage adapters need no changes; these are ordinary planning fields.

## Env / config knobs

All additive to `.env.example` + `docker-compose.yml` + README per AGENTS.md:66-74:

```
TRACKTRACK_DECISION_PROVIDER=heuristic     # heuristic | jev
TRACKTRACK_DECISION_MODE=off               # off | shadow | enforce
TRACKTRACK_DECISION_MODEL=jev-latest
JEV_API_KEY=
TRACKTRACK_DECISION_LOG=                   # empty = disabled
TRACKTRACK_JEV_RATEABLE_THRESHOLD=0.5
TRACKTRACK_JEV_S3_CAUSE_THRESHOLD=0.6
TRACKTRACK_JEV_VE_HI=1.5
TRACKTRACK_JEV_VE_MD=1.0
```

`heuristic` / `off` are the shipped defaults, so the service behaves exactly as it does
today with no configuration.

## Testing

- Per phase, narrowest first: `pnpm --filter @m2/track-service test`, then
  `pnpm --filter tracktrack typecheck`, then `pnpm verify` before finishing.
- New: `apps/tracktrack/server/decide/*.test.ts` — adapter contract tests run against
  **both** adapters with recorded fixtures (no network in CI). A Jev-response fixture
  with a malformed distribution must degrade to heuristic, not throw.
- `s3-endpoints.test.ts` — extend for each `S3ErrorCause`, including that
  `bad_credentials` does **not** invalidate the endpoint.
- `tasks.test.ts` — the new nullable-key clearing, and `mode` in assessment metadata.
- `utils.test.ts` — `computeExpectedValue` bounds and the `null`-confidence path.
- Golden-file test for the shadow log line shape, so the aggregator script and the writer
  cannot drift.

## Rollout

1. Ship Phase 0 alone (correctness + tests). No behavior change. Bump
   `tracktrack` → 0.17.8, `@m2/track-service` → 0.10.4.
2. Ship Phase 1 with `heuristic`/`off` defaults. Dead code until configured. `tracktrack`
   → 0.18.0.
3. Enable `shadow` on the real scope. Let the log fill. No writes change.
4. Write `scripts/aggregate-decisions.ts` (or a `pnpm decisions:report` script) to compute,
   per question, the threshold that maximizes agreement with the recorded human outcome.
   Commit the chosen thresholds as the new defaults, with the report as justification.
5. Enable `enforce` per question, one at a time, keeping `heuristic` as fallback.
6. Phases 2-5 land in the order listed, each gated on its own shadow comparison.

## Risks

- **Jev is early-access.** No public API key today (request at typesafe.ai). The entire
  plan is therefore structured so that only the adapter needs the vendor, and nothing
  ships broken without it.
- **Rubric judgments are Jev's measured weak spot** (arXiv 2609.37647: all models degrade
  on rubric-based quality judgments). Phase 2 is the highest-risk phase and is explicitly
  gated on measured agreement, not on vendor claims.
- **Calibration is unproven here.** Every default threshold in this plan is a guess,
  marked as such. Phase 1.4.1 exists so they stop being guesses.
- **GUI parity.** Phases 3 and 4 change fields both GUIs read. Per AGENTS.md:44-57, record
  the ts-rogue config-editor work in its `planning/TODO.md` in the same change.
- **Cold-start cost.** Shadow mode doubles decision calls during the measurement window.
  At ~$0.00006/task this is under a dollar for a full re-assessment of a large scope.

## Open questions

- Where do scope context and inspirational references actually live for this repo, now
  that `planning/` does not exist here? (Blocks 0.1.)
- Is there any labeled history — human `implementationStatus` against LLM ratings — to
  calibrate against, or does the log start empty?
- Should `decisionSource: 'jev'` be visible in the GUI, or only in the API/meta? Useful
  during rollout, clutter afterwards.
- Does the ts-rogue config-editor GUI want the same decision layer behind
  `TRACKTRACK_URL`, or only the additive fields?
- Should the decision layer become a third MCP tool (`decide_tasks`), or stay an internal
  implementation detail of `assess_tasks`?