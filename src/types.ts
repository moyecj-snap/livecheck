export type SourceStatus = "live" | "closed" | "unknown";

export type ConfirmStatus = "confirmed" | "failed" | "unknown";
export type ConfirmIntent = "lead_submit";

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

export type ConfirmEvidence = {
  level: number;
  confirmation_id?: string;
  kind?: string;
};

export type ConfirmVerdict = {
  url: string;
  canonical_url: string;
  status: ConfirmStatus;
  intent: ConfirmIntent;
  http_status: number;
  checked_at: string;
  title?: string;
  signals: string[];
  confidence: number;
  price_usd: number;
  evidence: ConfirmEvidence;
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
