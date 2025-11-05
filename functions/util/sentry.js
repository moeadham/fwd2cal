const Sentry = require("@sentry/node");
const {nodeProfilingIntegration} = require("@sentry/profiling-node");
const {SENTRY_DSN} = require("./config");
const {logger} = require("firebase-functions");

// Lazy initialization of Sentry
let sentryInitialized = false;
const initSentry = () => {
  if (!sentryInitialized) {
    const dsn = SENTRY_DSN.value();
    if (dsn) {
      Sentry.init({
        dsn: dsn,
        integrations: [
          nodeProfilingIntegration(),
        ],
        // Performance Monitoring
        tracesSampleRate: 1.0, //  Capture 100% of the transactions
        // Set sampling rate for profiling - relative to tracesSampleRate
        profilesSampleRate: 1.0,
      });
      sentryInitialized = true;
    }
  }
};

const wrapAndReport = (fn) => async (...args) => {
  try {
    return await fn(...args);
  } catch (e) {
    initSentry(); // Initialize Sentry if not already done
    logger.warn("Capturing exception in Sentry");
    logger.error(e);
    if (sentryInitialized) {
      Sentry.captureException(e);
      await Sentry.flush(2000);
    }
    throw e;
  }
};

module.exports = {wrapAndReport};
