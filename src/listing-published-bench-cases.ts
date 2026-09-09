import type { VerifyVerdict } from "./types.js";

export type BenchBucket = "true_live" | "true_closed" | "trap";
export type BenchExpect = "confirmed" | "failed" | "unknown";

export type ListingPublishedBenchCase = {
  id: string;
  bucket: BenchBucket;
  expect: BenchExpect;
  url: string;
  canonicalUrl?: string;
  httpStatus?: number;
  html?: string;
  title?: string;
  redirected?: boolean;
  cookiesUsed?: boolean;
  claim?: Record<string, unknown>;
  verify?: Pick<VerifyVerdict, "status" | "signals" | "http_status"> & {
    title?: string;
    confidence?: number;
  };
};

function jobLiveHtml(title: string): string {
  return `<!doctype html><html><head><title>${title}</title></head><body>
  <h1>${title}</h1>
  <p>Location: Oakland, CA. This is a specific posting, not a search results page.</p>
  <form action="/apply" method="post"><button type="submit">Apply Now</button></form>
  </body></html>`;
}

function productLiveHtml(title: string): string {
  return `<!doctype html><html><head><title>${title}</title></head><body>
  <h1>${title}</h1>
  <p>In-stock product page with a real cart control.</p>
  <form action="/cart/add" method="post"><button type="submit">Add to cart</button></form>
  </body></html>`;
}

function productSoldOutHtml(title: string): string {
  return `<!doctype html><html><head><title>${title}</title></head><body>
  <h1>${title}</h1>
  <p>This item is currently unavailable.</p>
  <p class="price__badge">Sold out</p>
  <button type="button" disabled>Sold out</button>
  </body></html>`;
}

function closedJobHtml(title: string): string {
  return `<!doctype html><html><head><title>${title} — this job is closed to new applications</title></head><body>
  <h1>${title}</h1>
  <p>This job is closed to new applications.</p>
  </body></html>`;
}

function notFoundHtml(kind: string): string {
  return `<!doctype html><html><head><title>404 Not Found</title></head><body>
  <h1>Not Found</h1><p>The ${kind} does not exist.</p>
  </body></html>`;
}

function boardHtml(): string {
  return `<!doctype html><html><head><title>Acme — Current Openings</title></head><body>
  <h1>Current Openings</h1>
  <p>We're sorry, the job you are looking for is no longer available. Browse other openings.</p>
  <ul>
    <li class="opening"><a href="/jobs/11">Warehouse Associate</a></li>
    <li class="opening"><a href="/jobs/12">Shift Supervisor</a></li>
    <li class="opening"><a href="/jobs/13">Fleet Dispatcher</a></li>
  </ul>
  </body></html>`;
}

const LIVE_JOBS = [
  ["1842", "Staff Backend Engineer — Northwind Labs"],
  ["1843", "Senior Platform Engineer"],
  ["2201", "Product Designer"],
  ["3308", "Account Executive"],
  ["4410", "Staff SRE"],
  ["5520", "Data Engineer"],
  ["6611", "Security Engineer"],
  ["7702", "Mobile Engineer"],
  ["8803", "Technical Writer"],
  ["9904", "Support Engineer"],
  ["1012", "Solutions Architect"],
  ["1115", "Recruiter"],
] as const;

const LIVE_PRODUCTS = [
  ["ridge-wallet", "Ridge Wallet"],
  ["groove-ring", "Groove Ring"],
  ["canvas-tote", "Canvas Tote"],
  ["steel-bottle", "Steel Bottle"],
  ["linen-shirt", "Linen Shirt"],
  ["wool-cap", "Wool Cap"],
  ["desk-mat", "Desk Mat"],
  ["usb-cable", "USB Cable"],
  ["notebook-a5", "Notebook A5"],
  ["ceramic-mug", "Ceramic Mug"],
] as const;

