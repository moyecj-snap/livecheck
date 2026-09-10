export type NumericOp = "lt" | "lte" | "gt" | "gte" | "eq" | "change_pct";

export const NUMERIC_OPS: readonly NumericOp[] = ["lt", "lte", "gt", "gte", "eq", "change_pct"];

const CURRENCY_ALIASES: Record<string, string> = {
  $: "USD",
  usd: "USD",
  us$: "USD",
  "€": "EUR",
  eur: "EUR",
  "£": "GBP",
  gbp: "GBP",
};

export function normalizeCurrency(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const key = raw.trim();
  if (!key) return null;
  return CURRENCY_ALIASES[key.toLowerCase()] ?? key.toUpperCase();
}

/**
 * Parse loosely formatted money / counts: "$1,299.00", "1 299,00 €", "149".
 */
export function parseLooseNumber(raw: string): number | null {
  if (!raw) return null;
  const text = raw.replace(/\u00a0/g, " ").replace(/[+\u2212]/g, (ch) => (ch === "+" ? "" : "-"));
  const match = text.match(/-?\d(?:[\d\s.,]*\d)?|\d/);
  if (!match) return null;
  let token = match[0].replace(/\s+/g, "");
  const lastComma = token.lastIndexOf(",");
  const lastDot = token.lastIndexOf(".");
  if (lastComma > lastDot) {
    token = token.replace(/\./g, "").replace(",", ".");
  } else if (lastDot > lastComma) {
    token = token.replace(/,/g, "");
  } else if (lastComma >= 0) {
    const after = token.length - lastComma - 1;
    token = after === 3 ? token.replace(/,/g, "") : token.replace(",", ".");
  }
  const n = Number(token);
  return Number.isFinite(n) ? n : null;
}

const AMOUNT_RE =
  /(?:([$€£]|usd|eur|gbp)\s*)?(-?\d(?:[\d\s.,]*\d)?)(?:\s*([$€£]|usd|eur|gbp))?/gi;

export type ParsedAmount = { value: number; currency: string | null; raw: string };

export function extractAmounts(text: string): ParsedAmount[] {
  const out: ParsedAmount[] = [];
  const hay = text.replace(/\u00a0/g, " ");
  let match: RegExpExecArray | null;
  const re = new RegExp(AMOUNT_RE.source, AMOUNT_RE.flags);
  while ((match = re.exec(hay))) {
    const value = parseLooseNumber(match[2] ?? "");
    if (value == null) continue;
    const marker = match[1] || match[3] || null;
    out.push({ value, currency: normalizeCurrency(marker), raw: match[0].trim() });
  }
  return out;
}

export function pickAmount(text: string, currency?: string | null): number | null {
  const wanted = normalizeCurrency(currency);
  const amounts = extractAmounts(text);
  if (amounts.length === 0) return parseLooseNumber(text);
  if (wanted) {
    const hit = amounts.find((item) => item.currency === wanted);
    if (hit) return hit.value;
  }
  return amounts[0]?.value ?? null;
}

function tokenizePath(path: string): Array<string | number> {
  const trimmed = path.trim();
  const body = trimmed.startsWith("$") ? trimmed.slice(1) : trimmed;
  const tokens: Array<string | number> = [];
  const re = /\[(\d+)\]|\['([^']+)'\]|\["([^"]+)"\]|\.([A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body))) {
    if (match[1] != null) tokens.push(Number(match[1]));
    else if (match[2] != null) tokens.push(match[2]);
    else if (match[3] != null) tokens.push(match[3]);
    else if (match[4] != null) tokens.push(match[4]);
    else if (match[5] != null) tokens.push(match[5]);
  }
  return tokens;
}

export function queryJsonPath(data: unknown, path: string): unknown {
  if (!path.trim() || path.trim() === "$") return data;
  let current: unknown = data;
  for (const token of tokenizePath(path)) {
    if (current == null || typeof current !== "object") return undefined;
    if (typeof token === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[token];
    } else {
      current = (current as Record<string, unknown>)[token];
    }
  }
  return current;
}

function parseJsonValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function extractJsonPath(source: string, path: string): unknown {
  const asJson = parseJsonValue(source.trim());
  if (asJson !== undefined) return queryJsonPath(asJson, path);
  const scripts = source.matchAll(/<script\b[^>]*type=["']application\/(?:ld\+)?json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const script of scripts) {
    const parsed = parseJsonValue((script[1] ?? "").trim());
    if (parsed === undefined) continue;
    const hit = queryJsonPath(parsed, path);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

export function jsonPathToNumber(value: unknown, currency?: string | null): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") return pickAmount(value, currency);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of ["price", "amount", "value", "lowPrice", "highPrice"]) {
      const n = jsonPathToNumber(record[key], currency);
      if (n != null) return n;
    }
  }
  return null;
}

export function compareNumeric(op: NumericOp, current: number, threshold: number, previous: number | null): boolean {
  switch (op) {
    case "lt":
      return current < threshold;
    case "lte":
      return current <= threshold;
    case "gt":
      return current > threshold;
    case "gte":
      return current >= threshold;
    case "eq":
      return current === threshold;
    case "change_pct": {
      if (previous == null) return false;
      if (previous === 0) return current !== 0 && threshold <= 100;
      const pct = (Math.abs(current - previous) / Math.abs(previous)) * 100;
      return pct >= threshold;
    }
    default:
      return false;
  }
}

export function numericFromSignals(signals: string[] | undefined): number | null {
  if (!signals) return null;
  for (const signal of signals) {
    const match = /^numeric:(-?\d+(?:\.\d+)?)$/.exec(signal);
    if (match) return Number(match[1]);
  }
  return null;
}
