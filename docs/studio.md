# NexusQL Studio

NexusQL Studio is the browser interface for the governed analytics runtime.
It is designed around a domain-first rule: business context must be selected
before data, semantics, or analysis can exist. The semantic layer stays visible
and editable instead of hiding behind an opaque chat box.

## Start the interface

From the repository root:

```bash
make web-install
make web-dev
```

Open <http://localhost:3000>. The interface uses a deterministic demo response
when the NexusQL-compatible API is offline, which is useful for exploring the product.

For live execution, start the Python API in another terminal:

```bash
queryforge --serve-api
```

The Studio sends requests through its same-origin `/api/queryforge/*` proxy. Set
`QUERYFORGE_API_URL` in `web/.env.local` if the API is not available at
`http://127.0.0.1:8000`.

## Domain-first workflow

1. Open **Data Domains**.
2. Select the bundled Anime Streaming sample or create a clean business domain.
3. Add one executable CSV or Parquet asset inside the active domain. The current
   single-asset boundary rejects a second published source until multi-table Join
   Path review is implemented.
4. Run real physical profiling over the uploaded rows and review candidate keys,
   types, null rates, distinct rates, and Watermark.
5. Review identity, grain, dimensions, measures, time fields, and ownership.
   When events can arrive late, set a bounded lookback window and choose Upsert
   so reviewed business keys can correct existing target rows.
6. Define metrics, relationships, cardinality, and safe Join Paths.
7. Classify sensitivity, apply SQL policy, and pass quality checks.
8. Publish the source through `DataAssetBuilder`; the backend creates the domain
   SQLite database, semantic model, SQL policy, lineage, Quarantine, and Watermark.
9. Ask questions against that domain's newly published artifacts and inspect
   Trust Trace evidence.

The top-bar domain switcher changes the context for Overview, Data Sources,
Data Pipelines, Semantic Studio, Ask & Analyze, and Run History. Sources and runs carry a
`domain_id`; uploaded objects use
`domains/{domainId}/sources/{sourceId}/...`. A new domain never reuses semantic
definitions from the sample.

## Executable data pipeline workspace

The bundled Anime Streaming domain includes a real, local data-asset pipeline
behind the **Data Pipelines** view. Studio uses the asynchronous run API:

- `GET /engineering/pipeline/status` reads persisted watermark, lineage,
  quarantine, quality-gate, and run evidence;
- `POST /engineering/pipeline/runs` returns `202` with a durable run id;
- `GET /engineering/pipeline/runs/{run_id}` polls queued/running/terminal state;
- retry creates a new attempt linked to the failed run, while cancel only removes
  queued work and never force-kills an atomic publication;
- the worker executes the reviewed
  `sample_data/data_assets/assets.yml` contract. The bounded
  `scenario=quality_failure` mode appends a deterministic newer row with a
  missing required field for interview-safe failure demonstrations.

The first run ingests and atomically publishes the CSV asset. Later runs use
the persisted watermark and unique-key contract, so unchanged input produces
an auditable idempotent no-op rather than duplicate rows. Runtime databases and
immutable run evidence are stored separately, so an atomic publication rollback
does not erase the quarantined record or failure explanation shown in Studio.
The workspace exposes queue delay, execution duration, Extract, Normalize/Stage,
Quality, Publish and semantic-publication timings. It also shows immutable task
history, attempt number, retry ancestry, error classification, recent row counts,
watermark movement, and Quarantine evidence. Runtime databases and
published semantics stay under `.queryforge/studio_pipeline/` and are excluded
from source control. The endpoints intentionally execute only the bundled,
reviewed contract; they do not accept arbitrary local paths from HTTP clients.

## Mandatory semantic onboarding

The Data Sources workflow calls the Python profiling API over the real uploaded
rows, generates a conservative semantic and pipeline draft, and then stops at a
human review gate. Physical column names are
evidence—not accepted business truth. Publication remains disabled until:

1. business entity identity and row grain are explicit;
2. primary keys, dimensions, measures, time semantics, and metric units are
   reviewed;
3. relationship cardinality and every multi-hop Join Path are approved;
4. owner, sensitivity, policy, and data-quality contracts are complete;
5. blocking validation succeeds; and
6. the reviewer explicitly confirms the contract.

The server enforces both boundaries. Calling the upload endpoint without a valid
`domain_id` or without `reviewed=true` returns an error, so neither domain
selection nor semantic review can be bypassed through the UI.

After review, Studio stores the source bytes in R2 and sends the same bounded
content and reviewed contracts to the Python asset service. Publication succeeds
only after staging, row-quality checks, Quarantine, target-table publication,
Watermark update, and semantic-contract validation all pass. The returned
database, semantic model, SQL policy, run id, row count, profile, and Watermark
are persisted in D1. A non-sample domain is unlocked for Ask & Analyze only when
those executable artifacts exist. If its live query fails, Studio does not
substitute the Anime sample response.

## Runtime persistence

Hosted deployments use D1 for domains, executable artifact metadata, profiles,
and run history and R2 for uploaded files. The Python runtime owns physical
profiling, governed publication, SQL planning, policy enforcement, read-only
execution, and analytical artifacts. A hosted Studio therefore needs an
externally reachable `QUERYFORGE_API_URL`; local filesystem paths always belong
to that Python runtime, not to the browser or Cloudflare Worker.

The bundled anime dataset under `sample_data/anime_streaming/` is read-only
showcase data attached to the Anime Streaming sample domain. It is not the
platform schema. Upload tests and hosted storage never modify or delete it.

## Validate the frontend

```bash
make web-check
```

The check covers linting, TypeScript types, production compilation, server
rendering, mandatory semantic-review enforcement, and branded social assets.
