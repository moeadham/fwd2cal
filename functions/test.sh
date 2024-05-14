#!/bin/bash



if [ -z "$TESTER_PRIMARY_GOOGLE_ACCT" ]; then
  echo "Error: TESTER_PRIMARY_GOOGLE_ACCT is not set: export TESTER_PRIMARY_GOOGLE_ACCT=\"your@gmail.com\""
  exit 1
fi

if [ -z "$TESTER_SECONDARY_EMAIL_ACCT" ]; then
  echo "Error: TESTER_SECONDARY_EMAIL_ACCT is not set: export TESTER_SECONDARY_EMAIL_ACCT=\"anotherEmailAddressThatYouUse@anything.com\""
  exit 1
fi

# If emulator didn't shut down cleanly last time, try:
# lsof -ti :8085 | xargs kill
lsof -ti :8085 | xargs kill
lsof -ti :4500 | xargs kill
lsof -ti :4400 | xargs kill
lsof -ti :5000 | xargs kill
lsof -ti :8080 | xargs kill

echo "Starting firebase emulator"
firebase emulators:start > /dev/stdout &
LOGS_PID=$!
sleep 15

echo "running tests"
mocha test/test.js --timeout 99999999999 --bail || TEST_FAILED=true

# Stop the logs stream
kill $LOGS_PID

# Exit with error if tests failed
if [ "$TEST_FAILED" = true ]; then
    exit 1
fi
sleep 10