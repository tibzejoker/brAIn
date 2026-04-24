"""Transparent HTTP proxy to the upstream voice and gaze servers.

The intent node does not replicate voice/gaze profile CRUD — we forward
those calls so the front-end can do everything (rename, merge, delete,
adjust tuning, list voiceprints / faceprints) against the authoritative
backends without extra wiring. Only identity *linking* into "persons" is
owned by this node, and lives at /api/persons.

Paths mapped:
    /api/voice/*   →   <voice_url>/api/*
    /api/gaze/*    →   <gaze_url>/api/*
"""
from __future__ import annotations

import logging
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Request, Response

log = logging.getLogger(__name__)


def build_proxy(prefix: str, upstream_url: str, client: httpx.AsyncClient) -> APIRouter:
    router = APIRouter(prefix=f"/api/{prefix}")

    async def forward(request: Request, rest: str) -> Response:
        url = f"{upstream_url.rstrip('/')}/api/{rest}"
        body = await request.body()
        headers = {
            k: v for k, v in request.headers.items()
            if k.lower() not in {"host", "content-length", "connection"}
        }
        params = dict(request.query_params)
        try:
            resp = await client.request(
                request.method,
                url,
                content=body if body else None,
                params=params,
                headers=headers,
                timeout=30.0,
            )
        except httpx.HTTPError as e:
            log.warning("proxy %s %s → %s failed: %s", request.method, url, upstream_url, e)
            raise HTTPException(status_code=502, detail=f"upstream {prefix} unreachable: {e}") from e
        # Pass through body + status + content-type. Drop transfer-encoding
        # because FastAPI/Starlette will set its own.
        out_headers = {
            k: v for k, v in resp.headers.items()
            if k.lower() not in {"transfer-encoding", "content-length", "content-encoding"}
        }
        return Response(
            content=resp.content, status_code=resp.status_code, headers=out_headers,
        )

    @router.api_route("/{rest:path}", methods=["GET", "POST", "PATCH", "DELETE", "PUT"])
    async def proxy_any(rest: str, request: Request) -> Response:
        return await forward(request, rest)

    return router


async def fetch_json(client: httpx.AsyncClient, url: str) -> Any:
    resp = await client.get(url, timeout=10.0)
    resp.raise_for_status()
    return resp.json()
