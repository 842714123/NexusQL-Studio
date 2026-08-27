from __future__ import annotations

import shutil
import tempfile
import threading
import time
import unittest
from pathlib import Path

from queryforge.application.pipeline_orchestrator import PipelineRunOrchestrator
from queryforge.application.pipeline_runtime import PipelineRuntime
from queryforge.interfaces.api.app import create_app

try:
    from fastapi.testclient import TestClient
except ImportError:  # pragma: no cover - optional API dependency
    TestClient = None


class PipelineRunOrchestratorTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_directory.name)
        source_root = Path(__file__).resolve().parents[1] / "sample_data" / "data_assets"
        self.config = self.root / "assets.yml"
        shutil.copy2(source_root / "assets.yml", self.config)
        shutil.copy2(source_root / "anime_watch_events.csv", self.root)
        self.runtime = PipelineRuntime(
            config_path=self.config,
            publish_database=self.root / "published.sqlite",
            state_root=self.root / "state",
        )
        self.orchestrator = PipelineRunOrchestrator(self.runtime)

    def tearDown(self) -> None:
        self.orchestrator.shutdown()
        self.temp_directory.cleanup()

    def test_persistent_state_machine_records_stage_and_operation_timings(self) -> None:
        submitted = self.orchestrator.submit("standard")
        finished = self.wait_for_terminal(submitted["run_id"])

        self.assertEqual(finished["status"], "succeeded")
        self.assertIsNotNone(finished["queue_delay_ms"])
        self.assertIsNotNone(finished["execution_duration_ms"])
        details = finished["result"]["results"][0]["details"]
        self.assertIn("stage_durations_ms", details)
        self.assertIn("extract", details["stage_durations_ms"])
        self.assertIn("quality", details["stage_durations_ms"])
        self.assertIn("publish", details["stage_durations_ms"])
        self.assertGreaterEqual(details["batch_duration_ms"], 0)
        self.assertEqual(self.orchestrator.list()[0]["run_id"], finished["run_id"])

    def test_quality_failure_is_classified_and_can_be_manually_retried(self) -> None:
        submitted = self.orchestrator.submit("quality_failure")
        failed = self.wait_for_terminal(submitted["run_id"])

        self.assertEqual(failed["status"], "failed")
        self.assertEqual(failed["error_type"], "data_quality_error")
        self.assertFalse(failed["retryable"])

        retried = self.orchestrator.retry(failed["run_id"])
        retry_finished = self.wait_for_terminal(retried["run_id"])
        self.assertEqual(retry_finished["attempt"], 2)
        self.assertEqual(retry_finished["retry_of"], failed["run_id"])

    @unittest.skipIf(TestClient is None, "FastAPI test client is unavailable")
    def test_api_exposes_create_poll_list_and_retry(self) -> None:
        client = TestClient(
            create_app(
                pipeline_runtime=self.runtime,
                pipeline_orchestrator=self.orchestrator,
            )
        )

        created = client.post(
            "/engineering/pipeline/runs",
            json={"scenario": "quality_failure"},
        )
        self.assertEqual(created.status_code, 202)
        run_id = created.json()["run_id"]
        finished = self.wait_for_terminal(run_id)

        detail = client.get(f"/engineering/pipeline/runs/{run_id}")
        listed = client.get("/engineering/pipeline/runs", params={"limit": 10})
        retried = client.post(f"/engineering/pipeline/runs/{run_id}/retry")

        self.assertEqual(finished["status"], "failed")
        self.assertEqual(detail.status_code, 200)
        self.assertEqual(listed.status_code, 200)
        self.assertTrue(listed.json()["runs"])
        self.assertEqual(retried.status_code, 202)
        self.wait_for_terminal(retried.json()["run_id"])

    def wait_for_terminal(self, run_id: str) -> dict:
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            operation = self.orchestrator.get(run_id)
            if operation["status"] in {"succeeded", "failed", "cancelled"}:
                return operation
            time.sleep(0.01)
        self.fail(f"Pipeline run {run_id} did not finish")


class PipelineCancellationTest(unittest.TestCase):
    def test_queued_run_can_be_cancelled_without_interrupting_active_work(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            entered = threading.Event()
            release = threading.Event()

            class BlockingRuntime:
                state_root = root

                @staticmethod
                def run(scenario: str = "standard") -> dict:
                    entered.set()
                    release.wait(timeout=5)
                    return {"status": "success", "scenario": scenario, "results": []}

            orchestrator = PipelineRunOrchestrator(BlockingRuntime())  # type: ignore[arg-type]
            try:
                first = orchestrator.submit()
                self.assertTrue(entered.wait(timeout=2))
                queued = orchestrator.submit()

                cancelled = orchestrator.cancel(queued["run_id"])

                self.assertEqual(cancelled["status"], "cancelled")
                self.assertTrue(cancelled["retryable"])
                release.set()
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline:
                    if orchestrator.get(first["run_id"])["status"] == "succeeded":
                        break
                    time.sleep(0.01)
                self.assertEqual(orchestrator.get(first["run_id"])["status"], "succeeded")
            finally:
                release.set()
                orchestrator.shutdown()


if __name__ == "__main__":
    unittest.main()
