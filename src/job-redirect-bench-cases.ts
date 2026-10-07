import { FIXTURES } from "./fixtures.js";

export type JobBenchExpect = "live" | "closed" | "unknown";

export type JobBenchBucket = "search_to_job" | "job_to_board" | "job_page" | "search_page";

export type JobBenchCase = {
  id: string;
  bucket: JobBenchBucket;
  expect: JobBenchExpect;
  requestedUrl: string;
  canonicalUrl: string;
  redirected: boolean;
  httpStatus: number;
  html: string;
  /** Where a real fetch landed, when this case is a recorded redirect. */
  redirect_to?: string;
};

/**
 * Recorded 2026-10-07.
 * Live: https://stripe.com/jobs/search?gh_jid=8172508
 *   → https://stripe.com/careers/listing/abuse-investigator/8172508?gh_jid=8172508
 * Closed: https://stripe.com/jobs/search?gh_jid=1
 *   → https://stripe.com/careers/search?gh_jid=1
 *   (HTTP 200 careers search, not a listing)
 */
export const STRIPE_LIVE_SEARCH_URL = "https://stripe.com/jobs/search?gh_jid=8172508";
export const STRIPE_LIVE_LISTING_URL =
  "https://stripe.com/careers/listing/abuse-investigator/8172508?gh_jid=8172508";
export const STRIPE_CLOSED_SEARCH_URL = "https://stripe.com/jobs/search?gh_jid=1";
export const STRIPE_CLOSED_REDIRECT_URL = "https://stripe.com/careers/search?gh_jid=1";

const STRIPE_LISTING_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>Stripe Careers | Abuse Investigator</title></head>
<body>
  <h1>Abuse Investigator</h1>
  <p>Who we are About Stripe</p>
  <a class="hds-button careers-listing-details__apply-button hds-button--primary" href="/careers/apply/abuse-investigator/8172508">Apply now</a>
</body>
</html>`;

const STRIPE_SEARCH_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>Stripe Careers | Open Roles</title></head>
<body>
  <h1>Open roles</h1>
  <div class="job-card">AEO and GEO Marketing Manager</div>
  <div class="job-card">AI Engineer Solutions Architect</div>
  <div class="job-card">AI Solutions Program Manager</div>
  <a href="/careers/listing/aeo-and-geo-marketing-manager/1">Apply now</a>
</body>
</html>`;

export function jobRedirectBenchCases(): JobBenchCase[] {
  return [
    {
      id: "stripe-search-redirects-to-listing",
      bucket: "search_to_job",
      expect: "live",
      requestedUrl: STRIPE_LIVE_SEARCH_URL,
      canonicalUrl: STRIPE_LIVE_LISTING_URL,
      redirected: true,
      httpStatus: 200,
      html: STRIPE_LISTING_HTML,
      redirect_to: STRIPE_LIVE_LISTING_URL,
    },
    {
      id: "stripe-careers-listing-is-a-job-page",
      bucket: "job_page",
      expect: "live",
      requestedUrl: "https://stripe.com/careers/listing/abuse-investigator/8172508",
      canonicalUrl: "https://stripe.com/careers/listing/abuse-investigator/8172508",
      redirected: false,
      httpStatus: 200,
      html: STRIPE_LISTING_HTML,
    },
    {
      id: "stripe-closed-gh-jid-redirects-to-search",
      bucket: "job_to_board",
      expect: "closed",
      requestedUrl: STRIPE_CLOSED_SEARCH_URL,
      canonicalUrl: STRIPE_CLOSED_REDIRECT_URL,
      redirected: true,
      httpStatus: 200,
      html: STRIPE_SEARCH_HTML,
      redirect_to: STRIPE_CLOSED_REDIRECT_URL,
    },
    {
      id: "greenhouse-job-redirects-to-board",
      bucket: "job_to_board",
      expect: "closed",
      requestedUrl: "https://boards.greenhouse.io/acme/jobs/9901",
      canonicalUrl: "https://boards.greenhouse.io/acme",
      redirected: true,
      httpStatus: 200,
      html: FIXTURES["greenhouse-board"].body!,
    },
    {
      id: "job-redirects-to-careers-home",
      bucket: "job_to_board",
      expect: "closed",
      requestedUrl: "https://example.com/jobs/1842",
      canonicalUrl: "https://example.com/careers",
      redirected: true,
      httpStatus: 200,
      html: `<!doctype html><html><head><title>Careers</title></head><body><h1>Careers</h1><p>See open roles.</p><a href="/jobs/1">Apply now</a></body></html>`,
    },
    {
      id: "job-redirects-to-no-longer-available",
      bucket: "job_to_board",
      expect: "closed",
      requestedUrl: "https://jobs.example.com/jobs/7781",
      canonicalUrl: "https://jobs.example.com/jobs/7781/closed",
      redirected: true,
      httpStatus: 200,
      html: `<!doctype html><html><head><title>Job</title></head><body><p>Sorry, this job is no longer available.</p></body></html>`,
    },
    {
      id: "job-redirects-to-unclear-page",
      bucket: "job_to_board",
      expect: "unknown",
      requestedUrl: "https://jobs.example.com/jobs/7782",
      canonicalUrl: "https://jobs.example.com/notice/7782",
      redirected: true,
      httpStatus: 200,
      html: `<!doctype html><html><head><title>Notice</title></head><body><p>Thanks for visiting.</p><a href="/apply">Apply now</a></body></html>`,
    },
    {
      id: "search-query-page-stays-unknown",
      bucket: "search_page",
      expect: "unknown",
      requestedUrl: "https://example.com/search?q=engineer",
      canonicalUrl: "https://example.com/search?q=engineer",
      redirected: false,
      httpStatus: 200,
      html: `<!doctype html><html><head><title>Search</title></head><body><h1>Search results</h1><p>3 jobs</p><a href="/jobs/1">Apply now</a></body></html>`,
    },
  ];
}
