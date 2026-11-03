import type { PageData } from '../extract/html.js';
import type { FindingSink } from '../rules/engine.js';

/**
 * Google rich-result requirements, transcribed from the "Required properties" tables of the
 * official feature docs (verified 2026-10-30, see docs/research/official-sources-2026-10.md).
 * `anyOf` groups mean at least one property of the group is required.
 * Only types with documented required properties are listed; Article and Organization have none.
 */
interface Requirement {
  docs: string;
  all: string[];
  anyOf?: string[][];
}

const BASE = 'https://developers.google.com/search/docs/appearance/structured-data/';

export const RICH_RESULT_REQUIREMENTS: Record<string, Requirement> = {
  Product: { docs: BASE + 'product-snippet', all: ['name'], anyOf: [['review', 'aggregateRating', 'offers']] },
  BreadcrumbList: { docs: BASE + 'breadcrumb', all: ['itemListElement'] },
  LocalBusiness: { docs: BASE + 'local-business', all: ['name', 'address'] },
  Event: { docs: BASE + 'event', all: ['name', 'startDate', 'location'] },
  Recipe: { docs: BASE + 'recipe', all: ['name', 'image'] },
  JobPosting: { docs: BASE + 'job-posting', all: ['datePosted', 'description', 'hiringOrganization', 'title'] },
  VideoObject: { docs: BASE + 'video', all: ['name', 'thumbnailUrl', 'uploadDate'] },
  Review: { docs: BASE + 'review-snippet', all: ['author', 'itemReviewed', 'reviewRating'] },
};

/** Common schema.org LocalBusiness subtypes treated as LocalBusiness. */
const LOCAL_BUSINESS_SUBTYPES = new Set([
  'LocalBusiness', 'Restaurant', 'Store', 'Dentist', 'Physician', 'MedicalClinic', 'Hotel', 'LodgingBusiness', 'AutoRepair',
  'BeautySalon', 'HairSalon', 'CafeOrCoffeeShop', 'Bakery', 'BarOrPub', 'FoodEstablishment', 'LegalService', 'Attorney',
  'RealEstateAgent', 'HomeAndConstructionBusiness', 'Electrician', 'Plumber', 'HealthAndBeautyBusiness', 'SportsActivityLocation',
  'ProfessionalService', 'FinancialService', 'AutomotiveBusiness', 'ChildCare', 'TravelAgency',
]);

/** Types whose Google rich result has been retired (see knowledge rule sd.retired-type). */
export const RETIRED_TYPES = new Set(['HowTo', 'FAQPage', 'ClaimReview', 'SpecialAnnouncement', 'Vehicle', 'Car', 'CourseInstance', 'EstimatedSalary', 'MathSolver']);

type Node = Record<string, unknown>;

function typesOf(n: Node): string[] {
  const t = n['@type'];
  return typeof t === 'string' ? [t] : Array.isArray(t) ? t.filter((x): x is string => typeof x === 'string') : [];
}

