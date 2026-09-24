import { AsyncLocalStorage } from "node:async_hooks";
import type { FacilitatorClient } from "@x402/core/server";
import {
  decodeExtensionResponsesHeader,
  facilitatorErrorParts,
  fillCatalogPaymentPayload,
  formatFacilitatorLog,
  resourceDescriptionLength,
  summarizeCatalogPayload,
  type PaymentEnvelope,
} from "./catalog-payload.js";

type VerifyArgs = Parameters<FacilitatorClient["verify"]>;
type PaymentPayload = VerifyArgs[0];
type PaymentRequirements = VerifyArgs[1];

type ExtCapture = { header: string | null; names: string[] };

const extCapture = new AsyncLocalStorage<ExtCapture>();
let fetchPatched = false;

function patchFetchOnce(): void {
  if (fetchPatched) return;
  fetchPatched = true;
  const original = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const response = await original(input, init);
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
    }
    return response;
  }) as typeof fetch;
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
    const capture: ExtCapture = { header: null, names: [] };
    let thrown: unknown;
    try {
      return await extCapture.run(capture, () => run(payload as PaymentPayload));
    } catch (error) {
      thrown = error;
      throw error;
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
