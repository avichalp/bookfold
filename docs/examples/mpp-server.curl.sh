#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8787}"
FILE_PATH="${FILE_PATH:-./book.pdf}"
DETAIL="${DETAIL:-short}"

UPLOAD_JSON="$(curl -sS "$BASE_URL/v1/uploads" \
  -H 'content-type: application/json' \
  -d "{
    \"fileName\": \"$(basename "$FILE_PATH")\",
    \"contentType\": \"application/pdf\",
    \"sizeBytes\": $(wc -c < "$FILE_PATH" | tr -d ' ')
  }")"

echo "$UPLOAD_JSON"

# Use the returned client token to upload to Blob with your MPP-capable client.

QUOTE_JSON="$(curl -sS "$BASE_URL/v1/quotes" \
  -H 'content-type: application/json' \
  -d "{
    \"uploadId\": \"$(printf '%s' "$UPLOAD_JSON" | jq -r '.fileId')\",
    \"detail\": \"$DETAIL\"
  }")"

echo "$QUOTE_JSON"

QUOTE_ID="$(printf '%s' "$QUOTE_JSON" | jq -r '.quoteId')"

curl -i "$BASE_URL/v1/jobs" \
  -H 'content-type: application/json' \
  -d "{\"quoteId\":\"$QUOTE_ID\"}"

# The first call should return 402.
# Retry the same request with a valid MPP Authorization header from your client.
