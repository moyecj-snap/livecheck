export type FixtureId = string;

export type FixtureSpec = {
  id: FixtureId;
  status: number;
  contentType?: string;
  body?: string;
  location?: string;
  label: string;
};

const LIVE_APPLY_NOW = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Staff Backend Engineer — Northwind Labs</title>
</head>
<body>
  <h1>Staff Backend Engineer</h1>
  <p>Location: Oakland, CA · Posted on Greenhouse</p>
  <article>
    <p>Build the payments path that keeps our primary-source checks honest.</p>
    <p>This is a specific posting, not a search results page.</p>
  </article>
  <form action="/jobs/1842/apply" method="post">
    <label>Resume <input type="file" name="resume" /></label>
    <button type="submit">Apply Now</button>
  </form>
</body>
</html>
`;

const CLOSED_GREENHOUSE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Product Designer — this job is closed to new applications</title>
</head>
<body>
  <div class="flash-banner">
    <h1>Product Designer</h1>
    <p>This job is closed to new applications.</p>
  </div>
  <p>Greenhouse empty-state for a filled requisition. There is no apply form.</p>
</body>
</html>
`;

const CLOSED_LEVER = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Account Executive at Harbor Freight Robotics</title>
</head>
<body>
  <header>
    <p class="posting-headline">Account Executive</p>
    <p class="posting-categories">Sales · Remote</p>
  </header>
  <div class="application-closed">
    <strong>This job is closed to new applications.</strong>
    <p>The posting remains visible on Lever for internal records only.</p>
  </div>
</body>
</html>
`;

const GREENHOUSE_BOARD = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Acme Corp — Current Openings</title>
</head>
<body>
  <h1>Current Openings</h1>
  <p>We're sorry, the job you are looking for is no longer available. Browse other openings.</p>
  <ul class="opening-list">
    <li class="opening"><a href="/jobs/11">Warehouse Associate</a></li>
    <li class="opening"><a href="/jobs/12">Shift Supervisor</a></li>
    <li class="opening"><a href="/jobs/13">Fleet Dispatcher</a></li>
  </ul>
</body>
</html>
`;

const NOT_FOUND = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>404 Not Found</title>
</head>
<body>
  <h1>Not Found</h1>
  <p>The job posting does not exist.</p>
</body>
</html>
`;

const LIVE_APPLY_RECAPTCHA = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Staff Backend Engineer — Northwind Labs</title>
  <script src="https://www.google.com/recaptcha/api.js" async defer></script>
</head>
<body>
  <h1>Staff Backend Engineer</h1>
  <p>Greenhouse apply form. Spam protection uses recaptcha / hcaptcha widgets.</p>
  <form action="/jobs/1842/apply" method="post">
    <div class="g-recaptcha" data-sitekey="test-site-key"></div>
    <button type="submit">Apply Now</button>
  </form>
</body>
</html>
`;

const CLOUDFLARE_CHALLENGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Just a moment...</title>
</head>
<body>
  <div id="cf-challenge" class="cf-challenge">
    <h1>Attention Required! | Cloudflare</h1>
    <p>Checking your browser before accessing boards.greenhouse.io.</p>
    <p>Verify you are human. Enable JavaScript and cookies to continue.</p>
    <div class="challenge-platform" data-ray="test"></div>
  </div>
</body>
</html>
`;

const SHOPIFY_IN_STOCK = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Ridge Wallet – Ridge</title>
  <script src="https://www.google.com/recaptcha/api.js"></script>
</head>
<body>
  <h1>Ridge Wallet</h1>
  <p>Aluminum wallet. recaptcha is loaded for checkout spam checks.</p>
  <div class="g-recaptcha" data-sitekey="test-site-key"></div>
  <form action="/cart/add" method="post">
    <button type="submit" name="add">Add to cart</button>
  </form>
</body>
</html>
`;

const SHOPIFY_SOLD_OUT = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Groove Ring – Groove Life</title>
</head>
<body>
  <h1>Groove Ring</h1>
  <p>This item is currently unavailable.</p>
  <p class="price__badge">Sold out</p>
  <button type="button" disabled>Sold out</button>
</body>
</html>
`;

const SHOPIFY_COLLECTION = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Rings – Groove Life</title>
</head>
<body>
  <h1>Rings</h1>
  <p>Collection template includes a quick-add control.</p>
  <ul>
    <li class="product-card"><a href="/products/ring-a">Ring A</a><button>Add to cart</button></li>
    <li class="product-card"><a href="/products/ring-b">Ring B</a><button>Add to cart</button></li>
    <li class="product-card"><a href="/products/ring-c">Ring C</a><button>Add to cart</button></li>
  </ul>
</body>
</html>
`;

