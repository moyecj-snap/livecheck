import { CHECK_TIMEOUT_SIGNAL, VERIFY_DEADLINE_MS } from "./config.js";

/**
 * The verify/check envelope elapsed. Verify turns this into status unknown.
 * Check turns it into 422 baseline_unreachable. Both carry check_timeout.
 */
export class DeadlineError extends Error {
  readonly signal = CHECK_TIMEOUT_SIGNAL;
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`${CHECK_TIMEOUT_SIGNAL}: exceeded ${timeoutMs}ms`);
    this.name = "DeadlineError";
    this.timeoutMs = timeoutMs;
  }
}

let deadlineOverrideMs: number | null = null;

/** Test seam. Production leaves this unset so VERIFY_DEADLINE_MS applies. */
export function setDeadlineForTests(ms: number | null): void {
  deadlineOverrideMs = ms;
}

export function resolveDeadlineMs(explicit?: number): number {
  if (explicit != null) return explicit;
  if (deadlineOverrideMs != null) return deadlineOverrideMs;
  return VERIFY_DEADLINE_MS;
}

export function isAbortLike(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

/**
 * Abort after `timeoutMs`, or sooner when `parent` aborts.
 * Caller must `cancel()` so the timer does not outlive the fetch.
 */
export function linkedAbort(
  timeoutMs: number,
  parent?: AbortSignal,
): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const onParent = () => controller.abort();
  if (parent) {
    if (parent.aborted) controller.abort();
    else parent.addEventListener("abort", onParent, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParent);
    },
  };
}

/**
 * Race `work` against a deadline and abort its signal when the deadline wins.
 * A fetch that honors the signal stops; the event loop is not left waiting on it.
 */
export async function withDeadline<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new DeadlineError(ms));
    }, ms);
  });
  deadline.catch(() => undefined);
  const task = work(controller.signal).then(
    (value) => value,
    (error: unknown) => {
      if (settled) return undefined as T;
      throw error;
    },
  );
  try {
    const result = await Promise.race([task, deadline]);
    settled = true;
    return result;
  } catch (error) {
    settled = true;
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
