/**
 * Controlled noisy pages for Sentinel honesty benches.
 * Status stays live (or flips to closed on inject). Noise rotates:
 * timestamps, view counters, session/CSRF, ad slots, cookie banners,
 * and promo copy that must not live inside the text_diff selector.
 */

export const LISTING_TITLE_SELECTOR = ".listing-title";
export const JOB_TITLE = "Staff Backend Engineer";
export const PRODUCT_TITLE = "Ridge Wallet";
export const PRODUCT_DESC = "Aluminum wallet. Ships today.";

export const PROMO_BANNERS = ["Summer sale — extra 10% off", "Free shipping this weekend", "Members event: early access"] as const;

export type NoiseKind = "clock" | "counters" | "tokens" | "promo" | "combined";

export type NoiseTick = {
  kind: NoiseKind;
  tick: number;
};

export function isoForTick(tick: number): string {
  const base = Date.UTC(2026, 8, 10, 18, 0, 0);
  return new Date(base + tick * 37_000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function noiseBits(tick: NoiseTick): {
  iso: string;
  viewers: number;
  sold: number;
  hoursAgo: number;
  session: string;
  csrf: string;
  promo: string;
} {
  const n = tick.tick;
  return {
    iso: isoForTick(n),
    viewers: 17 + (n * 3) % 400,
    sold: 1_024 + n * 7,
    hoursAgo: 1 + (n % 11),
    session: `sess_${n.toString(16).padStart(8, "0")}deadbeef`,
    csrf: `csrf_${(n * 1103515245 + 12345).toString(16)}`,
    promo: PROMO_BANNERS[n % PROMO_BANNERS.length] ?? PROMO_BANNERS[0],
  };
}

function clockBlock(tick: NoiseTick): string {
  if (tick.kind !== "clock" && tick.kind !== "combined") return "";
  const bits = noiseBits(tick);
  return `<p class="stamp">Posted ${bits.hoursAgo} hours ago · ${bits.iso} · last updated: Sep 10, 2026</p>`;
}

function counterBlock(tick: NoiseTick): string {
  if (tick.kind !== "counters" && tick.kind !== "combined") return "";
  const bits = noiseBits(tick);
  return `<p class="viewers">${bits.viewers} watching · ${bits.sold.toLocaleString("en-US")} sold</p>`;
}

function tokenBlock(tick: NoiseTick): string {
  if (tick.kind !== "tokens" && tick.kind !== "combined") return "";
  const bits = noiseBits(tick);
  return `
  <p class="sess">session_id=${bits.session} csrf_token=${bits.csrf}</p>
  <ins class="adsbygoogle" data-ad-slot="99${tick.tick}"></ins>
  <p class="cookies">We use cookies to improve your experience. Accept all cookies</p>`;
}

function promoBlock(tick: NoiseTick): string {
  if (tick.kind !== "promo" && tick.kind !== "combined") return "";
  const bits = noiseBits(tick);
  return `<aside class="promo rotating-banner">${bits.promo}</aside>`;
}

/** Title text stays stable. Ignore-by-default tokens rotate inside the selected node. */
function titleNode(stableTitle: string, tick: NoiseTick): string {
  const bits = noiseBits(tick);
  return `<h1 class="listing-title">${stableTitle} <span class="freshness">Updated ${bits.iso}</span> · ${bits.viewers} watching</h1>`;
}

export function noisyJobHtml(tick: NoiseTick, closed = false): string {
  const apply = closed
    ? `<div class="flash-banner"><p>This job is closed to new applications.</p></div>`
    : `<form action="/jobs/1842/apply" method="post"><button type="submit">Apply Now</button></form>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${JOB_TITLE} — Northwind Labs</title>
</head>
<body>
  ${titleNode(JOB_TITLE, tick)}
  ${clockBlock(tick)}
  ${counterBlock(tick)}
  ${tokenBlock(tick)}
  ${promoBlock(tick)}
  <article>
    <p>Build the payments path that keeps our primary-source checks honest.</p>
    <p>This is a specific posting, not a search results page.</p>
  </article>
  ${apply}
</body>
</html>
`;
}

export function noisyProductHtml(tick: NoiseTick, opts?: { title?: string; desc?: string; soldOut?: boolean }): string {
  const title = opts?.title ?? PRODUCT_TITLE;
  const desc = opts?.desc ?? PRODUCT_DESC;
  const buy = opts?.soldOut
    ? `<p class="oos">Sold out. This product is currently unavailable.</p>`
    : `<form action="/cart/add" method="post"><button type="submit">Add to cart</button></form>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${title} – $1,299.00</title>
</head>
<body>
  ${titleNode(title, tick)}
  <p class="price">$1,299.00</p>
  ${clockBlock(tick)}
  ${counterBlock(tick)}
  ${tokenBlock(tick)}
  ${promoBlock(tick)}
  <p class="product-desc">${desc}</p>
  ${buy}
</body>
</html>
`;
}

export const HONESTY_KINDS: readonly NoiseKind[] = ["clock", "counters", "tokens", "promo", "combined"];

export function honestyCases(repeats: number): Array<{
  id: string;
  page: "job" | "product";
  kind: NoiseKind;
  tick: number;
}> {
  const out: Array<{ id: string; page: "job" | "product"; kind: NoiseKind; tick: number }> = [];
  for (const page of ["job", "product"] as const) {
    for (const kind of HONESTY_KINDS) {
      for (let tick = 0; tick < repeats; tick += 1) {
        out.push({ id: `${page}-${kind}-${tick}`, page, kind, tick });
      }
    }
  }
  return out;
}
