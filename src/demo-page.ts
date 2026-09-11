import {
  MOCK_PAYMENT_HEADER,
  PRICE_USD,
  VERIFY_DESCRIPTION,
  isLiveSettlement,
  missingLiveKeyNames,
} from "./config.js";
import { FIXTURE_LIST } from "./fixtures.js";
import { encodePaymentRequired, paymentRequiredBody } from "./x402-payload.js";

const EXAMPLE_VERDICT = {
  url: "https://boards.greenhouse.io/northwind/jobs/1842",
  canonical_url: "https://boards.greenhouse.io/northwind/jobs/1842",
  status: "live",
  http_status: 200,
  checked_at: "2026-08-30T21:00:00Z",
  title: "Staff Backend Engineer — Northwind Labs",
  signals: ["apply form present", "no closure banner"],
  confidence: 0.82,
  price_usd: PRICE_USD,
};

export function demoHtml(origin: string): string {
  const live = isLiveSettlement();
  const example402 = paymentRequiredBody(`${origin}/v1/verify`);
  const encoded = encodePaymentRequired(example402);
  const fixtureItems = FIXTURE_LIST.map(
    (f) =>
      `<li><code>${f.id}</code> — ${escapeHtml(f.label)} <span class="muted">${origin}/fixtures/${f.id}</span></li>`,
  ).join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Livecheck — primary-source verification</title>
  <style>
    :root {
      --ink: #14211a;
      --paper: #f4efe4;
      --rule: #c9c0ae;
      --live: #1f7a46;
      --closed: #9b2c2c;
      --unknown: #8a6d1b;
      --banner: #3d2b12;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--ink);
      background: var(--paper);
      font-family: "Iowan Old Style", "Palatino Linotype", Palatino, serif;
      line-height: 1.5;
    }
    .banner {
      background: #5c3b14;
      color: #f8e7c7;
      padding: 0.7rem 1.25rem;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.82rem;
    }
    .banner.live { background: #1f3d2c; color: #d7f0e1; }
    main { max-width: 52rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
    h1 { font-size: 2.1rem; letter-spacing: -0.02em; margin: 0 0 0.4rem; }
    .lede { font-size: 1.15rem; max-width: 40rem; }
    h2 { margin-top: 2.2rem; font-size: 1.2rem; text-transform: uppercase; letter-spacing: 0.06em; }
    pre, code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    pre {
      background: #1b241e;
      color: #e8efe8;
      padding: 1rem;
      overflow: auto;
      font-size: 0.78rem;
      border-radius: 4px;
    }
    .row { display: flex; gap: 0.6rem; flex-wrap: wrap; margin: 0.8rem 0 1rem; }
    button, .btn {
      appearance: none;
      border: 1px solid var(--ink);
      background: #fff;
      color: var(--ink);
      padding: 0.45rem 0.75rem;
      font: inherit;
      font-size: 0.95rem;
      cursor: pointer;
    }
    button:hover, .btn:hover { background: #efe7d4; }
    .muted { color: #5b645c; font-size: 0.88rem; }
    ul { padding-left: 1.2rem; }
    li { margin: 0.35rem 0; }
    .status { font-weight: 700; }
    .status.live { color: var(--live); }
    .status.closed { color: var(--closed); }
    .status.unknown { color: var(--unknown); }
    footer { margin-top: 3rem; border-top: 1px solid var(--rule); padding-top: 1rem; font-size: 0.9rem; }
    @media (max-width: 640px) {
      h1 { font-size: 1.65rem; }
      pre { font-size: 0.7rem; }
    }
  </style>
</head>
<body>
  ${
    live
      ? `<div class="banner live">Settlement is live. Unpaid <code>POST /v1/verify</code> returns HTTP 402 with Stripe x402 requirements on Base (USDC). Use <code>purl</code> for a real paid request.</div>`
      : `<div class="banner">Settlement is disabled. Keys missing: ${escapeHtml(missingLiveKeyNames().join(", ") || "none")}. This process still returns a realistic 402 and will run the verifier against fixtures if you send <code>X-Livecheck-Mock: 1</code>.</div>`
  }
  <main>
    <p class="muted">Per-check agent API · $0.01 USDC on Base via x402</p>
    <h1>Livecheck</h1>
    <p class="lede">
      ${escapeHtml(VERIFY_DESCRIPTION)}
      Price is <strong>$${PRICE_USD.toFixed(2)} USDC</strong> on Base per request.
    </p>

    <h2>Try it</h2>
    <div class="row">
      <button type="button" id="hit-402">POST /v1/verify without payment</button>
      ${
        live
          ? ""
          : `<button type="button" id="hit-closed">Mock-pay a closed fixture</button>
             <button type="button" id="hit-live">Mock-pay a live fixture</button>`
      }
    </div>
    <p id="result-meta" class="muted">The 402 response includes a <code>payment-required</code> header (x402 v2, Stripe deposit address, USDC on Base).</p>
    <pre id="result">${escapeHtml(JSON.stringify(example402, null, 2))}</pre>

    <h2>Example 402 (decoded)</h2>
    <p class="muted">Header value is base64. Decoded shape:</p>
    <pre>${escapeHtml(JSON.stringify(example402, null, 2))}</pre>
    <p class="muted">Encoded header starts <code>${escapeHtml(encoded.slice(0, 48))}…</code></p>

    <h2>Example verify JSON</h2>
    <pre>${escapeHtml(JSON.stringify(EXAMPLE_VERDICT, null, 2))}</pre>

    <h2>Local fixtures</h2>
    <p class="muted">Served by this process so you can exercise the classifier without the open web.</p>
    <ul>${fixtureItems}</ul>

    <h2>curl</h2>
    <pre>curl -iv ${origin}/v1/verify -H 'content-type: application/json' \\
  -d '{"url":"https://boards.greenhouse.io/example/jobs/1"}'

${
  live
    ? `# Real funds: Stripe's purl client from the x402 docs
purl ${origin}/v1/verify -H 'content-type: application/json' \\
  -d '{"url":"https://boards.greenhouse.io/example/jobs/1"}'`
    : `# Mock settlement (dev only)
curl -s ${origin}/v1/verify -H 'content-type: application/json' \\
  -H 'X-Livecheck-Mock: 1' \\
  -d '{"url":"${origin}/fixtures/closed-to-new-applications"}'`
}</pre>

    <h2>Live stats</h2>
    <p class="muted">
      Source of truth: <code>GET /stats?format=json</code>
      (<a href="https://livecheck.fly.dev/stats?format=json">https://livecheck.fly.dev/stats?format=json</a>).
      Gil owns landing copy — this strip only fetches that JSON.
    </p>
    <pre id="stats">Loading /stats?format=json…</pre>

    <footer>
      Not a search engine. Not an aggregator copy. HTML + status only — no page JS in v1.
      Paid route is <code>POST /v1/verify</code>. Free: <code>GET /</code>, <code>GET /health</code>, and <code>GET /stats?format=json</code>.
      Mock header <code>${MOCK_PAYMENT_HEADER}</code> is ignored when live keys are set.
    </footer>
  </main>
  <script>
    const result = document.getElementById("result");
    const meta = document.getElementById("result-meta");
    async function postVerify(url, headers = {}) {
      const res = await fetch("/v1/verify", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ url }),
      });
      const raw = await res.text();
      let parsed = raw;
      try { parsed = JSON.stringify(JSON.parse(raw), null, 2); } catch {}
      const pay = res.headers.get("payment-required");
      meta.textContent = "HTTP " + res.status + (pay ? " · payment-required header present (" + pay.length + " chars)" : "");
      if (res.status === 402 && pay) {
        try {
          const decoded = JSON.parse(atob(pay));
          result.textContent = parsed + "\\n\\n# decoded payment-required\\n" + JSON.stringify(decoded, null, 2);
          return;
        } catch {}
      }
      result.textContent = parsed;
    }
    document.getElementById("hit-402")?.addEventListener("click", () => {
      postVerify("https://boards.greenhouse.io/example/jobs/1");
    });
    document.getElementById("hit-closed")?.addEventListener("click", () => {
      postVerify(location.origin + "/fixtures/closed-to-new-applications", { "X-Livecheck-Mock": "1" });
    });
    document.getElementById("hit-live")?.addEventListener("click", () => {
      postVerify(location.origin + "/fixtures/live-apply-now", { "X-Livecheck-Mock": "1" });
    });
    const statsEl = document.getElementById("stats");
    fetch("/stats?format=json")
      .then(async (res) => {
        const raw = await res.text();
        try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; }
      })
      .then((text) => { if (statsEl) statsEl.textContent = text; })
      .catch((err) => { if (statsEl) statsEl.textContent = "Could not load /stats?format=json: " + err; });
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
