import { PAID_CALL_ROUTES, PAYMENT_PROTOCOLS, type PaidCallRoute } from "./paid-call.js";
import { queryProtocolRouteWindowsFromStore, type ProtocolRouteCounts } from "./paid-call-store.js";
import { ROUTE_PRICE_CENTS } from "./traffic-buckets.js";

/**
 * /stats lines per route and per payment rail (x402 vs MPP).
 *
 * Protocol is a second dimension, not a bucket: an MPP call still sits in
 * exactly one of internal / graders / testers / unattributed /
 * testers_probable / external by payer. Here every paid call also sits on
 * exactly one protocol line, and the protocol lines must add up to
 * traffic.all for calls and revenue in each window. If they do not, /stats
 * shows a warning, the same way the bucket check does.
 */

export const PROTOCOL_TRAFFIC_LABEL =
  "Each paid call is on exactly one payment line: x402 (Base USDC via CDP) or mpp_tempo (MPP on Tempo via Stripe). Rows written before MPP are x402. The lines must add up to all traffic. Protocol is not a bucket: MPP payers go through the same five bucket rules by payer address.";

export type ProtocolAmount = { calls: number; revenue_usd: number };

export type ProtocolWindow = {
  /** route -> protocol -> amount. Every route and every known protocol is present (zeros included). */
  routes: Record<PaidCallRoute, Record<string, ProtocolAmount>>;
  totals: Record<string, ProtocolAmount>;
  sum: ProtocolAmount;
  /** traffic.all for the same window (from the bucket reconciliation total). */
  all: ProtocolAmount | null;
  gap: ProtocolAmount | null;
};

export type TrafficProtocols = {
  label: string;
  available: boolean;
  protocols: string[];
  /** True only when available, all is known, and both windows have a zero gap. */
  ok: boolean;
  warning: string | null;
  l7d: ProtocolWindow;
  l30d: ProtocolWindow;
};

function emptyWindow(protocols: readonly string[]): ProtocolWindow {
  const routes = {} as Record<PaidCallRoute, Record<string, ProtocolAmount>>;
  for (const route of PAID_CALL_ROUTES) {
    routes[route] = {};
    for (const protocol of protocols) routes[route][protocol] = { calls: 0, revenue_usd: 0 };
  }
  const totals: Record<string, ProtocolAmount> = {};
  for (const protocol of protocols) totals[protocol] = { calls: 0, revenue_usd: 0 };
  return { routes, totals, sum: { calls: 0, revenue_usd: 0 }, all: null, gap: null };
}

function windowFromCounts(
  counts: ProtocolRouteCounts,
  protocols: readonly string[],
  all: ProtocolAmount | null,
): ProtocolWindow {
  const out = emptyWindow(protocols);
  const totalCents: Record<string, number> = {};
  const routeCents: Record<string, Record<string, number>> = {};
  let sumCalls = 0;
  let sumCents = 0;
  for (const route of PAID_CALL_ROUTES) {
    for (const [protocol, amount] of Object.entries(counts[route] ?? {})) {
      out.routes[route][protocol] ??= { calls: 0, revenue_usd: 0 };
      out.totals[protocol] ??= { calls: 0, revenue_usd: 0 };
      out.routes[route][protocol].calls += amount.calls;
      (routeCents[route] ??= {})[protocol] = (routeCents[route][protocol] ?? 0) + amount.revenue_cents;
      out.totals[protocol].calls += amount.calls;
      totalCents[protocol] = (totalCents[protocol] ?? 0) + amount.revenue_cents;
      sumCalls += amount.calls;
      sumCents += amount.revenue_cents;
    }
  }
  for (const route of PAID_CALL_ROUTES) {
    for (const protocol of Object.keys(out.routes[route])) {
      out.routes[route][protocol].revenue_usd = (routeCents[route]?.[protocol] ?? 0) / 100;
    }
  }
  for (const protocol of Object.keys(out.totals)) out.totals[protocol].revenue_usd = (totalCents[protocol] ?? 0) / 100;
  out.sum = { calls: sumCalls, revenue_usd: sumCents / 100 };
  if (all) {
    out.all = { ...all };
    out.gap = {
      calls: all.calls - sumCalls,
      revenue_usd: (Math.round(all.revenue_usd * 100) - sumCents) / 100,
    };
  }
  return out;
}

