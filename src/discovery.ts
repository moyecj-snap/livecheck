import {
  CONFIRM_DESCRIPTION,
  CONFIRM_PRICE_USD,
  CONFIRM_SUMMARY,
  CONFIRM_TAGS,
  PRICE_USD,
  VERIFY_DESCRIPTION,
} from "./config.js";
import { publicConfirmUrl, publicOrigin, publicVerifyUrl } from "./public-url.js";

export const CONFIRM_OPENAPI_SUMMARY = CONFIRM_SUMMARY;
export const CONFIRM_OPENAPI_TAGS = [...CONFIRM_TAGS];

const INFO_DESCRIPTION = `${VERIFY_DESCRIPTION} Also POST /v1/confirm to independently confirm lead_submit side effects.`;

export function openApiDocument(requestUrl?: string, host?: string): Record<string, unknown> {
  const origin = publicOrigin(requestUrl, host);
  const verifyUrl = publicVerifyUrl(requestUrl, host);
  const confirmUrl = publicConfirmUrl(requestUrl, host);

  return {
    openapi: "3.1.0",
    info: {
      title: "Livecheck",
      version: "0.1.0",
      description: INFO_DESCRIPTION,
    },
    servers: [{ url: origin }],
    tags: [
      { name: "Verify", description: "URL liveness for jobs and product pages" },
      { name: "Confirm", description: "Independent lead_submit side-effect confirmation" },
      { name: "lead_submit", description: "Day-1 Confirm intent" },
      { name: "side-effect", description: "Post-submit confirmation, not page classification" },
    ],
    paths: {
      "/v1/verify": {
        post: {
          tags: ["Verify"],
          summary: "Check whether a specific job or product URL is still live",
          description: VERIFY_DESCRIPTION,
          operationId: "verifyListing",
          "x-payment-info": { amount: PRICE_USD, currency: "USD", network: "base" },
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    url: { type: "string", format: "uri" },
                  },
                  required: ["url"],
                },
              },
            },
          },
          responses: {
            "200": {
              description: "live | closed | unknown verdict",
            },
            "402": {
              description: "Payment required ($0.01 USDC on Base)",
            },
          },
        },
      },
      "/v1/confirm": {
        post: {
          tags: CONFIRM_OPENAPI_TAGS,
          summary: CONFIRM_OPENAPI_SUMMARY,
          description: CONFIRM_DESCRIPTION,
          "x-guidance": CONFIRM_DESCRIPTION,
          operationId: "confirmLeadSubmit",
          "x-payment-info": { amount: CONFIRM_PRICE_USD, currency: "USD", network: "base" },
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
                      description: "Thank-you or result page after the lead/contact submit",
                    },
                    intent: {
                      type: "string",
                      enum: ["lead_submit"],
                      description: "Day-1: lead_submit only",
                    },
                  },
                  required: ["url", "intent"],
                },
              },
            },
          },
          responses: {
            "200": {
              description: "confirmed | failed | unknown with Level-2+ evidence",
            },
            "402": {
              description: "Payment required ($0.10 USDC on Base)",
            },
          },
        },
      },
    },
    "x-livecheck-resources": {
      verify: verifyUrl,
      confirm: confirmUrl,
    },
  };
}

export function wellKnownX402(requestUrl?: string, host?: string): Record<string, unknown> {
  return {
    version: 2,
    resources: [
      {
        url: publicVerifyUrl(requestUrl, host),
        description: VERIFY_DESCRIPTION,
        mimeType: "application/json",
      },
      {
        url: publicConfirmUrl(requestUrl, host),
        description: CONFIRM_DESCRIPTION,
        mimeType: "application/json",
      },
    ],
  };
}
