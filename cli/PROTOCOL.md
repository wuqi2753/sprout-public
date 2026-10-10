# CLI HTTP contract (REQ-089–REQ-092)

Client wire contract, aligned with the implemented v0.3.0 Server handlers (REQ-079–086). See [Server contract](../server/README.md#cli-订阅同步req-079086). Mock tests exercise failure recovery; real Go/CLI tests exercise compatibility.

All business paths start with `/api/v1`. Requests use Bearer OAuth and JSON. Errors use `{ "error": { "code": "...", "message": "..." } }`. OAuth follows the existing REQ-076 form contract, client_id `sprout-cli`.

Labels: 1–100 exact values without `#` or whitespace, each at most 256 UTF-8 bytes; deterministic UTF-8 ordering and deduplication. Creation/task keys are persisted UUIDs, accepted by Server's 1–128 ASCII key format.

| Request | Body | Response |
| --- | --- | --- |
| GET /tags | — | `{tags: string[]}` |
| POST /subscriptions | `{tags, creation_key}` | Subscription |
| GET /subscriptions/{id} | — | Subscription |
| PATCH /subscriptions/{id} | `{tags, expected_tags, request_id}` | Subscription |
| POST /subscriptions/{id}/backfill | `{tags, request_id}` | `{subscription_id}` |
| POST /subscriptions/{id}/pull | `{limit: 50}` | Page |
| POST /subscriptions/{id}/ack | `{receipt}` | `{subscription_id}` |

Subscription includes `{subscription_id: string, tags: string[], acknowledged_cursor: string|null, phase, pending, eligible_backfill_tags}`. Cursor is opaque and displayed only; the client never constructs one. The CLI validates its required fields and accepts additional Server progress fields.

Page: `{receipt: string, phase: "initial"|"incremental"|"backfill", done: boolean, items: Item[]}`; at most 50 items. Each page, including empty pages and final pages, must have an ack receipt. `done` ends that phase's fixed round; a completed backfill is followed by the original incremental round.

Item: `{action: "upsert", note: {note_id, content, version, images: string[], files: string[], ...}}` or `{action: "stop", note_id}`. Note identifiers obey existing Server rules. Images/files use existing authenticated GET endpoints. Unknown actions, invalid fields and oversized responses fail before ack.

Required Server semantics: creation_key is a persistent UUID scoped to owner, identical retry returns the same subscription, changed tags conflict. PATCH request_id is an idempotent UUID and expected_tags is compared with canonical current tags; identical retries succeed even after application. Backfill request_id is idempotent, is tied to that PATCH's added tags, and retries after completion must not restart the task. PATCH conflicts while pending pages/rounds/backfill exist, without partial mutation. Pull resumes the pending page; ack receipt is idempotent, including after its response is lost. Server owns all progress. Token refresh/reauthorization preserves owner.

Attachments may change between pull and download: any download failure leaves the page unacknowledged; next sync re-pulls current state. Once all material is durable, the client journals the receipt before ack, then retries that exact ack on restart. Stop never removes local material.

## Workspace root authorization (REQ-099)

CLI login/logout/tags require --workspace ROOT. Credentials are selected by the canonical root identity and Server; different roots do not reuse a grant, even when using the same private configuration directory. Agent chooses tags from that root AGENTS.md and passes them explicitly. Changing tags and requesting backfill do not require reauthorization. OAuth wire fields and Server read permissions remain unchanged; no directory path or workspace identity is sent to Server.
