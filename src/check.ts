import { createHash } from "node:crypto";
import { CHECK_PRICE_USD } from "./config.js";
import { classify } from "./classify.js";
import {
  compareNumeric,
  extractJsonPath,
  jsonPathToNumber,
  NUMERIC_OPS,
  pickAmount,
  type NumericOp,
} from "./numeric.js";
import { DEFAULT_MIN_CHANGE_RATIO, normalizeForTextDiff, textDiffConfidence, textDiffFired, textDiffHash } from "./text-diff.js";
import type {
  CheckCondition,
  CheckObservation,
  CheckTarget,
  HttpClass,
  KeywordParams,
  NumericThresholdParams,
  SourceStatus,
  TextDiffParams,
} from "./types.js";
import { VerifyError, fetchPage, parseTargetUrl, verifyUrl } from "./verify.js";

export const CHECK_INTENT = "check" as const;
export const PHASE1_DETECTORS = ["status_change", "keyword"] as const;
export const CHECK_DETECTORS = ["status_change", "keyword", "text_diff", "numeric_threshold"] as const;
export const BASELINE_HASH_RE = /^[a-f0-9]{64}$/i;

export type CheckErrorCode = "invalid_target" | "invalid_condition" | "baseline_unreachable";

export class CheckError extends Error {
  readonly code: CheckErrorCode;
  readonly status: number;

  constructor(code: CheckErrorCode, message: string, status: 400 | 422) {
    super(message);
    this.name = "CheckError";
    this.code = code;
    this.status = status;
  }
}

export type ParsedCheckRequest = {
  target: CheckTarget;
  condition: CheckCondition;
  baseline_hash: string | null;
  baseline_text?: string | null;
  baseline_value?: number | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new CheckError("invalid_condition", `condition.params.${field} must be an array of strings.`, 400);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function optionalSelector(value: unknown, where: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new CheckError("invalid_target", `${where} must be a string or null.`, 400);
  }
  const trimmed = value.trim();
  return trimmed || null;
}

export function httpClassOf(status: number): HttpClass {
  if (status >= 100 && status < 200) return "1xx";
  if (status >= 200 && status < 300) return "2xx";
  if (status >= 300 && status < 400) return "3xx";
  if (status >= 400 && status < 500) return "4xx";
  if (status >= 500 && status < 600) return "5xx";
  return "other";
}

/** Fingerprint of status + HTTP class. Clients store this as baseline_hash. */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

export function observationHash(status: SourceStatus, httpClass: HttpClass): string {
  return createHash("sha256").update(stableJson({ status, http_class: httpClass }), "utf8").digest("hex");
}

export function observationSummary(
  status: SourceStatus,
  httpClass: HttpClass,
  httpStatus: number,
  signals: string[],
): string {
  const signalBit = signals.length ? `; ${signals.slice(0, 3).join(", ")}` : "";
  return `${status} ${httpClass} (${httpStatus})${signalBit}`;
}

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Phase 1 HTML-only selector. Supports tag, #id, .class, tag#id, tag.class.
 * No Playwright. Unrecognized selectors yield an empty haystack.
 */
export function extractBySelector(html: string, selector: string): string {
  const sel = selector.trim();
  if (!sel) return "";
  const parsed = sel.match(/^([a-zA-Z][a-zA-Z0-9]*)?(?:#([a-zA-Z0-9_-]+)|\.([a-zA-Z0-9_-]+))?$/);
  if (!parsed || (!parsed[1] && !parsed[2] && !parsed[3])) return "";
  const tag = parsed[1] ?? "[a-zA-Z][a-zA-Z0-9]*";
  const id = parsed[2];
  const className = parsed[3];
  const tagRe = new RegExp(`<(${tag})(\\s[^>]*)?>([\\s\\S]*?)</\\1>`, "gi");
  const parts: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(html))) {
    const attrs = match[2] ?? "";
    if (id && !new RegExp(`\\sid=["']${escapeRegExp(id)}["']`, "i").test(attrs)) continue;
    if (className && !new RegExp(`\\sclass=["'][^"']*\\b${escapeRegExp(className)}\\b`, "i").test(attrs)) {
      continue;
    }
    parts.push(match[3]);
  }
  return stripTags(parts.join(" "));
}

export function keywordPresenceMatches(haystack: string, params: KeywordParams): boolean {
  const text = params.case_sensitive ? haystack : haystack.toLowerCase();
  const norm = (kw: string) => (params.case_sensitive ? kw : kw.toLowerCase());
  const has = (kw: string) => text.includes(norm(kw));
  const anyOk = params.any.length === 0 || params.any.some(has);
  const allOk = params.all.every(has);
  const noneOk = params.none.every((kw) => !has(kw));
  return anyOk && allOk && noneOk;
}

