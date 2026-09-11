#!/usr/bin/env bash
set -euo pipefail
image_ref="$1"
engine="$2"
if [[ "$engine" == docker ]]; then
  export CLARVIS_DOCKER_RUNTIME_CANARY=1
  export CLARVIS_DOCKER_RUNTIME_CONTEXT=default
  export CLARVIS_DOCKER_RUNTIME_IMAGE_DIGEST="$(docker image inspect --format '{{.Id}}' "$image_ref")"
  [[ "$CLARVIS_DOCKER_RUNTIME_IMAGE_DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]]
  cd packages/kernel
  bun test tests/integration/local-docker-runtime.e2e.test.ts tests/integration/runtime-docker-identity.e2e.test.ts tests/integration/runtime-mcp-hooks.e2e.test.ts --timeout 60000
elif [[ "$engine" == podman ]]; then
  socket_dir="$(mktemp -d)"
  connection="clarvis-canary-$RANDOM"
  podman system service --time=0 "unix://$socket_dir/podman.sock" > "$socket_dir/service.log" 2>&1 &
  service_pid=$!
  trap 'podman system connection remove "$connection" >/dev/null 2>&1 || true; kill "$service_pid" 2>/dev/null || true; rm -rf "$socket_dir"' EXIT
  for attempt in $(seq 1 100); do
    if [[ -S "$socket_dir/podman.sock" ]]; then break; fi
    sleep 0.1
  done
  test -S "$socket_dir/podman.sock"
  podman system connection add "$connection" "unix://$socket_dir/podman.sock"
  export CLARVIS_PODMAN_RUNTIME_CANARY=1
  export CLARVIS_PODMAN_RUNTIME_CONNECTION="$connection"
  digest="$(podman image inspect --format '{{.Id}}' "$image_ref")"
  export CLARVIS_PODMAN_RUNTIME_IMAGE_DIGEST="sha256:${digest#sha256:}"
  [[ "$CLARVIS_PODMAN_RUNTIME_IMAGE_DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]]
  cd packages/kernel
  bun test tests/integration/local-docker-runtime.e2e.test.ts tests/integration/runtime-podman-isolation.e2e.test.ts tests/integration/runtime-mcp-hooks.e2e.test.ts --timeout 60000
else
  echo 'engine must be docker or podman' >&2
  exit 1
fi
