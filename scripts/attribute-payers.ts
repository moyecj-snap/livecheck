/**
 * Ops: fill blank paid_calls.payer from the USDC Transfer into payTo.
 * The Transfer `from` is the payer. The transaction sender is not.
 * A miss stays attribution=unattributed and keeps the lookup note.
 * This does not run on boot.
 *
 *   npm run attribute:payers
 *   npm run attribute:payers -- --db /data/paid-calls.sqlite
 */
import { payToAddress } from "../src/config.js";
import { defaultPaidCallDbPath, openPaidCallDb, recoverPaidCallPayers } from "../src/paid-call-store.js";
import { payerFromSettlementTx } from "../src/settlement-payer.js";

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx < 0) return undefined;
  const value = process.argv[idx + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

const dbPath = argValue("--db") ?? defaultPaidCallDbPath();
const payTo = payToAddress();
const db = openPaidCallDb(dbPath);
const result = await recoverPaidCallPayers(db, (tx) => payerFromSettlementTx(tx, { payTo }));
db.close();
console.log(JSON.stringify({ db: dbPath, recovered: result.recovered, still_unattributed: result.still_unattributed }));
