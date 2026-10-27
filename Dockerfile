# syntax=docker/dockerfile:1
FROM rust:1.96-slim AS build
WORKDIR /src
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config ca-certificates && apt-get clean
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY migrations ./migrations
COPY openapi.yaml ./
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/src/target \
    cargo build --release --bin mailcraft-server --bin mailcraft \
 && cp target/release/mailcraft-server target/release/mailcraft /usr/local/bin/

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /usr/local/bin/mailcraft-server /usr/local/bin/mailcraft /usr/local/bin/
EXPOSE 8080
USER nonroot
ENTRYPOINT ["/usr/local/bin/mailcraft-server"]
