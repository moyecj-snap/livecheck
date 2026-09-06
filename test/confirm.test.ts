import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { serve } from "@hono/node-server";
import { createApp } from "../src/app.js";
import { classifyConfirm, extractConfirmationId, parseConfirmBody } from "../src/confirm.js";
import {
  CONFIRM_DESCRIPTION,
  CONFIRM_PRICE_ATOMIC_USDC,
  CONFIRM_PRICE_USD,
} from "../src/config.js";
import type { FetchedPage } from "../src/types.js";
import { confirmUrl } from "../src/confirm.js";
import { VerifyError } from "../src/verify.js";

function page(partial: Partial<FetchedPage> & { text: string; html?: string }): FetchedPage {
  return {
    requestedUrl: partial.requestedUrl ?? "https://example.com/thanks",
    canonicalUrl: partial.canonicalUrl ?? partial.requestedUrl ?? "https://example.com/thanks",
    httpStatus: partial.httpStatus ?? 200,
    title: partial.title ?? "Thank you",
    html: partial.html ?? `<p>${partial.text}</p>`,
    text: partial.text,
    redirected: partial.redirected ?? false,
    redirectChain: partial.redirectChain ?? [],
  };
}

describe("Confirm honesty gates", () => {
  it("requires a Level-2 confirmation/ref/ticket id for confirmed", () => {
    const verdict = classifyConfirm(
      page({ text: "Thank you. Your request has been received. Confirmation number: CNF-1842" }),
    );
    assert.equal(verdict.status, "confirmed");
    assert.equal(verdict.evidence.level, 2);
    assert.equal(verdict.evidence.confirmation_id, "CNF-1842");
    assert.equal(verdict.price_usd, CONFIRM_PRICE_USD);
    assert.equal(verdict.intent, "lead_submit");
  });

  it("does not treat a thank-you page without an id as confirmed", () => {
    const verdict = classifyConfirm(
      page({ text: "Thank you for contacting us. We received your message." }),
    );
    assert.equal(verdict.status, "unknown");
    assert.ok(verdict.evidence.level < 2);
    assert.equal(verdict.evidence.confirmation_id, undefined);
    assert.ok(verdict.signals.includes("not_a_thank_you_page_classifier"));
  });

  it("returns failed on explicit submit failure without an id", () => {
    const verdict = classifyConfirm(page({ text: "Submission failed. We could not submit your form." }));
    assert.equal(verdict.status, "failed");
  });

  it("extracts ticket and ref ids", () => {
    assert.deepEqual(extractConfirmationId("Ticket #48291 is open"), {
      id: "48291",
      kind: "ticket_id",
    });
    assert.deepEqual(extractConfirmationId("Reference ID: REF-9X21"), {
      id: "REF-9X21",
      kind: "ref_id",
    });
  });

  it("rejects intents other than lead_submit", () => {
    assert.throws(
      () => parseConfirmBody({ url: "https://example.com/thanks", intent: "payment" }),
      (err: unknown) => err instanceof VerifyError && /lead_submit/.test(err.message),
    );
  });
});

describe("POST /v1/confirm", () => {
  const app = createApp();
  let origin = "";
  let close: () => void = () => {};

  before(async () => {
    await new Promise<void>((resolve) => {
      const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
        origin = `http://127.0.0.1:${info.port}`;
        close = () => server.close();
        resolve();
      });
    });
  });

  after(() => close());

  it("returns 402 with CONFIRM_DESCRIPTION and $0.10 atomic amount", async () => {
    const res = await fetch(`${origin}/v1/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/thanks", intent: "lead_submit" }),
    });
    assert.equal(res.status, 402);
    const decoded = JSON.parse(Buffer.from(res.headers.get("payment-required") ?? "", "base64").toString("utf8"));
    assert.equal(decoded.resource.description, CONFIRM_DESCRIPTION);
    assert.match(decoded.resource.description, /Livecheck/);
    assert.equal(decoded.accepts[0].amount, CONFIRM_PRICE_ATOMIC_USDC);
    assert.equal(decoded.accepts[0].amount, "100000");
    assert.ok(decoded.extensions?.bazaar);
    assert.equal(decoded.extensions.bazaar.info.output.example.price_usd, CONFIRM_PRICE_USD);
    assert.deepEqual(decoded.extensions.bazaar.info.input.body, {
      url: "https://example.com/contact/thanks",
      intent: "lead_submit",
    });
  });

  it("mock-paid confirm-with-ref-id returns confirmed", async () => {
    const res = await fetch(`${origin}/v1/confirm`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-livecheck-mock": "1",
      },
      body: JSON.stringify({
        url: `${origin}/fixtures/confirm-with-ref-id`,
        intent: "lead_submit",
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; evidence: { confirmation_id?: string; level: number } };
    assert.equal(body.status, "confirmed");
    assert.equal(body.evidence.level, 2);
    assert.equal(body.evidence.confirmation_id, "CNF-1842");
  });

  it("mock-paid thank-you-no-id stays unknown", async () => {
    const res = await fetch(`${origin}/v1/confirm`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-livecheck-mock": "1",
      },
      body: JSON.stringify({
        url: `${origin}/fixtures/thank-you-no-id`,
        intent: "lead_submit",
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string };
    assert.equal(body.status, "unknown");
  });

  it("confirmUrl does not send cookies", async () => {
    const seen: string[] = [];
    const fetcher: typeof fetch = async (_input, init) => {
      const headers = new Headers(init?.headers);
      seen.push(headers.get("cookie") ?? "");
      return new Response("<html><title>Thanks</title><p>Thank you. Confirmation number: TCK-9910</p></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    };
    const verdict = await confirmUrl("https://example.com/thanks", fetcher);
    assert.equal(verdict.status, "confirmed");
    assert.equal(seen[0], "");
  });
});
