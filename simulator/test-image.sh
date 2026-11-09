#!/bin/sh
# Runs the simulator's tests inside a built image, so a test sees the packages the image ships.
# The tests read files from studio, so the whole checkout is mounted. cdp_sim still comes from the image's /app.
set -eu
image="$1"
repo="$(cd "$(dirname "$0")/.." && pwd)"
docker run --rm --user root -v "$repo:/src:ro" --entrypoint sh "$image" -c '
  pip install --quiet --no-cache-dir --require-hashes -r /src/simulator/requirements-test.lock
  python -c "import cdp_sim; print(\"cdp_sim from\", cdp_sim.__file__)"
  python -m pytest -q -p no:cacheprovider /src/simulator/tests
'
