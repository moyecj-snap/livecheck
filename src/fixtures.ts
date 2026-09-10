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

const SHOPIFY_IN_STOCK_LOCALE_CLASS = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Ridge Wallet – Ridge</title>
  <script type="application/ld+json">
    {"@context":"https://schema.org/","@type":"Product","offers":{"availability":"https://schema.org/InStock"}}
  </script>
  <script type="application/json" id="LocaleJson">
    { "products.product.sold_out": "sold out" }
  </script>
</head>
<body>
  <h1>Ridge Wallet</h1>
  <div class="product-form sold-out" data-sold-out="false">
    <form action="/cart/add" method="post">
      <button type="submit" name="add" class="btn sold-out-style">Add to cart</button>
    </form>
  </div>
</body>
</html>
`;

const SHOPIFY_SOLD_OUT_SCHEMA = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Ridge Wallet – Ridge</title>
  <script type="application/ld+json">
    {"@context":"https://schema.org/","@type":"Product","offers":{"availability":"https://schema.org/OutOfStock"}}
  </script>
</head>
<body>
  <h1>Ridge Wallet</h1>
  <p>The aluminum wallet.</p>
</body>
</html>
`;

const SHOPIFY_COLLECTION_APPLY = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>All – Ridge</title>
</head>
<body>
  <h1>All products</h1>
  <p>Apply now for the wholesale catalog.</p>
  <form action="/apply" method="post">
    <button type="submit">Apply now</button>
  </form>
  <ul>
    <li class="product-card"><a href="/products/wallet-a">Wallet A</a></li>
    <li class="product-card"><a href="/products/wallet-b">Wallet B</a></li>
    <li class="product-card"><a href="/products/wallet-c">Wallet C</a></li>
  </ul>
</body>
</html>
`;

const CONFIRM_THANK_YOU_ID = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Thank you</title>
</head>
<body>
  <h1>Thank you</h1>
  <p>We've received your request. Confirmation number: ABC123</p>
</body>
</html>
`;

const CONFIRM_THANK_YOU_ONLY = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Thank you</title>
</head>
<body>
  <h1>Thank you</h1>
  <p>Thanks for submitting. We'll be in touch.</p>
</body>
</html>
`;

const CONFIRM_ERROR_BANNER = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Submission failed</title>
</head>
<body>
  <h1>Something went wrong</h1>
  <p class="error">Your submission was rejected. Please try again.</p>
</body>
</html>
`;

const ORDER_THANK_YOU_ID = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Order confirmation</title>
</head>
<body>
  <h1>Thank you for your order</h1>
  <p>Your order has been placed. Order number: ORD-18421</p>
  <p>Order total: $42.00</p>
</body>
</html>
`;

const ORDER_THANK_YOU_ONLY = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Thanks for your order</title>
</head>
<body>
  <h1>Thank you for your order</h1>
  <p>We've received your order. A confirmation email is on the way.</p>
</body>
</html>
`;

const ORDER_PAYMENT_FAILED = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Payment failed</title>
</head>
<body>
  <h1>Checkout failed</h1>
  <p class="error">Your payment was declined. We could not process your payment.</p>
</body>
</html>
`;

const ORDER_CANCELLED = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Order cancelled</title>
</head>
<body>
  <h1>Order cancelled</h1>
  <p>Your order has been cancelled. No charge was made.</p>
</body>
</html>
`;

const ORDER_LOGINWALL = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Sign in to view your order</title>
</head>
<body>
  <h1>Sign in to view your order</h1>
  <p>Please log in to view this confirmation. Login required.</p>
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

const PRODUCT_USD_PRICE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Ridge Wallet – $1,299.00</title>
</head>
<body>
  <h1>Ridge Wallet</h1>
  <p class="price">$1,299.00</p>
  <p class="viewers">23 watching</p>
  <p class="stamp">Posted 2 hours ago · 2026-09-10T18:00:00Z</p>
  <p class="desc">Aluminum wallet. Ships today.</p>
  <form action="/cart/add" method="post">
    <button type="submit">Add to cart</button>
  </form>
</body>
</html>
`;

const PRODUCT_EUR_PRICE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Ridge Wallet – 1 299,00 €</title>
</head>
<body>
  <h1>Ridge Wallet</h1>
  <p class="price">1 299,00 €</p>
  <form action="/cart/add" method="post">
    <button type="submit">Add to cart</button>
  </form>
</body>
</html>
`;

