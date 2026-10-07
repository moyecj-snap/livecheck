import { testTrafficAddresses, TEST_TRAFFIC_WALLETS } from "./test-traffic.js";

/**
 * Grader addresses from `src/test-traffic.ts`.
 * `LIVECHECK_GRADER_WALLETS=off` drops them. Any other value appends.
 */
export const DEFAULT_GRADER_WALLETS = TEST_TRAFFIC_WALLETS.filter((wallet) => wallet.role === "grader").map(
  (wallet) => wallet.address,
);

export function graderWallets(env: NodeJS.ProcessEnv = process.env): string[] {
  return testTrafficAddresses("grader", env);
}
