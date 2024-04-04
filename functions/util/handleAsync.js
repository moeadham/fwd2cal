/* eslint-disable require-jsdoc */

// Error handling wrapper
async function handleAsync(fn) {
  try {
    return [null, await fn()];
  } catch (err) {
    return [err, null];
  }
}

module.exports = handleAsync;
