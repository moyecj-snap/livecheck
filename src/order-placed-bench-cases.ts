export type BenchBucket = "true_placed" | "true_failed" | "trap";
export type BenchExpect = "confirmed" | "failed" | "unknown";

export type OrderPlacedBenchCase = {
  id: string;
  bucket: BenchBucket;
  expect: BenchExpect;
  url: string;
  canonicalUrl?: string;
  httpStatus?: number;
  html?: string;
  title?: string;
  cookiesUsed?: boolean;
  claim?: Record<string, unknown>;
};

function orderHtml(opts: {
  title: string;
  body: string;
}): string {
  return `<!doctype html><html><head><title>${opts.title}</title></head><body>
  ${opts.body}
  </body></html>`;
}

const PLACED_IDS = [
  ["ORD-18421", "Order number: ORD-18421"],
  ["CNF-99014", "Confirmation number: CNF-99014"],
  ["RCPT-44001", "Receipt number: RCPT-44001"],
  ["TKT-88210", "Ticket number: TKT-88210"],
  ["BK-33018", "Booking reference: BK-33018"],
  ["REF-77102", "Reference id: REF-77102"],
  ["A1B2C3D4", "Order id: A1B2C3D4"],
  ["WXYZ-10021", "Confirmation id: WXYZ-10021"],
  ["10421", "Order number is 10421"],
  ["882914", "Order # 882914"],
  ["ORD10021", "Your order ORD10021 is confirmed"],
  ["RC-55019", "Receipt id: RC-55019"],
  ["CONF-22018", "Confirmation code: CONF-22018"],
  ["LEADNO", "skip"],
] as const;

const PLACED_SHOPS = [
  "northwind.example",
  "harbor.shop",
  "lumen.store",
  "oak.example",
  "river.shop",
  "field.store",
  "ridge.example",
  "canvas.shop",
  "steel.store",
  "linen.example",
] as const;

function placedPage(orderId: string, label: string, extra = ""): string {
  return orderHtml({
    title: "Thank you for your order",
    body: `<h1>Thank you for your order</h1>
      <p>Your order has been placed.</p>
      <p>${label}</p>
      <p>Order total: $42.00</p>
      ${extra}`,
  });
}

