/**
 * Minimal Sentinel watch callback receiver.
 *
 * Recipes: check (one-shot) stays request/response. watch POSTs HMAC-signed
 * events to callback.url. Point POST /v1/watch callback.url here.
 *
 *   LIVECHECK_WEBHOOK_SECRET=whsec_example npx tsx examples/sentinel-webhook.ts
 *
 * Header: X-Sentinel-Signature: t=<unix>,v1=<hex>
 * v1 = lowercase hex HMAC-SHA256(secret, raw_body)
 * t is NOT part of the MAC. Reject stale t (default 5 minutes).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const SENTINEL_SIGNATURE_HEADER = "x-sentinel-signature";
export const DEFAULT_MAX_AGE_S = 5 * 60;

export function parseSentinelSignature(header: string): { t: number; v1: string } | undefined {
  const parts = Object.fromEntries(
    header.split(",").map((part) => {
      const eq = part.trim().indexOf("=");
      return eq === -1 ? ["", ""] : [part.trim().slice(0, eq), part.trim().slice(eq + 1)];
    }),
  );
  const t = Number(parts.t);
  const v1 = typeof parts.v1 === "string" ? parts.v1.toLowerCase() : "";
  if (!Number.isInteger(t) || !/^[0-9a-f]+$/.test(v1)) return undefined;
  return { t, v1 };
}

export function verifySentinelSignature(
  secret: string,
  rawBody: string,
  header: string,
  nowS = Math.floor(Date.now() / 1000),
  maxAgeS = DEFAULT_MAX_AGE_S,
): boolean {
  const parsed = parseSentinelSignature(header);
  if (!parsed) return false;
  if (Math.abs(nowS - parsed.t) > maxAgeS) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  try {
    const a = Buffer.from(parsed.v1, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length || a.length === 0) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function startSentinelWebhook(options: {
  secret: string;
  port?: number;
  hostname?: string;
}): ReturnType<typeof createServer> {
  const port = options.port ?? (Number(process.env.PORT) || 8788);
  const hostname = options.hostname ?? "127.0.0.1";
  const server = createServer(async (req, res) => {
    if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "livecheck-sentinel-webhook" }));
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }
    const rawBody = await readBody(req);
    const header = req.headers[SENTINEL_SIGNATURE_HEADER];
    const signature = Array.isArray(header) ? header[0] : header;
    if (!signature || !verifySentinelSignature(options.secret, rawBody, signature)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_signature" }));
      return;
    }
    let event: unknown = rawBody;
    try {
      event = JSON.parse(rawBody);
    } catch {
      /* keep raw */
    }
    console.log(JSON.stringify({ event: "sentinel.callback", payload: event }));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  server.listen(port, hostname, () => {
    console.error(`sentinel webhook listening on http://${hostname}:${port}`);
  });
  return server;
}

const isMain = Boolean(
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href,
);
if (isMain) {
  const secret = process.env.LIVECHECK_WEBHOOK_SECRET?.trim();
  if (!secret) {
    console.error("Set LIVECHECK_WEBHOOK_SECRET (same value as watch callback.secret).");
    process.exit(1);
  }
  startSentinelWebhook({ secret });
}
