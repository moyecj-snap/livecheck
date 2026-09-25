import { createReadStream, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

/** Public URL for the Confirm LI-v4 demo. File lives in public/ and is copied into the Fly image. */
export const CONFIRM_DEMO_VIDEO_PATH = "/media/Livecheck-Confirm-HowDoYouKnow-LI-v4.mp4";

const CONFIRM_DEMO_VIDEO_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../public/Livecheck-Confirm-HowDoYouKnow-LI-v4.mp4",
);

/**
 * Serve the committed mp4 with byte ranges so browsers can play and seek.
 * Same public/ pattern as GET /llms.txt — no CDN.
 */
export function confirmDemoVideoResponse(request: Request): Response {
  const size = statSync(CONFIRM_DEMO_VIDEO_FILE).size;
  const headers: Record<string, string> = {
    "content-type": "video/mp4",
    "accept-ranges": "bytes",
    "cache-control": "public, max-age=86400",
  };
  const range = request.headers.get("range");
  if (!range) {
    return new Response(Readable.toWeb(createReadStream(CONFIRM_DEMO_VIDEO_FILE)) as ReadableStream, {
      status: 200,
      headers: { ...headers, "content-length": String(size) },
    });
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!match || (match[1] === "" && match[2] === "")) {
    return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${size}` } });
  }

  let start: number;
  let end: number;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Number(match[2]);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= size || start > end) {
    return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${size}` } });
  }
  end = Math.min(end, size - 1);
  return new Response(Readable.toWeb(createReadStream(CONFIRM_DEMO_VIDEO_FILE, { start, end })) as ReadableStream, {
    status: 206,
    headers: {
      ...headers,
      "content-length": String(end - start + 1),
      "content-range": `bytes ${start}-${end}/${size}`,
    },
  });
}
