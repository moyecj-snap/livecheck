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
