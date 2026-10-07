import { USDC_BASE } from "./config.js";
import { sanitizePayer, sanitizeTx } from "./paid-call.js";

/** keccak256("Transfer(address,address,uint256)") */
export const USDC_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export const ATTRIBUTION_UNATTRIBUTED = "unattributed";
export const ATTRIBUTION_TX_TRANSFER = "tx_transfer";
export const NO_TX_ATTRIBUTION_NOTE = "no settlement tx; USDC Transfer from cannot be read";
export const TX_NOT_RECOVERED_NOTE = "settlement tx present; payer not recovered";
export const TX_TRANSFER_NOTE = "USDC Transfer into payTo; from is the payer, not the tx sender";

export const DEFAULT_BASE_RPC_URL = "https://mainnet.base.org";

export type TransferLog = {
  address?: string;
  topics?: string[];
};

export function topicToAddress(topic: string | undefined): string | undefined {
  if (!topic) return undefined;
  const hex = topic.toLowerCase().replace(/^0x/, "");
  if (hex.length < 40) return undefined;
  return sanitizePayer(`0x${hex.slice(-40)}`);
}

/**
 * Payer is the `from` of the USDC Transfer whose `to` is payTo.
 * The transaction sender is not the payer.
 */
export function payerFromUsdcTransferLogs(
  logs: readonly TransferLog[],
  payTo: string,
  usdcAddress: string = USDC_BASE,
): string | undefined {
  const recipient = sanitizePayer(payTo);
  const token = sanitizePayer(usdcAddress);
  if (!recipient || !token) return undefined;
  for (const log of logs) {
    if (sanitizePayer(log.address) !== token) continue;
    const topics = log.topics ?? [];
    if ((topics[0] ?? "").toLowerCase() !== USDC_TRANSFER_TOPIC) continue;
    if (topicToAddress(topics[2]) !== recipient) continue;
    const from = topicToAddress(topics[1]);
    if (from) return from;
  }
  return undefined;
}

export async function payerFromSettlementTx(
  txHash: string,
  options: {
    payTo: string;
    rpcUrl?: string;
    fetchImpl?: typeof fetch;
    usdcAddress?: string;
  },
): Promise<{ payer?: string; note: string }> {
  const tx = sanitizeTx(txHash);
  if (!tx) return { note: NO_TX_ATTRIBUTION_NOTE };
  const rpcUrl = options.rpcUrl ?? (process.env.LIVECHECK_BASE_RPC_URL?.trim() || DEFAULT_BASE_RPC_URL);
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getTransactionReceipt",
        params: [tx],
      }),
    });
    if (!response.ok) return { note: `receipt lookup HTTP ${response.status}` };
    const body = (await response.json()) as {
      result?: { logs?: TransferLog[] } | null;
      error?: { message?: string };
    };
    if (body.error) return { note: body.error.message || "receipt lookup failed" };
    if (!body.result) return { note: "transaction receipt not found" };
    const payer = payerFromUsdcTransferLogs(body.result.logs ?? [], options.payTo, options.usdcAddress);
    if (!payer) return { note: "no USDC Transfer into payTo in the settlement tx" };
    return { payer, note: TX_TRANSFER_NOTE };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { note: `receipt lookup failed: ${message}` };
  }
}
