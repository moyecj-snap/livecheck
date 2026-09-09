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
