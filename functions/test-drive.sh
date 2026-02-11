#!/bin/bash



if [ -z "$TESTER_PRIMARY_GOOGLE_ACCT" ]; then
  echo "WARN: TESTER_PRIMARY_GOOGLE_ACCT is not set. Setting to default: export TESTER_PRIMARY_GOOGLE_ACCT=\"jezos.beff.420@gmail.com\""
  export TESTER_PRIMARY_GOOGLE_ACCT="jezos.beff.420@gmail.com"
  # exit 1
fi

# If emulator didn't shut down cleanly last time, try:
# lsof -ti :8085 | xargs kill
lsof -ti :8085 | xargs kill
lsof -ti :4500 | xargs kill
lsof -ti :4400 | xargs kill
lsof -ti :5000 | xargs kill
lsof -ti :5002 | xargs kill
lsof -ti :8080 | xargs kill

echo "Building TypeScript..."
npm run build || { echo "Build failed"; exit 1; }

# Load environment variables from .env.local for tests
if [ -f .env.local ]; then
  echo "Loading environment variables from .env.local..."
  set -a
  source .env.local
  set +a
fi

echo "Starting firebase emulator (using dev project)"
firebase use dev
firebase emulators:start > /dev/stdout &
LOGS_PID=$!
sleep 30

echo "running drive tests"
./node_modules/.bin/mocha --require ts-node/register test/drive.test.ts --timeout 99999999999 --bail "$@" || TEST_FAILED=true

# Stop the logs stream
kill $LOGS_PID

# Restore default project
firebase use default

# Exit with error if tests failed
if [ "$TEST_FAILED" = true ]; then
    exit 1
fi
sleep 10
