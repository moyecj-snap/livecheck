import { listTestWalletsFromStore } from "./paid-call-store.js";
import { TEST_TRAFFIC_WALLETS, testTrafficWallets, type TestTrafficWallet } from "./test-traffic.js";

/**
 * Built-in grader seed addresses from `src/test-traffic.ts`.
 * The live list is the `test_wallets` table (`src/test-wallet-store.ts`).
 */
export const DEFAULT_GRADER_WALLETS = TEST_TRAFFIC_WALLETS.filter((wallet) => wallet.role === "grader").map(
  (wallet) => wallet.address,
);

export type TestWalletListSource = "db" | "built-in";

/**
 * The grader / tester list this process uses right now:
 * the `test_wallets` table when the paid-call store is open (read per call,
 * so a `testers:add` shows up on the next /stats load), otherwise the
 * built-in seed list. Env additions / `off` switches apply on top.
 */
export function activeTestTrafficWallets(env: NodeJS.ProcessEnv = process.env): TestTrafficWallet[] {
  const stored = listTestWalletsFromStore();
  return testTrafficWallets(env, stored ?? TEST_TRAFFIC_WALLETS);
}

export function testWalletListSource(): TestWalletListSource {
  return listTestWalletsFromStore() ? "db" : "built-in";
}

/** `LIVECHECK_GRADER_WALLETS=off` drops graders. Any other value appends. */
export function graderWallets(env: NodeJS.ProcessEnv = process.env): string[] {
  return activeTestTrafficWallets(env)
    .filter((wallet) => wallet.role === "grader")
    .map((wallet) => wallet.address);
}

export function testerWallets(env: NodeJS.ProcessEnv = process.env): string[] {
  return activeTestTrafficWallets(env)
    .filter((wallet) => wallet.role === "tester")
    .map((wallet) => wallet.address);
}
