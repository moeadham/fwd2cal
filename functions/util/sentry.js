const Sentry = require("@sentry/node");
const {nodeProfilingIntegration} = require("@sentry/profiling-node");
const {SENTRY_DSN} = require("./credentials");

Sentry.init({
  dsn: SENTRY_DSN,
  integrations: [
    nodeProfilingIntegration(),
  ],
  // Performance Monitoring
  tracesSampleRate: 1.0, //  Capture 100% of the transactions
  // Set sampling rate for profiling - this is relative to tracesSampleRate
  profilesSampleRate: 1.0,
});

const wrapAndReport = (fn) => async (...args) => {
  try {
    return await fn(...args);
  } catch (e) {
    // TODO: Disable this on local.
    Sentry.captureException(e);
    await Sentry.flush(2000);
    throw e;
  }
};

module.exports = {wrapAndReport};
