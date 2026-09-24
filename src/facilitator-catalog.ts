import { AsyncLocalStorage } from "node:async_hooks";
import type { FacilitatorClient } from "@x402/core/server";
import {
  decodeExtensionResponsesHeader,
  facilitatorErrorParts,
  facilitatorFailureMessage,
  fillCatalogPaymentPayload,
  formatFacilitatorLog,
  resourceDescriptionLength,
  summarizeCatalogPayload,
  type PaymentEnvelope,
} from "./catalog-payload.js";

type VerifyArgs = Parameters<FacilitatorClient["verify"]>;
type PaymentPayload = VerifyArgs[0];
type PaymentRequirements = VerifyArgs[1];

type ExtCapture = {
  header: string | null;
  names: string[];
  errorStatus: number | null;
  errorBody: string | null;
  errorOperation: "verify" | "settle" | null;
};

const extCapture = new AsyncLocalStorage<ExtCapture>();
let fetchPatched = false;
/** Test seam. Production leaves this null and uses global fetch. */
let fetchOverride: typeof fetch | null = null;

export function setFacilitatorFetchForTests(impl: typeof fetch | null): void {
  fetchOverride = impl;
}

function facilitatorOperation(input: Parameters<typeof fetch>[0]): "verify" | "settle" | null {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (/\/settle(\?|$)/.test(url)) return "settle";
  if (/\/verify(\?|$)/.test(url)) return "verify";
  return null;
}

function patchFetchOnce(): void {
  if (fetchPatched) return;
  fetchPatched = true;
  const original = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const operation = facilitatorOperation(input);
    const response = await (fetchOverride && operation ? fetchOverride : original)(input, init);
    const store = extCapture.getStore();
    if (store) {
      const names: string[] = [];
      response.headers.forEach((_value, name) => {
        if (name.toLowerCase().includes("extension")) names.push(name);
      });
      store.names = names;
      store.header =
        response.headers.get("extension-responses") ??
        response.headers.get("EXTENSION-RESPONSES") ??
        response.headers.get("Extension-Responses");
      if (!response.ok) {
        store.errorStatus = response.status;
        store.errorOperation = operation;
        try {
          store.errorBody = await response.clone().text();
        } catch {
          store.errorBody = null;
        }
      }
    }
    return response;
  }) as typeof fetch;
}

function enrichFacilitatorError(error: unknown, capture: ExtCapture): unknown {
  if (!capture.errorBody) return error;
  const operation =
    capture.errorOperation ??
    (error instanceof Error && /settle failed/i.test(error.message) ? "settle" : "verify");
  const status =
    capture.errorStatus ??
    (error instanceof Error ? Number(error.message.match(/\((\d{3})\)/)?.[1]) : 0);
  const next = new Error(facilitatorFailureMessage(operation, Number.isFinite(status) ? status : 0, capture.errorBody));
  if (error instanceof Error) next.cause = error;
  return next;
}

function envelope(payload: PaymentPayload): PaymentEnvelope {
  return payload as unknown as PaymentEnvelope;
}

function logPhase(
  phase: "verify" | "settle",
  inbound: PaymentEnvelope,
  outbound: PaymentEnvelope,
  filled: { resourceFilled: boolean; bazaarFilled: boolean; descriptionClamped: boolean },
  ext: ReturnType<typeof decodeExtensionResponsesHeader>,
  error?: unknown,
): void {
  const parts: Record<string, unknown> = {
    inbound: summarizeCatalogPayload(inbound),
    outbound: summarizeCatalogPayload(outbound),
    desc_len: resourceDescriptionLength(outbound.resource),
    description_clamped: filled.descriptionClamped,
    resource_filled: filled.resourceFilled,
    bazaar_filled: filled.bazaarFilled,
    extension_responses: ext.empty && ext.present ? "empty {}" : ext.present ? ext : "absent",
    bazaar_status: ext.bazaar_status,
    rejected_reason: ext.rejected_reason,
  };
  if (error !== undefined) {
    Object.assign(parts, facilitatorErrorParts(error));
  }
  console.log(formatFacilitatorLog(phase, parts));
}

/**
 * Facilitator wrapper: backfill paymentPayload.resource + extensions.bazaar
 * (Hono does not copy them from the 402) and log EXTENSION-RESPONSES without secrets.
 * POST /v1/watch is the exception: the fat bazaar is stripped, not backfilled.
 */
export function wrapFacilitatorForCatalog(inner: FacilitatorClient): FacilitatorClient {
  patchFetchOnce();

  async function withFilled<T>(
    phase: "verify" | "settle",
    paymentPayload: PaymentPayload,
    run: (filled: PaymentPayload) => Promise<T>,
  ): Promise<T> {
    const inbound = envelope(paymentPayload);
    const { payload, resourceFilled, bazaarFilled, descriptionClamped } = fillCatalogPaymentPayload(inbound);
    const capture: ExtCapture = {
      header: null,
      names: [],
      errorStatus: null,
      errorBody: null,
      errorOperation: null,
    };
    let thrown: unknown;
    try {
      return await extCapture.run(capture, () => run(payload as PaymentPayload));
    } catch (error) {
      thrown = enrichFacilitatorError(error, capture);
      throw thrown;
    } finally {
      try {
        const ext = decodeExtensionResponsesHeader(capture.header, capture.names);
        logPhase(
          phase,
          inbound,
          payload,
          { resourceFilled, bazaarFilled, descriptionClamped },
          ext,
          thrown,
        );
      } catch {
        // A log failure must not hide the facilitator error.
      }
    }
  }

  return {
    getSupported: () => inner.getSupported(),
    verify: (paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements) =>
      withFilled("verify", paymentPayload, (filled) => inner.verify(filled, paymentRequirements)),
    settle: (paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements) =>
      withFilled("settle", paymentPayload, (filled) => inner.settle(filled, paymentRequirements)),
  };
}