const SHOPIFY_IN_STOCK_LOCALE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Ridge Wallet – Ridge</title>
  <script type="application/json" id="LocaleJson">
    {
      "products.product.sold_out": "sold out",
      "products.product.out_of_stock": "out of stock",
      "products": { "product": { "sold_out": "sold out", "unavailable": "unavailable" } }
    }
  </script>
</head>
<body>
  <h1>Ridge Wallet</h1>
  <p>In-stock product. Translation catalog is present for theme labels.</p>
  <form action="/cart/add" method="post">
    <button type="submit" name="add">Add to cart</button>
  </form>
</body>
</html>
`;

const CLOUDFLARE_CHALLENGE_PLATFORM_ONLY = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Groove Ring – Groove Life</title>
  <script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>
</head>
<body>
  <h1>Groove Ring</h1>
  <p>Cloudflare bot-management script only. No interstitial copy.</p>
  <form action="/cart/add" method="post">
    <button type="submit" name="add">Add to cart</button>
  </form>
</body>
</html>
`;

const PRODUCT_404 = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>404 Not Found</title>
</head>
<body>
  <h1>Not Found</h1>
  <p>The product does not exist.</p>
</body>
</html>
`;

export const FIXTURES: Record<FixtureId, FixtureSpec> = {
  "live-apply-now": {
    id: "live-apply-now",
    status: 200,
    body: LIVE_APPLY_NOW,
    label: "200 + Apply Now on a specific posting",
  },
  "closed-to-new-applications": {
    id: "closed-to-new-applications",
    status: 200,
    body: CLOSED_GREENHOUSE,
    label: "Greenhouse: this job is closed to new applications",
  },
  "closed-to-new-applications-lever": {
    id: "closed-to-new-applications-lever",
    status: 200,
    body: CLOSED_LEVER,
    label: "Lever: this job is closed to new applications",
  },
  "greenhouse-closed-job": {
    id: "greenhouse-closed-job",
    status: 302,
    location: "/fixtures/careers",
    label: "Greenhouse job URL that redirects to the company board",
  },
  "greenhouse-board": {
    id: "greenhouse-board",
    status: 200,
    body: GREENHOUSE_BOARD,
    label: "Greenhouse board (empty-state after redirect)",
  },
  careers: {
    id: "careers",
    status: 200,
    body: GREENHOUSE_BOARD,
    label: "Careers homepage / ATS board",
  },
  "jobs/9901": {
    id: "jobs/9901",
    status: 302,
    location: "/fixtures/careers",
    label: "Numeric job path that 302s to the board",
  },
  "gone-404": {
    id: "gone-404",
    status: 404,
    body: NOT_FOUND,
    label: "HTTP 404 job URL",
  },
  "live-apply-recaptcha": {
    id: "live-apply-recaptcha",
    status: 200,
    body: LIVE_APPLY_RECAPTCHA,
    label: "Open job apply form that includes a recaptcha widget",
  },
  "cloudflare-challenge": {
    id: "cloudflare-challenge",
    status: 200,
    body: CLOUDFLARE_CHALLENGE,
    label: "Cloudflare interstitial challenge page",
  },
  "products/ridge-wallet": {
    id: "products/ridge-wallet",
    status: 200,
    body: SHOPIFY_IN_STOCK,
    label: "Shopify product page with Add to cart (recaptcha present)",
  },
  "products/groove-ring": {
    id: "products/groove-ring",
    status: 200,
    body: SHOPIFY_SOLD_OUT,
    label: "Shopify product page that is sold out",
  },
  "collections/rings": {
    id: "collections/rings",
    status: 200,
    body: SHOPIFY_COLLECTION,
    label: "Shopify collection page with template add-to-cart",
  },
  "products/missing": {
    id: "products/missing",
    status: 404,
    body: PRODUCT_404,
    label: "HTTP 404 product URL",
  },
  "products/ridge-wallet-locale": {
    id: "products/ridge-wallet-locale",
    status: 200,
    body: SHOPIFY_IN_STOCK_LOCALE,
    label: "Shopify in-stock product whose locale JSON contains sold-out strings",
  },
  "products/groove-ring-challenge-platform": {
    id: "products/groove-ring-challenge-platform",
    status: 200,
    body: CLOUDFLARE_CHALLENGE_PLATFORM_ONLY,
    label: "Product HTML with only a Cloudflare challenge-platform script",
  },
};

export const FIXTURE_LIST = Object.values(FIXTURES);
