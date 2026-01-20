import {AsyncResult} from "../types";

// Error handling wrapper
async function handleAsync<T>(fn: () => Promise<T>): Promise<AsyncResult<T>> {
  try {
    return [null, await fn()];
  } catch (err) {
    return [err as Error, null];
  }
}

export default handleAsync;