export function buildProtocolTraffic(
  counts: { l7d: ProtocolRouteCounts; l30d: ProtocolRouteCounts } | undefined,
  allTotals: { l7d: ProtocolAmount; l30d: ProtocolAmount } | null,
): TrafficProtocols {
  const seen = new Set<string>(PAYMENT_PROTOCOLS);
  for (const window of counts ? [counts.l7d, counts.l30d] : []) {
    for (const byProtocol of Object.values(window)) for (const protocol of Object.keys(byProtocol)) seen.add(protocol);
  }
  const protocols = [...seen];
  if (!counts) {
    return {
      label: PROTOCOL_TRAFFIC_LABEL,
      available: false,
      protocols,
      ok: false,
      warning: "Payment-protocol lines are not a measurement on this response (paid-call store closed).",
      l7d: emptyWindow(protocols),
      l30d: emptyWindow(protocols),
    };
  }
  const l7d = windowFromCounts(counts.l7d, protocols, allTotals?.l7d ?? null);
  const l30d = windowFromCounts(counts.l30d, protocols, allTotals?.l30d ?? null);
  const gaps: string[] = [];
  for (const [name, w] of [
    ["L7d", l7d],
    ["L30d", l30d],
  ] as const) {
    if (!w.gap) continue;
    if (w.gap.calls !== 0 || Math.round(w.gap.revenue_usd * 100) !== 0) {
      gaps.push(
        `${name}: all ${w.all?.calls} calls / $${w.all?.revenue_usd.toFixed(2)}, protocol lines ${w.sum.calls} calls / $${w.sum.revenue_usd.toFixed(2)}`,
      );
    }
  }
  let warning: string | null = null;
  if (!allTotals) {
    warning = "Payment-protocol lines were not checked against all traffic on this response.";
  } else if (gaps.length > 0) {
    warning = `Payment-protocol lines do not add up to all traffic. ${gaps.join("; ")}.`;
  }
  return {
    label: PROTOCOL_TRAFFIC_LABEL,
    available: true,
    protocols,
    ok: warning === null,
    warning,
    l7d,
    l30d,
  };
}

export function protocolTrafficFromStore(
  now: Date,
  allTotals: { l7d: ProtocolAmount; l30d: ProtocolAmount } | null,
): TrafficProtocols {
  return buildProtocolTraffic(queryProtocolRouteWindowsFromStore(now, ROUTE_PRICE_CENTS), allTotals);
}

/** Fleet documents sum per-volume rows elsewhere; this split stays per machine. */
export function fleetProtocolTraffic(local: TrafficProtocols | undefined): TrafficProtocols | undefined {
  if (!local) return undefined;
  return {
    ...local,
    available: false,
    ok: false,
    warning: "Payment-protocol lines are per machine and are not summed on a fleet document.",
  };
}

const PROTOCOL_DISPLAY: Record<string, string> = {
  x402: "x402 (Base)",
  mpp_tempo: "MPP (Tempo)",
};

function esc(value: string): string {
  return value.replace(/[&<>"]/g, (ch) => (ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : "&quot;"));
}

export function protocolTableHtml(protocols: TrafficProtocols | undefined): string {
  if (!protocols) return "";
  const cell = (a: ProtocolAmount | null | undefined) =>
    a ? `<td>${a.calls}</td><td>$${a.revenue_usd.toFixed(2)}</td>` : `<td>n/a</td><td>n/a</td>`;
  const rows: string[] = [];
  for (const route of PAID_CALL_ROUTES) {
    for (const protocol of protocols.protocols) {
      rows.push(
        `<tr><td><code>${esc(route)}</code></td><td>${esc(PROTOCOL_DISPLAY[protocol] ?? protocol)}</td>${cell(protocols.l7d.routes[route]?.[protocol])}${cell(protocols.l30d.routes[route]?.[protocol])}</tr>`,
      );
    }
  }
  for (const protocol of protocols.protocols) {
    rows.push(
      `<tr><td><strong>All routes</strong></td><td>${esc(PROTOCOL_DISPLAY[protocol] ?? protocol)}</td>${cell(protocols.l7d.totals[protocol])}${cell(protocols.l30d.totals[protocol])}</tr>`,
    );
  }
  const warning = protocols.ok
    ? `<p class="muted">Payment lines add up to all traffic (L30d ${protocols.l30d.sum.calls} calls / $${protocols.l30d.sum.revenue_usd.toFixed(2)}).</p>`
    : `<p class="warning" role="alert"><strong>Warning:</strong> ${esc(protocols.warning ?? "Payment-protocol lines do not add up to all traffic.")}</p>`;
  return `<h3>Payments by route and protocol</h3>
  <p class="muted">${esc(protocols.label)}</p>
  ${warning}
  <table>
    <thead>
      <tr><th>Route</th><th>Protocol</th><th>L7d calls</th><th>L7d revenue</th><th>L30d calls</th><th>L30d revenue</th></tr>
    </thead>
    <tbody>
      ${rows.join("\n      ")}
      <tr><td><strong>Sum of protocol lines</strong></td><td></td>${cell(protocols.l7d.sum)}${cell(protocols.l30d.sum)}</tr>
      <tr><td><strong>All traffic</strong></td><td></td>${cell(protocols.l7d.all)}${cell(protocols.l30d.all)}</tr>
      <tr><td><strong>Gap</strong></td><td></td>${cell(protocols.l7d.gap)}${cell(protocols.l30d.gap)}</tr>
    </tbody>
  </table>`;
}
