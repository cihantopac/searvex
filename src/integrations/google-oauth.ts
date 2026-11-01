import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { defaultCredentialStore, FileCredentialStore, type CredentialStore, type StoredCredential } from './credentials.js';

/**
 * Google OAuth 2.0 for installed (desktop) apps: loopback redirect + PKCE (S256), per
 * https://developers.google.com/identity/protocols/oauth2/native-app.
 *
 * Users bring their own OAuth client ("Desktop app" client JSON from Google Cloud Console); Searvex ships
 * no client credentials. Refresh tokens go to a `CredentialStore` (file in the user's config directory by
 * default) and are only used to call read-only Google APIs.
 *
 * Note for clients in the "Testing" publishing status: Google issues refresh tokens that expire after 7 days
 * (https://developers.google.com/identity/protocols/oauth2#expiration); `accessToken` explains this on
 * `invalid_grant`.
 */
export const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';

export interface OAuthClient {
  clientId: string;
  clientSecret?: string;
}

export type { StoredCredential } from './credentials.js';
export { configDir } from './credentials.js';

const AUTH_URL = () => process.env['SEARVEX_GOOGLE_AUTH_URL'] ?? 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = () => process.env['SEARVEX_GOOGLE_TOKEN_URL'] ?? 'https://oauth2.googleapis.com/token';
const REVOKE_URL = () => process.env['SEARVEX_GOOGLE_REVOKE_URL'] ?? 'https://oauth2.googleapis.com/revoke';

export class OAuthClientFileError extends Error {}

/**
 * Read a Google OAuth client JSON. Only "Desktop app" clients (`installed`) support the loopback redirect
 * without registering redirect URIs; a "Web application" client fails at Google with redirect_uri_mismatch,
 * so it is rejected here with an actionable message.
 */
export function loadClientFile(file: string): OAuthClient {
  let raw: Record<string, { client_id?: string; client_secret?: string }>;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8')) as typeof raw;
  } catch (e) {
    throw new OAuthClientFileError(`Cannot read OAuth client file ${file}: ${(e as NodeJS.ErrnoException).code ?? 'invalid JSON'}`);
  }
  if (raw['web'] && !raw['installed']) throw new OAuthClientFileError('This is a "Web application" OAuth client. Create a "Desktop app" client in Google Cloud Console (Google Auth Platform → Clients) and download its JSON.');
  const c = raw['installed'];
  if (!c?.client_id) throw new OAuthClientFileError('Not a Google OAuth client file (expected an "installed" Desktop app client with client_id)');
  return { clientId: c.client_id, clientSecret: c.client_secret };
}

const store = (): CredentialStore => defaultCredentialStore();

/** The stored credential `name`, from whichever backend is configured. */
export function getCredential(name: string): StoredCredential | null {
  return store().get(name);
}

export function saveCredential(name: string, cred: StoredCredential): string {
  const s = store();
  s.set(name, cred);
  return s instanceof FileCredentialStore ? s.file : s.describe();
}

export function deleteCredential(name: string): boolean {
  return store().delete(name);
}

/**
 * Revoke a refresh (or access) token at Google so the grant disappears from the user's account, per
 * https://developers.google.com/identity/protocols/oauth2/native-app#tokenrevoke. Returns false when Google
 * reports the token as already invalid.
 */
export async function revokeToken(token: string): Promise<boolean> {
  const { status } = await postForm(REVOKE_URL(), { token });
  return status === 200;
}

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(crypto.randomBytes(48));
  return { verifier, challenge: b64url(crypto.createHash('sha256').update(verifier).digest()) };
}

/** POST application/x-www-form-urlencoded and parse JSON (http allowed only for test overrides). */
export function postForm(url: string, form: Record<string, string>): Promise<{ status: number; json: Record<string, unknown> }> {
  const body = new URLSearchParams(form).toString();
  const mod = url.startsWith('https:') ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) }, timeout: 30000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: Record<string, unknown> = {};
        try {
          json = JSON.parse(text) as Record<string, unknown>;
        } catch {
          json = { error: text.slice(0, 200) };
        }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('OAuth request timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * Interactive authorization: starts a one-shot listener on 127.0.0.1, hands the consent URL to `onUrl`
 * (printed for the user), waits for Google's redirect, verifies `state`, exchanges the code with the PKCE
 * verifier and returns the refresh token.
 */
export async function authorize(client: OAuthClient, scope: string, onUrl: (url: string) => void | Promise<void>, timeoutMs = 5 * 60 * 1000): Promise<StoredCredential> {
  const { verifier, challenge } = pkcePair();
  const state = b64url(crypto.randomBytes(16));
  const server = http.createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const codePromise = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Authorization timed out')), timeoutMs);
      server.on('request', (req, res) => {
        const u = new URL(req.url ?? '/', redirectUri);
        const code = u.searchParams.get('code');
        const err = u.searchParams.get('error');
        if (!code && !err) {
          res.writeHead(404).end();
          return;
        }
        const ok = !!code && u.searchParams.get('state') === state;
        res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
        res.end(ok ? '<p>Searvex is authorized. You can close this tab.</p>' : '<p>Authorization failed. Return to the terminal.</p>');
        clearTimeout(timer);
        if (err) reject(new Error(`Authorization denied: ${err}`));
        else if (!ok) reject(new Error('State mismatch — possible CSRF; aborting'));
        else resolve(code!);
      });
    });
    const params = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      access_type: 'offline',
      prompt: 'consent',
    });
    await onUrl(`${AUTH_URL()}?${params}`);
    const code = await codePromise;
    const { status, json } = await postForm(TOKEN_URL(), {
      code,
      client_id: client.clientId,
      ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    });
    if (status !== 200 || typeof json['refresh_token'] !== 'string') throw new Error(`Token exchange failed (${status}): ${String(json['error_description'] ?? json['error'] ?? 'no refresh_token returned')}`);
    return { clientId: client.clientId, clientSecret: client.clientSecret, refreshToken: json['refresh_token'], scope: String(json['scope'] ?? scope), createdAt: new Date().toISOString() };
  } finally {
    server.close();
  }
}

/** Exchange a stored refresh token for a short-lived access token. */
export async function accessToken(cred: StoredCredential): Promise<string> {
  const { status, json } = await postForm(TOKEN_URL(), {
    client_id: cred.clientId,
    ...(cred.clientSecret ? { client_secret: cred.clientSecret } : {}),
    refresh_token: cred.refreshToken,
    grant_type: 'refresh_token',
  });
  if (status !== 200 || typeof json['access_token'] !== 'string') {
    if (json['error'] === 'invalid_grant') throw new Error('The stored Google authorization is no longer valid (revoked, expired, or older than 7 days for an OAuth app in "Testing" status). Run "searvex gsc auth --client <file>" again.');
    throw new Error(`Token refresh failed (${status}): ${String(json['error_description'] ?? json['error'] ?? 'unknown')}. Run "searvex gsc auth" again.`);
  }
  return json['access_token'];
}

/** Access token from SEARVEX_GSC_TOKEN, or from the stored "gsc" credential. */
export async function gscAccessToken(): Promise<string | null> {
  if (process.env['SEARVEX_GSC_TOKEN']) return process.env['SEARVEX_GSC_TOKEN'];
  const cred = store().get('gsc');
  return cred ? accessToken(cred) : null;
}
