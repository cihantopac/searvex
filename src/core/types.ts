/**
 * Core domain types shared by every Searvex module.
 *
 * Design rule: every finding must carry evidence and must say how certain it is.
 * "verified" means it was observed directly (HTTP response, parsed HTML, file on disk).
 * "heuristic" means it is an inference from observed data and may be wrong.
 * "unmeasurable" is used when a metric cannot be measured with the data available
 * (for example real AI citations without a platform integration).
 */

export type Engine = 'google' | 'bing' | 'yandex' | 'all' | 'ai';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type Confidence = 'verified' | 'heuristic' | 'unmeasurable';

export type Category =
  | 'crawlability'
  | 'indexability'
  | 'canonicalization'
  | 'international'
  | 'metadata'
  | 'content'
  | 'links'
  | 'structured-data'
  | 'performance'
  | 'mobile'
  | 'accessibility'
  | 'security'
  | 'geo'
  | 'architecture';

export interface SourceRef {
  title: string;
  url: string;
  /** ISO date (YYYY-MM-DD) the source was last checked by a maintainer. */
  checked: string;
  /**
   * How the statement was verified:
   * - fetched: page fetched and statement read directly
   * - excerpt: page not fetchable (client-rendered); statement confirmed from search excerpts
   * - url-resolved: URL confirmed live; statement from maintainer knowledge, pending direct re-read
   */
  level?: 'fetched' | 'excerpt' | 'url-resolved';
}

export interface Evidence {
  url?: string;
  file?: string;
  line?: number;
  /** Short excerpt or observed value. Never contains secrets. */
  observed?: string;
  expected?: string;
}

export interface Finding {
  ruleId: string;
  title: string;
  severity: Severity;
  confidence: Confidence;
  category: Category;
  engines: Engine[];
  message: string;
  evidence: Evidence[];
  /** Short actionable fix. */
  fix?: string;
  /** True when an automated, framework-aware code fix exists. */
  autofixable?: boolean;
}

export interface RedirectHop {
  url: string;
  status: number;
  location?: string;
}

export interface FetchResult {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  headers: Record<string, string>;
  redirects: RedirectHop[];
  body: string;
  bodyBytes: number;
  truncated: boolean;
  timingMs: number;
  contentType: string;
  error?: string;
}
