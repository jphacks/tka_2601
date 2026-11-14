# Pin uv independently from the Python runtime so dependency resolution is repeatable.
FROM ghcr.io/astral-sh/uv:0.13.7 AS uv-bin

FROM python:3.12-slim-bookworm AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH="/opt/venv/bin:$PATH" \
    HOME=/home/monban

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg libstdc++6 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 monban \
    && useradd --system --uid 10001 --gid monban --home-dir /home/monban monban \
    && mkdir -p /app /data /home/monban/.cache \
    && chown -R monban:monban /app /data /home/monban

COPY --from=uv-bin /uv /uvx /usr/local/bin/
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY --chown=monban:monban monban_backend ./monban_backend

USER 10001:10001
EXPOSE 8093
CMD ["uvicorn", "monban_backend.api:app", "--host", "0.0.0.0", "--port", "8093", "--proxy-headers", "--forwarded-allow-ips", "*"]
