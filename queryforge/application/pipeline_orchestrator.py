"""Persistent asynchronous orchestration for governed pipeline runs."""

from __future__ import annotations

import json
import threading
from concurrent.futures import Future, ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from queryforge.application.pipeline_runtime import PipelineRuntime
from queryforge.infrastructure.db.connection import sqlite_connection


TERMINAL_STATES = {"succeeded", "failed", "cancelled"}


class PipelineRunNotFound(KeyError):
    """Raised when an orchestration run id does not exist."""


class PipelineRunConflict(ValueError):
    """Raised when retry or cancellation conflicts with the current state."""


class PipelineRunOrchestrator:
    """Serialize pipeline work while persisting a queryable task state machine."""

    def __init__(
        self,
        runtime: PipelineRuntime,
        database: str | Path | None = None,
        *,
        max_workers: int = 1,
    ) -> None:
        self.runtime = runtime
        self.database = Path(
            database or runtime.state_root / "orchestration.sqlite"
        ).expanduser().resolve()
        self.database.parent.mkdir(parents=True, exist_ok=True)
        self._executor = ThreadPoolExecutor(
            max_workers=max_workers,
            thread_name_prefix="queryforge-pipeline",
        )
        self._futures: dict[str, Future[None]] = {}
        self._lock = threading.Lock()
        self._initialize()

    def submit(
        self,
        scenario: str = "standard",
        *,
        retry_of: str | None = None,
        attempt: int = 1,
    ) -> dict[str, Any]:
        if scenario not in {"standard", "quality_failure"}:
            raise ValueError("scenario must be 'standard' or 'quality_failure'")
        run_id = f"pipeline_{uuid4().hex}"
        created_at = _now()
        with sqlite_connection(self.database) as connection:
            connection.execute(
                """
                INSERT INTO pipeline_operations(
                    run_id, scenario, status, attempt, retry_of, retryable,
                    created_at, updated_at
                ) VALUES (?, ?, 'queued', ?, ?, 0, ?, ?)
                """,
                (run_id, scenario, attempt, retry_of, created_at, created_at),
            )
        with self._lock:
            future = self._executor.submit(self._execute, run_id, scenario)
            self._futures[run_id] = future
        return self.get(run_id)

    def get(self, run_id: str) -> dict[str, Any]:
        with sqlite_connection(self.database) as connection:
            row = connection.execute(
                f"SELECT {_SELECT_COLUMNS} FROM pipeline_operations WHERE run_id = ?",
                (run_id,),
            ).fetchone()
        if row is None:
            raise PipelineRunNotFound(run_id)
        return _operation(row)

    def list(self, limit: int = 20) -> list[dict[str, Any]]:
        bounded_limit = max(1, min(int(limit), 100))
        with sqlite_connection(self.database) as connection:
            rows = connection.execute(
                f"SELECT {_SELECT_COLUMNS} FROM pipeline_operations "
                "ORDER BY created_at DESC LIMIT ?",
                (bounded_limit,),
            ).fetchall()
        return [_operation(row) for row in rows]

    def retry(self, run_id: str) -> dict[str, Any]:
        previous = self.get(run_id)
        if previous["status"] not in {"failed", "cancelled"}:
            raise PipelineRunConflict(
                "Only failed or cancelled pipeline runs can be retried"
            )
        return self.submit(
            str(previous["scenario"]),
            retry_of=run_id,
            attempt=int(previous["attempt"]) + 1,
        )

    def cancel(self, run_id: str) -> dict[str, Any]:
        operation = self.get(run_id)
        if operation["status"] != "queued":
            raise PipelineRunConflict("Only queued pipeline runs can be cancelled")
        with self._lock:
            future = self._futures.get(run_id)
            cancelled = bool(future and future.cancel())
        if not cancelled:
            raise PipelineRunConflict(
                "The pipeline run has already started and cannot be cancelled safely"
            )
        now = _now()
        with sqlite_connection(self.database) as connection:
            connection.execute(
                """
                UPDATE pipeline_operations
                SET status = 'cancelled', finished_at = ?, updated_at = ?,
                    error_type = 'cancelled_by_user',
                    error_message = 'Cancelled before worker execution',
                    retryable = 1
                WHERE run_id = ? AND status = 'queued'
                """,
                (now, now, run_id),
            )
        return self.get(run_id)

    def shutdown(self, *, wait: bool = True) -> None:
        self._executor.shutdown(wait=wait, cancel_futures=not wait)

    def _initialize(self) -> None:
        with sqlite_connection(self.database) as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS pipeline_operations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_id TEXT NOT NULL UNIQUE,
                    scenario TEXT NOT NULL,
                    status TEXT NOT NULL CHECK (
                        status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')
                    ),
                    attempt INTEGER NOT NULL,
                    retry_of TEXT,
                    retryable INTEGER NOT NULL DEFAULT 0,
                    error_type TEXT,
                    error_message TEXT,
                    result_json TEXT,
                    created_at TEXT NOT NULL,
                    started_at TEXT,
                    finished_at TEXT,
                    updated_at TEXT NOT NULL,
                    queue_delay_ms REAL,
                    execution_duration_ms REAL
                )
                """
            )
            connection.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_pipeline_operations_status_created
                ON pipeline_operations(status, created_at DESC)
                """
            )
            now = _now()
            connection.execute(
                """
                UPDATE pipeline_operations
                SET status = 'failed', finished_at = ?, updated_at = ?,
                    error_type = 'worker_interrupted',
                    error_message = 'The process stopped before the run reached a terminal state',
                    retryable = 1
                WHERE status IN ('queued', 'running')
                """,
                (now, now),
            )

    def _execute(self, run_id: str, scenario: str) -> None:
        started_at = _now()
        with sqlite_connection(self.database) as connection:
            created = connection.execute(
                "SELECT created_at FROM pipeline_operations WHERE run_id = ?",
                (run_id,),
            ).fetchone()
            if created is None:
                return
            queue_delay_ms = _elapsed_ms(str(created[0]), started_at)
            updated = connection.execute(
                """
                UPDATE pipeline_operations
                SET status = 'running', started_at = ?, updated_at = ?,
                    queue_delay_ms = ?
                WHERE run_id = ? AND status = 'queued'
                """,
                (started_at, started_at, queue_delay_ms, run_id),
            )
            if updated.rowcount != 1:
                return

        try:
            payload = self.runtime.run(scenario=scenario)
            finished_at = _now()
            succeeded = payload.get("status") == "success"
            error_type, error_message, retryable = _classify_payload(payload)
            with sqlite_connection(self.database) as connection:
                connection.execute(
                    """
                    UPDATE pipeline_operations
                    SET status = ?, result_json = ?, finished_at = ?, updated_at = ?,
                        execution_duration_ms = ?, error_type = ?, error_message = ?,
                        retryable = ?
                    WHERE run_id = ?
                    """,
                    (
                        "succeeded" if succeeded else "failed",
                        json.dumps(payload, ensure_ascii=False, default=str),
                        finished_at,
                        finished_at,
                        _elapsed_ms(started_at, finished_at),
                        error_type,
                        error_message,
                        int(retryable),
                        run_id,
                    ),
                )
        except Exception as exc:  # noqa: BLE001 - boundary persists all failures
            finished_at = _now()
            with sqlite_connection(self.database) as connection:
                connection.execute(
                    """
                    UPDATE pipeline_operations
                    SET status = 'failed', finished_at = ?, updated_at = ?,
                        execution_duration_ms = ?, error_type = 'execution_error',
                        error_message = ?, retryable = 1
                    WHERE run_id = ?
                    """,
                    (
                        finished_at,
                        finished_at,
                        _elapsed_ms(started_at, finished_at),
                        str(exc),
                        run_id,
                    ),
                )
        finally:
            with self._lock:
                self._futures.pop(run_id, None)