export function parseBaselineHash(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string" || !BASELINE_HASH_RE.test(raw.trim())) {
    throw new CheckError("baseline_unreachable", "baseline_hash must be a SHA-256 hex digest.", 422);
  }
  return raw.trim().toLowerCase();
}

export function parseCheckTarget(raw: unknown): CheckTarget {
  if (!isRecord(raw)) {
    throw new CheckError("invalid_target", "target must be { type: \"url\", url, render?, selector? }.", 400);
  }
  if (raw.type !== "url") {
    throw new CheckError("invalid_target", 'target.type must be "url".', 400);
  }
  const render = raw.render === undefined ? "never" : raw.render;
  if (render !== "never") {
    throw new CheckError("invalid_target", 'Phase 1 only accepts target.render "never" (HTML, no Playwright).', 400);
  }
  let url: string;
  try {
    url = parseTargetUrl(raw.url);
  } catch (error) {
    const message = error instanceof VerifyError ? error.message : "url must be an absolute http(s) URL.";
    throw new CheckError("invalid_target", message, 400);
  }
  let selector: string | null;
  try {
    selector = optionalSelector(raw.selector, "target.selector");
  } catch (error) {
    if (error instanceof CheckError && error.code === "invalid_target") throw error;
    throw new CheckError("invalid_target", "target.selector must be a string or null.", 400);
  }
  return { type: "url", url, render: "never", selector };
}

function optionalParamSelector(params: Record<string, unknown>): string | null {
  if (params.selector === undefined || params.selector === null) return null;
  if (typeof params.selector !== "string") {
    throw new CheckError("invalid_condition", "condition.params.selector must be a string or null.", 400);
  }
  return params.selector.trim() || null;
}

function parseIgnoreRegexes(value: unknown): string[] {
  const patterns = stringArray(value, "ignore");
  for (const pattern of patterns) {
    try {
      new RegExp(pattern, "gi");
    } catch {
      throw new CheckError("invalid_condition", `condition.params.ignore has an invalid regex: ${pattern}`, 400);
    }
  }
  return patterns;
}

function parseTextDiffParams(params: Record<string, unknown>): TextDiffParams {
  const selector = optionalParamSelector(params);
  const ignore = params.ignore === undefined ? [] : parseIgnoreRegexes(params.ignore);
  let min_change_ratio = DEFAULT_MIN_CHANGE_RATIO;
  if (params.min_change_ratio !== undefined && params.min_change_ratio !== null) {
    if (typeof params.min_change_ratio !== "number" || !Number.isFinite(params.min_change_ratio)) {
      throw new CheckError("invalid_condition", "condition.params.min_change_ratio must be a number.", 400);
    }
    if (params.min_change_ratio < 0 || params.min_change_ratio > 1) {
      throw new CheckError("invalid_condition", "condition.params.min_change_ratio must be between 0 and 1.", 400);
    }
    min_change_ratio = params.min_change_ratio;
  }
  return { selector, ignore, min_change_ratio };
}

function parseNumericThresholdParams(params: Record<string, unknown>): NumericThresholdParams {
  const selector = optionalParamSelector(params);
  let jsonpath: string | null = null;
  if (params.jsonpath !== undefined && params.jsonpath !== null) {
    if (typeof params.jsonpath !== "string") {
      throw new CheckError("invalid_condition", "condition.params.jsonpath must be a string or null.", 400);
    }
    jsonpath = params.jsonpath.trim() || null;
  }
  if (!selector && !jsonpath) {
    throw new CheckError(
      "invalid_condition",
      "numeric_threshold requires condition.params.selector or condition.params.jsonpath.",
      400,
    );
  }
  const op = params.op;
  if (typeof op !== "string" || !NUMERIC_OPS.includes(op as NumericOp)) {
    throw new CheckError(
      "invalid_condition",
      'condition.params.op must be "lt", "lte", "gt", "gte", "eq", or "change_pct".',
      400,
    );
  }
  if (typeof params.value !== "number" || !Number.isFinite(params.value)) {
    throw new CheckError("invalid_condition", "condition.params.value must be a finite number.", 400);
  }
  let currency: string | null = null;
  if (params.currency !== undefined && params.currency !== null) {
    if (typeof params.currency !== "string") {
      throw new CheckError("invalid_condition", "condition.params.currency must be a string or null.", 400);
    }
    currency = params.currency.trim() || null;
  }
  let baseline_value: number | null = null;
  if (params.baseline_value !== undefined && params.baseline_value !== null) {
    if (typeof params.baseline_value !== "number" || !Number.isFinite(params.baseline_value)) {
      throw new CheckError("invalid_condition", "condition.params.baseline_value must be a finite number.", 400);
    }
    baseline_value = params.baseline_value;
  }
  return { selector, jsonpath, op: op as NumericOp, value: params.value, currency, baseline_value };
}

