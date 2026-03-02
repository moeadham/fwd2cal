#!/bin/bash
# Deploy a specific agent's functions
# Usage: ./scripts/deploy-agent.sh <calendar|drive> [--project <project>]

set -e

AGENT="$1"
shift || true

if [ -z "$AGENT" ]; then
  echo "Usage: $0 <calendar|drive> [--project <project>]"
  exit 1
fi

AGENT_CONFIG="../firebase.${AGENT}.json"
AGENT_MAIN="lib/agents/${AGENT}/index.js"

if [ ! -f "$AGENT_CONFIG" ]; then
  echo "Error: ${AGENT_CONFIG} not found."
  exit 1
fi

# Determine target project: explicit --project flag takes priority, otherwise active Firebase project
PROJECT=""
ARGS=("$@")
for ((i=0; i<${#ARGS[@]}; i++)); do
  if [ "${ARGS[$i]}" = "--project" ] && [ $((i+1)) -lt ${#ARGS[@]} ]; then
    PROJECT="${ARGS[$((i+1))]}"
    break
  fi
done
if [ -z "$PROJECT" ]; then
  PROJECT=$(firebase use 2>/dev/null)
fi

# Verify OAuth credentials for the target project exist before building
CREDS_DIR="src/agents/${AGENT}/auth"
if [ "$PROJECT" = "fwd2cal-dev-2578e" ]; then
  SUFFIX="-dev"
else
  SUFFIX=""
fi

case "$AGENT" in
  calendar) CREDS_FILE="v2-google-auth-credentials-fwd2cal${SUFFIX}.json" ;;
  drive)    CREDS_FILE="v2-google-auth-credentials-drive2cal${SUFFIX}.json" ;;
esac

if [ ! -f "${CREDS_DIR}/${CREDS_FILE}" ]; then
  echo "Error: Missing OAuth credentials: ${CREDS_DIR}/${CREDS_FILE}"
  exit 1
fi

# Build first
npm run build

if [ ! -f "$AGENT_MAIN" ]; then
  echo "Error: ${AGENT_MAIN} not found."
  exit 1
fi

# Point package.json main to agent entry point for deployment
ORIGINAL_MAIN=$(node -e "console.log(require('./package.json').main)")
set_main() {
  node -e "
    const fs = require('fs');
    const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf-8'));
    pkg.main = '$1';
    fs.writeFileSync('./package.json', JSON.stringify(pkg, null, 2) + '\n');
  "
}
set_main "$AGENT_MAIN"
trap 'set_main "$ORIGINAL_MAIN"' EXIT

echo "Deploying ${AGENT} agent"
firebase deploy --config "${AGENT_CONFIG}" "$@"
