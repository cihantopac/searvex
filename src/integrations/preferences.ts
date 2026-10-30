import fs from 'node:fs';
import path from 'node:path';
import { configDir } from './credentials.js';

/**
 * Per-site choice for optional search data ("Google ile bağlan" / "CSV içe aktar" / "Şimdilik geç"),
 * stored in the user's config directory — never in the repository — so Searvex does not ask again on every
 * run. The user can change it any time with `searvex connect`.
 */
export type SearchDataChoice = 'google' | 'csv' | 'skip';

export interface SitePreference {
  choice: SearchDataChoice;
  property?: string;
  updatedAt: string;
}

const file = () => path.join(configDir(), 'search-data.json');

/** Key by host without `www.`: the choice is about the website, not one URL. */
export function siteKey(urlOrHost: string): string {
  let h = urlOrHost.trim().toLowerCase();
  try {
    h = new URL(/^[a-z]+:\/\//.test(h) ? h : `https://${h}`).hostname;
  } catch {
    /* keep raw */
  }
  return h.replace(/^www\./, '');
}

function readAll(): Record<string, SitePreference> {
  try {
    return JSON.parse(fs.readFileSync(file(), 'utf8')) as Record<string, SitePreference>;
  } catch {
    return {};
  }
}

export function getSitePreference(site: string): SitePreference | null {
  return readAll()[siteKey(site)] ?? null;
}

export function setSitePreference(site: string, pref: Omit<SitePreference, 'updatedAt'>): SitePreference {
  const all = readAll();
  const value = { ...pref, updatedAt: new Date().toISOString() };
  all[siteKey(site)] = value;
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file(), JSON.stringify(all, null, 2), { mode: 0o600 });
  return value;
}
