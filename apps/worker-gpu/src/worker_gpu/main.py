"""API HTTP interna do worker-gpu (specs/001-agente-reunioes-mvp/contracts/worker-gpu.md)."""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .audio import pcm_to_float32
from .gpu import gpu_stats

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("worker")


class FileIn(BaseModel):
    path: str = Field(max_length=500)
    channel: str = Field(default="mixed", pattern="^(mic|remote|mixed)$")
    diarize: bool = False


class JobIn(BaseModel):
    language: str = Field(default="pt", max_length=8)
    prompt: str | None = Field(default=None, max_length=400)
    files: list[FileIn] = Field(min_length=1, max_length=4)


def create_app(engine=None, diarizer=None, jobs=None, load_model: bool = True) -> FastAPI:
    if engine is None:
        from .asr import engine_from_env

        engine = engine_from_env()
    if diarizer is None:
        from .diarize import diarizer_from_env

        diarizer = diarizer_from_env()
    if jobs is None:
        from .jobs import JobManager

        jobs = JobManager(engine, diarizer)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        if load_model:
            engine.load_in_background()
        jobs.start()
        yield

    app = FastAPI(title="worker-gpu", lifespan=lifespan)

    @app.get("/health")
    def health():
        diarization, reason = diarizer.status()
        body = {
            "ok": engine.ready,
            "model": engine.model_name,
            "compute_type": engine.compute_type,
            "device": engine.device,
            "diarization": diarization,
            "diarization_reason": reason,
            "error": engine.error,
        }
        return JSONResponse(body, status_code=200 if engine.ready else 503)

    @app.get("/gpu")
    def gpu():
        stats = gpu_stats()
        if stats is None:
            return JSONResponse({"error": "gpu indisponível"}, status_code=503)
        return stats

    @app.post("/transcribe/chunk")
    async def transcribe_chunk(
        request: Request,
        language: str = Query(default="pt", max_length=8),
        prompt: str | None = Query(default=None, max_length=400),
        channel: str = Query(default="mixed", max_length=10),
    ):
        if not engine.ready:
            raise HTTPException(503, "modelo carregando")
        body = await request.body()
        try:
            audio = pcm_to_float32(body)
        except ValueError as err:
            raise HTTPException(400, str(err)) from err
        result = await run_in_threadpool(engine.transcribe_chunk, audio, language, prompt)
        log.info(
            "chunk %s: %.1fs de áudio, %.1fs de fala, %d segmentos em %.2fs",
            channel, result.duration, result.speech_seconds, len(result.segments), result.elapsed,
        )
        return {
            "duration": round(result.duration, 3),
            "speech_seconds": round(result.speech_seconds, 3),
            "elapsed": round(result.elapsed, 3),
            "segments": [{"start": round(s.start, 3), "end": round(s.end, 3), "text": s.text} for s in result.segments],
        }

    @app.post("/jobs/transcribe", status_code=202)
    def submit_job(body: JobIn):
        if not engine.ready:
            raise HTTPException(503, "modelo carregando")
        try:
            job = jobs.submit([f.model_dump() for f in body.files], body.language, body.prompt)
        except ValueError as err:
            raise HTTPException(400, str(err)) from err
        return {"job_id": job.id}

    @app.get("/jobs/{job_id}")
    def get_job(job_id: str):
        job = jobs.get(job_id)
        if job is None:
            raise HTTPException(404, "job não encontrado")
        return job.to_json()

    return app


app = create_app() if os.environ.get("WORKER_GPU_NO_APP") != "1" else None


def run() -> None:
    import uvicorn

    uvicorn.run("worker_gpu.main:app", host="0.0.0.0", port=8000, workers=1)
