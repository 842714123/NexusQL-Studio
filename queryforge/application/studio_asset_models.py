"""Validated application contracts for Studio profiling and publication."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator


class EncodedAssetFile(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    content_base64: str = Field(min_length=1)

    @field_validator("name")
    @classmethod
    def safe_name(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized or normalized in {".", ".."}:
            raise ValueError("upload name is invalid")
        if "/" in normalized or "\\" in normalized:
            raise ValueError("upload name must not contain path separators")
        return normalized


class AssetProfileRequest(BaseModel):
    file: EncodedAssetFile


class UploadedMetricContract(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(min_length=1, max_length=500)
    aggregation: Literal["count", "sum"]
    expression: str = Field(min_length=1, max_length=500)


class UploadedSemanticContract(BaseModel):
    version: int = Field(default=1, ge=1)
    entity: str = Field(min_length=1, max_length=120)
    description: str = Field(min_length=1, max_length=1000)
    owner: str = Field(min_length=1, max_length=200)
    grain: str = Field(min_length=1, max_length=500)
    primary_key: str = Field(min_length=1, max_length=500)
    sensitivity: Literal["public", "internal", "restricted"] = "internal"
    dimensions: list[str] = Field(min_length=1, max_length=200)
    metrics: list[UploadedMetricContract] = Field(default_factory=list, max_length=50)
    reviewed: bool = False


class UploadedPipelineContract(BaseModel):
    watermark_field: str | None = Field(default=None, max_length=120)
    watermark_lookback_seconds: int = Field(default=0, ge=0, le=2_592_000)
    required_columns: list[str] = Field(min_length=1, max_length=200)
    unique_key: list[str] = Field(min_length=1, max_length=20)
    max_invalid_ratio: float = Field(default=0.05, ge=0.0, le=1.0)
    publish_mode: Literal["append", "upsert"] = "upsert"


class AssetPublishRequest(BaseModel):
    domain_id: str = Field(pattern=r"^[A-Za-z0-9_-]{3,120}$")
    source_id: str = Field(pattern=r"^[A-Za-z0-9_-]{3,120}$")
    file: EncodedAssetFile
    semantic_contract: UploadedSemanticContract
    pipeline_contract: UploadedPipelineContract
