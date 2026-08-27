import { ensureStudioSchema, getStudioBindings } from "@/db/runtime";

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(["csv", "parquet"]);

type UploadedSemanticContract = {
  version: number;
  entity: string;
  description: string;
  owner: string;
  grain: string;
  primaryKey: string;
  sensitivity: "public" | "internal" | "restricted";
  dimensions: string[];
  metrics: Array<{
    name: string;
    description: string;
    aggregation: string;
    expression: string;
  }>;
};

type UploadedPipelineContract = {
  watermarkField: string | null;
  watermarkLookbackSeconds: number;
  requiredColumns: string[];
  uniqueKey: string[];
  maxInvalidRatio: number;
  publishMode: "append" | "upsert";
};

type PublishedAsset = {
  database_path: string;
  semantic_model_path: string;
  sql_policy_path: string;
  run_id: string;
  published_rows: number;
  watermark_after: string | null;
  profile: Record<string, unknown>;
};

function safeFileName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function extension(name: string) {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

function backendUrl(path: string) {
  const base = (
    process.env.QUERYFORGE_API_URL ?? "http://127.0.0.1:8000"
  ).replace(/\/+$/, "");
  return `${base}/${path}`;
}

function encodeBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function parseSemanticContract(value: FormDataEntryValue | null) {
  if (typeof value !== "string") return null;
  try {
    const contract = JSON.parse(value) as Partial<UploadedSemanticContract>;
    const required = [
      contract.entity,
      contract.description,
      contract.owner,
      contract.grain,
      contract.primaryKey,
    ];
    const sensitivityValid = ["public", "internal", "restricted"].includes(
      String(contract.sensitivity),
    );
    const dimensionsValid =
      Array.isArray(contract.dimensions) &&
      contract.dimensions.length > 0 &&
      contract.dimensions.every(
        (dimension) =>
          typeof dimension === "string" && dimension.trim().length > 0,
      );
    const metricsValid =
      Array.isArray(contract.metrics) &&
      contract.metrics.length > 0 &&
      contract.metrics.every(
        (metric) =>
          metric &&
          typeof metric.name === "string" &&
          metric.name.trim() &&
          typeof metric.description === "string" &&
          metric.description.trim() &&
          typeof metric.aggregation === "string" &&
          metric.aggregation.trim() &&
          typeof metric.expression === "string" &&
          metric.expression.trim(),
      );
    if (
      required.some(
        (field) => typeof field !== "string" || !field.trim(),
      ) ||
      !sensitivityValid ||
      !dimensionsValid ||
      !metricsValid
    ) {
      return null;
    }
    return contract as UploadedSemanticContract;
  } catch {
    return null;
  }
}

function parsePipelineContract(value: FormDataEntryValue | null) {
  if (typeof value !== "string") return null;
  try {
    const contract = JSON.parse(value) as Partial<UploadedPipelineContract>;
    const requiredValid =
      Array.isArray(contract.requiredColumns) &&
      contract.requiredColumns.length > 0 &&
      contract.requiredColumns.every(
        (column) => typeof column === "string" && column.trim(),
      );
    const uniqueValid =
      Array.isArray(contract.uniqueKey) &&
      contract.uniqueKey.length > 0 &&
      contract.uniqueKey.every(
        (column) => typeof column === "string" && column.trim(),
      );
    const ratio = Number(contract.maxInvalidRatio);
    const lookback = Number(contract.watermarkLookbackSeconds ?? 0);
    const publishMode = contract.publishMode ?? "upsert";
    if (
      !requiredValid ||
      !uniqueValid ||
      ratio < 0 ||
      ratio > 1 ||
      lookback < 0 ||
      lookback > 2_592_000 ||
      !["append", "upsert"].includes(publishMode)
    ) return null;
    return {
      watermarkField:
        typeof contract.watermarkField === "string" &&
        contract.watermarkField.trim()
          ? contract.watermarkField.trim()
          : null,
      watermarkLookbackSeconds: lookback,
      requiredColumns: contract.requiredColumns as string[],
      uniqueKey: contract.uniqueKey as string[],
      maxInvalidRatio: ratio,
      publishMode: publishMode as "append" | "upsert",
    } satisfies UploadedPipelineContract;
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  try {
    const domainId = new URL(request.url).searchParams.get("domain_id");
    const { db } = getStudioBindings();
    await ensureStudioSchema(db);
    const statement = db.prepare(
      `SELECT id, domain_id, name, source_type, size_bytes, table_count, status,
              contract_status, database_path, semantic_model_path, sql_policy_path,
              pipeline_run_id, row_count, watermark, profile_json, created_at
       FROM studio_sources
       ${domainId ? "WHERE domain_id = ?" : ""}
       ORDER BY created_at DESC
       LIMIT 50`,
    );
    const result = domainId
      ? await statement.bind(domainId).all()
      : await statement.all();
    return Response.json({ sources: result.results });
  } catch (error) {
    return Response.json(
      {
        sources: [],
        detail:
          error instanceof Error ? error.message : "Studio storage unavailable.",
      },
      { status: 503 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const domainId = String(form.get("domain_id") ?? "").trim();
    if (!domainId) {
      return Response.json(
        { detail: "Select a data domain before uploading data." },
        { status: 400 },
      );
    }
    if (form.get("reviewed") !== "true") {
      return Response.json(
        { detail: "A reviewed semantic contract is required." },
        { status: 400 },
      );
    }
    const semanticContract = parseSemanticContract(
      form.get("semantic_contract"),
    );
    if (!semanticContract) {
      return Response.json(
        {
          detail:
            "A complete semantic contract with entity, grain, owner, dimensions, and metrics is required.",
        },
        { status: 400 },
      );
    }
    const pipelineContract = parsePipelineContract(form.get("pipeline_contract"));
    if (!pipelineContract) {
      return Response.json(
        {
          detail:
            "A complete pipeline contract with required columns, unique key, and quality threshold is required.",
        },
        { status: 400 },
      );
    }

    const files = form
      .getAll("files")
      .filter((value): value is File => value instanceof File);
    if (!files.length) {
      return Response.json(
        { detail: "At least one data file is required." },
        { status: 400 },
      );
    }
    if (files.length !== 1) {
      return Response.json(
        { detail: "Publish one governed asset per upload." },
        { status: 400 },
      );
    }

    for (const file of files) {
      if (!ALLOWED_EXTENSIONS.has(extension(file.name))) {
        return Response.json(
          {
            detail: `Unsupported executable source: ${file.name}. Use CSV or Parquet.`,
          },
          { status: 400 },
        );
      }
      if (file.size > MAX_FILE_BYTES) {
        return Response.json(
          { detail: `${file.name} exceeds the 25 MB upload limit.` },
          { status: 413 },
        );
      }
    }

    const { db, uploads } = getStudioBindings();
    await ensureStudioSchema(db);
    const domain = await db
      .prepare("SELECT id, name FROM studio_domains WHERE id = ? LIMIT 1")
      .bind(domainId)
      .first<{ id: string; name: string }>();
    if (!domain) {
      return Response.json(
        { detail: "The selected data domain does not exist." },
        { status: 404 },
      );
    }
    const existingSource = await db
      .prepare(
        "SELECT id FROM studio_sources WHERE domain_id = ? AND status = 'published' LIMIT 1",
      )
      .bind(domainId)
      .first<{ id: string }>();
    if (existingSource) {
      return Response.json(
        {
          detail:
            "This domain already owns an executable asset. Create another domain until multi-table Join Path review is available.",
        },
        { status: 409 },
      );
    }
    const sourceId = crypto.randomUUID();
    const stored: Array<{
      name: string;
      objectKey: string;
      size: number;
      buffer: ArrayBuffer;
    }> = [];

    for (const file of files) {
      const objectKey = `domains/${domainId}/sources/${sourceId}/${safeFileName(file.name)}`;
      const buffer = await file.arrayBuffer();
      await uploads.put(objectKey, buffer, {
        httpMetadata: { contentType: file.type || "application/octet-stream" },
        customMetadata: {
          sourceId,
          domainId,
          semanticEntity: semanticContract.entity,
          semanticReviewed: "true",
        },
      });
      stored.push({ name: file.name, objectKey, size: file.size, buffer });
    }

    let publication: PublishedAsset;
    try {
      const response = await fetch(backendUrl("engineering/assets/publish"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          domain_id: domainId,
          source_id: sourceId,
          file: {
            name: stored[0].name,
            content_base64: encodeBase64(stored[0].buffer),
          },
          semantic_contract: {
            version: semanticContract.version,
            entity: semanticContract.entity,
            description: semanticContract.description,
            owner: semanticContract.owner,
            grain: semanticContract.grain,
            primary_key: semanticContract.primaryKey,
            sensitivity: semanticContract.sensitivity,
            dimensions: semanticContract.dimensions,
            metrics: semanticContract.metrics,
            reviewed: true,
          },
          pipeline_contract: {
            watermark_field: pipelineContract.watermarkField,
            watermark_lookback_seconds: pipelineContract.watermarkLookbackSeconds,
            required_columns: pipelineContract.requiredColumns,
            unique_key: pipelineContract.uniqueKey,
            max_invalid_ratio: pipelineContract.maxInvalidRatio,
            publish_mode: pipelineContract.publishMode,
          },
        }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) {
        const failure = (await response.json().catch(() => ({}))) as {
          detail?: string;
        };
        throw new Error(failure.detail || "Data-asset publication failed.");
      }
      publication = (await response.json()) as PublishedAsset;
    } catch (error) {
      await uploads.delete(stored.map((item) => item.objectKey));
      return Response.json(
        {
          detail:
            error instanceof Error
              ? error.message
              : "Data-asset publication failed.",
        },
        { status: 422 },
      );
    }

    const totalBytes = stored.reduce((sum, file) => sum + file.size, 0);
    const sourceName =
      stored.length === 1
        ? stored[0].name
        : `${stored[0].name} + ${stored.length - 1}`;
    const sourceType = Array.from(
      new Set(stored.map((file) => extension(file.name).toUpperCase())),
    ).join(" · ");
    const semanticModel = {
      ...semanticContract,
      reviewed: true,
      domain: { id: domainId, name: domain.name },
      inference: {
        status: "human_reviewed",
        note: "Physical inference was confirmed by the accountable domain owner.",
      },
      contract: { status: "passed", blocking_failures: 0 },
    };

    await db
      .prepare(
        `INSERT INTO studio_sources (
          id, domain_id, name, source_type, object_key, size_bytes, table_count,
          status, semantic_json, profile_json, reviewed, contract_status,
          database_path, semantic_model_path, sql_policy_path, pipeline_run_id,
          row_count, watermark
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, 1, 'passed', ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        sourceId,
        domainId,
        sourceName,
        sourceType,
        stored[0].objectKey,
        totalBytes,
        stored.length,
        JSON.stringify(semanticModel),
        JSON.stringify(publication.profile),
        publication.database_path,
        publication.semantic_model_path,
        publication.sql_policy_path,
        publication.run_id,
        publication.published_rows,
        publication.watermark_after ?? "",
      )
      .run();
    await db
      .prepare(
        "UPDATE studio_domains SET status = 'ready', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      )
      .bind(domainId)
      .run();

    return Response.json(
      {
        source: {
          id: sourceId,
          domainId,
          name: sourceName,
          sourceType,
          sizeBytes: totalBytes,
          tableCount: stored.length,
          status: "published",
          semanticModel,
          publication,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    return Response.json(
      {
        detail:
          error instanceof Error ? error.message : "Upload publication failed.",
      },
      { status: 503 },
    );
  }
}
