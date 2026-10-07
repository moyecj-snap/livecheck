/** Hosted confirm example. GET /demo/thank-you?ref=ABC123. No storage. */
export const DEMO_THANK_YOU_PATH = "/demo/thank-you";
export const DEMO_REF_MAX_LENGTH = 64;

const ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeDemoText(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ESCAPE[ch] ?? ch);
}

/** Cap length, then escape. The ref is only echoed in the HTML response. */
export function demoThankYouHtml(ref: string): string {
  const capped = ref.slice(0, DEMO_REF_MAX_LENGTH);
  const safe = escapeDemoText(capped);
  const confirmation = safe
    ? `<p>Confirmation number: ${safe}</p>`
    : `<p>No reference was provided.</p>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Thank you</title>
</head>
<body>
  <h1>Thank you</h1>
  <p>We've received your request.</p>
  ${confirmation}
</body>
</html>
`;
}
