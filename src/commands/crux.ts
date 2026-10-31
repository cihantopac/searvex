import { defaultCredentialStore } from '../integrations/credentials.js';
import { deleteCredential, getCredential, saveCredential } from '../integrations/google-oauth.js';
import { maskCruxKey, queryCrux } from '../integrations/crux.js';
import { UsageError, type GlobalFlags } from '../cli.js';
import { readSecret } from './gsc.js';

/** CrUX API key: SEARVEX_CRUX_API_KEY, or the key saved with `crux auth` in the credential store. */
export function cruxKey(): { key: string; source: string } | null {
  const env = process.env['SEARVEX_CRUX_API_KEY'];
  if (env) return { key: env, source: 'SEARVEX_CRUX_API_KEY' };
  const stored = getCredential('crux');
  return stored?.refreshToken ? { key: stored.refreshToken, source: defaultCredentialStore().describe() } : null;
}

/** An origin that is always in the CrUX dataset, used only to check that a key works. */
const PROBE_ORIGIN = 'https://developer.chrome.com';

/** `searvex crux auth|status|logout`: Chrome UX Report API key (real-user Core Web Vitals). */
export async function commandCrux(flags: GlobalFlags): Promise<number> {
  const v = flags.values;
  const sub = flags.positionals[1];
  if (sub === 'auth') {
    if (getCredential('crux') && !v['force']) {
      console.log(`A CrUX API key is already stored in ${defaultCredentialStore().describe()}. Use --force to replace it, or "crux logout".`);
      return 0;
    }
    const key = await readSecret('Chrome UX Report API key (Google Cloud → Credentials; input hidden): ');
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(key)) throw new UsageError('That does not look like a Google API key. Nothing was stored.');
    const probe = await queryCrux(PROBE_ORIGIN, key);
    if (probe.status === 'error') throw new UsageError(`Google rejected the key; nothing was stored. ${maskCruxKey(probe.message, key)}`);
    saveCredential('crux', { clientId: 'crux-api-key', refreshToken: key, scope: 'chromeuxreport', createdAt: new Date().toISOString() });
    console.log(`Stored the CrUX API key in ${defaultCredentialStore().describe()}. Website audits now include real-user Core Web Vitals when an origin has enough traffic.`);
    return 0;
  }
  if (sub === 'logout') {
    const removed = deleteCredential('crux');
    console.log(`${removed ? 'Removed the stored CrUX API key.' : 'No stored CrUX API key.'} The key stays valid until you delete or restrict it in Google Cloud Console.`);
    return 0;
  }
  if (sub === 'status') {
    const k = cruxKey();
    if (!k) throw new UsageError('No CrUX API key: run "searvex crux auth", or set SEARVEX_CRUX_API_KEY.');
    const probe = await queryCrux(PROBE_ORIGIN, k.key);
    const status = { key: k.source, valid: probe.status !== 'error', ...(probe.status === 'error' ? { error: probe.message } : {}) };
    if (v['json']) process.stdout.write(JSON.stringify(status, null, 2) + '\n');
    else for (const [n, x] of Object.entries(status)) console.log(`${n}: ${String(x)}`);
    return status.valid ? 0 : 1;
  }
  throw new UsageError('crux subcommands: auth [--force] | status | logout');
}