export function parseCheckCondition(raw: unknown): CheckCondition {
  if (!isRecord(raw)) {
    throw new CheckError("invalid_condition", "condition must be { detector, params? }.", 400);
  }
  const detector = raw.detector;
  if (
    detector !== "status_change" &&
    detector !== "keyword" &&
    detector !== "text_diff" &&
    detector !== "numeric_threshold"
  ) {
    throw new CheckError(
      "invalid_condition",
      'condition.detector must be "status_change", "keyword", "text_diff", or "numeric_threshold".',
      400,
    );
  }
  if (raw.params !== undefined && !isRecord(raw.params)) {
    throw new CheckError("invalid_condition", "condition.params must be an object.", 400);
  }
  const params = raw.params ?? {};
  if (detector === "status_change") {
    return { detector: "status_change", params: {} };
  }
  if (detector === "text_diff") {
    return { detector: "text_diff", params: parseTextDiffParams(params) };
  }
  if (detector === "numeric_threshold") {
    return { detector: "numeric_threshold", params: parseNumericThresholdParams(params) };
  }
  const any = stringArray(params.any, "any");
  const all = stringArray(params.all, "all");
  const none = stringArray(params.none, "none");
  if (any.length + all.length + none.length === 0) {
    throw new CheckError(
      "invalid_condition",
      "keyword detector requires a non-empty any, all, or none array.",
      400,
    );
  }
  if (params.case_sensitive !== undefined && typeof params.case_sensitive !== "boolean") {
    throw new CheckError("invalid_condition", "condition.params.case_sensitive must be a boolean.", 400);
  }
  return {
    detector: "keyword",
    params: {
      any,
      all,
      none,
      selector: optionalParamSelector(params),
      case_sensitive: params.case_sensitive === true,
    },
  };
}

export function parseCheckRequest(body: unknown): ParsedCheckRequest {
  if (!isRecord(body)) {
    throw new CheckError("invalid_target", "JSON body must be an object.", 400);
  }
  const target = parseCheckTarget(body.target);
  const condition = parseCheckCondition(body.condition);
  const baseline_hash = parseBaselineHash(body.baseline_hash);
  let baseline_text: string | null = null;
  if (body.baseline_text !== undefined && body.baseline_text !== null) {
    if (typeof body.baseline_text !== "string") {
      throw new CheckError("invalid_condition", "baseline_text must be a string.", 400);
    }
    baseline_text = body.baseline_text;
  }
  let baseline_value: number | null = null;
  if (body.baseline_value !== undefined && body.baseline_value !== null) {
    if (typeof body.baseline_value !== "number" || !Number.isFinite(body.baseline_value)) {
      throw new CheckError("invalid_condition", "baseline_value must be a finite number.", 400);
    }
    baseline_value = body.baseline_value;
  }
  return { target, condition, baseline_hash, baseline_text, baseline_value };
}

function asObservation(
  status: SourceStatus,
  httpStatus: number,
  signals: string[],
  checkedAt: string,
  canonicalUrl: string,
  title?: string,
): CheckObservation {
  const http_class = httpClassOf(httpStatus);
  return {
    status,
    signals,
    http_status: httpStatus,
    http_class,
    hash: observationHash(status, http_class),
    summary: observationSummary(status, http_class, httpStatus, signals),
    checked_at: checkedAt,
    canonical_url: canonicalUrl,
    ...(title ? { title } : {}),
  };
}

export function classifyKeywordFired(haystack: string, params: KeywordParams): boolean {
  return keywordPresenceMatches(haystack, params);
}

function contentObservation(
  status: SourceStatus,
  httpStatus: number,
  signals: string[],
  checkedAt: string,
  canonicalUrl: string,
  hash: string,
  summary: string,
  title?: string,
): CheckObservation {
  const http_class = httpClassOf(httpStatus);
  return {
    status,
    signals,
    http_status: httpStatus,
    http_class,
    hash,
    summary,
    checked_at: checkedAt,
    canonical_url: canonicalUrl,
    ...(title ? { title } : {}),
  };
}

