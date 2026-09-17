# UID 1001 = mesmo do pwuser do backend (lê o volume de áudio).
# CUDA 12.8 (driver do host ≥ 570). cuBLAS 12 e cuDNN 9 vêm das wheels nvidia-* do torch cu128
# e são expostos ao ctranslate2 via LD_LIBRARY_PATH — um único cuDNN no processo.
FROM nvidia/cuda:12.8.1-base-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    UV_PYTHON_INSTALL_DIR=/opt/python \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/venv

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg python3-pip \
    && pip3 install --no-cache-dir uv==0.12.3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv python install 3.12 \
    && uv sync --frozen --no-dev --no-install-project
COPY src ./src
RUN uv sync --frozen --no-dev

ENV PATH=/opt/venv/bin:$PATH \
    LD_LIBRARY_PATH=/opt/venv/lib/python3.12/site-packages/nvidia/cublas/lib:/opt/venv/lib/python3.12/site-packages/nvidia/cudnn/lib \
    HF_HOME=/models/hf \
    WHISPER_CACHE=/models/whisper \
    PYTHONUNBUFFERED=1

RUN useradd --create-home --uid 1001 worker \
    && mkdir -p /models \
    && chown worker:worker /models
USER worker

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s \
  CMD curl -fsS http://127.0.0.1:8000/health || exit 1

CMD ["uvicorn", "worker_gpu.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