export function orderPlacedBenchCases(): OrderPlacedBenchCase[] {
  const cases: OrderPlacedBenchCase[] = [];

  const placedPairs = PLACED_IDS.filter((pair) => pair[1] !== "skip");
  let shopIdx = 0;
  for (const [orderId, label] of placedPairs) {
    const shop = PLACED_SHOPS[shopIdx % PLACED_SHOPS.length];
    shopIdx += 1;
    cases.push({
      id: `placed-label-${orderId}`,
      bucket: "true_placed",
      expect: "confirmed",
      url: `https://${shop}/checkout/success`,
      httpStatus: 200,
      html: placedPage(orderId, label),
    });
  }

  const urlTokenIds = [
    "ORD-20001",
    "ORD-20002",
    "CNF-20003",
    "RCPT-20004",
    "TKT-20005",
    "BK-20006",
    "REF-20007",
    "A9B8C7D6",
    "WXYZ-20009",
    "882915",
  ];
  for (const orderId of urlTokenIds) {
    cases.push({
      id: `placed-url-${orderId}`,
      bucket: "true_placed",
      expect: "confirmed",
      url: `https://shop.example.com/thank-you?order_id=${orderId}`,
      httpStatus: 200,
      html: orderHtml({
        title: "Thanks for your order",
        body: `<h1>Thanks for your order</h1><p>We've received your order.</p>`,
      }),
    });
  }

  const pathIds = ["ORD-30001", "ORD-30002", "CNF-30003", "RCPT-30004", "882916"];
  for (const orderId of pathIds) {
    cases.push({
      id: `placed-path-${orderId}`,
      bucket: "true_placed",
      expect: "confirmed",
      url: `https://shop.example.com/orders/${orderId}`,
      httpStatus: 200,
      html: orderHtml({
        title: "Order received",
        body: `<h1>Order received</h1><p>Thanks for shopping.</p>`,
      }),
    });
  }

  cases.push({
    id: "placed-claim-match",
    bucket: "true_placed",
    expect: "confirmed",
    url: "https://shop.example.com/checkout/success",
    httpStatus: 200,
    html: placedPage("ORD-18421", "Order number: ORD-18421", "<p>buyer@acme.com</p>"),
    claim: { order_id: "ORD-18421", total: "42.00", email_domain: "acme.com" },
  });

  cases.push({
    id: "placed-receipt-token",
    bucket: "true_placed",
    expect: "confirmed",
    url: "https://shop.example.com/receipt?receipt=RC-88021",
    httpStatus: 200,
    html: orderHtml({
      title: "Receipt",
      body: `<h1>Thank you for your purchase</h1><p>Receipt number: RC-88021</p>`,
    }),
  });

  cases.push({
    id: "placed-order-status-path",
    bucket: "true_placed",
    expect: "confirmed",
    url: "https://shop.example.com/order-status/ORD-41001",
    httpStatus: 200,
    html: orderHtml({
      title: "Order status",
      body: `<h1>Order confirmed</h1><p>We have received your order.</p>`,
    }),
  });

  cases.push({
    id: "placed-woocommerce-style",
    bucket: "true_placed",
    expect: "confirmed",
    url: "https://shop.example.com/checkout/order-received/18421/?key=wc_order_abc",
    httpStatus: 200,
    html: orderHtml({
      title: "Order received",
      body: `<h1>Thank you for your order</h1><p>Order number: 18421</p><ul><li>Total: $18.00</li></ul>`,
    }),
  });

  cases.push({
    id: "placed-shopify-style",
    bucket: "true_placed",
    expect: "confirmed",
    url: "https://shop.example.com/thank-you",
    httpStatus: 200,
    html: orderHtml({
      title: "Thank you",
      body: `<h1>Thank you for your purchase</h1><p>Order # 10021</p><p>Confirmed.</p>`,
    }),
  });

  cases.push({
    id: "placed-ticket-label",
    bucket: "true_placed",
    expect: "confirmed",
    url: "https://events.example.com/confirmation",
    httpStatus: 200,
    html: orderHtml({
      title: "You're in",
      body: `<h1>Thank you for your order</h1><p>Ticket id: EVT-55018</p>`,
    }),
  });

  const failedBanners: Array<[string, string, string]> = [
    ["payment-failed", "Payment failed", "Payment failed. Please use another card."],
    ["payment-declined", "Payment declined", "Your payment was declined."],
    ["card-declined", "Card declined", "Card declined. The issuer rejected this charge."],
    ["txn-declined", "Transaction declined", "Transaction declined by the bank."],
    ["txn-failed", "Transaction failed", "Transaction failed. Try again later."],
    ["could-not-process", "Checkout", "We could not process your payment."],
    ["unable-process", "Checkout", "Unable to process your payment at this time."],
    ["checkout-failed", "Checkout failed", "Checkout failed. No order was created."],
    ["order-cancelled", "Order cancelled", "Order cancelled. Your order has been cancelled."],
    ["order-canceled", "Order canceled", "Your order has been canceled."],
    ["this-cancelled", "Cancelled", "This order was cancelled by the merchant."],
    ["this-canceled", "Canceled", "This order was canceled before capture."],
    ["payment-not-success", "Payment", "Payment was not successful."],
    ["could-not-complete", "Order", "Order could not be completed."],
    ["unable-complete", "Order", "Unable to complete your order."],
    ["could-not-place", "Order", "Your order could not be placed."],
    ["declined-banner", "Declined", "Payment declined. Card declined."],
    ["cancelled-no-charge", "Cancelled", "Your order has been cancelled. No charge was made."],
    ["failed-retry", "Payment failed", "Payment failed. We could not process your payment."],
    ["checkout-declined", "Checkout failed", "Checkout failed. Transaction declined."],
  ];
  for (const [id, title, body] of failedBanners) {
    cases.push({
      id: `failed-${id}`,
      bucket: "true_failed",
      expect: "failed",
      url: `https://shop.example.com/checkout/${id}`,
      httpStatus: 200,
      html: orderHtml({ title, body: `<h1>${title}</h1><p class="error">${body}</p>` }),
    });
  }

  for (const n of ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10"]) {
    cases.push({
      id: `failed-declined-${n}`,
      bucket: "true_failed",
      expect: "failed",
      url: `https://shop.example.com/checkout/retry-${n}`,
      httpStatus: 200,
      html: orderHtml({
        title: "Payment declined",
        body: `<h1>Payment declined</h1><p>Your payment was declined. Attempt ${n}.</p>`,
      }),
    });
  }

  // traps — must not false-confirm
  const fluffCopy = [
    ["thanks-only", "Thank you for your order", "We've received your order. A confirmation email is on the way."],
    ["thanks-shopping", "Thanks for shopping", "Thanks for shopping with us. We'll be in touch."],
    ["placed-no-id", "Order placed", "Your order has been placed. Watch your inbox."],
    ["received-no-id", "Order received", "Your order has been received."],
    ["confirmed-banner", "Order confirmed", "Order confirmed. Thanks for your purchase."],
    ["email-soon", "Thanks", "Thank you for your order. We'll email your receipt."],
    ["processing", "Processing", "Your order has been placed and is being processed."],
    ["guest-thanks", "Thank you", "Thanks for your order. Create an account next time."],
  ] as const;
  for (const [id, title, body] of fluffCopy) {
    cases.push({
      id: `trap-fluff-${id}`,
      bucket: "trap",
      expect: "unknown",
      url: `https://shop.example.com/thank-you/${id}`,
      httpStatus: 200,
      html: orderHtml({ title, body: `<h1>${title}</h1><p>${body}</p>` }),
    });
  }

  cases.push({
    id: "trap-loginwall",
    bucket: "trap",
    expect: "unknown",
    url: "https://shop.example.com/orders/ORD-18421",
    httpStatus: 200,
    html: orderHtml({
      title: "Sign in to view your order",
      body: `<h1>Sign in to view your order</h1><p>Please log in to view this confirmation. Login required.</p>`,
    }),
  });

  cases.push({
    id: "trap-loginwall-please-sign-in",
    bucket: "trap",
    expect: "unknown",
    url: "https://shop.example.com/account/orders/ORD-18421",
    httpStatus: 200,
    html: orderHtml({
      title: "Please sign in",
      body: `<p>Please sign in to continue. Log in to view your order history.</p>`,
    }),
  });

  cases.push({
    id: "trap-cookies-with-id",
    bucket: "trap",
    expect: "unknown",
    url: "https://shop.example.com/thank-you?order_id=ORD-18421",
    httpStatus: 200,
    html: placedPage("ORD-18421", "Order number: ORD-18421"),
    cookiesUsed: true,
  });

  cases.push({
    id: "trap-claim-only-invented-id",
    bucket: "trap",
    expect: "unknown",
    url: "https://shop.example.com/thank-you",
    httpStatus: 200,
    html: orderHtml({
      title: "Thank you for your order",
      body: `<h1>Thank you for your order</h1><p>We've received your order.</p>`,
    }),
    claim: { order_id: "INV-FAKE-0001" },
  });

  cases.push({
    id: "trap-claim-id-mismatch",
    bucket: "trap",
    expect: "unknown",
    url: "https://shop.example.com/checkout/success",
    httpStatus: 200,
    html: placedPage("ORD-18421", "Order number: ORD-18421"),
    claim: { order_id: "ORD-99999" },
  });

  cases.push({
    id: "trap-claim-total-mismatch",
    bucket: "trap",
    expect: "unknown",
    url: "https://shop.example.com/checkout/success",
    httpStatus: 200,
    html: placedPage("ORD-18421", "Order number: ORD-18421"),
    claim: { order_id: "ORD-18421", total: "99.00" },
  });

  cases.push({
    id: "trap-claim-email-domain-mismatch",
    bucket: "trap",
    expect: "unknown",
    url: "https://shop.example.com/checkout/success",
    httpStatus: 200,
    html: placedPage("ORD-18421", "Order number: ORD-18421", "<p>buyer@acme.com</p>"),
    claim: { order_id: "ORD-18421", email_domain: "other.example" },
  });

  cases.push({
    id: "trap-cart-page",
    bucket: "trap",
    expect: "unknown",
    url: "https://shop.example.com/cart",
    httpStatus: 200,
    html: orderHtml({
      title: "Your cart",
      body: `<h1>Your cart</h1><p>Add to cart. Place order when ready.</p>`,
    }),
  });

  cases.push({
    id: "trap-checkout-form",
    bucket: "trap",
    expect: "unknown",
    url: "https://shop.example.com/checkout",
    httpStatus: 200,
    html: orderHtml({
      title: "Checkout",
      body: `<h1>Checkout</h1><form><button>Place order</button></form>`,
    }),
  });

  cases.push({
    id: "trap-marketing-order-now",
    bucket: "trap",
    expect: "unknown",
    url: "https://shop.example.com/products/ridge-wallet",
    httpStatus: 200,
    html: orderHtml({
      title: "Ridge Wallet",
      body: `<h1>Ridge Wallet</h1><p>Order now. In stock.</p><button>Add to cart</button>`,
    }),
  });

  cases.push({
    id: "trap-faq-order-number",
    bucket: "trap",
    expect: "unknown",
    url: "https://shop.example.com/help/where-is-my-order-number",
    httpStatus: 200,
    html: orderHtml({
      title: "Where is my order number?",
      body: `<p>Your order number appears on the confirmation page after checkout.</p>`,
    }),
  });

  cases.push({
    id: "trap-blog-thanks",
    bucket: "trap",
    expect: "unknown",
    url: "https://shop.example.com/blog/thanks-for-your-order-tips",
    httpStatus: 200,
    html: orderHtml({
      title: "Thanks for your order — packing tips",
      body: `<p>Thank you for your order is what customers see. This is a blog post.</p>`,
    }),
  });

  cases.push({
    id: "trap-generic-success",
    bucket: "trap",
    expect: "unknown",
    url: "https://shop.example.com/success",
    httpStatus: 200,
    html: orderHtml({
      title: "Success",
      body: `<h1>Success</h1><p>You're all set.</p>`,
    }),
  });

  cases.push({
    id: "trap-lead-thank-you",
    bucket: "trap",
    expect: "unknown",
    url: "https://example.com/thank-you",
    httpStatus: 200,
    html: orderHtml({
      title: "Thank you",
      body: `<h1>Thank you</h1><p>We've received your request. We'll be in touch.</p>`,
    }),
  });

  cases.push({
    id: "trap-cloudflare",
    bucket: "trap",
    expect: "unknown",
    url: "https://shop.example.com/thank-you?order_id=ORD-18421",
    httpStatus: 200,
    html: orderHtml({
      title: "Just a moment...",
      body: `<div class="cf-challenge"><p>Checking your browser. Verify you are human.</p></div>`,
    }),
  });

  cases.push({
    id: "trap-empty-spa",
    bucket: "trap",
    expect: "unknown",
    url: "https://shop.example.com/thank-you",
    httpStatus: 200,
    html: orderHtml({
      title: "Checkout",
      body: `<div id="root"></div><p>Enable JavaScript to view this application.</p>`,
    }),
  });

  cases.push({
    id: "trap-order-history-list",
    bucket: "trap",
    expect: "unknown",
    url: "https://shop.example.com/account/orders",
    httpStatus: 200,
    html: orderHtml({
      title: "Your orders",
      body: `<h1>Your orders</h1>
        <ul>
          <li>Order from last week</li>
          <li>Order from last month</li>
        </ul>
        <p>Sign in to view details.</p>`,
    }),
  });

  cases.push({
    id: "trap-tracking-no-id",
    bucket: "trap",
    expect: "unknown",
    url: "https://shop.example.com/track",
    httpStatus: 200,
    html: orderHtml({
      title: "Track a package",
      body: `<h1>Track</h1><p>Enter your email to see shipment status.</p>`,
    }),
  });

  cases.push({
    id: "trap-404",
    bucket: "trap",
    expect: "unknown",
    url: "https://shop.example.com/orders/missing",
    httpStatus: 404,
    html: orderHtml({
      title: "Not Found",
      body: `<h1>Not Found</h1><p>The order does not exist.</p>`,
    }),
  });

  cases.push({
    id: "trap-generic-token-success",
    bucket: "trap",
    expect: "unknown",
    url: "https://shop.example.com/thank-you?order=success",
    httpStatus: 200,
    html: orderHtml({
      title: "Thank you for your order",
      body: `<h1>Thank you for your order</h1><p>Order confirmed.</p>`,
    }),
  });

  cases.push({
    id: "trap-short-id",
    bucket: "trap",
    expect: "unknown",
    url: "https://shop.example.com/thank-you?order_id=AB1",
    httpStatus: 200,
    html: orderHtml({
      title: "Thanks",
      body: `<h1>Thanks for your order</h1><p>Order number: AB1</p>`,
    }),
  });

  cases.push({
    id: "trap-no-digits-token",
    bucket: "trap",
    expect: "unknown",
    url: "https://shop.example.com/thank-you",
    httpStatus: 200,
    html: orderHtml({
      title: "Thanks",
      body: `<h1>Thank you for your order</h1><p>Order number: NEW-ORDER</p>`,
    }),
  });

  cases.push({
    id: "trap-ambiguous-html",
    bucket: "trap",
    expect: "unknown",
    url: "https://example.com/page",
    httpStatus: 200,
    html: orderHtml({ title: "Hello", body: `<p>Hello world.</p>` }),
  });

  cases.push({
    id: "trap-newsletter",
    bucket: "trap",
    expect: "unknown",
    url: "https://shop.example.com/newsletter/thanks",
    httpStatus: 200,
    html: orderHtml({
      title: "Thanks",
      body: `<h1>Thank you</h1><p>Thanks for subscribing.</p>`,
    }),
  });

  cases.push({
    id: "trap-invoice-teaser",
    bucket: "trap",
    expect: "unknown",
    url: "https://shop.example.com/invoice",
    httpStatus: 200,
    html: orderHtml({
      title: "Invoice",
      body: `<p>Download your invoice after you sign in to view your order.</p>`,
    }),
  });

  cases.push({
    id: "trap-account-required",
    bucket: "trap",
    expect: "unknown",
    url: "https://shop.example.com/orders/ORD-18421",
    httpStatus: 200,
    html: orderHtml({
      title: "Create an account",
      body: `<p>Create an account to view this order confirmation.</p>`,
    }),
  });

  cases.push({
    id: "trap-pending-no-id",
    bucket: "trap",
    expect: "unknown",
    url: "https://shop.example.com/checkout/pending",
    httpStatus: 200,
    html: orderHtml({
      title: "Payment pending",
      body: `<h1>Almost done</h1><p>Your order has been placed pending bank confirmation.</p>`,
    }),
  });

  cases.push({
    id: "trap-homepage",
    bucket: "trap",
    expect: "unknown",
    url: "https://shop.example.com/",
    httpStatus: 200,
    html: orderHtml({
      title: "Store",
      body: `<h1>Welcome</h1><p>Thanks for shopping with independent makers.</p>`,
    }),
  });

  return cases;
}

export function benchCaseCounts(cases = orderPlacedBenchCases()): {
  n: number;
  true_placed: number;
  true_failed: number;
  trap: number;
} {
  return {
    n: cases.length,
    true_placed: cases.filter((c) => c.bucket === "true_placed").length,
    true_failed: cases.filter((c) => c.bucket === "true_failed").length,
    trap: cases.filter((c) => c.bucket === "trap").length,
  };
}
