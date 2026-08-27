"""Real profiling and governed publication for Studio file uploads."""

from __future__ import annotations

import base64
import binascii
import csv
import io
import json
import re
from collections import Counter
from pathlib import Path
from typing import Any, Iterable

import yaml

from queryforge.data_assets import DataAssetBuilder
from queryforge.data_assets.models import (
    AssetBuildConfig,
    AssetQualityRules,
    AssetSemanticModelSpec,
    AssetSemanticSpec,
    AssetSource,
    DataAssetError,
    DataAssetSpec,
)
from queryforge.data_assets.transforms import normalize_identifier, normalize_value
from queryforge.domain.semantic import SemanticMetric
from queryforge.infrastructure.db.connection import sqlite_connection
from queryforge.application.studio_asset_models import (
    AssetProfileRequest,
    AssetPublishRequest,
    EncodedAssetFile,
    UploadedMetricContract,
)


MAX_UPLOAD_BYTES = 25 * 1024 * 1024
PROFILE_SAMPLE_ROWS = 5_000
SUPPORTED_UPLOAD_TYPES = {"csv", "parquet"}
_TIME_NAME = re.compile(r"(^|_)(date|time|timestamp|created|updated|recorded|at)($|_)")
_INTEGER = re.compile(r"^[+-]?\d+$")
_NUMBER = re.compile(r"^[+-]?(?:\d+\.\d*|\d*\.\d+)$")
_ISO_DATE = re.compile(
    r"^\d{4}-\d{2}-\d{2}(?:[T ][0-2]\d:[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$"
)