function hasValue(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/** Walk JSON-LD (including @graph and nested objects) and yield every typed node. */
export function* typedNodes(data: unknown, depth = 0): Generator<Node> {
  if (depth > 15 || data === null || typeof data !== 'object') return;
  if (Array.isArray(data)) {
    for (const d of data) yield* typedNodes(d, depth + 1);
    return;
  }
  const n = data as Node;
  if (typesOf(n).length) yield n;
  for (const [k, v] of Object.entries(n)) if (k !== '@context' && typeof v === 'object') yield* typedNodes(v, depth + 1);
}

export interface SdIssue {
  type: string;
  missing: string[];
  docs: string;
}

export function validateNode(n: Node): SdIssue | null {
  for (const t of typesOf(n)) {
    const key = LOCAL_BUSINESS_SUBTYPES.has(t) ? 'LocalBusiness' : t;
    const req = RICH_RESULT_REQUIREMENTS[key];
    if (!req) continue;
    const missing = req.all.filter((p) => !hasValue(n[p]));
    for (const group of req.anyOf ?? []) if (!group.some((p) => hasValue(n[p]))) missing.push(group.join(' | '));
    // JobPosting: jobLocation required unless fully remote (jobLocationType TELECOMMUTE).
    if (key === 'JobPosting' && !hasValue(n['jobLocation']) && n['jobLocationType'] !== 'TELECOMMUTE') missing.push('jobLocation');
    // Review nested inside a Product is validated by the parent; only check standalone reviews.
    if (missing.length) return { type: t, missing, docs: req.docs };
  }
  return null;
}

/** Paths that indicate a business site (products, plans, a shop). */
const COMMERCIAL_PATH = /\/(pricing|prices|plans|products?|shop|store|cart|checkout|buy|fiyat(lar)?|urun(ler)?|magaza|sepet)(\/|$|\.)/i;
const ORG_WORDS = /\b(inc|ltd|llc|gmbh|corp|co|company|studio|studios|agency|labs?|group|team|solutions|software|technologies|a\.?ş|ltd\.?\s*şti)\b\.?/i;

/**
 * Heuristic personal-site signal for the Organization-or-Person suggestion: the homepage title starts with a
 * name-like phrase (2–3 capitalised words, no company words) and no page looks commercial.
 */
export function personalSiteSignal(homepageTitle: string | null | undefined, pageUrls: string[]): { personal: boolean; reason: string } {
  const name = (homepageTitle ?? '').split(/\s+[|·•—–:-]\s+/)[0]!.trim();
  const word = "\\p{Lu}\\p{Ll}+(?:[-'’]\\p{Lu}?\\p{Ll}+)*\\.?";
  const nameLike = new RegExp(`^${word}(?:\\s${word}){1,2}$`, 'u').test(name) && !ORG_WORDS.test(name);
  const commercial = pageUrls.find((u) => {
    try {
      return COMMERCIAL_PATH.test(new URL(u).pathname);
    } catch {
      return false;
    }
  });
  if (!nameLike) return { personal: false, reason: 'homepage title does not start with a personal name' };
  if (commercial) return { personal: false, reason: `commercial page ${commercial}` };
  return { personal: true, reason: `homepage title starts with a name ("${name}") and no product, pricing or shop pages` };
}

function organizationMissing(url: string, observed: string, sink: FindingSink, signal?: { personal: boolean; reason: string }): void {
  if (signal?.personal) {
    sink.emit('geo.organization-missing', { url, observed: `${observed} — looks like a personal site (heuristic: ${signal.reason}): add ProfilePage with a Person mainEntity` }, {
      message: 'The homepage has no Person / ProfilePage markup, and the site looks personal (heuristic). Google uses ProfilePage structured data for a page about a single person; Organization markup applies when the site represents a company or brand.',
    });
  } else {
    sink.emit('geo.organization-missing', { url, observed: `${observed} — add Organization (company or brand) or ProfilePage with a Person mainEntity (personal site)` });
  }
}

export function checkStructuredData(url: string, f: PageData, sink: FindingSink, isHomepage: boolean, signal?: { personal: boolean; reason: string }): void {
  if (!f.jsonLd.length && !f.microdataTypes.length) {
    sink.emit('sd.none', { url });
    if (isHomepage) organizationMissing(url, 'no structured data on homepage', sink, signal);
    return;
  }
  const allTypes = new Set<string>(f.microdataTypes);
  for (const block of f.jsonLd) {
    if (block.error) {
      sink.emit('sd.invalid-json', { url, observed: block.error });
      continue;
    }
    const roots = Array.isArray(block.data) ? block.data : [block.data];
    for (const r of roots) {
      if (r && typeof r === 'object' && !('@context' in (r as Node)) && !(block.raw.includes('@context'))) {
        sink.emit('sd.missing-context', { url, observed: block.raw.slice(0, 120) });
      }
    }
    for (const node of typedNodes(block.data)) {
      for (const t of typesOf(node)) allTypes.add(t);
      // Reviews embedded in a Product inherit itemReviewed from the parent.
      if (typesOf(node).includes('Review') && !node['itemReviewed']) continue;
      const issue = validateNode(node);
      if (issue) sink.emit('sd.missing-required', { url, observed: `${issue.type}: missing ${issue.missing.join(', ')}`, expected: issue.docs });
    }
  }
  for (const t of allTypes) if (RETIRED_TYPES.has(t)) sink.emit('sd.retired-type', { url, observed: t });
  // A personal site describes a Person (often on a ProfilePage); Organization markup does not apply there.
  const personal = allTypes.has('Person') || allTypes.has('ProfilePage');
  if (isHomepage && !personal && !['Organization', 'Corporation', 'OnlineStore', 'OnlineBusiness', 'NGO', 'EducationalOrganization', 'GovernmentOrganization', ...LOCAL_BUSINESS_SUBTYPES].some((t) => allTypes.has(t))) {
    organizationMissing(url, `types present: ${[...allTypes].join(', ') || 'none'}`, sink, signal);
  }
}
