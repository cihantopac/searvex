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
  /**
   * Stable reference of this occurrence, `<ruleId>#<hash of url|file|line>` (the one the HTML report, repair
   * prompts and `searvex review` use). Set on reports written since 1.3.0.
   */
  ref?: string;
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
  /** Impact-based priority (see analyze/priority.ts). */
  priority?: Priority;
  /** URL-pattern templates the affected pages belong to ("fix once" signal). */
  templates?: Array<{ pattern: string; pages: number }>;
  /**
   * Page-structure templates of the affected pages (layout skeleton hash, see PageData.skeleton) with an example
   * URL: finds one template behind unrelated URLs (flat slugs) that URL patterns miss. Since schema 1.1.
   */
  structures?: Array<{ id: string; pages: number; example: string }>;
  /**
   * Pre-launch profile only: `environment` = depends on the test server, `launch-checklist` = a deliberate
   * pre-launch state to change before going live. Either way the finding does not count toward the score,
   * --fail-on or monitor regressions.
   */
  context?: 'environment' | 'launch-checklist';
  /**
   * Every affected URL (website) or file (repository) of this finding, sorted; `evidence` is only a sample of at
   * most 50. `urls` is complete up to 10,000 entries, `truncated` counts the rest; with --compact only `count`
   * is written. robots.txt and llms.txt locations are never listed (those findings are about the site).
   * Since 1.3.0.
   */
  affected?: { count: number; urls?: string[]; truncated?: number };
  /** Stable reference of the finding: its rule id (a report has one finding per rule). Since 1.3.0. */
  ref?: string;
  /**
   * How it gets fixed: `auto` (a concrete Searvex patch exists in the linked repository), `agent` (needs code or
   * content work) or `manual` (server, infrastructure, account or business decision). Since 1.3.0.
   */
  remediation?: 'auto' | 'agent' | 'manual';
}

export interface Priority {
  /** 0–100; higher = fix first. */
  score: number;
  bucket: 'P1' | 'P2' | 'P3';
  /** Importance-weighted share of indexable pages affected (0–1); 1 for site-wide findings. */
  reach: number;
  effort: 'low' | 'medium' | 'high';
  reasons: string[];
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
  /** Time to response headers of the final request (server responsiveness). */
  ttfbMs?: number;
  contentType: string;
  error?: string;
}
