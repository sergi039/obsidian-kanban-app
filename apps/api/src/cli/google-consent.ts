/**
 * Renew the personal Google grant with Gmail headers (backlog B-2):
 *
 *   npx tsx apps/api/src/cli/google-consent.ts [--account <calendar account id>]
 *
 * Opens Google's consent page, waits for the loopback redirect, checks the grant
 * (refresh token, calendar.readonly + gmail.metadata, the configured account's verified
 * address) and only then replaces the account's token file. Exit codes: 0 saved and Gmail
 * answers; 3 saved but Gmail is not usable yet (the message says why); 1 nothing changed.
 */
import { execFile } from 'node:child_process';
import { lstatSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.js';
import { expandHome, fetchJson, readEnvValues } from '../calendar-providers.js';
import { assertPrivateDirectory, writeSecretFileAtomic } from '../secret-file.js';
import {
  acceptGrant,
  awaitCallback,
  buildConsentRequest,
  CONSENT_TIMEOUT_MS,
  describeLifetime,
  listenLoopback,
  probeGmail,
  TOKEN_URL,
  type TokenResponse,
} from '../google-consent.js';

async function main(argv: string[]): Promise<number> {
  const flag = argv.indexOf('--account');
  const wanted = flag >= 0 ? argv[flag + 1] : undefined;
  const config = loadConfig();
  const candidates = (config.calendarAccounts ?? []).filter(
    (a) => a.provider === 'google' && a.credentials?.type === 'google-oauth',
  );
  const account = wanted ? candidates.find((a) => a.id === wanted) : candidates.length === 1 ? candidates[0] : undefined;
  if (!account || account.credentials?.type !== 'google-oauth') {
    console.error(`Name the Google account with --account; configured: ${candidates.map((a) => a.id).join(', ') || 'none'}.`);
    return 1;
  }
  const tokenPath = path.resolve(expandHome(account.credentials.tokenFile));

  // Refuse an unsafe place before the owner clicks anything.
  assertPrivateDirectory(path.dirname(tokenPath));
  if (lstatSync(tokenPath, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error(`${tokenPath} is a symbolic link; refusing to replace it`);
  }
  const client = readEnvValues(account.credentials.clientEnvFile, ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);

  const { server, port } = await listenLoopback();
  const request = buildConsentRequest(client.GOOGLE_CLIENT_ID, account.email, port);
  console.log(`Google consent for ${account.email}: calendar (read-only) and Gmail message headers.`);
  console.log('Sign in with that account and allow both. If no browser tab opens, paste this address into one:');
  console.log(request.url);
  if (process.platform === 'darwin') {
    execFile('open', [request.url], (err) => { if (err) console.warn(`Could not open the browser: ${err.message}`); });
  }

  const outcome = await awaitCallback(server, request.state, CONSENT_TIMEOUT_MS);
  if (outcome.kind === 'denied') {
    console.error(`Google answered "${outcome.error}". Nothing was changed.`);
    return 1;
  }
  const response = await fetchJson(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: outcome.code,
      client_id: client.GOOGLE_CLIENT_ID,
      client_secret: client.GOOGLE_CLIENT_SECRET,
      redirect_uri: request.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: request.codeVerifier,
    }),
  }, AbortSignal.timeout(30_000)) as TokenResponse;
  const grant = acceptGrant(response, account, new Date());

  writeSecretFileAtomic(tokenPath, JSON.stringify({
    account: account.email,
    refresh_token: grant.refreshToken,
    scope: grant.scope,
    ...(grant.refreshTokenExpiresAt ? { refresh_token_expires_at: grant.refreshTokenExpiresAt } : {}),
  }, null, 2) + '\n');
  console.log(`Saved the new grant for ${account.email} to ${tokenPath}.`);
  console.log(describeLifetime(grant.refreshTokenExpiresAt));

  const probe = await probeGmail(grant.accessToken, client.GOOGLE_CLIENT_ID);
  if (probe.kind === 'ready') {
    console.log('Gmail answers with the new grant.');
  } else if (probe.kind === 'api-disabled') {
    console.log(`The Gmail API is off in the OAuth client's Google Cloud project. Enable it here, no new consent needed: ${probe.enableUrl}`);
  } else {
    console.log(`Gmail did not answer (${probe.detail}). The grant is saved; check /api/health -> followUps after the next sync.`);
  }
  console.log('The Kanban API picks the new grant within an hour, or at once after: launchctl kickstart -k gui/$(id -u)/com.obsidian-kanban');
  return probe.kind === 'ready' ? 0 : 3;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(`google-consent: ${err instanceof Error ? err.message : String(err)}. Nothing was changed unless "Saved" was printed above.`);
    process.exit(1);
  },
);
