import { defaultCredentialStore } from '../integrations/credentials.js';
import { deleteCredential, getCredential, saveCredential } from '../integrations/google-oauth.js';
import { maskCruxKey } from '../integrations/crux.js';
import { queryPsi } from '../integrations/psi.js';
import { UsageError, type GlobalFlags } from '../cli.js';
import { readSecret } from './gsc.js';

/** PageSpeed Insights API key: SEARVEX_PSI_API_KEY, or the key saved with `psi auth` in the credential store. */
export function psiKey(): { key: string; source: string } | null {
  const env = process.env['SEARVEX_PSI_API_KEY'];
  if (env) return { key: env, source: 'SEARVEX_PSI_API_KEY' };
  const stored = getCredential('psi');
  return stored?.refreshToken ? { key: stored.refreshToken, source: defaultCredentialStore().describe() } : null;
}

/** A small public page, used only to check that a key works (PageSpeed Insights measures it for real). */
const PROBE_URL = 'https://example.com/';

/** `searvex psi auth|status|logout`: PageSpeed Insights API key (Lighthouse lab data with `--lab`). */
export async function commandPsi(flags: GlobalFlags): Promise<number> {
  const v = flags.values;
  const sub = flags.positionals[1];
  if (sub === 'auth') {
    if (getCredential('psi') && !v['force']) {
      console.log(`A PageSpeed Insights API key is already stored in ${defaultCredentialStore().describe()}. Use --force to replace it, or "psi logout".`);
      return 0;
    }
    const key = await readSecret('PageSpeed Insights API key (Google Cloud → Credentials; input hidden): ');
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(key)) throw new UsageError('That does not look like a Google API key. Nothing was stored.');
    console.log('Checking the key with one PageSpeed Insights run (takes up to a minute)…');
    const probe = await queryPsi(PROBE_URL, key);
    // A page Lighthouse could not load still proves the key works; any API or network error does not.
    if (probe.status === 'error' && !probe.message.startsWith('Lighthouse could not measure')) throw new UsageError(`Google rejected the key; nothing was stored. ${maskCruxKey(probe.message, key)}`);
    saveCredential('psi', { clientId: 'psi-api-key', refreshToken: key, scope: 'pagespeedonline', createdAt: new Date().toISOString() });
    console.log(`Stored the PageSpeed Insights API key in ${defaultCredentialStore().describe()}. Add --lab to a website audit to measure sampled templates.`);
    return 0;
  }
  if (sub === 'logout') {
    const removed = deleteCredential('psi');
    console.log(`${removed ? 'Removed the stored PageSpeed Insights API key.' : 'No stored PageSpeed Insights API key.'} The key stays valid until you delete or restrict it in Google Cloud Console.`);
    return 0;
  }
  if (sub === 'status') {
    const k = psiKey();
    if (!k) {
      const hint = 'No PageSpeed Insights API key: run "searvex psi auth", or set SEARVEX_PSI_API_KEY.';
      if (v['json']) process.stdout.write(JSON.stringify({ key: 'none', valid: false, hint }, null, 2) + '\n');
      else console.log(`key: none\n${hint}`);
      return 1;
    }
    const probe = await queryPsi(PROBE_URL, k.key);
    const status = { key: k.source, valid: probe.status === 'ok', ...(probe.status === 'error' ? { error: probe.message } : {}) };
    if (v['json']) process.stdout.write(JSON.stringify(status, null, 2) + '\n');
    else for (const [n, x] of Object.entries(status)) console.log(`${n}: ${String(x)}`);
    return status.valid ? 0 : 1;
  }
  throw new UsageError('psi subcommands: auth [--force] | status | logout');
}
