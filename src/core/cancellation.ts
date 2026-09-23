/**
 * Settles with `cancelled()` as soon as `signal` aborts, instead of waiting for work that cannot itself be
 * cancelled. The abandoned work keeps running under its own owner and bounds; its eventual rejection is
 * consumed so it can never surface as an unhandled rejection.
 */
export function raceAbort<T>(work: Promise<T>, signal: AbortSignal | undefined, cancelled: () => Error): Promise<T> {
  if (signal === undefined) return work;
  if (signal.aborted) {
    work.catch(() => { /* abandoned after cancellation */ });
    return Promise.reject(cancelled());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      work.catch(() => { /* abandoned after cancellation */ });
      reject(cancelled());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}
