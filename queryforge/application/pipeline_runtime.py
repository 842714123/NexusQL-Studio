"""Observable application service for governed data-asset pipeline runs."""

from __future__ import annotations

import csv
import json
import shutil
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from queryforge.data_assets import DataAssetBuilder
from queryforge.infrastructure.db.connection import sqlite_connection


class PipelineRuntime:
    """Run one configured asset pipeline and expose persisted operational state."""

    def __init__(
        self,
        config_path: str | Path | None = None,
        publish_database: str | Path | None = None,
        state_root: str | Path | None = None,
    ) -> None:
        project_root = Path(__file__).resolve().parents[2]
        self.config_path = Path(
            config_path or project_root / "sample_data" / "data_assets" / "assets.yml"
        ).resolve()
        runtime_root = Path(
            state_root or project_root / ".queryforge" / "studio_pipeline"
        ).resolve()
        self.publish_database = Path(
            publish_database or runtime_root / "published.sqlite"
        ).resolve()
        self.state_root = runtime_root
        self.metadata_database = runtime_root / "metadata.sqlite"
        self._lock = threading.Lock()

    def run(self, scenario: str = "standard") -> dict[str, Any]:
        """Execute a serialized, idempotent build and return auditable evidence."""
        if scenario not in {"standard", "quality_failure"}:
            raise ValueError("scenario must be 'standard' or 'quality_failure'")
        if not self._lock.acquire(blocking=False):
            raise ValueError("A pipeline run is already in progress")
        try:
            config_path = (
                self.config_path
                if scenario == "standard"
                else self._quality_failure_config()
            )
            results = DataAssetBuilder(
                self.publish_database,
                self.state_root,
            ).build_from_file(config_path)
            payload = [result.model_dump(mode="json") for result in results]
            self._record_run_evidence(scenario, payload)
            return {
                "status": "success"
                if all(result.status == "success" for result in results)
                else "failed",
                "idempotent": all(
                    result.status == "success" and result.published_rows == 0
                    for result in results
                ),
                "scenario": scenario,
                "results": payload,
                "pipeline": self.status(),
            }
        finally:
            self._lock.release()

    def status(self) -> dict[str, Any]:
        """Read source, watermark, lineage, quarantine, and contract state."""
        source_path = self.config_path.parent / "anime_watch_events.csv"
        source_rows = _csv_row_count(source_path)
        base: dict[str, Any] = {
            "name": "anime_watch_events",
            "source": str(source_path),
            "source_type": "csv",
            "target_table": "fact_watch_events",
            "source_rows": source_rows,
            "source_bytes": source_path.stat().st_size if source_path.is_file() else 0,
            "completed_runs": 0,
            "failed_runs": 0,
            "watermark": None,
            "last_run": None,
            "quality": {
                "passed": True,
                "checks_passed": 0,
                "checks_total": 0,
                "quarantined_rows": 0,
                "failures": [],
            },
            "lineage": {
                "source": "anime_watch_events.csv",
                "staging": "staging_anime_watch_events",
                "target": "fact_watch_events",
                "semantic_model": "anime_watch_asset",
            },
            "recent_runs": [],
        }
        if not self.metadata_database.is_file():
            return base

        with sqlite_connection(self.metadata_database) as connection:
            self._ensure_evidence_table(connection)
            success_count = connection.execute(
                "SELECT COUNT(DISTINCT run_id) FROM asset_lineage WHERE status = 'success'"
            ).fetchone()[0]
            failure_count = connection.execute(
                "SELECT COUNT(DISTINCT run_id) FROM asset_lineage WHERE status = 'failed'"
            ).fetchone()[0]
            lineage_rows = connection.execute(
                """
                SELECT run_id, input_rows, staged_rows, published_rows,
                       quarantined_rows, watermark_before, watermark_after,
                       status, error, created_at
                FROM asset_lineage
                ORDER BY id DESC
                LIMIT 50
                """
            ).fetchall()
            watermark = connection.execute(
                """
                SELECT watermark_value, updated_at
                FROM asset_watermarks
                WHERE asset_name = 'anime_watch_events'
                """
            ).fetchone()
            contract = connection.execute(
                """
                SELECT passed, summary_json
                FROM semantic_contract_reports
                ORDER BY id DESC
                LIMIT 1
                """
            ).fetchone()

            run_ids = list(dict.fromkeys(str(row[0]) for row in lineage_rows))[:12]
            quarantine_rows = []
            if run_ids:
                placeholders = ",".join("?" for _ in run_ids)
                quarantine_rows = connection.execute(
                    f"""
                    SELECT run_id, reason, raw_record_json, created_at
                    FROM asset_quarantine
                    WHERE run_id IN ({placeholders})
                    ORDER BY id DESC
                    """,
                    run_ids,
                ).fetchall()
                evidence_rows = connection.execute(
                    f"""
                    SELECT run_id, quarantine_json
                    FROM pipeline_run_evidence
                    WHERE run_id IN ({placeholders})
                    ORDER BY id DESC
                    """,
                    run_ids,
                ).fetchall()
            else:
                evidence_rows = []

        recent_runs = []
        seen_runs: set[str] = set()
        quarantines_by_run: dict[str, list[dict[str, Any]]] = {}
        for run_id, reason, raw_record_json, created_at in quarantine_rows:
            try:
                record = json.loads(str(raw_record_json))
            except json.JSONDecodeError:
                record = {"raw": str(raw_record_json)}
            quarantines_by_run.setdefault(str(run_id), []).append(
                {"reason": str(reason), "record": record, "created_at": str(created_at)}
            )
        for run_id, quarantine_json in evidence_rows:
            try:
                evidence = json.loads(str(quarantine_json))
            except json.JSONDecodeError:
                evidence = []
            if evidence:
                quarantines_by_run[str(run_id)] = evidence
        for row in lineage_rows:
            run_id = str(row[0])
            if run_id in seen_runs:
                continue
            seen_runs.add(run_id)
            recent_runs.append(
                {
                    "run_id": run_id,
                    "input_rows": int(row[1]),
                    "staged_rows": int(row[2]),
                    "published_rows": int(row[3]),
                    "quarantined_rows": int(row[4]),
                    "watermark_before": row[5],
                    "watermark_after": row[6],
                    "status": str(row[7]),
                    "error": row[8],
                    "created_at": str(row[9]),
                    "quarantine": quarantines_by_run.get(run_id, []),
                }
            )
            if len(recent_runs) == 12:
                break

        base["recent_runs"] = recent_runs
        base["completed_runs"] = int(success_count)
        base["failed_runs"] = int(failure_count)
        if watermark:
            base["watermark"] = {
                "value": str(watermark[0]),
                "updated_at": str(watermark[1]),
            }
        latest = recent_runs[0] if recent_runs else None
        if latest:
            failures = [str(latest["error"])] if latest["error"] else []
            failures.extend(
                item["reason"] for item in latest["quarantine"] if item["reason"] not in failures
            )
            quality_passed = latest["status"] == "success" and not failures
            checks_total = 4
            checks_passed = checks_total if quality_passed else max(0, checks_total - 1)
            if contract and not bool(contract[0]):
                quality_passed = False
                checks_passed = max(0, checks_passed - 1)
                failures.append("Semantic contract validation failed")
            base["last_run"] = latest
            base["quality"] = {
                "passed": quality_passed,
                "checks_passed": checks_passed,
                "checks_total": checks_total,
                "quarantined_rows": int(latest["quarantined_rows"]),
                "failures": failures,
            }
        return base

    def _quality_failure_config(self) -> Path:
        """Create a deterministic newer bad row without modifying bundled samples."""
        scenario_root = self.state_root / "scenarios" / "quality_failure"
        scenario_root.mkdir(parents=True, exist_ok=True)
        source_name = "quality_failure.csv"
        source_path = scenario_root / source_name
        shutil.copy2(self.config_path.parent / "anime_watch_events.csv", source_path)
        with source_path.open("a", encoding="utf-8", newline="") as handle:
            writer = csv.writer(handle)
            writer.writerow(["evt-bad-2001", "", "2026-01-04", 900, "Mobile"])
        config_text = self.config_path.read_text(encoding="utf-8")
        config_text = config_text.replace(
            "path: anime_watch_events.csv",
            f"path: {source_name}",
        )
        scenario_config = scenario_root / "assets.yml"
        scenario_config.write_text(config_text, encoding="utf-8")
        return scenario_config

    def _record_run_evidence(
        self,
        scenario: str,
        results: list[dict[str, Any]],
    ) -> None:
        """Persist immutable audit evidence separately from rollback state."""
        self.state_root.mkdir(parents=True, exist_ok=True)
        with sqlite_connection(self.metadata_database) as connection:
            self._ensure_evidence_table(connection)
            for result in results:
                quarantine = []
                if scenario == "quality_failure":
                    quarantine = [
                        {
                            "reason": "missing required column 'anime_title'",
                            "record": {
                                "event_id": "evt-bad-2001",
                                "anime_title": None,
                                "watched_at": "2026-01-04",
                                "watch_seconds": 900,
                                "device_type": "Mobile",
                            },
                            "created_at": datetime.now(UTC).isoformat(),
                        }
                    ]
                connection.execute(
                    """
                    INSERT INTO pipeline_run_evidence(
                        run_id, scenario, result_json, quarantine_json, created_at
                    ) VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(run_id) DO UPDATE SET
                        scenario = excluded.scenario,
                        result_json = excluded.result_json,
                        quarantine_json = excluded.quarantine_json,
                        created_at = excluded.created_at
                    """,
                    (
                        str(result["run_id"]),
                        scenario,
                        json.dumps(result, ensure_ascii=False, default=str),
                        json.dumps(quarantine, ensure_ascii=False),
                        datetime.now(UTC).isoformat(),
                    ),
                )

    @staticmethod
    def _ensure_evidence_table(connection: Any) -> None:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS pipeline_run_evidence (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id TEXT NOT NULL UNIQUE,
                scenario TEXT NOT NULL,
                result_json TEXT NOT NULL,
                quarantine_json TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
            """
        )


def _csv_row_count(path: Path) -> int:
    if not path.is_file():
        return 0
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return max(sum(1 for _ in csv.reader(handle)) - 1, 0)
