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
3. Add SQLite, CSV, or Parquet files inside the active domain.
4. Profile physical schema and candidate keys.
5. Review identity, grain, dimensions, measures, time fields, and ownership.
6. Define metrics, relationships, cardinality, and safe Join Paths.
7. Classify sensitivity, apply SQL policy, and pass quality checks.
8. Publish data and semantics atomically.
9. Ask questions and inspect Trust Trace evidence within that same domain.

The top-bar domain switcher changes the context for Overview, Data Sources,
Data Pipelines, Semantic Studio, Ask & Analyze, and Run History. Sources and runs carry a
`domain_id`; uploaded objects use
`domains/{domainId}/sources/{sourceId}/...`. A new domain never reuses semantic
definitions from the sample.

## Executable data pipeline workspace

The bundled Anime Streaming domain includes a real, local data-asset pipeline
behind the **Data Pipelines** view. The Studio calls two bounded API routes:

- `GET /engineering/pipeline/status` reads persisted watermark, lineage,
  quarantine, quality-gate, and run evidence;
- `POST /engineering/pipeline/run` executes the reviewed
  `sample_data/data_assets/assets.yml` contract. The bounded
  `scenario=quality_failure` mode appends a deterministic newer row with a
  missing required field for interview-safe failure demonstrations.

The first run ingests and atomically publishes the CSV asset. Later runs use
the persisted watermark and unique-key contract, so unchanged input produces
an auditable idempotent no-op rather than duplicate rows. Runtime databases and
immutable run evidence are stored separately, so an atomic publication rollback
does not erase the quarantined record or failure explanation shown in Studio.
The run-history panel exposes recent row counts, status, watermark movement, and
quarantine evidence. Runtime databases and
published semantics stay under `.queryforge/studio_pipeline/` and are excluded
from source control. The endpoints intentionally execute only the bundled,
reviewed contract; they do not accept arbitrary local paths from HTTP clients.

## Mandatory semantic onboarding

The Data Sources workflow profiles an uploaded asset, generates a conservative
semantic draft, and then stops at a human review gate. Physical column names are
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

## Runtime persistence

Hosted deployments use D1 for domains, source metadata, and run history and R2
for uploaded files. The Python runtime still owns SQL planning, policy
enforcement, read-only execution, and analytical artifacts.

The bundled anime dataset under `sample_data/anime_streaming/` is read-only
showcase data attached to the Anime Streaming sample domain. It is not the
platform schema. Upload tests and hosted storage never modify or delete it.

## Validate the frontend

```bash
make web-check
```

The check covers linting, TypeScript types, production compilation, server
rendering, mandatory semantic-review enforcement, and branded social assets.
