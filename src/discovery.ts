import { VERIFY_OUTPUT_SCHEMA } from "./bazaar.js";
import { VERIFY_DESCRIPTION } from "./config.js";
import { publicOrigin, publicVerifyUrl } from "./public-url.js";

const OPENAPI_VERSION = "0.1.0";
const OPENAPI_PRICE_AMOUNT = "0.01";

export function discoveryHeaders(): Record<string, string> {
  return {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "public, max-age=300",
    "access-control-allow-origin": "*",
  };
}

export function openApiDocument(requestUrl?: string, host?: string): Record<string, unknown> {
  const origin = publicOrigin(requestUrl, host);
  return {
    openapi: "3.1.0",
    info: {
      title: "Livecheck",
      version: OPENAPI_VERSION,
      description: VERIFY_DESCRIPTION,
      "x-guidance": VERIFY_DESCRIPTION,
    },
    servers: [{ url: origin }],
    paths: {
      "/v1/verify": {
        post: {
          operationId: "verifyListing",
          summary: "Verify a specific job, product, or eBay item URL",
          description: VERIFY_DESCRIPTION,
          tags: ["Verify"],
          "x-payment-info": {
            price: {
              mode: "fixed",
              currency: "USD",
              amount: OPENAPI_PRICE_AMOUNT,
            },
            protocols: [{ x402: {} }],
          },
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    url: {
                      type: "string",
                      format: "uri",
                      description:
                        "Absolute http(s) URL of the specific job, product, or eBay item page to check. Not a search-results URL.",
                    },
                  },
                  required: ["url"],
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Primary-source live, closed, or unknown verdict",
              content: {
                "application/json": {
                  schema: VERIFY_OUTPUT_SCHEMA,
                },
              },
            },
            "402": {
              description: "Payment Required",
            },
          },
        },
      },
    },
  };
}

/**
 * x402scan DISCOVERY.md compatibility fan-out.
 * resources must be absolute URL strings (not objects) — @agentcash/discovery
 * WellKnownDocSchema is z.array(z.string()).
 */
export function wellKnownX402(requestUrl?: string, host?: string): Record<string, unknown> {
  return {
    version: 1,
    x402Version: 2,
    resources: [publicVerifyUrl(requestUrl, host)],
  };
}

export function openApiPriceAmount(): string {
  return OPENAPI_PRICE_AMOUNT;
}
