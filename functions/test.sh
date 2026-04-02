#!/bin/bash



if [ -z "$TESTER_PRIMARY_GOOGLE_ACCT" ]; then
  echo "WARN: TESTER_PRIMARY_GOOGLE_ACCT is not set. Setting to default: export TESTER_PRIMARY_GOOGLE_ACCT=\"jezos.beff.420@gmail.com\""
  export TESTER_PRIMARY_GOOGLE_ACCT="jezos.beff.420@gmail.com"
  # exit 1
fi

if [ -z "$TESTER_SECONDARY_EMAIL_ACCT" ]; then
  echo "WARN: TESTER_SECONDARY_EMAIL_ACCT is not set. Setting to default: export TESTER_SECONDARY_EMAIL_ACCT=\"jezos.beff.420+secondary@gmail.com\""
  export TESTER_SECONDARY_EMAIL_ACCT="jezos.beff.420+secondary@gmail.com"
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

echo "Starting firebase emulator"
firebase emulators:start --config ../firebase.calendar.json --project fwd2cal-dev-2578e > /dev/stdout &
LOGS_PID=$!
sleep 30

echo "running tests"
./node_modules/.bin/mocha test/test.cjs --timeout 99999999999 --bail "$@" || TEST_FAILED=true

# Stop the logs stream
kill $LOGS_PID

# Exit with error if tests failed
if [ "$TEST_FAILED" = true ]; then
    exit 1
fi
sleep 10