_SELECT_COLUMNS = """
run_id, scenario, status, attempt, retry_of, retryable,
error_type, error_message, result_json, created_at, started_at, finished_at,
updated_at, queue_delay_ms, execution_duration_ms
""".strip()


def _operation(row: tuple[Any, ...]) -> dict[str, Any]:
    result = json.loads(str(row[8])) if row[8] else None
    return {
        "run_id": str(row[0]),
        "scenario": str(row[1]),
        "status": str(row[2]),
        "attempt": int(row[3]),
        "retry_of": row[4],
        "retryable": bool(row[5]),
        "error_type": row[6],
        "error_message": row[7],
        "result": result,
        "created_at": str(row[9]),
        "started_at": str(row[10]) if row[10] else None,
        "finished_at": str(row[11]) if row[11] else None,
        "updated_at": str(row[12]),
        "queue_delay_ms": float(row[13]) if row[13] is not None else None,
        "execution_duration_ms": float(row[14]) if row[14] is not None else None,
    }


def _classify_payload(payload: dict[str, Any]) -> tuple[str | None, str | None, bool]:
    if payload.get("status") == "success":
        return None, None, False
    errors = [
        str(result.get("error"))
        for result in payload.get("results", [])
        if result.get("error")
    ]
    message = "; ".join(errors) or "Pipeline publication failed"
    lowered = message.lower()
    if any(token in lowered for token in ("invalid ratio", "required column", "duplicate")):
        return "data_quality_error", message, False
    if any(token in lowered for token in ("contract", "semantic", "configuration")):
        return "contract_error", message, False
    return "pipeline_error", message, True


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _elapsed_ms(start: str, finish: str) -> float:
    started_at = datetime.fromisoformat(start)
    finished_at = datetime.fromisoformat(finish)
    return round((finished_at - started_at).total_seconds() * 1000, 3)