const PRODUCT_PRICE_149 = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Ridge Card Case – 149</title>
</head>
<body>
  <h1>Ridge Card Case</h1>
  <p class="price">149</p>
  <form action="/cart/add" method="post">
    <button type="submit">Add to cart</button>
  </form>
</body>
</html>
`;

const PRODUCT_JSON_PRICE = `{
  "name": "Ridge Card Case",
  "offers": { "price": 149, "priceCurrency": "USD" }
}
`;

const PRODUCT_TEXT_CHANGED = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Ridge Wallet – new copy</title>
</head>
<body>
  <h1>Ridge Wallet Titanium</h1>
  <p class="price">$1,299.00</p>
  <p class="viewers">88 watching</p>
  <p class="stamp">Posted 1 minute ago · 2026-09-10T19:00:00Z</p>
  <p class="desc">Titanium wallet. Limited drop. Completely rewritten product story for collectors.</p>
  <form action="/cart/add" method="post">
    <button type="submit">Add to cart</button>
  </form>
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
  "jobs/1842": {
    id: "jobs/1842",
    status: 200,
    body: LIVE_APPLY_NOW,
    label: "Numeric job path with Apply Now",
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
    label: "In-stock product with only a Cloudflare bot-management script",
  },
  "products/ridge-wallet-locale-class": {
    id: "products/ridge-wallet-locale-class",
    status: 200,
    body: SHOPIFY_IN_STOCK_LOCALE_CLASS,
    label: "In-stock product with locale sold_out JSON, sold-out CSS class, and schema InStock",
  },
  "products/ridge-wallet-schema-oos": {
    id: "products/ridge-wallet-schema-oos",
    status: 200,
    body: SHOPIFY_SOLD_OUT_SCHEMA,
    label: "Product whose only sold-out signal is schema.org OutOfStock",
  },
  "collections/all-apply": {
    id: "collections/all-apply",
    status: 200,
    body: SHOPIFY_COLLECTION_APPLY,
    label: "Collection page that accidentally includes Apply now",
  },
  "confirm/thank-you-id": {
    id: "confirm/thank-you-id",
    status: 200,
    body: CONFIRM_THANK_YOU_ID,
    label: "Thank-you page with confirmation number ABC123",
  },
  "confirm/thank-you-only": {
    id: "confirm/thank-you-only",
    status: 200,
    body: CONFIRM_THANK_YOU_ONLY,
    label: "Thank-you copy with no confirmation id",
  },
  "confirm/error-banner": {
    id: "confirm/error-banner",
    status: 200,
    body: CONFIRM_ERROR_BANNER,
    label: "Lead submit error / reject banner",
  },
  "confirm/order-thank-you-id": {
    id: "confirm/order-thank-you-id",
    status: 200,
    body: ORDER_THANK_YOU_ID,
    label: "Order thank-you page with order number ORD-18421",
  },
  "confirm/order-thank-you-only": {
    id: "confirm/order-thank-you-only",
    status: 200,
    body: ORDER_THANK_YOU_ONLY,
    label: "Order thank-you copy with no order id",
  },
  "confirm/order-payment-failed": {
    id: "confirm/order-payment-failed",
    status: 200,
    body: ORDER_PAYMENT_FAILED,
    label: "Payment declined / checkout failed banner",
  },
  "confirm/order-cancelled": {
    id: "confirm/order-cancelled",
    status: 200,
    body: ORDER_CANCELLED,
    label: "Order cancelled banner",
  },
  "confirm/order-loginwall": {
    id: "confirm/order-loginwall",
    status: 200,
    body: ORDER_LOGINWALL,
    label: "Login wall on an order confirmation URL",
  },
  "products/price-usd": {
    id: "products/price-usd",
    status: 200,
    body: PRODUCT_USD_PRICE,
    label: "Product page with $1,299.00 and viewer/timestamp noise",
  },
  "products/price-eur": {
    id: "products/price-eur",
    status: 200,
    body: PRODUCT_EUR_PRICE,
    label: "Product page with 1 299,00 euro price",
  },
  "products/price-149": {
    id: "products/price-149",
    status: 200,
    body: PRODUCT_PRICE_149,
    label: "Product page with bare 149 price",
  },
  "products/price.json": {
    id: "products/price.json",
    status: 200,
    contentType: "application/json",
    body: PRODUCT_JSON_PRICE,
    label: "JSON product payload with offers.price 149",
  },
  "products/price-usd-changed": {
    id: "products/price-usd-changed",
    status: 200,
    body: PRODUCT_TEXT_CHANGED,
    label: "Same product with rewritten description (noise counters changed too)",
  },
};

export const FIXTURE_LIST = Object.values(FIXTURES);
