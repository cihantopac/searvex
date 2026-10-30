/**
 * Searvex public API (library usage). The CLI (`searvex`) is a thin layer over these functions.
 */
export { auditWebsite, analyzeCrawl, computeScores, type AuditReport, type AuditOptions } from './analyze/audit.js';
export { crawl, type CrawlOptions, type CrawlResult, type PageRecord } from './crawl/crawler.js';
export { RunStore } from './crawl/store.js';
export { extractPage, type PageData } from './extract/html.js';
export { safeFetch, DEFAULT_USER_AGENT, SEARVEX_VERSION } from './net/fetcher.js';
export { DEFAULT_POLICY, assertUrlAllowed, classifyAddress, type NetPolicy } from './net/ssrf.js';
export { auditRepository } from './repo/audit.js';
export { detect, type Framework } from './repo/detect.js';
export { planFixes, AUTOFIX_RULES, type Fix, type FixPlan, type AgentTask } from './optimize/fixes.js';
export { applyFixes, rollback, listChanges, type Manifest } from './optimize/transaction.js';
export { unifiedDiff } from './optimize/diff.js';
export { loadKnowledge, validateKnowledge, FindingSink, type Rule, type KnowledgeBase } from './rules/engine.js';
export { renderMarkdown } from './report/markdown.js';
export { renderHtml } from './report/html.js';
export { renderSarif } from './report/sarif.js';
export type { Finding, Evidence, Severity, Confidence, Engine, Category, SourceRef } from './core/types.js';
