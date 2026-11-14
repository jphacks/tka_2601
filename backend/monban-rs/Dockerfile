# Rust build of the Monban API (relay v2 voice pipeline included). Build for the Pi on the
# Mac with `docker buildx build --platform linux/arm64`, then `docker save | ssh docker load`.
FROM rust:1.92-slim-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN cargo build --release --locked -p monban-backend --bin monban-api

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 monban \
    && useradd --system --uid 10001 --gid monban --home-dir /nonexistent --shell /usr/sbin/nologin monban
COPY --from=build /src/target/release/monban-api /usr/local/bin/monban-api
ENV MONBAN_HOST=0.0.0.0 \
    MONBAN_PORT=8093
USER 10001:10001
EXPOSE 8093
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["monban-api", "healthcheck"]
CMD ["monban-api"]
