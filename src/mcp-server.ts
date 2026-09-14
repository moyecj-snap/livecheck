import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  checkListing,
  confirmListing,
  livecheckOrigin,
  livecheckVerifyUrl,
  watchChainTopup,
  watchEvents,
  watchGet,
  watchListing,
  watchRenew,
  watchStop,
  verifyListing,
} from "./mcp-client.js";

export const MCP_SERVER_NAME = "livecheck";
export const MCP_SERVER_VERSION = "0.1.0";

/** Canonical paid tools Gil recipes should call. */
export const MCP_PAID_TOOLS = ["verify", "check", "confirm", "watch"] as const;
/** Existing Cursor plugin / mcp.json still calls this. */
export const MCP_COMPAT_TOOLS = ["verify_listing"] as const;
/** Free owner-token follow-ups already on Fly. */
export const MCP_WATCH_FOLLOWUP_TOOLS = ["watch_get", "watch_events", "watch_stop"] as const;
/** Paid owner-token follow-ups. */
export const MCP_WATCH_PAID_FOLLOWUP_TOOLS = ["watch_chain_topup", "watch_renew"] as const;

export const MCP_TOOL_NAMES = [
  ...MCP_COMPAT_TOOLS,
  ...MCP_PAID_TOOLS,
  ...MCP_WATCH_FOLLOWUP_TOOLS,
  ...MCP_WATCH_PAID_FOLLOWUP_TOOLS,
] as const;

const paymentSignature = z
  .string()
  .optional()
  .describe(
    "Optional PAYMENT-SIGNATURE / X-PAYMENT envelope from the caller. This MCP has no wallet and does not settle. Omit to receive a structured HTTP 402 (paid: false) with decoded x402 accept info.",
  );

const targetShape = z.object({
  type: z.literal("url").optional().describe('Must be "url".'),
  url: z.string().describe("Absolute http(s) URL you already have."),
  render: z.literal("never").optional().describe('HTML only. "always" is not available (no Playwright / fast tier).'),
  selector: z.string().nullable().optional().describe("Optional CSS selector. Null is fine."),
});

const conditionShape = z.object({
  detector: z
    .enum(["status_change", "keyword", "text_diff", "numeric_threshold"])
    .describe("Sentinel detector. Same set as POST /v1/check."),
  params: z
    .record(z.unknown())
    .optional()
    .describe(
      "Detector params. status_change: {}. keyword: any/all/none arrays. text_diff: selector, ignore, min_change_ratio. numeric_threshold: selector or jsonpath, op, value.",
    ),
});

function toolResult(result: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
  };
}

function toolError(error: unknown) {
  const message = error instanceof Error ? error.message : "Livecheck request failed.";
  const extra =
    error instanceof Error && "http" in error
      ? { http: (error as Error & { http?: number }).http, body: (error as Error & { body?: unknown }).body }
      : undefined;
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(extra ? { error: message, ...extra } : { error: message }, null, 2),
      },
    ],
  };
}

const NO_WALLET_NOTE =
  "Does not pay. No wallet in this MCP. Unpaid Fly/local returns structured HTTP 402 (paid: false) plus decoded payment-required / x402 accept info. A caller that already has a PAYMENT-SIGNATURE may pass payment_signature (or set LIVECHECK_PAYMENT_SIGNATURE); only then is the paid path attempted. Never treats 402 as a successful settle.";