const LEVER_JOBS = [
  ["harbor/ae-3301", "Account Executive at Harbor"],
  ["northwind/be-1842", "Backend Engineer at Northwind"],
  ["lumen/pm-201", "Product Manager at Lumen"],
  ["oak/design-88", "Designer at Oak"],
  ["river/sre-12", "SRE at River"],
  ["field/sales-44", "Sales Lead at Field"],
] as const;

export function listingPublishedBenchCases(): ListingPublishedBenchCase[] {
  const cases: ListingPublishedBenchCase[] = [];

  for (const [id, title] of LIVE_JOBS) {
    cases.push({
      id: `live-gh-${id}`,
      bucket: "true_live",
      expect: "confirmed",
      url: `https://boards.greenhouse.io/northwind/jobs/${id}`,
      httpStatus: 200,
      html: jobLiveHtml(title),
    });
  }

  for (const [handle, title] of LIVE_PRODUCTS) {
    cases.push({
      id: `live-p-${handle}`,
      bucket: "true_live",
      expect: "confirmed",
      url: `https://shop.example.com/products/${handle}`,
      httpStatus: 200,
      html: productLiveHtml(title),
    });
  }

  for (const [path, title] of LEVER_JOBS) {
    cases.push({
      id: `live-lever-${path.replace("/", "-")}`,
      bucket: "true_live",
      expect: "confirmed",
      url: `https://jobs.lever.co/${path}`,
      httpStatus: 200,
      html: jobLiveHtml(title),
    });
  }

  cases.push({
    id: "live-recaptcha-job",
    bucket: "true_live",
    expect: "confirmed",
    url: "https://boards.greenhouse.io/northwind/jobs/1842",
    httpStatus: 200,
    html: `<!doctype html><html><head><title>Staff Backend Engineer</title>
      <script src="https://www.google.com/recaptcha/api.js"></script></head>
      <body><h1>Staff Backend Engineer</h1>
      <form action="/jobs/1842/apply"><div class="g-recaptcha"></div>
      <button>Apply Now</button></form></body></html>`,
  });

  cases.push({
    id: "live-locale-product",
    bucket: "true_live",
    expect: "confirmed",
    url: "https://shop.example.com/products/ridge-wallet-locale",
    httpStatus: 200,
    html: `<!doctype html><html><head><title>Ridge Wallet</title>
      <script type="application/json">{"products.product.sold_out":"sold out"}</script></head>
      <body><h1>Ridge Wallet</h1>
      <form action="/cart/add"><button>Add to cart</button></form></body></html>`,
  });

  cases.push({
    id: "live-buy-now-product",
    bucket: "true_live",
    expect: "confirmed",
    url: "https://shop.example.com/products/trail-shoes",
    httpStatus: 200,
    html: `<!doctype html><html><head><title>Trail Shoes</title></head>
      <body><h1>Trail Shoes</h1><button>Buy now</button></body></html>`,
  });

  cases.push({
    id: "live-claim-title-match",
    bucket: "true_live",
    expect: "confirmed",
    url: "https://shop.example.com/products/ridge-wallet",
    httpStatus: 200,
    html: productLiveHtml("Ridge Wallet"),
    claim: { title: "Ridge Wallet", sku: "ridge-wallet" },
  });

  cases.push({
    id: "live-ebay-in-stock",
    bucket: "true_live",
    expect: "confirmed",
    url: "https://www.ebay.com/itm/123456789012",
    verify: { status: "live", signals: ["ebay-in-stock"], http_status: 200, title: "Vintage Camera", confidence: 0.86 },
  });

  cases.push({
    id: "live-ebay-limited",
    bucket: "true_live",
    expect: "confirmed",
    url: "https://www.ebay.com/itm/vintage-lens/223456789012",
    verify: {
      status: "live",
      signals: ["ebay-in-stock"],
      http_status: 200,
      title: "Vintage Lens",
      confidence: 0.8,
    },
  });

  // true_closed
  for (const id of ["4040", "4041", "4042", "4043", "4100", "4101"]) {
    cases.push({
      id: `closed-job-404-${id}`,
      bucket: "true_closed",
      expect: "failed",
      url: `https://boards.greenhouse.io/acme/jobs/${id}`,
      httpStatus: 404,
      html: notFoundHtml("job posting"),
    });
  }

  for (const handle of ["missing", "retired", "gone-sku", "old-ring", "discontinued"]) {
    cases.push({
      id: `closed-product-404-${handle}`,
      bucket: "true_closed",
      expect: "failed",
      url: `https://shop.example.com/products/${handle}`,
      httpStatus: 404,
      html: notFoundHtml("product"),
    });
  }

  for (const [handle, title] of [
    ["groove-ring", "Groove Ring"],
    ["limited-drop", "Limited Drop"],
    ["last-pair", "Last Pair"],
    ["archive-tote", "Archive Tote"],
    ["schema-oos", "Ridge Wallet"],
  ] as const) {
    const html =
      handle === "schema-oos"
        ? `<!doctype html><html><head><title>${title}</title>
          <script type="application/ld+json">{"@type":"Product","offers":{"availability":"https://schema.org/OutOfStock"}}</script>
          </head><body><h1>${title}</h1><p>The aluminum wallet.</p></body></html>`
        : productSoldOutHtml(title);
    cases.push({
      id: `closed-soldout-${handle}`,
      bucket: "true_closed",
      expect: "failed",
      url: `https://shop.example.com/products/${handle}`,
      httpStatus: 200,
      html,
    });
  }

  for (const [id, title] of [
    ["2201", "Product Designer"],
    ["3301", "Account Executive"],
    ["4402", "Warehouse Lead"],
    ["5503", "Nurse Practitioner"],
  ] as const) {
    cases.push({
      id: `closed-job-banner-${id}`,
      bucket: "true_closed",
      expect: "failed",
      url: `https://boards.greenhouse.io/acme/jobs/${id}`,
      httpStatus: 200,
      html: closedJobHtml(title),
    });
  }

  cases.push({
    id: "closed-lever-banner",
    bucket: "true_closed",
    expect: "failed",
    url: "https://jobs.lever.co/harbor/3301-account-executive",
    httpStatus: 200,
    html: closedJobHtml("Account Executive"),
  });

  cases.push({
    id: "closed-position-filled",
    bucket: "true_closed",
    expect: "failed",
    url: "https://boards.greenhouse.io/acme/jobs/8808",
    httpStatus: 200,
    html: `<!doctype html><html><head><title>This position has been filled</title></head>
      <body><p>This position has been filled.</p></body></html>`,
  });

  cases.push({
    id: "closed-no-longer-available",
    bucket: "true_closed",
    expect: "failed",
    url: "https://boards.greenhouse.io/acme/jobs/8809",
    httpStatus: 200,
    html: `<!doctype html><html><head><title>Sorry</title></head>
      <body><p>Sorry, this job is no longer available.</p></body></html>`,
  });

  cases.push({
    id: "closed-redirect-board",
    bucket: "true_closed",
    expect: "failed",
    url: "https://boards.greenhouse.io/acme/jobs/9901",
    canonicalUrl: "https://boards.greenhouse.io/acme",
    redirected: true,
    httpStatus: 200,
    html: boardHtml(),
  });

  cases.push({
    id: "closed-redirect-board-2",
    bucket: "true_closed",
    expect: "failed",
    url: "https://boards.greenhouse.io/acme/jobs/9902",
    canonicalUrl: "https://boards.greenhouse.io/acme/careers",
    redirected: true,
    httpStatus: 200,
    html: boardHtml(),
  });

  cases.push({
    id: "closed-ebay-ended",
    bucket: "true_closed",
    expect: "failed",
    url: "https://www.ebay.com/itm/333456789012",
    verify: { status: "closed", signals: ["ebay-ended"], http_status: 200, title: "Ended auction" },
  });

  cases.push({
    id: "closed-ebay-oos",
    bucket: "true_closed",
    expect: "failed",
    url: "https://www.ebay.com/itm/343456789012",
    verify: { status: "closed", signals: ["sold-out"], http_status: 200, title: "Out of stock item" },
  });

  cases.push({
    id: "closed-ebay-404",
    bucket: "true_closed",
    expect: "failed",
    url: "https://www.ebay.com/itm/353456789012",
    verify: { status: "closed", signals: ["http_404", "ebay-ended"], http_status: 404 },
  });

  cases.push({
    id: "closed-http-410",
    bucket: "true_closed",
    expect: "failed",
    url: "https://boards.greenhouse.io/acme/jobs/4102",
    httpStatus: 410,
    html: `<!doctype html><html><head><title>Gone</title></head><body><p>Gone.</p></body></html>`,
  });

  cases.push({
    id: "closed-requisition",
    bucket: "true_closed",
    expect: "failed",
    url: "https://boards.greenhouse.io/acme/jobs/7777",
    httpStatus: 200,
    html: `<!doctype html><html><head><title>Closed</title></head>
      <body><p>This requisition is closed.</p></body></html>`,
  });

  // traps — must not false-confirm
  cases.push({
    id: "trap-thank-you-id",
    bucket: "trap",
    expect: "unknown",
    url: "https://example.com/thank-you?ref=ABC123",
    httpStatus: 200,
    html: `<!doctype html><html><head><title>Thank you</title></head>
      <body><h1>Thank you</h1><p>We've received your request. Confirmation number: ABC123</p></body></html>`,
  });

  cases.push({
    id: "trap-thank-you-only",
    bucket: "trap",
    expect: "unknown",
    url: "https://example.com/thank-you",
    httpStatus: 200,
    html: `<!doctype html><html><head><title>Thank you</title></head>
      <body><h1>Thank you</h1><p>Thanks for submitting. We'll be in touch.</p></body></html>`,
  });

  cases.push({
    id: "trap-thank-you-plus-cart",
    bucket: "trap",
    expect: "unknown",
    url: "https://shop.example.com/thank-you",
    httpStatus: 200,
    html: `<!doctype html><html><head><title>Thank you</title></head>
      <body><h1>Thank you</h1><p>We've received your request.</p>
      <button>Add to cart</button></body></html>`,
  });

  cases.push({
    id: "trap-seller-listing-published-copy",
    bucket: "trap",
    expect: "unknown",
    url: "https://seller.example.com/listings/new/success",
    httpStatus: 200,
    html: `<!doctype html><html><head><title>Success</title></head>
      <body><h1>Success</h1><p>Your listing has been published. Your listing is now live.</p></body></html>`,
  });

  cases.push({
    id: "trap-collection-rings",
    bucket: "trap",
    expect: "unknown",
    url: "https://shop.example.com/collections/rings",
    httpStatus: 200,
    html: `<!doctype html><html><head><title>Rings</title></head><body>
      <h1>Rings</h1>
      <ul>
        <li class="product-card"><a href="/products/ring-a">Ring A</a><button>Add to cart</button></li>
        <li class="product-card"><a href="/products/ring-b">Ring B</a><button>Add to cart</button></li>
        <li class="product-card"><a href="/products/ring-c">Ring C</a><button>Add to cart</button></li>
      </ul></body></html>`,
  });

  cases.push({
    id: "trap-collection-apply",
    bucket: "trap",
    expect: "unknown",
    url: "https://shop.example.com/collections/all",
    httpStatus: 200,
    html: `<!doctype html><html><head><title>All</title></head><body>
      <h1>All products</h1><p>Apply now for the wholesale catalog.</p>
      <form action="/apply"><button>Apply now</button></form>
      <ul>
        <li class="product-card"><a href="/products/a">A</a></li>
        <li class="product-card"><a href="/products/b">B</a></li>
        <li class="product-card"><a href="/products/c">C</a></li>
      </ul></body></html>`,
  });

  cases.push({
    id: "trap-careers-home",
    bucket: "trap",
    expect: "unknown",
    url: "https://example.com/careers",
    httpStatus: 200,
    html: `<!doctype html><html><head><title>Careers</title></head><body>
      <h1>Current Openings</h1>
      <ul>
        <li class="opening"><a href="/jobs/11">Warehouse Associate</a></li>
        <li class="opening"><a href="/jobs/12">Shift Supervisor</a></li>
        <li class="opening"><a href="/jobs/13">Fleet Dispatcher</a></li>
      </ul></body></html>`,
  });

  cases.push({
    id: "trap-greenhouse-board",
    bucket: "trap",
    expect: "unknown",
    url: "https://boards.greenhouse.io/acme",
    httpStatus: 200,
    html: `<!doctype html><html><head><title>Acme Corp — Current Openings</title></head><body>
      <h1>Current Openings</h1>
      <p>Browse other openings.</p>
      <ul>
        <li class="opening"><a href="/jobs/11">Warehouse Associate</a></li>
        <li class="opening"><a href="/jobs/12">Shift Supervisor</a></li>
        <li class="opening"><a href="/jobs/13">Fleet Dispatcher</a></li>
      </ul></body></html>`,
  });

  cases.push({
    id: "trap-search-jobs",
    bucket: "trap",
    expect: "unknown",
    url: "https://example.com/jobs?q=engineer",
    httpStatus: 200,
    html: `<!doctype html><html><head><title>Search</title></head>
      <body><h1>Search results</h1><p>Apply now appears in a card template.</p>
      <div class="job-card">Role A</div><div class="job-card">Role B</div><div class="job-card">Role C</div>
      </body></html>`,
  });

  cases.push({
    id: "trap-cloudflare",
    bucket: "trap",
    expect: "unknown",
    url: "https://boards.greenhouse.io/northwind/jobs/1842",
    httpStatus: 200,
    html: `<!doctype html><html><head><title>Just a moment...</title></head>
      <body><div id="cf-challenge" class="cf-challenge">
      <h1>Attention Required! | Cloudflare</h1>
      <p>Checking your browser. Verify you are human.</p>
      </div></body></html>`,
  });

  cases.push({
    id: "trap-loginwall",
    bucket: "trap",
    expect: "unknown",
    url: "https://shop.example.com/products/ridge-wallet",
    httpStatus: 200,
    html: `<!doctype html><html><head><title>Sign in</title></head>
      <body><p>Please log in to view this product.</p><p>Login required.</p></body></html>`,
  });

  cases.push({
    id: "trap-homepage-addtocart",
    bucket: "trap",
    expect: "unknown",
    url: "https://shop.example.com/",
    httpStatus: 200,
    html: `<!doctype html><html><head><title>Store</title></head>
      <body><h1>Welcome</h1><button>Add to cart</button></body></html>`,
  });

  cases.push({
    id: "trap-about-instock-footer",
    bucket: "trap",
    expect: "unknown",
    url: "https://shop.example.com/about",
    httpStatus: 200,
    html: `<!doctype html><html><head><title>About</title></head>
      <body><p>We keep popular sizes in stock.</p><footer>Add to cart available in shop</footer></body></html>`,
  });

  cases.push({
    id: "trap-blog-mentions-cart",
    bucket: "trap",
    expect: "unknown",
    url: "https://shop.example.com/blog/how-to-add-to-cart",
    httpStatus: 200,
    html: `<!doctype html><html><head><title>How to add to cart</title></head>
      <body><p>Click add to cart on a product page.</p></body></html>`,
  });

  cases.push({
    id: "trap-coming-soon",
    bucket: "trap",
    expect: "unknown",
    url: "https://shop.example.com/products/coming-soon-drop",
    httpStatus: 200,
    html: `<!doctype html><html><head><title>Coming soon</title></head>
      <body><h1>Coming soon</h1><p>Notify me when available.</p></body></html>`,
  });

  cases.push({
    id: "trap-related-products",
    bucket: "trap",
    expect: "unknown",
    url: "https://shop.example.com/related",
    httpStatus: 200,
    html: `<!doctype html><html><head><title>Related</title></head><body>
      <li class="product-card">A <button>Add to cart</button></li>
      <li class="product-card">B <button>Add to cart</button></li>
      <li class="product-card">C <button>Add to cart</button></li>
      </body></html>`,
  });

  cases.push({
    id: "trap-checkout-success",
    bucket: "trap",
    expect: "unknown",
    url: "https://shop.example.com/checkout/success",
    httpStatus: 200,
    html: `<!doctype html><html><head><title>Order confirmed</title></head>
      <body><h1>Thank you</h1><p>Your order has been received. Confirmation number: ORD99881</p></body></html>`,
  });

  cases.push({
    id: "trap-cart-page",
    bucket: "trap",
    expect: "unknown",
    url: "https://shop.example.com/cart",
    httpStatus: 200,
    html: `<!doctype html><html><head><title>Cart</title></head>
      <body><h1>Your cart</h1><button>Add to cart</button></body></html>`,
  });

  cases.push({
    id: "trap-cookies-on-live-product",
    bucket: "trap",
    expect: "unknown",
    url: "https://shop.example.com/products/ridge-wallet",
    httpStatus: 200,
    html: productLiveHtml("Ridge Wallet"),
    cookiesUsed: true,
  });

  cases.push({
    id: "trap-claim-title-mismatch",
    bucket: "trap",
    expect: "unknown",
    url: "https://shop.example.com/products/ridge-wallet",
    httpStatus: 200,
    html: productLiveHtml("Ridge Wallet"),
    claim: { title: "Completely Different Product" },
  });

  cases.push({
    id: "trap-claim-id-mismatch",
    bucket: "trap",
    expect: "unknown",
    url: "https://shop.example.com/products/ridge-wallet",
    httpStatus: 200,
    html: productLiveHtml("Ridge Wallet"),
    claim: { id: "other-sku-999" },
  });

  cases.push({
    id: "trap-ambiguous-html",
    bucket: "trap",
    expect: "unknown",
    url: "https://example.com/page",
    httpStatus: 200,
    html: `<!doctype html><html><head><title>Hello</title></head><body><p>Hello world.</p></body></html>`,
  });

  cases.push({
    id: "trap-marketing-published",
    bucket: "trap",
    expect: "unknown",
    url: "https://example.com/press/listing-published",
    httpStatus: 200,
    html: `<!doctype html><html><head><title>Press</title></head>
      <body><p>This listing is published and live for buyers worldwide.</p></body></html>`,
  });

  cases.push({
    id: "trap-newsletter",
    bucket: "trap",
    expect: "unknown",
    url: "https://example.com/newsletter/thanks",
    httpStatus: 200,
    html: `<!doctype html><html><head><title>Thanks</title></head>
      <body><h1>Thank you</h1><p>Thanks for subscribing.</p></body></html>`,
  });

  cases.push({
    id: "trap-workday-js",
    bucket: "trap",
    expect: "unknown",
    url: "https://acme.myworkdayjobs.com/en-US/careers/job/12345",
    httpStatus: 200,
    html: `<!doctype html><html><head><title>Job</title></head>
      <body><div id="root"></div><p>Enable JavaScript to view this application.</p></body></html>`,
  });

  cases.push({
    id: "trap-category",
    bucket: "trap",
    expect: "unknown",
    url: "https://shop.example.com/category/wallets",
    httpStatus: 200,
    html: `<!doctype html><html><head><title>Wallets</title></head>
      <body><h1>Wallets</h1><button>Add to cart</button></body></html>`,
  });

  cases.push({
    id: "trap-soft-apply-home",
    bucket: "trap",
    expect: "unknown",
    url: "https://example.com/",
    httpStatus: 200,
    html: `<!doctype html><html><head><title>Home</title></head>
      <body><a href="/jobs">Apply now</a></body></html>`,
  });

  cases.push({
    id: "trap-ebay-unknown",
    bucket: "trap",
    expect: "unknown",
    url: "https://www.ebay.com/itm/363456789012",
    verify: { status: "unknown", signals: ["ebay_availability_unknown"], http_status: 200, title: "Maybe listed" },
  });

  cases.push({
    id: "trap-ebay-api-error",
    bucket: "trap",
    expect: "unknown",
    url: "https://www.ebay.com/itm/373456789012",
    verify: { status: "unknown", signals: ["ebay_api_error"], http_status: 200 },
  });

  cases.push({
    id: "trap-invented-id-absent",
    bucket: "trap",
    expect: "unknown",
    url: "https://example.com/mystery",
    httpStatus: 200,
    html: `<!doctype html><html><head><title>Mystery</title></head>
      <body><p>Listing id will be assigned later. Add to cart coming soon.</p></body></html>`,
    claim: { id: "INV-FAKE-0001" },
  });

  cases.push({
    id: "trap-compare-page",
    bucket: "trap",
    expect: "unknown",
    url: "https://shop.example.com/compare",
    httpStatus: 200,
    html: `<!doctype html><html><head><title>Compare</title></head>
      <body><p>Add to cart on each column.</p></body></html>`,
  });

  cases.push({
    id: "trap-pdf-job-desc",
    bucket: "trap",
    expect: "unknown",
    url: "https://example.com/jobs/staff-backend.pdf",
    httpStatus: 200,
    html: `<!doctype html><html><head><title>Staff Backend</title></head>
      <body><p>Job description PDF text. No apply form.</p></body></html>`,
  });

  cases.push({
    id: "trap-empty-ats",
    bucket: "trap",
    expect: "unknown",
    url: "https://jobs.ashbyhq.com/acme/jobs",
    httpStatus: 200,
    html: `<!doctype html><html><head><title>Jobs</title></head>
      <body><p>No open roles right now.</p></body></html>`,
  });

  cases.push({
    id: "trap-amazon-like",
    bucket: "trap",
    expect: "unknown",
    url: "https://www.amazon.com/dp/B000000000",
    httpStatus: 200,
    html: `<!doctype html><html><head><title>Amazon</title></head>
      <body><p>Sign in to continue shopping.</p></body></html>`,
  });

  cases.push({
    id: "trap-confirmation-path-product-words",
    bucket: "trap",
    expect: "unknown",
    url: "https://shop.example.com/confirmation/abc123",
    httpStatus: 200,
    html: `<!doctype html><html><head><title>Confirmation</title></head>
      <body><h1>Thank you</h1><p>Add this SKU to your next cart: ridge-wallet</p></body></html>`,
  });

  cases.push({
    id: "trap-login-to-see-price",
    bucket: "trap",
    expect: "unknown",
    url: "https://shop.example.com/products/wholesale-wallet",
    httpStatus: 200,
    html: `<!doctype html><html><head><title>Wholesale Wallet</title></head>
      <body><p>Please sign in to continue. Login required to see price.</p></body></html>`,
  });

  cases.push({
    id: "trap-challenge-just-a-moment",
    bucket: "trap",
    expect: "unknown",
    url: "https://shop.example.com/products/ridge-wallet",
    httpStatus: 200,
    html: `<!doctype html><html><head><title>Just a moment...</title></head>
      <body><p>Checking your browser before accessing shop.example.com.</p>
      <div class="cf-challenge"></div></body></html>`,
  });

  cases.push({
    id: "trap-search-products",
    bucket: "trap",
    expect: "unknown",
    url: "https://shop.example.com/search?q=wallet",
    httpStatus: 200,
    html: `<!doctype html><html><head><title>Search</title></head>
      <body><p>Results</p><button>Add to cart</button></body></html>`,
  });

  return cases;
}

export function benchCaseCounts(cases = listingPublishedBenchCases()): {
  n: number;
  true_live: number;
  true_closed: number;
  trap: number;
} {
  return {
    n: cases.length,
    true_live: cases.filter((c) => c.bucket === "true_live").length,
    true_closed: cases.filter((c) => c.bucket === "true_closed").length,
    trap: cases.filter((c) => c.bucket === "trap").length,
  };
}
