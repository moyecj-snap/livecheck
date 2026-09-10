/**
 * Noise stripped from page text before text_diff hashing / ratio.
 * Applied first, then any caller `ignore` regexes.
 */
export const IGNORE_BY_DEFAULT: readonly RegExp[] = [
  // ISO-8601 / RFC-3339 timestamps
  /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?/g,
  // Common date stamps
  /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4}\b/gi,
  /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g,
  /\b\d{4}-\d{2}-\d{2}\b/g,
  // Relative clocks
  /\b\d+\s+(?:second|minute|hour|day|week|month|year)s?\s+ago\b/gi,
  /\b(?:posted|updated|published)\s+\d+\s+\w+\s+ago\b/gi,
  /\b(?:last\s+updated|as\s+of)\s*:?\s+[^\n<]{0,40}/gi,
  // Viewers / sold counters
  /\b\d[\d,]*\s+(?:view(?:er|ing|s)?|watching|watchers|sold|bought|purchased)\b/gi,
  /\b(?:view(?:er|ing|s)?|watching|watchers|sold)\s*:?\s*\d[\d,]*\b/gi,
  // Session identifiers
  /\b(?:session[_-]?id|sid|jsessionid|phpsessid)\s*[=:]\s*[a-zA-Z0-9._-]+\b/gi,
  /\b(?:connect\.sid|sessionid)=[a-zA-Z0-9._%-]+\b/gi,
  // CSRF / authenticity tokens
  /\b(?:csrf(?:[_-]?token)?|authenticity_token|__requestverificationtoken)\s*[=:"']+\s*[a-zA-Z0-9/_+=.-]+\b/gi,
  /<input[^>]*(?:csrf|authenticity_token|__requestverificationtoken)[^>]*>/gi,
  // Ad slots
  /<ins\b[^>]*>[\s\S]*?<\/ins>/gi,
  /\b(?:google_ads|adsbygoogle|ad-slot|data-ad-slot|doubleclick|gpt-ad)[^\s<]*/gi,
  // Cookie banners
  /\b(?:we use cookies|this site uses cookies|cookie (?:banner|consent|policy|settings)|accept (?:all )?cookies|manage (?:all )?cookies|reject (?:all )?cookies)\b[^.<\n]{0,200}/gi,
];

export function compileIgnorePatterns(patterns: string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const raw of patterns) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    try {
      out.push(new RegExp(trimmed, "gi"));
    } catch {
      // invalid caller regex — skip; parsers already 400 on compile failure when validating
    }
  }
  return out;
}

export function applyIgnorePatterns(text: string, extra: readonly RegExp[] = []): string {
  let next = text;
  for (const pattern of IGNORE_BY_DEFAULT) {
    next = next.replace(pattern, " ");
  }
  for (const pattern of extra) {
    next = next.replace(pattern, " ");
  }
  return next.replace(/\s+/g, " ").trim();
}

export function compileAndApplyIgnore(text: string, extraPatterns: string[] = []): string {
  return applyIgnorePatterns(text, compileIgnorePatterns(extraPatterns));
}
