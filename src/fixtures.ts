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
};

export const FIXTURE_LIST = Object.values(FIXTURES);
