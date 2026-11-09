#!/bin/bash
set -e

# Target paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${SCRIPT_DIR}/../src/main/thrift"
TARGET_FILE="${TARGET_DIR}/collector-payload.thrift"

# Official Snowplow Thrift schema URL
URL="https://raw.githubusercontent.com/snowplow/snowplow/master/2-collectors/thrift-schemas/collector-payload-1/src/main/thrift/collector-payload.thrift"

echo "Creating target directory: ${TARGET_DIR}"
mkdir -p "${TARGET_DIR}"

echo "Downloading official Snowplow collector-payload.thrift..."
curl -sS "${URL}" -o "${TARGET_FILE}"

echo "Adjusting Java namespace for project compatibility..."
# Replace the official namespace with com.cdp.platform.model
if [[ "$OSTYPE" == "darwin"* ]]; then
  sed -i '' 's/namespace java com.snowplowanalytics.snowplow.CollectorPayload.thrift.model1/namespace java com.cdp.platform.model/g' "${TARGET_FILE}"
else
  sed -i 's/namespace java com.snowplowanalytics.snowplow.CollectorPayload.thrift.model1/namespace java com.cdp.platform.model/g' "${TARGET_FILE}"
fi

echo "Successfully downloaded and configured: ${TARGET_FILE}"
