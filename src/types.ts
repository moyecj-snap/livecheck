export type SourceStatus = "live" | "closed" | "unknown";

export type VerifyVerdict = {
  url: string;
  canonical_url: string;
  status: SourceStatus;
  http_status: number;
  checked_at: string;
  title?: string;
  signals: string[];
  confidence: number;
  price_usd: number;
};

export type ConfirmVerdictStatus = "confirmed" | "failed" | "unknown";

export type ConfirmIntent = "lead_submit" | "listing_published" | "order_placed";

export type ConfirmEffect = {
  type: ConfirmIntent;
  id?: string;
};

/** v1.0 Confirm evidence scale. lead_submit / listing_published / order_placed confirmed stay L2 (independent id or strong listing signals). */
export type EvidenceLevel = 0 | 1 | 2 | 3 | 4;

export type ConfirmReceipt = {
  hash: string;
  verify_url: string;
  signature?: string;
  signer?: string;
};

export type ConfirmNextStep = {
  action: "human_review";
  endpoint: "/v1/judge";
  est_price_usd: number;
};

export type ConfirmResult = {
  verdict: ConfirmVerdictStatus;
  effect: ConfirmEffect;
  evidence_strength: 1 | 2;
  signals: string[];
  independent_signals: number;
  independent_evidence: boolean;
  evidence_id: string;
  http_status: number;
  fetched_at: string;
  url: string;
  canonical_url: string;
  price_usd: number;
  /** Stable confirm id (`cfm_` + ULID). Present on successful HTTP confirm. */
  id?: string;
  evidence_level: EvidenceLevel;
  /** 0–1. confirmed requires ≥0.90 and evidence_level ≥ 2. */
  confidence: number;
  receipt?: ConfirmReceipt;
  next_step?: ConfirmNextStep;
};

export type CheckDetector = "status_change" | "keyword" | "text_diff" | "numeric_threshold";

export type CheckTarget = {
  type: "url";
  url: string;
  render: "never";
  selector: string | null;
};

export type KeywordParams = {
  any: string[];
  all: string[];
  none: string[];
  selector: string | null;
  case_sensitive: boolean;
};

export type TextDiffParams = {
  selector: string | null;
  ignore: string[];
  min_change_ratio: number;
};

export type NumericOp = "lt" | "lte" | "gt" | "gte" | "eq" | "change_pct";

export type NumericThresholdParams = {
  selector: string | null;
  jsonpath: string | null;
  op: NumericOp;
  value: number;
  currency: string | null;
  baseline_value: number | null;
};

export type CheckCondition =
  | { detector: "status_change"; params: Record<string, never> }
  | { detector: "keyword"; params: KeywordParams }
  | { detector: "text_diff"; params: TextDiffParams }
  | { detector: "numeric_threshold"; params: NumericThresholdParams };

export type HttpClass = "1xx" | "2xx" | "3xx" | "4xx" | "5xx" | "other";

export type CheckObservation = {
  status: SourceStatus;
  signals: string[];
  http_status: number;
  http_class: HttpClass;
  hash: string;
  summary: string;
  checked_at: string;
  canonical_url: string;
  title?: string;
};

export type CheckResult = {
  id: string;
  target: CheckTarget;
  condition: { detector: CheckDetector; params: Record<string, unknown> };
  observation: CheckObservation;
  /** Present when the detector can decide. null when status_change has no baseline_hash. */
  fired: boolean | null;
  confidence: number;
  price_usd: number;
  receipt: ConfirmReceipt;
};

export type WatchStatus = "active" | "stopped" | "expired";

export type WatchBaseline = {
  captured: boolean;
  hash?: string;
  summary?: string;
};

export type WatchCallbackDeliver = "on_change" | "every_check";

export type WatchEventType = "change" | "unreachable" | "recovered" | "expiring" | "expired" | "baseline";

export type WatchObservationSnapshot = {
  hash: string;
  status: SourceStatus;
  http_status: number;
  http_class: HttpClass;
  summary: string;
};

export type WatchCallbackPayload = {
  id: string;
  type: WatchEventType;
  watcher_id: string;
  created_at: string;
  previous: WatchObservationSnapshot | null;
  current: WatchObservationSnapshot | null;
  diff: { fired: boolean | null; changed: string[] };
  confidence: number;
  checks_remaining: number;
  expires_at: string;
  receipt: ConfirmReceipt;
  context: Record<string, unknown> | null;
  chain: { run: "none" };
};

export type WatchCallback = {
  url: string;
  secret: string;
  deliver: WatchCallbackDeliver;
};

export type WatchCreateResult = {
  id: string;
  tier: "standard";
  status: WatchStatus;
  owner_token: string;
  expires_at: string;
  checks_remaining: number;
  interval_s: number;
  first_check_at: string;
  next_check_at: string;
  baseline: WatchBaseline;
  target: CheckTarget;
  condition: { detector: CheckDetector; params: Record<string, unknown> };
  price_usd: number;
  run: "none";
  receipt: ConfirmReceipt;
  label?: string;
};

export type WatchPublicView = {
  id: string;
  tier: "standard";
  status: WatchStatus;
  expires_at: string;
  checks_remaining: number;
  interval_s: number;
  first_check_at: string;
  next_check_at: string;
  baseline: WatchBaseline;
  last_observation: CheckObservation | null;
  target: CheckTarget;
  condition: { detector: CheckDetector; params: Record<string, unknown> };
  price_usd: number;
  run: "none";
  callback: { url: string; deliver: WatchCallbackDeliver };
  label?: string;
};

export type FetchedPage = {
  requestedUrl: string;
  canonicalUrl: string;
  httpStatus: number;
  title: string | null;
  html: string;
  text: string;
  redirected: boolean;
  redirectChain: string[];
};
