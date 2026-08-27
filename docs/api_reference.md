# API Reference

Start the optional REST server:

```bash
queryforge --serve-api --api-host 127.0.0.1 --api-port 8000
```

All request bodies use the `AskRequest` contract. The common fields are `question`,
`database`, `semantic_model_path`, `sql_policy_path`, `skills`, session options, Tool Loop,
parallel candidates, Subject Tree and report options.

A semantic model is required by default and is discovered beside the selected
database. `allow_schema_only: true` is an explicit diagnostics-only escape hatch;
normal analytical clients should never set it.

| Endpoint | Method | Description |
| --- | --- | --- |
| `/health` | GET | Service health and capability summary |
| `/models` | GET | Configured model providers |
| `/skills` | GET | Local prompt-only Skills |
| `/engineering/assets/profile` | POST | Profile a bounded base64-encoded CSV/Parquet upload and return physical statistics and contract candidates |
| `/engineering/assets/publish` | POST | Publish a reviewed upload through the real data-asset pipeline and return executable database/semantic/policy artifacts |
| `/engineering/pipeline/status` | GET | Read bundled pipeline watermark, quality, lineage, and run evidence |
| `/engineering/pipeline/run` | POST | Execute the bounded standard or quality-failure demonstration pipeline |
| `/engineering/pipeline/runs` | POST | Create a persistent asynchronous run and return `202` plus its run id |
| `/engineering/pipeline/runs?limit=20` | GET | List durable orchestration runs, newest first |
| `/engineering/pipeline/runs/{run_id}` | GET | Poll queued, running, or terminal state and timing evidence |
| `/engineering/pipeline/runs/{run_id}/retry` | POST | Create a new attempt linked through `retry_of` |
| `/engineering/pipeline/runs/{run_id}/cancel` | POST | Cancel queued work; running publication is never force-killed |
| `/ask` | POST | Execute the full governed NL2SQL workflow |
| `/ask/stream` | POST | SSE progress events; no SQL, prompts, or result rows in events |
| `/plan` | POST | Generate and preflight a plan without executing SQL |
| `/report/{run_id}` | GET | Download static HTML from the configured report directory |
| `/gateway/webhook` | POST | Gateway adapter with a stable user/channel session |

Example:

```bash
curl -X POST http://127.0.0.1:8000/ask \
  -H 'content-type: application/json' \
  -d '{"question":"Top anime by watch hours","database":"sample_data/anime_streaming/anime_streaming.sqlite"}'
```

For SSE, send the same body to `/ask/stream`. Each `data:` line is a `WorkflowEvent` containing
only progress metadata. Use `report: true` to create a static report after a successful execution,
then retrieve it from `/report/<run_id>`.

Errors caused by invalid inputs return `400`; workflow, policy, or execution failures return
`422`. SQL policy denials include a named `SQL_SECURITY_ERROR` and occur before SQLite execution.

Studio upload publication is intentionally bounded. The API accepts one CSV or
Parquet file up to 25 MB, validates a reviewed semantic contract plus required
columns, unique key, watermark, optional ISO-temporal lookback, append/upsert
mode, and invalid-row threshold, and writes artifacts
under the server-owned `.queryforge/studio_assets/<domain_id>/` root. HTTP clients
cannot choose arbitrary output paths. Studio currently permits one executable
asset per custom domain; publishing a different second source is rejected until
multi-table Join Path review is implemented.

Pipeline orchestration stores control-plane state in
`.queryforge/studio_pipeline/orchestration.sqlite`. A newly submitted run moves
through `queued -> running -> succeeded|failed`; queued work can also become
`cancelled`. Any queued/running row found after a process restart becomes a
`worker_interrupted` failure marked retryable. Data-quality and contract errors
are classified separately from transient execution failures. Retrying never
mutates the original evidence: it creates a new run with incremented `attempt`
and a `retry_of` pointer.

Cancellation is intentionally cooperative and bounded. The local executor can
remove a task that has not started, but it does not kill a running SQLite
publication because interruption during commit or rollback could violate the
atomicity guarantee. A distributed deployment should replace the in-process
executor with an external queue and check a cancellation flag at safe stage
boundaries.
