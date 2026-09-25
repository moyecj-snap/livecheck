import { createReadStream, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

/** Founder-approved Confirm LI-v4 cut. File lives in public/ and is copied by the Dockerfile. */
export const CONFIRM_CLIP_PATH = "/static/Livecheck-Confirm-HowDoYouKnow-LI-v4.mp4";

const CONFIRM_CLIP_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../public/static/Livecheck-Confirm-HowDoYouKnow-LI-v4.mp4",
);

function clipHeaders(size: number, extra: Record<string, string> = {}): Record<string, string> {
  return {
    "content-type": "video/mp4",
    "accept-ranges": "bytes",
    "cache-control": "public, max-age=86400",
    "content-length": String(size),
    ...extra,
  };
}

function webStream(file: ReturnType<typeof createReadStream>): ReadableStream {
  return Readable.toWeb(file) as ReadableStream;
}

/**
 * Stream the Confirm clip. HTML5 video seeks with a single Range request;
 * a multi-range header falls back to the full file.
 */
export function confirmClipResponse(rangeHeader: string | undefined, head: boolean): Response {
  const size = statSync(CONFIRM_CLIP_FILE).size;
  const range = rangeHeader?.trim();
  if (!range || range.includes(",")) {
    return new Response(head ? null : webStream(createReadStream(CONFIRM_CLIP_FILE)), {
      status: 200,
      headers: clipHeaders(size),
    });
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    return new Response(head ? null : "Invalid range", {
      status: 416,
      headers: { "content-range": `bytes */${size}` },
    });
  }

  let start = match[1] === "" ? NaN : Number(match[1]);
  let end = match[2] === "" ? size - 1 : Number(match[2]);
  if (match[1] === "" && match[2] !== "") {
    const suffix = Number(match[2]);
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else if (match[1] === "") {
    start = 0;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= size || start > end) {
    return new Response(null, {
      status: 416,
      headers: { "content-range": `bytes */${size}` },
    });
  }
  end = Math.min(end, size - 1);
  const length = end - start + 1;
  return new Response(head ? null : webStream(createReadStream(CONFIRM_CLIP_FILE, { start, end })), {
    status: 206,
    headers: clipHeaders(length, { "content-range": `bytes ${start}-${end}/${size}` }),
  });
}