export function createLivecheckMcp(): McpServer {
  const server = new McpServer({
    name: MCP_SERVER_NAME,
    version: MCP_SERVER_VERSION,
  });

  const verifyDescription = `Ask Livecheck whether a specific URL is still a live primary source. POSTs {url} to ${livecheckVerifyUrl()} ($0.01 USDC). ${NO_WALLET_NOTE} HTTP 200 returns the verify JSON as-is.`;

  server.registerTool(
    "verify_listing",
    {
      title: "Verify listing",
      description: verifyDescription,
      inputSchema: {
        url: z.string().describe("Absolute http(s) URL of the page to check. You already have this URL."),
        payment_signature: paymentSignature,
      },
    },
    async ({ url, payment_signature }) => {
      try {
        return toolResult(await verifyListing(url, { paymentSignature: payment_signature }));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "verify",
    {
      title: "Verify",
      description: `Wraps POST /v1/verify. Same as verify_listing. ${verifyDescription}`,
      inputSchema: {
        url: z.string().describe("Absolute http(s) URL of the page to check. You already have this URL."),
        payment_signature: paymentSignature,
      },
    },
    async ({ url, payment_signature }) => {
      try {
        return toolResult(await verifyListing(url, { paymentSignature: payment_signature }));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "check",
    {
      title: "Sentinel check",
      description: `One-shot Sentinel condition. Wraps POST /v1/check ($0.02 USDC). Does not create a watcher. Detectors: status_change, keyword, text_diff, numeric_threshold. ${NO_WALLET_NOTE}`,
      inputSchema: {
        target: targetShape,
        condition: conditionShape,
        baseline_hash: z
          .string()
          .nullable()
          .optional()
          .describe("Prior observation.hash (64 hex). Omit or null on the first call (fired is then null)."),
        baseline_text: z.string().nullable().optional().describe("Optional prior text for text_diff."),
        baseline_value: z.number().nullable().optional().describe("Optional prior number for numeric_threshold change_pct."),
        payment_signature: paymentSignature,
      },
    },
    async ({ payment_signature, ...body }) => {
      try {
        return toolResult(await checkListing(body, { paymentSignature: payment_signature }));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "confirm",
    {
      title: "Confirm",
      description: `Independent side-effect check. lead_submit / listing_published wrap POST /v1/confirm ($0.10). order_placed wraps POST /v1/confirm/order ($0.25) so the 402 stays one price per Fly route. ${NO_WALLET_NOTE}`,
      inputSchema: {
        url: z.string().describe("Thank-you / result / listing URL to inspect."),
        intent: z
          .enum(["lead_submit", "listing_published", "order_placed"])
          .describe("lead_submit and listing_published are $0.10 on /v1/confirm. order_placed is $0.25 on /v1/confirm/order."),
        claim: z
          .record(z.unknown())
          .optional()
          .describe("Optional claim object (order_id, total, title, sku, id, email_domain). Never invented by Livecheck."),
        payment_signature: paymentSignature,
      },
    },
    async ({ payment_signature, ...body }) => {
      try {
        return toolResult(await confirmListing(body, { paymentSignature: payment_signature }));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "watch",
    {
      title: "Sentinel watch",
      description: `Create a 30-day standard watcher. Wraps POST /v1/watch ($2.50 USDC). Returns owner_token once — store it for watch_get / watch_events / watch_stop / watch_chain_topup / watch_renew. HMAC callbacks go to callback.url (see examples/sentinel-webhook.ts). No Playwright / fast tier. ${NO_WALLET_NOTE}`,
      inputSchema: {
        target: targetShape,
        condition: conditionShape,
        callback: z.object({
          url: z.string().describe("Absolute http(s) URL that receives HMAC-signed POSTs."),
          secret: z.string().describe("Shared secret. Livecheck HMAC-SHA256s the raw body with this."),
          deliver: z
            .enum(["on_change", "every_check"])
            .optional()
            .describe("Default on_change. Standard still skips baseline spam."),
        }),
        interval_s: z.number().int().optional().describe("Seconds between checks. Min 300, default 900."),
        label: z.string().optional().describe("Optional short label."),
        context: z.record(z.unknown()).optional().describe("Optional JSON echoed on callbacks."),
        on_change: z
          .object({
            run: z
              .enum(["none", "verify", "confirm"])
              .optional()
              .describe("none (default), verify ($0.01), or confirm ($0.10 / $0.25 from chain balance)."),
            intent: z
              .enum(["lead_submit", "listing_published", "order_placed"])
              .optional()
              .describe("Confirm only. Default lead_submit ($0.10). order_placed is $0.25. Same as public Confirm routes."),
            url: z.string().optional().describe("Confirm only. Override URL; default target.url."),
            claim: z.record(z.unknown()).optional().describe("Confirm only. Forwarded to Confirm."),
          })
          .optional(),
        chain_budget_usd: z.number().nullable().optional().describe("Spend cap only — not funding. Fund via watch_chain_topup ($0.50)."),
        payment_signature: paymentSignature,
      },
    },
    async ({ payment_signature, ...body }) => {
      try {
        return toolResult(await watchListing(body, { paymentSignature: payment_signature }));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "watch_get",
    {
      title: "Get watcher",
      description:
        "Free GET /v1/watch/{id}. Send the owner_token returned once on watch create as X-Livecheck-Owner-Token. Does not return the token again. Does not pay.",
      inputSchema: {
        id: z.string().describe("Watcher id (wtc_…)."),
        owner_token: z.string().describe("owt_… token from watch create. Header only."),
      },
    },
    async ({ id, owner_token }) => {
      try {
        return toolResult(await watchGet(id, owner_token));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "watch_events",
    {
      title: "List watcher events",
      description:
        "Free GET /v1/watch/{id}/events. Last 30 days. Requires owner_token. Use after check→webhook / watch→callback recipes.",
      inputSchema: {
        id: z.string().describe("Watcher id (wtc_…)."),
        owner_token: z.string().describe("owt_… token from watch create."),
        limit: z.number().int().optional().describe("Page size. Default 50, max 100."),
        cursor: z.string().optional().describe("Event id cursor from the previous page."),
      },
    },
    async ({ id, owner_token, limit, cursor }) => {
      try {
        return toolResult(await watchEvents(id, owner_token, { limit, cursor }));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "watch_stop",
    {
      title: "Stop watcher",
      description: "Free DELETE /v1/watch/{id}. Requires owner_token. Stops immediately. No refund.",
      inputSchema: {
        id: z.string().describe("Watcher id (wtc_…)."),
        owner_token: z.string().describe("owt_… token from watch create."),
      },
    },
    async ({ id, owner_token }) => {
      try {
        return toolResult(await watchStop(id, owner_token));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "watch_chain_topup",
    {
      title: "Watch chain top-up",
      description: `Paid POST /v1/watch/{id}/chain/topup ($0.50 USDC). Owner token + payment. Funds on_change.run=verify ($0.01) and on_change.run=confirm ($0.10 / $0.25). ${NO_WALLET_NOTE}`,
      inputSchema: {
        id: z.string().describe("Watcher id (wtc_…)."),
        owner_token: z.string().describe("owt_… token from watch create."),
        payment_signature: paymentSignature,
      },
    },
    async ({ id, owner_token, payment_signature }) => {
      try {
        return toolResult(await watchChainTopup(id, owner_token, { paymentSignature: payment_signature }));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "watch_renew",
    {
      title: "Renew watcher",
      description: `Paid POST /v1/watch/renew ($2.50 USDC). Same price as watch create. Body {id}. Owner token + payment. Extends an active watcher's prepaid window. ${NO_WALLET_NOTE}`,
      inputSchema: {
        id: z.string().describe("Watcher id (wtc_…)."),
        owner_token: z.string().describe("owt_… token from watch create."),
        payment_signature: paymentSignature,
      },
    },
    async ({ id, owner_token, payment_signature }) => {
      try {
        return toolResult(await watchRenew(id, owner_token, { paymentSignature: payment_signature }));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  return server;
}

export function mcpReadyMessage(): string {
  return `livecheck MCP stdio ready → origin ${livecheckOrigin()} (verify ${livecheckVerifyUrl()})`;
}
