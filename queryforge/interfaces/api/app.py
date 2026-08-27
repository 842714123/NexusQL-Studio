"""FastAPI routes that delegate every operation to AgentService."""

from __future__ import annotations

import json
from typing import Callable

from queryforge import __version__
from queryforge.interfaces.api.schemas import (
    AskRequest,
    AssetProfileRequest,
    AssetPublishRequest,
    GatewayWebhookRequest,
    PipelineRunRequest,
)
from queryforge.interfaces.gateway import GatewayAdapter
from queryforge.application import AgentService
from queryforge.application.pipeline_runtime import PipelineRuntime
from queryforge.application.pipeline_orchestrator import (
    PipelineRunConflict,
    PipelineRunNotFound,
    PipelineRunOrchestrator,
)
from queryforge.application.studio_assets import StudioAssetService


class APIUnavailableError(RuntimeError):
    pass


def create_app(
    service: AgentService | None = None,
    pipeline_runtime: PipelineRuntime | None = None,
    studio_asset_service: StudioAssetService | None = None,
    pipeline_orchestrator: PipelineRunOrchestrator | None = None,
):
    try:
        from fastapi import FastAPI, HTTPException
        from fastapi.responses import FileResponse, StreamingResponse
    except ImportError as exc:
        raise APIUnavailableError(
            "FastAPI server is unavailable. Install optional dependencies with: "
            "pip install -r requirements-server.txt"
        ) from exc

    agent_service = service or AgentService()
    asset_pipeline = pipeline_runtime or PipelineRuntime()
    pipeline_runs = pipeline_orchestrator or PipelineRunOrchestrator(asset_pipeline)
    studio_assets = studio_asset_service or StudioAssetService()
    gateway = GatewayAdapter(agent_service)
    app = FastAPI(
        title="NexusQL API",
        version=__version__,
        description="Thin REST/Gateway transports over the shared AgentService.",
    )

    def call(operation: Callable[[], dict | list]):
        try:
            return operation()
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.get("/health")
    def health():
        return agent_service.health()

    @app.get("/models")
    def models():
        return call(agent_service.list_models)

    @app.get("/skills")
    def skills():
        return call(agent_service.list_skills)

    @app.get("/engineering/pipeline/status")
    def pipeline_status():
        return call(asset_pipeline.status)

    @app.post("/engineering/pipeline/run")
    def pipeline_run(scenario: str = "standard"):
        return call(lambda: asset_pipeline.run(scenario=scenario))

    @app.post("/engineering/pipeline/runs", status_code=202)
    def create_pipeline_run(request: PipelineRunRequest):
        return call(lambda: pipeline_runs.submit(request.scenario))

    @app.get("/engineering/pipeline/runs")
    def list_pipeline_runs(limit: int = 20):
        return {"runs": pipeline_runs.list(limit=limit)}

    @app.get("/engineering/pipeline/runs/{run_id}")
    def get_pipeline_run(run_id: str):
        try:
            return pipeline_runs.get(run_id)
        except PipelineRunNotFound as exc:
            raise HTTPException(status_code=404, detail="Pipeline run not found") from exc

    @app.post("/engineering/pipeline/runs/{run_id}/retry", status_code=202)
    def retry_pipeline_run(run_id: str):
        try:
            return pipeline_runs.retry(run_id)
        except PipelineRunNotFound as exc:
            raise HTTPException(status_code=404, detail="Pipeline run not found") from exc
        except PipelineRunConflict as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.post("/engineering/pipeline/runs/{run_id}/cancel")
    def cancel_pipeline_run(run_id: str):
        try:
            return pipeline_runs.cancel(run_id)
        except PipelineRunNotFound as exc:
            raise HTTPException(status_code=404, detail="Pipeline run not found") from exc
        except PipelineRunConflict as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.post("/engineering/assets/profile")
    def profile_asset(request: AssetProfileRequest):
        return call(lambda: studio_assets.profile(request))

    @app.post("/engineering/assets/publish", status_code=201)
    def publish_asset(request: AssetPublishRequest):
        return call(lambda: studio_assets.publish(request))

    @app.post("/ask")
    def ask(request: AskRequest):
        return call(lambda: agent_service.ask(request.question, request.to_options()))

    @app.post("/ask/stream")
    def ask_stream(request: AskRequest):
        try:
            event_stream = agent_service.stream(
                request.question,
                request.to_options(entrypoint="api_stream"),
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        def sse_events():
            for event in event_stream:
                yield f"data: {event.model_dump_json()}\n\n"

        return StreamingResponse(sse_events(), media_type="text/event-stream")

    @app.post("/plan")
    def plan(request: AskRequest):
        return call(lambda: agent_service.plan(request.question, request.to_options()))

    @app.get("/report/{run_id}")
    def report(run_id: str):
        try:
            return FileResponse(
                agent_service.report_path(run_id),
                media_type="text/html",
                filename=f"{run_id}.html",
            )
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/gateway/webhook")
    def gateway_webhook(request: GatewayWebhookRequest):
        return call(
            lambda: gateway.handle(
                user_id=request.user_id,
                channel=request.channel,
                text=request.text,
            )
        )

    return app