class StudioAssetService:
    """Turn a reviewed browser upload into a queryable local data asset."""

    def __init__(self, root: str | Path | None = None) -> None:
        project_root = Path(__file__).resolve().parents[2]
        self.root = Path(
            root or project_root / ".queryforge" / "studio_assets"
        ).expanduser().resolve()

    def profile(self, request: AssetProfileRequest) -> dict[str, Any]:
        payload = self._decode(request.file)
        extension = self._extension(request.file.name)
        rows = self._read_rows(payload, extension)
        if not rows:
            raise DataAssetError("Uploaded source contains no data rows")
        return self._profile_rows(request.file.name, extension, rows)

    def publish(self, request: AssetPublishRequest) -> dict[str, Any]:
        if not request.semantic_contract.reviewed:
            raise DataAssetError(
                "Publication requires a semantic contract confirmed by a human reviewer"
            )
        payload = self._decode(request.file)
        extension = self._extension(request.file.name)
        rows = self._read_rows(payload, extension)
        if not rows:
            raise DataAssetError("Uploaded source contains no data rows")
        profile = self._profile_rows(request.file.name, extension, rows)

        domain_root = self.root / request.domain_id
        source_root = domain_root / "sources" / request.source_id
        existing_manifests = [
            path
            for path in (domain_root / "sources").glob("*/manifest.json")
            if path.parent.name != request.source_id
        ]
        if existing_manifests:
            raise DataAssetError(
                "Studio currently publishes one executable asset per domain; "
                "create another domain until multi-table Join Path review is available"
            )
        source_root.mkdir(parents=True, exist_ok=True)
        source_path = source_root / f"source.{extension}"
        source_path.write_bytes(payload)

        normalized_columns = [column["name"] for column in profile["columns"]]
        column_set = set(normalized_columns)
        primary_key = self._normalized_list(
            request.pipeline_contract.unique_key
            or self._split_columns(request.semantic_contract.primary_key)
        )
        grain = self._normalized_list(
            self._split_columns(request.semantic_contract.grain) or primary_key
        )
        required = self._normalized_list(request.pipeline_contract.required_columns)
        dimensions = self._normalized_list(request.semantic_contract.dimensions)
        watermark = (
            normalize_identifier(request.pipeline_contract.watermark_field)
            if request.pipeline_contract.watermark_field
            else None
        )
        referenced = set(primary_key + grain + required + dimensions)
        if watermark:
            referenced.add(watermark)
        unknown = sorted(referenced - column_set)
        if unknown:
            raise DataAssetError(
                "Reviewed contract references columns missing from the physical source: "
                + ", ".join(unknown)
            )
        if not primary_key:
            raise DataAssetError("At least one unique-key column is required")

        entity = normalize_identifier(request.semantic_contract.entity)
        asset_name = entity
        target_table = normalize_identifier(f"fact_{entity}")
        model_name = normalize_identifier(f"{request.domain_id}_semantic_model")
        metrics = [
            self._metric(metric, entity, target_table, primary_key, dimensions, watermark)
            for metric in request.semantic_contract.metrics
        ]
        config = AssetBuildConfig(
            semantic_model=AssetSemanticModelSpec(
                name=model_name,
                description=request.semantic_contract.description,
                owner=request.semantic_contract.owner,
                reviewed=True,
                auto_count_metrics=True,
                metrics=metrics,
            ),
            assets=[
                DataAssetSpec(
                    name=asset_name,
                    target_table=target_table,
                    source=AssetSource(type=extension, path=str(source_path)),
                    column_aliases={
                        str(column["source_name"]): str(column["name"])
                        for column in profile["columns"]
                    },
                    watermark_field=watermark,
                    watermark_lookback_seconds=(
                        request.pipeline_contract.watermark_lookback_seconds
                    ),
                    quality=AssetQualityRules(
                        required_columns=required,
                        unique_key=primary_key,
                        max_invalid_ratio=request.pipeline_contract.max_invalid_ratio,
                    ),
                    publish_mode=request.pipeline_contract.publish_mode,
                    semantic=AssetSemanticSpec(
                        entity_name=entity,
                        entity_type="fact",
                        description=request.semantic_contract.description,
                        primary_key=primary_key,
                        grain=grain,
                        dimensions=dimensions,
                        owner=request.semantic_contract.owner,
                        sensitivity=request.semantic_contract.sensitivity,
                    ),
                )
            ],
        )

        publish_database = domain_root / "published.sqlite"
        state_root = domain_root / "state"
        semantic_model = domain_root / "semantic_model.yml"
        results = DataAssetBuilder(publish_database, state_root).build_all(
            config, semantic_model
        )
        result_payload = [result.model_dump(mode="json") for result in results]
        if not results or any(result.status != "success" for result in results):
            reason = "; ".join(
                result.error or "asset publication failed" for result in results
            )
            raise DataAssetError(reason or "asset publication failed")

        policy_path = domain_root / "sql_policy.yml"
        self._write_sql_policy(policy_path, publish_database, model_name)
        first = results[0]
        manifest = {
            "domain_id": request.domain_id,
            "source_id": request.source_id,
            "asset_name": asset_name,
            "target_table": target_table,
            "database_path": str(publish_database),
            "semantic_model_path": str(semantic_model),
            "sql_policy_path": str(policy_path),
            "run_id": first.run_id,
            "published_rows": first.published_rows,
            "quarantined_rows": first.quarantined_rows,
            "watermark_before": first.watermark_before,
            "watermark_after": first.watermark_after,
            "profile": profile,
            "results": result_payload,
        }
        (source_root / "manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        return manifest

    @staticmethod
    def _metric(
        metric: UploadedMetricContract,
        entity: str,
        table: str,
        primary_key: list[str],
        dimensions: list[str],
        watermark: str | None,
    ) -> SemanticMetric:
        if metric.aggregation == "count":
            expression = f"COUNT(DISTINCT {table}.{primary_key[0]})"
        else:
            match = re.fullmatch(
                r"\s*SUM\s*\(\s*(?:[A-Za-z_][A-Za-z0-9_]*\.)?"
                r"([A-Za-z_][A-Za-z0-9_]*)\s*\)\s*",
                metric.expression,
                flags=re.IGNORECASE,
            )
            if match is None:
                raise DataAssetError(
                    f"Metric {metric.name!r} must use a simple SUM(column) expression"
                )
            measure = normalize_identifier(match.group(1))
            if measure not in dimensions:
                raise DataAssetError(
                    f"Metric {metric.name!r} references unknown measure {measure!r}"
                )
            expression = f"SUM({table}.{measure})"
        return SemanticMetric(
            name=normalize_identifier(metric.name),
            description=metric.description,
            entity=entity,
            aggregation=metric.aggregation,
            expression=expression,
            allowed_dimensions=[f"{entity}.{column}" for column in dimensions],
            time_field=f"{table}.{watermark}" if watermark else None,
        )

    @staticmethod
    def _write_sql_policy(path: Path, database: Path, name: str) -> None:
        with sqlite_connection(database) as connection:
            tables = [
                str(row[0])
                for row in connection.execute(
                    "SELECT name FROM sqlite_master "
                    "WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
                )
            ]
        payload = {
            "version": 1,
            "name": f"{name}_analyst",
            "allowed_tables": tables,
            "dangerous_functions": ["randomblob"],
            "require_limit": False,
            "max_limit": 1000,
            "max_tables": min(max(len(tables), 1), 12),
            "max_joins": 8,
            "allow_cross_join": False,
        }
        path.write_text(
            yaml.safe_dump(payload, allow_unicode=True, sort_keys=False),
            encoding="utf-8",
        )

    def _profile_rows(
        self, file_name: str, extension: str, rows: list[dict[str, Any]]
    ) -> dict[str, Any]:
        source_names = [str(name) for name in rows[0]]
        normalized_names: list[str] = []
        seen: Counter[str] = Counter()
        for index, source_name in enumerate(source_names, start=1):
            name = normalize_identifier(source_name, fallback=f"column_{index}")
            seen[name] += 1
            if seen[name] > 1:
                name = f"{name}_{index}"
            normalized_names.append(name)

        normalized_rows = [
            {
                normalized: normalize_value(row.get(source))
                for source, normalized in zip(source_names, normalized_names)
            }
            for row in rows
        ]
        columns = []
        row_count = len(normalized_rows)
        sample_rows = normalized_rows[:PROFILE_SAMPLE_ROWS]
        for source_name, name in zip(source_names, normalized_names):
            values = [row.get(name) for row in normalized_rows]
            non_null = [value for value in values if value is not None]
            distinct = len({self._hashable(value) for value in non_null})
            null_count = row_count - len(non_null)
            columns.append(
                {
                    "source_name": source_name,
                    "name": name,
                    "data_type": self._infer_type(non_null),
                    "null_count": null_count,
                    "null_rate": round(null_count / row_count, 6),
                    "distinct_count": distinct,
                    "distinct_rate": round(distinct / row_count, 6),
                    "sample_values": [value for value in non_null[:3]],
                }
            )

        unique = [
            column
            for column in columns
            if column["null_count"] == 0 and column["distinct_count"] == row_count
        ]
        id_unique = [
            column
            for column in unique
            if column["name"] == "id" or column["name"].endswith("_id")
        ]
        primary = (id_unique or unique or columns)[0]["name"]
        time_columns = [
            column
            for column in columns
            if column["data_type"] == "datetime" or _TIME_NAME.search(column["name"])
        ]
        watermark = time_columns[0]["name"] if time_columns else None
        entity = normalize_identifier(Path(file_name).stem)
        numeric = [
            column["name"]
            for column in columns
            if column["data_type"] in {"integer", "number"}
            and column["name"] != primary
        ]
        metrics = [
            {
                "name": f"{entity}_count",
                "description": f"Count of {entity} records at the reviewed grain.",
                "aggregation": "count",
                "expression": "COUNT(*)",
            }
        ]
        if numeric:
            measure = numeric[0]
            metrics.append(
                {
                    "name": f"{measure}_sum",
                    "description": f"Sum of the profiled {measure} measure.",
                    "aggregation": "sum",
                    "expression": f"SUM({measure})",
                }
            )
        warnings = []
        if not unique:
            warnings.append("No fully unique non-null column was found")
        warnings.extend(
            f"{column['name']} has {column['null_rate']:.1%} null values"
            for column in columns
            if column["null_rate"] > 0
        )
        return {
            "file_name": file_name,
            "source_type": extension,
            "row_count": row_count,
            "sampled_rows": len(sample_rows),
            "column_count": len(columns),
            "columns": columns,
            "candidate_primary_key": primary,
            "candidate_watermark": watermark,
            "recommended_entity": entity,
            "recommended_required_columns": [primary]
            + ([watermark] if watermark and watermark != primary else []),
            "recommended_dimensions": normalized_names,
            "recommended_metrics": metrics,
            "quality_warnings": warnings,
            "preview": sample_rows[:5],
        }

    @staticmethod
    def _decode(file: EncodedAssetFile) -> bytes:
        if len(file.content_base64) > ((MAX_UPLOAD_BYTES + 2) // 3) * 4 + 16:
            raise DataAssetError("Uploaded source exceeds the 25 MB publication limit")
        try:
            payload = base64.b64decode(file.content_base64, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise DataAssetError("Uploaded source is not valid base64") from exc
        if len(payload) > MAX_UPLOAD_BYTES:
            raise DataAssetError("Uploaded source exceeds the 25 MB publication limit")
        return payload

    @staticmethod
    def _extension(name: str) -> str:
        extension = Path(name).suffix.lower().lstrip(".")
        if extension not in SUPPORTED_UPLOAD_TYPES:
            raise DataAssetError(
                "Executable Studio publication currently supports CSV and Parquet files"
            )
        return extension

    @staticmethod
    def _read_rows(payload: bytes, extension: str) -> list[dict[str, Any]]:
        if extension == "csv":
            try:
                text = payload.decode("utf-8-sig")
            except UnicodeDecodeError as exc:
                raise DataAssetError("CSV upload must use UTF-8 encoding") from exc
            reader = csv.DictReader(io.StringIO(text, newline=""))
            if not reader.fieldnames or any(not str(name).strip() for name in reader.fieldnames):
                raise DataAssetError("CSV upload requires a non-empty header row")
            return [dict(row) for row in reader]
        try:
            import pyarrow as pa
            import pyarrow.parquet as parquet
        except ImportError as exc:
            raise DataAssetError(
                "Parquet publication requires pyarrow; install requirements-assets.txt"
            ) from exc
        return [dict(row) for row in parquet.read_table(pa.BufferReader(payload)).to_pylist()]

    @staticmethod
    def _infer_type(values: Iterable[Any]) -> str:
        kinds: set[str] = set()
        for value in values:
            if isinstance(value, bool):
                kinds.add("boolean")
            elif isinstance(value, int):
                kinds.add("integer")
            elif isinstance(value, float):
                kinds.add("number")
            else:
                text = str(value)
                if _ISO_DATE.fullmatch(text):
                    kinds.add("datetime")
                elif _INTEGER.fullmatch(text):
                    kinds.add("integer")
                elif _NUMBER.fullmatch(text):
                    kinds.add("number")
                else:
                    kinds.add("text")
        if not kinds:
            return "null"
        if kinds <= {"integer"}:
            return "integer"
        if kinds <= {"integer", "number"}:
            return "number"
        if kinds <= {"datetime"}:
            return "datetime"
        if kinds <= {"boolean"}:
            return "boolean"
        return "text"

    @staticmethod
    def _hashable(value: Any) -> str:
        return json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)

    @staticmethod
    def _split_columns(value: str) -> list[str]:
        return [item.strip() for item in re.split(r"[,+]", value) if item.strip()]

    @staticmethod
    def _normalized_list(values: Iterable[str]) -> list[str]:
        return list(dict.fromkeys(normalize_identifier(value) for value in values if value))
