import { describe, expect, it } from 'vitest';
import { assertUrlAllowed, classifyAddress, DEFAULT_POLICY, expandIPv6 } from '../../src/net/ssrf.js';
import { safeFetch } from '../../src/net/fetcher.js';
import { startServer } from '../helpers/server.js';

describe('classifyAddress', () => {
  it.each([
    ['8.8.8.8', 'public'],
    ['127.0.0.1', 'loopback'],
    ['10.1.2.3', 'private'],
    ['172.16.0.1', 'private'],
    ['172.32.0.1', 'public'],
    ['192.168.1.1', 'private'],
    ['169.254.169.254', 'link-local'],
    ['100.64.0.1', 'private'],
    ['0.0.0.0', 'reserved'],
    ['224.0.0.1', 'reserved'],
    ['255.255.255.255', 'reserved'],
    ['::1', 'loopback'],
    ['::', 'reserved'],
    ['fe80::1', 'link-local'],
    ['fd00::1', 'private'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:7f00:1', 'loopback'],
    ['::ffff:169.254.169.254', 'link-local'],
    ['64:ff9b::a9fe:a9fe', 'link-local'],
    ['2001:db8::1', 'reserved'],
    ['2606:4700:4700::1111', 'public'],
    ['not-an-ip', 'invalid'],
  ])('%s → %s', (ip, cls) => {
    expect(classifyAddress(ip)).toBe(cls);
  });

  it('expands compressed IPv6', () => {
    expect(expandIPv6('2001:db8::1')).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]);
    expect(expandIPv6('1:2:3')).toBeNull();
  });
});

describe('assertUrlAllowed', () => {
  it.each([
    'file:///etc/passwd',
    'ftp://example.com/',
    'gopher://example.com/',
    'http://user:pass@example.com/',
    'http://127.0.0.1/',
    'http://[::1]/',
    'http://169.254.169.254/latest/meta-data/',
    'http://localhost:8080/',
    'http://metadata.google.internal/',
    'http://printer.local/',
    'http://0x7f000001/',
    'http://2130706433/',
  ])('blocks %s by default', (u) => {
    expect(() => assertUrlAllowed(u, DEFAULT_POLICY)).toThrow();
  });

  it('keeps link-local / cloud metadata blocked even with allowPrivate', () => {
    const p = { ...DEFAULT_POLICY, allowPrivate: true };
    expect(() => assertUrlAllowed('http://169.254.169.254/latest/meta-data/', p)).toThrow();
    expect(() => assertUrlAllowed('http://[fe80::1]/', p)).toThrow();
    expect(() => assertUrlAllowed('http://[::ffff:169.254.169.254]/', p)).toThrow();
    expect(assertUrlAllowed('http://10.0.0.5/', p).hostname).toBe('10.0.0.5');
  });

  it('allows public URLs and opt-in private targets', () => {
    expect(assertUrlAllowed('https://example.com/a', DEFAULT_POLICY).hostname).toBe('example.com');
    expect(assertUrlAllowed('http://127.0.0.1:3000/', { ...DEFAULT_POLICY, allowPrivate: true }).port).toBe('3000');
  });
});

describe('safeFetch network guards', () => {
  it('refuses to connect to loopback without opt-in (connection-time check)', async () => {
    const res = await safeFetch('http://127.0.0.1:9/');
    expect(res.error).toMatch(/Blocked/);
  });

  it('re-validates every redirect hop (public → private redirect is blocked)', async () => {
    const s = await startServer({ '/': { redirect: 'http://169.254.169.254/latest/meta-data/' } });
    try {
      const res = await safeFetch(s.url + '/', { policy: { ...DEFAULT_POLICY, allowPrivate: true } });
      // allowPrivate permits the loopback test server, but the metadata hop stays blocked.
      expect(res.redirects[0]?.location).toBe('http://169.254.169.254/latest/meta-data/');
      expect(res.error).toMatch(/Blocked/);
      const strict = await safeFetch(s.url + '/');
      expect(strict.error).toMatch(/Blocked/);
    } finally {
      await s.close();
    }
  });

  it('caps response size and reports truncation', async () => {
    const s = await startServer({ '/big': { body: 'x'.repeat(200_000) } });
    try {
      const res = await safeFetch(s.url + '/big', { policy: { ...DEFAULT_POLICY, allowPrivate: true }, maxBytes: 10_000 });
      expect(res.truncated).toBe(true);
      expect(res.bodyBytes).toBeLessThanOrEqual(10_000);
    } finally {
      await s.close();
    }
  });

  it('detects redirect loops', async () => {
    const s = await startServer({ '/a': { redirect: '/b' }, '/b': { redirect: '/a' } });
    try {
      const res = await safeFetch(s.url + '/a', { policy: { ...DEFAULT_POLICY, allowPrivate: true } });
      expect(res.error).toMatch(/loop|Too many/);
    } finally {
      await s.close();
    }
  });

  it('times out slow servers', async () => {
    const s = await startServer({ '/slow': { body: 'ok', delayMs: 3000 } });
    try {
      const res = await safeFetch(s.url + '/slow', { policy: { ...DEFAULT_POLICY, allowPrivate: true }, timeoutMs: 1000 });
      expect(res.error).toMatch(/Timeout/);
    } finally {
      await s.close();
    }
  });
});
