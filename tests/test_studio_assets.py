from __future__ import annotations

import base64
import tempfile
import unittest
from pathlib import Path

from queryforge.application.studio_asset_models import (
    AssetProfileRequest,
    AssetPublishRequest,
    EncodedAssetFile,
    UploadedMetricContract,
    UploadedPipelineContract,
    UploadedSemanticContract,
)
from queryforge.application.studio_assets import StudioAssetService
from queryforge.infrastructure.db.connection import sqlite_connection
from queryforge.interfaces.api.app import create_app

try:
    from fastapi.testclient import TestClient
except ImportError:  # pragma: no cover - optional API dependency
    TestClient = None


CSV = """Event ID,Anime Title,Watched At,Watch Seconds,Device Type
evt-1,Frieren,2026-01-01,1800,Mobile
evt-2,One Piece,2026-01-02,2400,Web
evt-3,Naruto,2026-01-03,1200,TV
"""


def encoded_file() -> EncodedAssetFile:
    return EncodedAssetFile(
        name="watch_events.csv",
        content_base64=base64.b64encode(CSV.encode("utf-8")).decode("ascii"),
    )


class StudioAssetServiceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_directory.name)
        self.service = StudioAssetService(self.root)

    def tearDown(self) -> None:
        self.temp_directory.cleanup()

    def test_profile_uses_physical_rows_instead_of_fixed_demo_values(self) -> None:
        profile = self.service.profile(AssetProfileRequest(file=encoded_file()))

        self.assertEqual(profile["row_count"], 3)
        self.assertEqual(profile["column_count"], 5)
        self.assertEqual(profile["candidate_primary_key"], "event_id")
        self.assertEqual(profile["candidate_watermark"], "watched_at")
        self.assertEqual(profile["columns"][3]["data_type"], "integer")
        self.assertEqual(profile["preview"][0]["anime_title"], "Frieren")

    def test_reviewed_upload_is_published_as_queryable_asset(self) -> None:
        request = self.publish_request()

        published = self.service.publish(request)

        self.assertEqual(published["published_rows"], 3)
        self.assertEqual(published["watermark_after"], "2026-01-03")
        self.assertTrue(Path(published["database_path"]).is_file())
        self.assertTrue(Path(published["semantic_model_path"]).is_file())
        self.assertTrue(Path(published["sql_policy_path"]).is_file())
        with sqlite_connection(published["database_path"]) as connection:
            count = connection.execute(
                "SELECT COUNT(*) FROM fact_watch_events"
            ).fetchone()[0]
        self.assertEqual(count, 3)

        repeated = self.service.publish(request)

        self.assertEqual(repeated["published_rows"], 0)
        self.assertEqual(repeated["watermark_before"], "2026-01-03")
        self.assertEqual(repeated["watermark_after"], "2026-01-03")

        corrected_csv = CSV.replace("evt-2,One Piece,2026-01-02,2400,Web", "evt-2,One Piece,2026-01-02,2600,Web")
        corrected_csv += "evt-4,Pluto,2026-01-04,900,Mobile\n"
        corrected = request.model_copy(
            update={
                "file": EncodedAssetFile(
                    name="watch_events.csv",
                    content_base64=base64.b64encode(
                        corrected_csv.encode("utf-8")
                    ).decode("ascii"),
                ),
                "pipeline_contract": request.pipeline_contract.model_copy(
                    update={"watermark_lookback_seconds": 172800}
                ),
            }
        )
        late_publish = self.service.publish(corrected)
        late_details = late_publish["results"][0]["details"]
        self.assertEqual(late_details["late_rows"], 2)
        self.assertEqual(late_details["updated_rows"], 2)
        self.assertEqual(late_details["inserted_rows"], 1)
        self.assertEqual(late_publish["watermark_after"], "2026-01-04")
        with sqlite_connection(late_publish["database_path"]) as connection:
            watch_seconds = connection.execute(
                "SELECT watch_seconds FROM fact_watch_events WHERE event_id = 'evt-2'"
            ).fetchone()[0]
        self.assertEqual(watch_seconds, 2600)

        different_source = request.model_copy(update={"source_id": "source_other"})
        with self.assertRaisesRegex(Exception, "one executable asset per domain"):
            self.service.publish(different_source)

    @unittest.skipIf(TestClient is None, "FastAPI test client is unavailable")
    def test_api_exposes_real_profile_and_publish_routes(self) -> None:
        client = TestClient(create_app(studio_asset_service=self.service))

        profiled = client.post(
            "/engineering/assets/profile",
            json=AssetProfileRequest(file=encoded_file()).model_dump(),
        )
        published = client.post(
            "/engineering/assets/publish",
            json=self.publish_request().model_dump(),
        )

        self.assertEqual(profiled.status_code, 200)
        self.assertEqual(profiled.json()["row_count"], 3)
        self.assertEqual(published.status_code, 201)
        self.assertEqual(published.json()["published_rows"], 3)

    @staticmethod
    def publish_request() -> AssetPublishRequest:
        return AssetPublishRequest(
            domain_id="domain_interview",
            source_id="source_watch_events",
            file=encoded_file(),
            semantic_contract=UploadedSemanticContract(
                entity="watch_events",
                description="One row per reviewed anime playback event.",
                owner="data-platform",
                grain="event_id",
                primary_key="event_id",
                sensitivity="internal",
                dimensions=[
                    "event_id",
                    "anime_title",
                    "watched_at",
                    "watch_seconds",
                    "device_type",
                ],
                metrics=[
                    UploadedMetricContract(
                        name="watch_hours",
                        description="Total uploaded watch seconds.",
                        aggregation="sum",
                        expression="SUM(watch_seconds)",
                    )
                ],
                reviewed=True,
            ),
            pipeline_contract=UploadedPipelineContract(
                watermark_field="watched_at",
                required_columns=["event_id", "watched_at"],
                unique_key=["event_id"],
                max_invalid_ratio=0.05,
            ),
        )


if __name__ == "__main__":
    unittest.main()
