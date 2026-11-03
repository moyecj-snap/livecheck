import { AsyncLocalStorage } from "node:async_hooks";
import type { Context, Next } from "hono";
import { apiKeyDb, authorizeStarterKey, finishStarterCall, reserveStarterCall } from "./api-key-store.js";
import { BOARD_URL_SHAPE_MESSAGE, classifyStarterSpend, isBoardUrlShape, starterKeyNow } from "./starter-key.js";
import { parseTargetUrl } from "./verify.js";

/**
 * A valid `Authorization: Bearer lc_live_…` on a verify route runs inside
 * this flag, the same way test mode does: the payment gate is skipped, the
 * check still uses the shared concurrency slots, and no paid_calls row is
 * written. Confirm, Sentinel, and /check never set the flag.
 */

const starterKeyAls = new AsyncLocalStorage<{ keyId: string }>();

export function isStarterKeyRequest(): boolean {
  return starterKeyAls.getStore() !== undefined;
}

type Admit = (c: Context, run: () => Promise<Response | void>) => Promise<Response | void>;

function deny(
  c: Context,
  status: 401 | 402 | 403 | 429 | 503,
  error: string,
  message: string,
  extra?: { retryAfter?: number; freeUsed?: number; freeAllowance?: number },
): Response {
  c.header("cache-control", "no-store");
  c.header("x-livecheck-starter-key", "1");
  if (extra?.retryAfter) c.header("retry-after", String(extra.retryAfter));
  const body: Record<string, unknown> = { error, message };
  if (extra?.freeUsed !== undefined) body.free_used = extra.freeUsed;
  if (extra?.freeAllowance !== undefined) body.free_allowance = extra.freeAllowance;
  return c.json(body, status);
}

/** URL string is a board. No fetch. Body stays cached for the handler when this is false. */
async function requestIsBoardShape(c: Context): Promise<boolean> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return false;
  }
  const raw = typeof body === "object" && body !== null ? (body as { url?: unknown }).url : undefined;
  if (typeof raw !== "string") return false;
  try {
    return isBoardUrlShape(parseTargetUrl(raw));
  } catch {
    return false;
  }
}

async function spendFromResponse(res: Response | undefined): Promise<{ charge: boolean; blocked: boolean }> {
  if (!res) return { charge: false, blocked: false };
  if (res.status !== 200) return { charge: false, blocked: false };
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("json")) return { charge: false, blocked: false };
  try {
    return classifyStarterSpend(res.status, await res.clone().json());
  } catch {
    return { charge: false, blocked: false };
  }
}

/**
 * Admit a starter-key verify. `admit` is the shared check-slot queue.
 * The credit reservation is released when the answer is not chargeable,
 * including a 503 from a full queue.
 */
export async function runStarterKeyAdmission(c: Context, next: Next, token: string, admit: Admit): Promise<Response | void> {
  const db = apiKeyDb();
  if (!db) {
    return deny(c, 503, "starter_keys_unavailable", "Starter keys are not available on this process.");
  }
  if (await requestIsBoardShape(c)) {
    const auth = authorizeStarterKey(db, token, starterKeyNow());
    if (!auth.ok) {
      return deny(c, auth.status, auth.error, auth.message, {
        retryAfter: auth.retryAfter,
        freeUsed: auth.freeUsed,
        freeAllowance: auth.freeAllowance,
      });
    }
    c.header("cache-control", "no-store");
    c.header("x-livecheck-starter-key", "1");
    return c.json({ error: "board_url", message: BOARD_URL_SHAPE_MESSAGE, billed: false, price_usd: 0 }, 400);
  }
  const reserved = reserveStarterCall(db, token, starterKeyNow());
  if (!reserved.ok) {
    return deny(c, reserved.status, reserved.error, reserved.message, {
      retryAfter: reserved.retryAfter,
      freeUsed: reserved.freeUsed,
      freeAllowance: reserved.freeAllowance,
    });
  }
  const keyId = reserved.key.id;
  let settled = false;
  const settle = async (outcome: { charge: boolean; blocked: boolean }) => {
    if (settled) return;
    settled = true;
    try {
      const done = finishStarterCall(db, keyId, outcome, starterKeyNow());
      const left = Math.max(0, done.freeAllowance - done.freeUsed);
      c.res?.headers.set("x-livecheck-free-left", String(left));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[starter_keys] could not settle key ${keyId}: ${reason}`);
    }
  };
  c.header("cache-control", "no-store");
  c.header("x-livecheck-starter-key", "1");
  try {
    const response = await admit(c, async () => {
      try {
        await starterKeyAls.run({ keyId }, () => next());
        await settle(await spendFromResponse(c.res));
      } catch (error) {
        await settle({ charge: false, blocked: false });
        throw error;
      }
    });
    if (!settled) await settle({ charge: false, blocked: false });
    return response;
  } catch (error) {
    if (!settled) await settle({ charge: false, blocked: false });
    throw error;
  }
}
