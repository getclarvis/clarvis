# syntax=docker/dockerfile:1
# Build from the REPOSITORY ROOT, not this directory:
#   docker build -f packages/server/Dockerfile -t clarvis-server .

FROM oven/bun:1.4.0-slim AS deps
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY packages/capability/package.json  packages/capability/
COPY packages/supervision/package.json packages/supervision/
COPY packages/llm/package.json         packages/llm/
COPY packages/paths/package.json       packages/paths/
COPY packages/trace/package.json       packages/trace/
COPY packages/mcp-client/package.json  packages/mcp-client/
COPY packages/tools/package.json       packages/tools/
COPY packages/hooks/package.json       packages/hooks/
COPY packages/skills/package.json      packages/skills/
COPY packages/memory/package.json      packages/memory/
COPY packages/plan/package.json        packages/plan/
COPY packages/goal/package.json        packages/goal/
COPY packages/tasks/package.json       packages/tasks/
COPY packages/protocol/package.json    packages/protocol/
COPY packages/loop/package.json        packages/loop/
COPY packages/workflows/package.json   packages/workflows/
COPY packages/kernel/package.json      packages/kernel/
COPY packages/server/package.json      packages/server/
COPY packages/code/package.json        packages/code/
RUN bun install --frozen-lockfile

# The build stage is a library typecheck gate, not the artifact: `tsc -b` must
# succeed, but the runtime stage ships source (see the runtime stage's note).
# The server image does not need the terminal client's distributable bundle.
FROM deps AS build
WORKDIR /app
COPY tsconfig.base.json tsconfig.json ./
COPY packages/ packages/
RUN bun run build:packages

FROM oven/bun:1.4.0-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    CLARVIS_SERVER_HOST=0.0.0.0 \
    # Binding 0.0.0.0 is required for the container's port mapping to reach it
    # at all; the isolation boundary here is the container network, not the
    # bind address (see README "Running"), so the public-bind refusal is
    # opted out of by the image itself rather than left for every operator to
    # discover after their first container exits(1) on boot.
    CLARVIS_SERVER_ALLOW_PUBLIC_BIND=1 \
    CLARVIS_SERVER_PORT=8080 \
    CLARVIS_WORKSPACE_ROOT=/workspace \
    CLARVIS_HOME=/config \
    CLARVIS_LOG_LEVEL=info \
    # Retention is off in the library so the local TUI is unaffected; 30 days is
    # the product default and belongs here, where the product is.
    CLARVIS_TRACE_TTL_DAYS=30 \
    # Headless: never park a run on an elicitation nobody will answer.
    CLARVIS_DEFAULT_ON_EXCEED=stop \
    CLARVIS_DEFAULT_ELICIT_WAIT_MS=60000 \
    CLARVIS_DEFAULT_TOTAL_TOKEN_LIMIT=8000000 \
    CLARVIS_TOKEN_CEILING=10000000 \
    CLARVIS_ITERATION_CEILING=200 \
    CLARVIS_TIMEOUT_CEILING_MS=600000

COPY --from=build /app/node_modules      /app/node_modules
COPY --from=build /app/package.json      /app/package.json
COPY --from=build /app/packages          /app/packages

# The base image ships no `rg`, and CI installs it explicitly for the same
# reason (see .github/workflows/ci.yml). Without it every `grep` in this
# container takes @clarvis/tools' in-process JS fallback — the slow path, and
# the one a hostile pattern can stall — 100% of the time, so the image installs
# it rather than leaving the safer native path to chance. This must run before
# `USER bun`, because apt needs root. The trailing `rg --version` is a
# build-time assertion: if the package ever leaves the base image's sources the
# build fails here instead of silently shipping the fallback.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ripgrep \
 && rm -rf /var/lib/apt/lists/* \
 && rg --version

# Run from source, deliberately. Every @clarvis/* package exports a "bun"
# condition pointing at src/, the loop resolves its optional subsystems through
# dynamic specifiers, and the provider adapter is a dynamic import — exactly the
# patterns a bundler drops silently.
RUN mkdir -p /workspace /config && chown -R bun:bun /workspace /config /app
USER bun
EXPOSE 8080
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD bun -e "await fetch('http://127.0.0.1:'+(process.env.CLARVIS_SERVER_PORT??8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["bun", "run", "packages/server/src/bin.ts"]
