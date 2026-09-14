export type BenchBucket = "true_submitted" | "true_failed" | "trap";
export type BenchExpect = "confirmed" | "failed" | "unknown";

export type LeadSubmitBenchCase = {
  id: string;
  bucket: BenchBucket;
  expect: BenchExpect;
  url: string;
  canonicalUrl?: string;
  httpStatus?: number;
  html?: string;
  title?: string;
  cookiesUsed?: boolean;
};

function pageHtml(opts: { title: string; body: string }): string {
  return `<!doctype html><html><head><title>${opts.title}</title></head><body>
  ${opts.body}
  </body></html>`;
}

function thankYouWithId(id: string, label: string): string {
  return pageHtml({
    title: "Thank you",
    body: `<h1>Thank you</h1><p>We've received your request. ${label}: ${id}</p>`,
  });
}

const LABELED_IDS = [
  ["ABC123", "Confirmation number"],
  ["LEAD-1842", "Lead id"],
  ["TKT-99014", "Ticket number"],
  ["REF-44001", "Reference number"],
  ["CNF-88210", "Confirmation id"],
  ["REQ-33018", "Reference id"],
  ["SUB-77102", "Confirmation code"],
  ["A1B2C3D4", "Ticket id"],
  ["WXYZ-10021", "Lead number"],
  ["10421", "Confirmation number"],
  ["882914", "Reference #"],
  ["LEAD10021", "Lead id"],
  ["TKT55019", "Ticket id"],
  ["CONF-22018", "Confirmation code"],
] as const;

const HOSTS = [
  "forms.example.com",
  "northwind.example",
  "harbor.site",
  "lumen.example",
  "oak.example",
  "river.site",
] as const;