function numericObservationHash(value: number, currency: string | null): string {
  return createHash("sha256")
    .update(JSON.stringify({ detector: "numeric_threshold", value, currency }), "utf8")
    .digest("hex");
}

export async function runCheck(
  parsed: ParsedCheckRequest,
  fetcher: typeof fetch = fetch,
  now = new Date(),
): Promise<{
  target: CheckTarget;
  condition: CheckCondition;
  observation: CheckObservation;
  fired: boolean | null;
  confidence: number;
  price_usd: number;
  content?: string;
}> {
  const { target, condition, baseline_hash } = parsed;
  try {
    if (condition.detector === "status_change") {
      const verdict = await verifyUrl(target.url, fetcher, now);
      const observation = asObservation(
        verdict.status,
        verdict.http_status,
        verdict.signals,
        verdict.checked_at,
        verdict.canonical_url,
        verdict.title,
      );
      const fired = baseline_hash ? observation.hash !== baseline_hash : null;
      return {
        target,
        condition,
        observation,
        fired,
        confidence: verdict.confidence,
        price_usd: CHECK_PRICE_USD,
      };
    }

    const page = await fetchPage(target.url, fetcher);
    const verdict = classify(page, now);

    if (condition.detector === "text_diff") {
      const selector = condition.params.selector ?? target.selector;
      const extracted = selector ? extractBySelector(page.html, selector) : page.text;
      const normalized = normalizeForTextDiff(extracted, condition.params.ignore);
      const hash = textDiffHash(normalized);
      const fired = textDiffFired({
        currentNormalized: normalized,
        currentHash: hash,
        baselineHash: baseline_hash,
        baselineText: parsed.baseline_text,
        minChangeRatio: condition.params.min_change_ratio,
      });
      const observation = contentObservation(
        verdict.status,
        verdict.http_status,
        [...verdict.signals, selector ? "text_diff:selector" : "text_diff:full_page"],
        verdict.checked_at,
        verdict.canonical_url,
        hash,
        `${verdict.status} text_diff chars=${normalized.length}`,
        verdict.title,
      );
      return {
        target,
        condition,
        observation,
        fired,
        confidence: textDiffConfidence(Boolean(selector)),
        price_usd: CHECK_PRICE_USD,
        content: normalized,
      };
    }

    if (condition.detector === "numeric_threshold") {
      const selector = condition.params.selector ?? target.selector;
      let current: number | null = null;
      if (condition.params.jsonpath) {
        current = jsonPathToNumber(extractJsonPath(page.html, condition.params.jsonpath), condition.params.currency);
      }
      if (current == null) {
        const haystack = selector ? extractBySelector(page.html, selector) : page.text;
        current = pickAmount(haystack, condition.params.currency);
      }
      if (current == null) {
        throw new CheckError("baseline_unreachable", "numeric_threshold could not parse a number from the target.", 422);
      }
      const previous = parsed.baseline_value ?? condition.params.baseline_value ?? null;
      const fired =
        condition.params.op === "change_pct" && previous == null
          ? null
          : compareNumeric(condition.params.op, current, condition.params.value, previous);
      const hash = numericObservationHash(current, condition.params.currency);
      const observation = contentObservation(
        verdict.status,
        verdict.http_status,
        [...verdict.signals, `numeric:${current}`, `numeric_op:${condition.params.op}`],
        verdict.checked_at,
        verdict.canonical_url,
        hash,
        `numeric ${current}${condition.params.currency ? ` ${condition.params.currency}` : ""}`,
        verdict.title,
      );
      return {
        target,
        condition,
        observation,
        fired,
        confidence: 0.88,
        price_usd: CHECK_PRICE_USD,
        content: String(current),
      };
    }

    const observation = asObservation(
      verdict.status,
      verdict.http_status,
      verdict.signals,
      verdict.checked_at,
      verdict.canonical_url,
      verdict.title,
    );
    const selector = condition.params.selector ?? target.selector;
    const haystack = selector ? extractBySelector(page.html, selector) : page.text;
    const fired = classifyKeywordFired(haystack, condition.params);
    return {
      target,
      condition,
      observation,
      fired,
      confidence: 0.85,
      price_usd: CHECK_PRICE_USD,
    };
  } catch (error) {
    if (error instanceof CheckError) throw error;
    if (error instanceof VerifyError && (error.status === 502 || error.status === 504)) {
      throw new CheckError("baseline_unreachable", error.message, 422);
    }
    throw error;
  }
}
