import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { matchAuditToProperty, parseProperty, selectAuditForProperty, urlInProperty } from '../../src/integrations/property.js';
import { writeAudit } from '../helpers/search-data.js';

describe('search property scope', () => {
  it('domain properties cover every protocol and subdomain, but not look-alike domains', () => {
    const p = parseProperty('sc-domain:Example.com');
    expect(urlInProperty('http://example.com/a', p)).toBe(true);
    expect(urlInProperty('https://shop.example.com/x', p)).toBe(true);
    expect(urlInProperty('https://notexample.com/', p)).toBe(false);
    expect(urlInProperty('https://example.com.evil.io/', p)).toBe(false);
  });

  it('URL-prefix properties are exact about protocol, host (www) and path prefix', () => {
    const p = parseProperty('https://www.example.com/shop/');
    expect(urlInProperty('https://www.example.com/shop/item', p)).toBe(true);
    expect(urlInProperty('http://www.example.com/shop/item', p)).toBe(false);
    expect(urlInProperty('https://example.com/shop/item', p)).toBe(false);
    expect(urlInProperty('https://www.example.com/blog', p)).toBe(false);
    expect(urlInProperty('http://www.example.com/shop/a', parseProperty('https://www.example.com/shop/', { anyProtocol: true }))).toBe(true);
  });

  it('rejects malformed properties', () => {
    expect(() => parseProperty('sc-domain:')).toThrow();
    expect(() => parseProperty('example.com')).toThrow(/sc-domain/);
    expect(() => parseProperty('ftp://example.com/')).toThrow();
  });

  it('matches an audit by the share of crawled pages inside the property (redirected start URLs included)', () => {
    const audit = { target: 'https://example.com', crawl: { startUrl: 'https://example.com' }, inventory: { pages: [{ url: 'https://www.example.com/' }, { url: 'https://www.example.com/a' }] } } as never;
    expect(matchAuditToProperty(audit, parseProperty('https://www.example.com/')).matches).toBe(true);
    expect(matchAuditToProperty(audit, parseProperty('https://example.com/')).matches).toBe(false);
  });
});

describe('selectAuditForProperty (multi-site workspace)', () => {
  let ws: string;
  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'searvex-prop-'));
  });
  afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

  it('"latest" picks the newest audit of the same site, not the newest audit in the workspace', () => {
    writeAudit(ws, 'run-20260101-000000-aaaaaa', 'https://alpha.example/', ['https://alpha.example/', 'https://alpha.example/p']);
    writeAudit(ws, 'run-20260102-000000-bbbbbb', 'https://beta.example/', ['https://beta.example/']);
    writeAudit(ws, 'run-20260103-000000-cccccc', '/repo', [], 'repository');
    expect(selectAuditForProperty(ws, 'latest', parseProperty('sc-domain:alpha.example')).runId).toBe('run-20260101-000000-aaaaaa');
    expect(selectAuditForProperty(ws, 'latest', parseProperty('https://beta.example/')).runId).toBe('run-20260102-000000-bbbbbb');
  });

  it('rejects an explicit audit of another site and explains which audits exist', () => {
    writeAudit(ws, 'run-20260101-000000-aaaaaa', 'https://alpha.example/', ['https://alpha.example/']);
    expect(() => selectAuditForProperty(ws, 'run-20260101-000000-aaaaaa', parseProperty('sc-domain:beta.example'))).toThrow(/does not belong/);
    expect(() => selectAuditForProperty(ws, 'latest', parseProperty('sc-domain:beta.example'))).toThrow(/other sites: run-20260101-000000-aaaaaa \(https:\/\/alpha\.example\/\)/);
    expect(() => selectAuditForProperty(ws, 'missing-run', parseProperty('sc-domain:alpha.example'))).toThrow(/No website audit/);
  });

  it('prefers the apex/www site for a domain property and rejects ambiguous subdomain-only choices', () => {
    writeAudit(ws, 'run-20260101-000000-aaaaaa', 'https://www.alpha.example/', ['https://www.alpha.example/']);
    writeAudit(ws, 'run-20260102-000000-bbbbbb', 'https://blog.alpha.example/', ['https://blog.alpha.example/']);
    expect(selectAuditForProperty(ws, 'latest', parseProperty('sc-domain:alpha.example')).runId).toBe('run-20260101-000000-aaaaaa');
    fs.rmSync(path.join(ws, '.searvex', 'runs', 'run-20260101-000000-aaaaaa'), { recursive: true });
    writeAudit(ws, 'run-20260103-000000-cccccc', 'https://shop.alpha.example/', ['https://shop.alpha.example/']);
    expect(() => selectAuditForProperty(ws, 'latest', parseProperty('sc-domain:alpha.example'))).toThrow(/Ambiguous/);
    // An explicit run id resolves the ambiguity.
    expect(selectAuditForProperty(ws, 'run-20260103-000000-cccccc', parseProperty('sc-domain:alpha.example')).runId).toBe('run-20260103-000000-cccccc');
  });
});
