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

export type ConfirmEffect = {
  type: "lead_submit";
  id?: string;
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
