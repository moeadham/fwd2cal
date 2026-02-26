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
