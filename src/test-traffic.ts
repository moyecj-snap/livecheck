import { sanitizePayer } from "./paid-call.js";

/**
 * Test wallets and test URLs omitted from `traffic.external`.
 * One list. Add a grader, tester, or URL by appending one entry.
 * Addresses stay lowercase. Labels are the reason, and they are not
 * published on `/stats` (only counts are).
 *
 * Runtime additions (additive, comma-separated):
 *   LIVECHECK_TEST_WALLETS=0xabc…:grader:Name, 0xdef…:tester:Name
 * A bare 0x address is a grader. `off` drops this built-in list.
 * LIVECHECK_GRADER_WALLETS still works: `off` drops graders only;
 * any other value appends grader addresses.
 */
export type TestTrafficRole = "grader" | "tester";

export type TestTrafficWallet = {
  address: string;
  role: TestTrafficRole;
  label: string;
};

/**
 * `ref` set: host + path + that `ref` query value.
 * `ref` omitted: host + path, any query (the Greenhouse docs job).
 * `sha256` stays excluded even if the href formatting changes later.
 */
export type TestTrafficUrl = {
  host: string;
  path: string;
  ref?: string;
  label: string;
  sha256?: string;
};

export const TEST_TRAFFIC_WALLETS: readonly TestTrafficWallet[] = [
  {
    address: "0xec2abd3eda89bed90124736e317e847d5fb6d034",
    role: "grader",
    label: "Lumière paycheck prober",
  },
  {
    address: "0xc9c7b38c0942914fc8ea12063bc92dcd3b581670",
    role: "grader",
    label: "vet402 observatory",
  },
  {
    address: "0x9cd5b9a8341dcaf7825348d70792ad9903f2c5a7",
    role: "tester",
    label: "docs-example tester",
  },
];

export const TEST_TRAFFIC_URLS: readonly TestTrafficUrl[] = [
  {
    host: "boards.greenhouse.io",
    path: "/example/jobs/1842",
    label: "Verify / OpenAPI docs example",
    sha256: "6c2d36fc55d201f5a2908a45aa21c73f318a79d352be6a0c8a9710bc3966843a",
  },
  {
    host: "example.com",
    path: "/thank-you",
    ref: "ABC123",
    label: "Former confirm docs example (example.com returns 404)",
  },
  {
    host: "livecheck.fly.dev",
    path: "/demo/thank-you",
    ref: "ABC123",
    label: "Hosted confirm demo (HTTP 200, confirmation number printed)",
  },
];

const FILTER_OFF = new Set(["off", "none", "false", "0"]);

export function testTrafficUrlHref(entry: TestTrafficUrl, scheme: "https" | "http" = "https"): string {
  const query = entry.ref ? `?ref=${entry.ref}` : "";
  return `${scheme}://${entry.host}${entry.path}${query}`;
}

export function testTrafficUrlHrefs(): string[] {
  return TEST_TRAFFIC_URLS.map((entry) => testTrafficUrlHref(entry));
}

function deduped(wallets: readonly TestTrafficWallet[]): TestTrafficWallet[] {
  const out: TestTrafficWallet[] = [];
  const seen = new Set<string>();
  for (const wallet of wallets) {
    if (seen.has(wallet.address)) continue;
    seen.add(wallet.address);
    out.push(wallet);
  }
  return out;
}

function parseWalletEntry(raw: string): TestTrafficWallet | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const [addressRaw, roleRaw, ...labelParts] = trimmed.split(":");
  const address = sanitizePayer(addressRaw);
  if (!address) return undefined;
  const role: TestTrafficRole = roleRaw?.toLowerCase() === "tester" ? "tester" : "grader";
  const label = labelParts.join(":").trim() || (role === "tester" ? "LIVECHECK_TEST_WALLETS tester" : "LIVECHECK_TEST_WALLETS grader");
  return { address, role, label };
}

function parseAddressList(raw: string, role: TestTrafficRole, label: string): TestTrafficWallet[] {
  const out: TestTrafficWallet[] = [];
  for (const part of raw.split(/[\s,]+/)) {
    const address = sanitizePayer(part);
    if (address) out.push({ address, role, label });
  }
  return out;
}

/**
 * Built-in list, plus env additions.
 * `LIVECHECK_TEST_WALLETS=off` drops the built-in list.
 * `LIVECHECK_GRADER_WALLETS=off` drops graders and keeps testers.
 */
export function testTrafficWallets(env: NodeJS.ProcessEnv = process.env): TestTrafficWallet[] {
  const testRaw = env.LIVECHECK_TEST_WALLETS;
  const testOff = testRaw !== undefined && FILTER_OFF.has(testRaw.trim().toLowerCase());
  let wallets: TestTrafficWallet[] = testOff ? [] : TEST_TRAFFIC_WALLETS.map((wallet) => ({ ...wallet }));

  const graderRaw = env.LIVECHECK_GRADER_WALLETS;
  if (graderRaw !== undefined && FILTER_OFF.has(graderRaw.trim().toLowerCase())) {
    wallets = wallets.filter((wallet) => wallet.role !== "grader");
  } else if (graderRaw !== undefined && graderRaw.trim() !== "") {
    wallets.push(...parseAddressList(graderRaw, "grader", "LIVECHECK_GRADER_WALLETS"));
  }

  if (testRaw !== undefined && !testOff && testRaw.trim() !== "") {
    for (const part of testRaw.split(",")) {
      const parsed = parseWalletEntry(part);
      if (parsed) wallets.push(parsed);
    }
  }
  return deduped(wallets);
}

export function testTrafficAddresses(role: TestTrafficRole, env: NodeJS.ProcessEnv = process.env): string[] {
  return testTrafficWallets(env)
    .filter((wallet) => wallet.role === role)
    .map((wallet) => wallet.address);
}
