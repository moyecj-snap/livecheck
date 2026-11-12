/**
 * Read at most `maxBytes` of a response body, then stop the download.
 *
 * The body is read as a stream. Once more than `maxBytes` decoded bytes have
 * arrived, the reader is cancelled (undici closes the connection) and the
 * caller's `stop` hook runs (fetchPage and the job-board reader abort their
 * request signal). Content-Length is never trusted. For gzip / br / deflate
 * responses, fetch decodes as it streams, so the cap is on decoded bytes and
 * the compressed download stops at the same point; nothing is fully buffered.
 */
export type CappedBody = {
  /** At most maxBytes. */
  bytes: Uint8Array;
  /** The body had more than maxBytes. */
  truncated: boolean;
  /** Decoded bytes pulled from the stream before it was stopped (>= bytes.byteLength). */
  received: number;
};

export async function readCappedBody(
  response: Response,
  maxBytes: number,
  stop?: () => void,
): Promise<CappedBody> {
  const reader = response.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(0), truncated: false, received: 0 };
  const chunks: Uint8Array[] = [];
  let kept = 0;
  let received = 0;
  let truncated = false;
  let finished = false;
  try {
    while (kept < maxBytes) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        break;
      }
      if (!value || value.byteLength === 0) continue;
      received += value.byteLength;
      const room = maxBytes - kept;
      if (value.byteLength > room) {
        chunks.push(value.subarray(0, room));
        kept += room;
        truncated = true;
        break;
      }
      chunks.push(value);
      kept += value.byteLength;
    }
    if (!truncated && !finished && kept >= maxBytes) {
      // Exactly at the cap: one more read tells a body of exactly maxBytes
      // from a longer one.
      for (;;) {
        const extra = await reader.read();
        if (extra.done) break;
        if (extra.value && extra.value.byteLength > 0) {
          received += extra.value.byteLength;
          truncated = true;
          break;
        }
      }
    }
  } finally {
    if (truncated || !finished) {
      await reader.cancel().catch(() => undefined);
      stop?.();
    } else {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(kept);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, truncated, received };
}
