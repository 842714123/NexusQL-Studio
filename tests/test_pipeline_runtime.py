from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path

from queryforge.application.pipeline_runtime import PipelineRuntime
from queryforge.interfaces.api.app import create_app

try:
    from fastapi.testclient import TestClient
except ImportError:  # pragma: no cover - optional API dependency
    TestClient = None


class PipelineRuntimeTest(unittest.TestCase):
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

    def tearDown(self) -> None:
        self.temp_directory.cleanup()

    def test_run_persists_quality_lineage_and_incremental_watermark(self) -> None:
        first = self.runtime.run()

        self.assertEqual(first["status"], "success")
        self.assertFalse(first["idempotent"])
        self.assertGreater(first["results"][0]["published_rows"], 0)
        self.assertTrue(first["pipeline"]["quality"]["passed"])
        self.assertIsNotNone(first["pipeline"]["watermark"])
        self.assertEqual(first["pipeline"]["completed_runs"], 1)

        second = self.runtime.run()

        self.assertEqual(second["status"], "success")
        self.assertTrue(second["idempotent"])
        self.assertEqual(second["results"][0]["published_rows"], 0)
        self.assertEqual(second["pipeline"]["completed_runs"], 2)
        self.assertEqual(
            second["pipeline"]["last_run"]["watermark_before"],
            second["pipeline"]["last_run"]["watermark_after"],
        )

    def test_quality_failure_is_quarantined_without_advancing_watermark(self) -> None:
        first = self.runtime.run()
        watermark_before = first["pipeline"]["watermark"]["value"]

        failed = self.runtime.run(scenario="quality_failure")

        self.assertEqual(failed["status"], "failed")
        self.assertEqual(failed["scenario"], "quality_failure")
        self.assertFalse(failed["pipeline"]["quality"]["passed"])
        self.assertGreater(failed["pipeline"]["last_run"]["quarantined_rows"], 0)
        self.assertEqual(failed["pipeline"]["watermark"]["value"], watermark_before)
        self.assertEqual(
            failed["pipeline"]["last_run"]["watermark_before"],
            failed["pipeline"]["last_run"]["watermark_after"],
        )
        self.assertEqual(failed["pipeline"]["failed_runs"], 1)
        self.assertTrue(failed["pipeline"]["last_run"]["quarantine"])
        self.assertIn(
            "required column",
            failed["pipeline"]["last_run"]["quarantine"][0]["reason"],
        )

    @unittest.skipIf(TestClient is None, "FastAPI test client is unavailable")
    def test_api_exposes_pipeline_status_and_run(self) -> None:
        client = TestClient(create_app(pipeline_runtime=self.runtime))

        before = client.get("/engineering/pipeline/status")
        executed = client.post("/engineering/pipeline/run")
        failed = client.post(
            "/engineering/pipeline/run", params={"scenario": "quality_failure"}
        )

        self.assertEqual(before.status_code, 200)
        self.assertEqual(before.json()["completed_runs"], 0)
        self.assertEqual(executed.status_code, 200)
        self.assertEqual(executed.json()["pipeline"]["completed_runs"], 1)
        self.assertEqual(failed.status_code, 200)
        self.assertEqual(failed.json()["status"], "failed")


if __name__ == "__main__":
    unittest.main()