export function leadSubmitBenchCases(): LeadSubmitBenchCase[] {
  const cases: LeadSubmitBenchCase[] = [];

  cases.push({
    id: "submitted-fixture-thank-you-id",
    bucket: "true_submitted",
    expect: "confirmed",
    url: "https://example.com/thank-you?ref=ABC123",
    httpStatus: 200,
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>Thank you</title></head>
<body><h1>Thank you</h1><p>We've received your request. Confirmation number: ABC123</p></body></html>`,
  });

  let hostIdx = 0;
  for (const [id, label] of LABELED_IDS) {
    const host = HOSTS[hostIdx % HOSTS.length];
    hostIdx += 1;
    cases.push({
      id: `submitted-label-${id}`,
      bucket: "true_submitted",
      expect: "confirmed",
      url: `https://${host}/thanks`,
      httpStatus: 200,
      html: thankYouWithId(id, label),
    });
  }

  const urlTokenIds = [
    "ABC124",
    "LEAD-20001",
    "TKT-20002",
    "REF-20003",
    "CNF-20004",
    "REQ-20005",
    "A9B8C7D6",
    "WXYZ-20009",
    "882915",
    "LEAD20010",
  ];
  for (const id of urlTokenIds) {
    cases.push({
      id: `submitted-url-${id}`,
      bucket: "true_submitted",
      expect: "confirmed",
      url: `https://forms.example.com/thank-you?ref=${id}`,
      httpStatus: 200,
      html: pageHtml({
        title: "Thank you",
        body: `<h1>Thank you</h1><p>We've received your request. We'll be in touch.</p>`,
      }),
    });
  }

  const pathIds = ["LEAD-30001", "TKT-30002", "REF-30003", "CNF-30004", "882916"];
  for (const id of pathIds) {
    cases.push({
      id: `submitted-path-${id}`,
      bucket: "true_submitted",
      expect: "confirmed",
      url: `https://forms.example.com/confirmation/${id}`,
      httpStatus: 200,
      html: pageHtml({
        title: "Submission received",
        body: `<h1>Submission received</h1><p>Thanks for submitting.</p>`,
      }),
    });
  }

  const failedBanners: Array<[string, string, string]> = [
    ["submission-failed", "Submission failed", "Submission failed. Please try again."],
    ["failed-to-submit", "Error", "Failed to submit your form."],
    ["unable-to-submit", "Unable to submit", "Unable to submit at this time."],
    ["could-not-submit", "Error", "Could not submit your request."],
    ["couldnt-submit", "Error", "Couldn't submit your request."],
    ["could-not-process", "Error", "We could not process your request."],
    ["couldnt-process", "Error", "We couldn't process your request."],
    ["unable-process", "Error", "We were unable to process your form."],
    ["there-was-an-error", "Error", "There was an error submitting this form."],
    ["an-error-occurred", "Error", "An error occurred. Please try again."],
    ["something-went-wrong", "Something went wrong", "Something went wrong. Please try again."],
    ["form-could-not", "Error", "The form could not be submitted."],
    ["invalid-submission", "Invalid", "Invalid submission. Please try again."],
    ["rejected", "Rejected", "Your submission was rejected. Please try again."],
    ["please-try-again", "Error", "Please try again later."],
  ];
  for (const [id, title, body] of failedBanners) {
    cases.push({
      id: `failed-${id}`,
      bucket: "true_failed",
      expect: "failed",
      url: `https://forms.example.com/submit/${id}`,
      httpStatus: 200,
      html: pageHtml({ title, body: `<h1>${title}</h1><p class="error">${body}</p>` }),
    });
  }

  for (const n of ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10"]) {
    cases.push({
      id: `failed-retry-${n}`,
      bucket: "true_failed",
      expect: "failed",
      url: `https://forms.example.com/submit/retry-${n}`,
      httpStatus: 200,
      html: pageHtml({
        title: "Submission failed",
        body: `<h1>Submission failed</h1><p>Your submission was rejected. Attempt ${n}.</p>`,
      }),
    });
  }

  cases.push({
    id: "failed-fixture-error-banner",
    bucket: "true_failed",
    expect: "failed",
    url: "https://example.com/submit",
    httpStatus: 200,
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>Submission failed</title></head>
<body><h1>Something went wrong</h1><p class="error">Your submission was rejected. Please try again.</p></body></html>`,
  });

  const fluffCopy = [
    ["thanks-only", "Thank you", "Thanks for submitting. We'll be in touch."],
    ["weve-received", "Thank you", "We've received your request. A confirmation email is on the way."],
    ["we-have-received", "Thanks", "We have received your request."],
    ["request-received", "Received", "Your request has been received."],
    ["successfully-submitted", "Success", "Successfully submitted. We'll be in touch."],
    ["submission-received", "Received", "Submission received. Thanks for your interest."],
    ["guest-thanks", "Thank you", "Thank you. Create an account next time."],
    ["in-touch", "Thanks", "Thanks for submitting. We'll be in touch shortly."],
  ] as const;
  for (const [id, title, body] of fluffCopy) {
    cases.push({
      id: `trap-fluff-${id}`,
      bucket: "trap",
      expect: "unknown",
      url: `https://forms.example.com/thank-you/${id}`,
      httpStatus: 200,
      html: pageHtml({ title, body: `<h1>${title}</h1><p>${body}</p>` }),
    });
  }

  cases.push({
    id: "trap-fixture-thank-you-only",
    bucket: "trap",
    expect: "unknown",
    url: "https://example.com/thank-you",
    httpStatus: 200,
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>Thank you</title></head>
<body><h1>Thank you</h1><p>Thanks for submitting. We'll be in touch.</p></body></html>`,
  });

  const cookieIds = ["ABC125", "LEAD-40001", "TKT-40002", "REF-40003", "CNF-40004", "882917"];
  for (const id of cookieIds) {
    cases.push({
      id: `trap-cookies-${id}`,
      bucket: "trap",
      expect: "unknown",
      url: `https://forms.example.com/thank-you?ref=${id}`,
      httpStatus: 200,
      html: thankYouWithId(id, "Confirmation number"),
      cookiesUsed: true,
    });
  }

  const otherTraps: Array<[string, string, string, string]> = [
    ["homepage", "https://example.com/", "Home", "Welcome to our site. Contact us anytime."],
    ["loginwall", "https://forms.example.com/thank-you", "Sign in", "Please sign in to view your confirmation."],
    ["empty", "https://forms.example.com/thanks", "Thanks", ""],
    ["generic-success", "https://forms.example.com/success", "Success", "Your action completed successfully."],
    ["no-copy", "https://forms.example.com/form", "Contact", "Fill out the form below."],
    ["careers", "https://example.com/careers", "Careers", "Browse current openings. Apply now."],
  ];
  for (const [id, url, title, body] of otherTraps) {
    cases.push({
      id: `trap-${id}`,
      bucket: "trap",
      expect: "unknown",
      url,
      httpStatus: 200,
      html: pageHtml({ title, body: `<h1>${title}</h1><p>${body}</p>` }),
    });
  }

  return cases;
}

export function benchCaseCounts(cases = leadSubmitBenchCases()): {
  n: number;
  true_submitted: number;
  true_failed: number;
  trap: number;
} {
  return {
    n: cases.length,
    true_submitted: cases.filter((c) => c.bucket === "true_submitted").length,
    true_failed: cases.filter((c) => c.bucket === "true_failed").length,
    trap: cases.filter((c) => c.bucket === "trap").length,
  };
}
