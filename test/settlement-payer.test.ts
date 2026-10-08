import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { USDC_BASE } from "../src/config.js";
import {
  TX_TRANSFER_NOTE,
  USDC_TRANSFER_TOPIC,
  payerFromSettlementTx,
  payerFromUsdcTransferLogs,
} from "../src/settlement-payer.js";

const PAY_TO = "0x1111111111111111111111111111111111111111";
const PAYER = "0x2222222222222222222222222222222222222222";
const TX_SENDER = "0x3333333333333333333333333333333333333333";

function topic(address: string): string {
  return `0x${address.slice(2).padStart(64, "0")}`;
}

describe("settlement payer", () => {
  it("uses the USDC Transfer from into payTo, not the transaction sender", async () => {
    const logs = [
      {
        address: USDC_BASE,
        topics: [USDC_TRANSFER_TOPIC, topic(PAYER), topic(PAY_TO)],
      },
    ];
    assert.equal(payerFromUsdcTransferLogs(logs, PAY_TO), PAYER);
    assert.notEqual(payerFromUsdcTransferLogs(logs, PAY_TO), TX_SENDER);

    const tx = `0x${"ab".repeat(32)}`;
    const found = await payerFromSettlementTx(tx, {
      payTo: PAY_TO,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            result: {
              from: TX_SENDER,
              logs,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    assert.equal(found.payer, PAYER);
    assert.equal(found.note, TX_TRANSFER_NOTE);
  });

  it("returns a note when the receipt has no Transfer into payTo", async () => {
    const found = await payerFromSettlementTx(`0x${"cd".repeat(32)}`, {
      payTo: PAY_TO,
      fetchImpl: async () =>
        new Response(JSON.stringify({ result: { from: TX_SENDER, logs: [] } }), { status: 200 }),
    });
    assert.equal(found.payer, undefined);
    assert.match(found.note, /no USDC Transfer/i);
  });
});
