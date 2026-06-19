/**
 * One-stop setup for the Veritas agent roster.
 *
 *   npm run setup -- gen           generate a keypair per agent → .agents.json
 *   npm run setup -- fund          request testnet SUI gas for each address
 *   npm run setup -- register      on-chain registry::register(endpoint) per agent
 *   npm run setup -- profiles      ask the Worker to create an AgentProfile per agent
 *   npm run setup -- sync          POST Worker /admin/sync-agents (warm endpoint cache)
 *   npm run setup -- set-endpoint  update on-chain endpoint to .agents.json value
 *   npm run setup -- endpoints     point .agents.json endpoints at the agents Worker
 *   npm run setup -- worker-config write the roster into ../agents-worker/wrangler.toml
 *   npm run setup -- status        print address / balance / registered state
 *   npm run setup -- all           gen → fund → (wait) → register → profiles → sync
 *
 * Config via env (sensible testnet defaults baked in):
 *   PACKAGE_ID, REGISTRY_ID, SUI_NETWORK, WORKER_URL, AGENTS_WORKER_URL, PUBLIC_BASE_URL
 *
 * Hosting the agents on Cloudflare (recommended): deploy ../agents-worker, then
 *   AGENTS_WORKER_URL=https://veritas-agents.<acct>.workers.dev npm run setup -- endpoints
 * which sets each agent's on-chain endpoint to `${AGENTS_WORKER_URL}/<name>/predict`.
 *
 * Running agents locally instead: PUBLIC_BASE_URL is the externally reachable
 * origin the Worker POSTs to (e.g. a tunnel https://abc.trycloudflare.com); the
 * `gen` default endpoint is `${PUBLIC_BASE_URL}:${port}/predict`.
 */

import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Ed25519Keypair }            from '@mysten/sui/keypairs/ed25519';
import { Transaction, TransactionDataBuilder } from '@mysten/sui/transactions';
import { getFaucetHost, requestSuiFromFaucetV2 } from '@mysten/sui/faucet';
import * as fs   from 'fs';
import * as path from 'path';

import { ROSTER, loadSecrets, saveSecrets, type AgentSecret } from '../src/agents.config';

// ── Config ──────────────────────────────────────────────────────────────────

const NETWORK    = (process.env.SUI_NETWORK ?? 'testnet') as 'testnet' | 'mainnet';
const PACKAGE_ID = process.env.PACKAGE_ID ?? '0xaf7137f72e7f44e7eabc8b3975da5f315085365696470fe7d1f8ff373f63d5d2';
const REGISTRY_ID = process.env.REGISTRY_ID ?? '0x54f5e69e3981ccaf1081e495ef7e8e8696dc96993bb7e9c3ea598760b77b4f10';
const WORKER_URL = process.env.WORKER_URL ?? 'https://veritas-worker.YOUR_ACCOUNT.workers.dev';
const AGENTS_WORKER_URL = process.env.AGENTS_WORKER_URL ?? 'https://veritas-agents.YOUR_ACCOUNT.workers.dev';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL ?? 'http://localhost';

const AGENTS_WRANGLER = path.join(__dirname, '..', '..', 'agents-worker', 'wrangler.toml');

const client = new SuiClient({ url: getFullnodeUrl(NETWORK) });

const defaultEndpoint = (port: number) => `${PUBLIC_BASE_URL}:${port}/predict`;
const strategyOf = (name: string) => ROSTER.find((d) => d.name === name)?.strategy ?? name;

// ── Sign helper (sign once; tolerate testnet node lag) ────────────────────────

async function signAndRun(keypair: Ed25519Keypair, tx: Transaction): Promise<string> {
  tx.setSenderIfNotSet(keypair.toSuiAddress());
  const bytes  = await tx.build({ client });
  const digest = TransactionDataBuilder.getDigestFromBytes(bytes);
  const { signature } = await keypair.signTransaction(bytes);

  for (let i = 0; i < 4; i++) {
    try {
      const res = await client.executeTransactionBlock({
        transactionBlock: bytes,
        signature,
        options: { showEffects: true },
      });
      if (res.effects?.status.status !== 'success') {
        throw new Error(`tx failed: ${JSON.stringify(res.effects?.status)}`);
      }
      return res.digest;
    } catch (err) {
      try {
        const ok = await client.waitForTransaction({ digest, options: { showEffects: true }, timeout: 15_000 });
        if (ok.effects?.status.status === 'success') return digest;
      } catch { /* genuinely not executed — retry */ }
      if (i === 3) throw err;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw new Error('unreachable');
}

// ── Commands ──────────────────────────────────────────────────────────────────

function gen() {
  const existing = loadSecrets();
  const out: AgentSecret[] = [];
  for (const def of ROSTER) {
    const prior = existing.find((s) => s.name === def.name);
    if (prior) {
      out.push(prior);
      console.log(`= ${def.name.padEnd(10)} ${prior.address} (kept)`);
      continue;
    }
    const kp   = new Ed25519Keypair();
    const sec: AgentSecret = {
      name:      def.name,
      address:   kp.toSuiAddress(),
      secretKey: kp.getSecretKey(), // bech32 suiprivkey1...
      endpoint:  defaultEndpoint(def.port),
    };
    out.push(sec);
    console.log(`+ ${def.name.padEnd(10)} ${sec.address} (new)`);
  }
  saveSecrets(out);
  console.log(`\nSaved ${out.length} agents → .agents.json (gitignored).`);
  console.log(`Next: \`npm run setup -- fund\` then \`npm run setup -- register\`.`);
}

async function fund() {
  if (NETWORK === 'mainnet') {
    console.log('No faucet on mainnet — fund agent addresses manually.');
    return;
  }
  for (const s of loadSecrets()) {
    try {
      await requestSuiFromFaucetV2({ host: getFaucetHost(NETWORK), recipient: s.address });
      console.log(`✓ funded ${s.name} ${s.address}`);
    } catch (err) {
      console.log(`✗ ${s.name}: ${String(err)} — fund manually: https://faucet.sui.io/?address=${s.address}`);
    }
    await new Promise((r) => setTimeout(r, 1500)); // be gentle with the faucet
  }
}

async function isRegistered(address: string): Promise<boolean> {
  const ev = await client.queryEvents({
    query: { MoveEventType: `${PACKAGE_ID}::registry::AgentRegistered` },
    limit: 200,
  });
  return ev.data.some((e) => (e.parsedJson as { agent?: string })?.agent === address);
}

async function register() {
  for (const s of loadSecrets()) {
    if (await isRegistered(s.address)) {
      console.log(`= ${s.name} already registered — use set-endpoint to change URL`);
      continue;
    }
    const kp = Ed25519Keypair.fromSecretKey(s.secretKey);
    const tx = new Transaction();
    tx.moveCall({
      target:    `${PACKAGE_ID}::registry::register`,
      arguments: [tx.object(REGISTRY_ID), tx.pure.vector('u8', Array.from(new TextEncoder().encode(s.endpoint)))],
    });
    try {
      const digest = await signAndRun(kp, tx);
      console.log(`✓ registered ${s.name} → ${s.endpoint}  (${digest})`);
    } catch (err) {
      console.log(`✗ ${s.name}: ${String(err)}`);
    }
  }
  console.log(`\nNext: \`npm run setup -- profiles\` then \`npm run setup -- sync\`.`);
}

async function setEndpoint() {
  for (const s of loadSecrets()) {
    const kp = Ed25519Keypair.fromSecretKey(s.secretKey);
    const tx = new Transaction();
    tx.moveCall({
      target:    `${PACKAGE_ID}::registry::update_endpoint`,
      arguments: [tx.object(REGISTRY_ID), tx.pure.vector('u8', Array.from(new TextEncoder().encode(s.endpoint)))],
    });
    try {
      const digest = await signAndRun(kp, tx);
      console.log(`✓ ${s.name} endpoint → ${s.endpoint}  (${digest})`);
    } catch (err) {
      console.log(`✗ ${s.name}: ${String(err)}`);
    }
  }
  console.log(`\nRun \`npm run setup -- sync\` to refresh the Worker's endpoint cache.`);
}

async function profiles() {
  for (const s of loadSecrets()) {
    try {
      const res = await fetch(`${WORKER_URL}/profile/ensure`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ agentAddress: s.address }),
      });
      const body = await res.json() as { profileId?: string; isNew?: boolean; error?: string };
      if (!res.ok || body.error) console.log(`✗ ${s.name}: ${body.error ?? res.status}`);
      else console.log(`✓ ${s.name} profile ${body.profileId} ${body.isNew ? '(new)' : '(exists)'}`);
    } catch (err) {
      console.log(`✗ ${s.name}: ${String(err)}`);
    }
  }
}

async function sync() {
  const res = await fetch(`${WORKER_URL}/admin/sync-agents`, { method: 'POST' });
  console.log(`POST ${WORKER_URL}/admin/sync-agents → ${res.status} ${await res.text()}`);
}

function endpoints() {
  if (AGENTS_WORKER_URL.includes('YOUR_ACCOUNT')) {
    console.log('Set AGENTS_WORKER_URL to your deployed agents Worker first, e.g.');
    console.log('  AGENTS_WORKER_URL=https://veritas-agents.<acct>.workers.dev npm run setup -- endpoints');
    process.exit(1);
  }
  const base = AGENTS_WORKER_URL.replace(/\/+$/, '');
  const secrets = loadSecrets().map((s) => ({ ...s, endpoint: `${base}/${s.name}/predict` }));
  saveSecrets(secrets);
  for (const s of secrets) console.log(`${s.name.padEnd(10)} → ${s.endpoint}`);
  console.log(`\nNow run \`register\` (first time) or \`set-endpoint\` (already registered), then \`sync\`.`);
}

function workerConfig() {
  const roster: Record<string, { strategy: string; address: string }> = {};
  for (const s of loadSecrets()) roster[s.name] = { strategy: strategyOf(s.name), address: s.address };
  const line = `AGENTS = '${JSON.stringify(roster)}'`;

  if (!fs.existsSync(AGENTS_WRANGLER)) {
    console.log(`agents Worker config not found at ${AGENTS_WRANGLER}.`);
    console.log(`Paste this under [vars]:\n${line}`);
    return;
  }
  const toml = fs.readFileSync(AGENTS_WRANGLER, 'utf8');
  const next = /^AGENTS = .*$/m.test(toml)
    ? toml.replace(/^AGENTS = .*$/m, line)
    : toml.replace(/^\[vars\]\s*$/m, `[vars]\n${line}`);
  fs.writeFileSync(AGENTS_WRANGLER, next);
  console.log(`Updated ${AGENTS_WRANGLER} with ${Object.keys(roster).length} agents.`);
  console.log(`Redeploy: cd ../agents-worker && npm run deploy`);
}

async function status() {
  console.log(`network=${NETWORK}  package=${PACKAGE_ID.slice(0, 10)}…  registry=${REGISTRY_ID.slice(0, 10)}…\n`);
  for (const s of loadSecrets()) {
    const bal = await client.getBalance({ owner: s.address }).then((b) => Number(b.totalBalance) / 1e9).catch(() => 0);
    const reg = await isRegistered(s.address);
    console.log(`${s.name.padEnd(10)} ${s.address}  ${bal.toFixed(2)} SUI  ${reg ? 'registered' : 'NOT registered'}`);
    console.log(`${''.padEnd(10)} → ${s.endpoint}`);
  }
}

async function all() {
  gen();
  console.log('\n— funding —');     await fund();
  console.log('\nwaiting 5s for faucet to settle…'); await new Promise((r) => setTimeout(r, 5000));
  console.log('\n— registering —'); await register();
  console.log('\n— profiles —');    await profiles();
  console.log('\n— sync —');        await sync();
}

// ── Dispatch ────────────────────────────────────────────────────────────────

const cmd = process.argv[2];
const cmds: Record<string, () => unknown> = {
  gen, fund, register, profiles, sync, status, all, endpoints,
  'set-endpoint':  setEndpoint,
  'worker-config': workerConfig,
};

(async () => {
  const fn = cmds[cmd];
  if (!fn) {
    console.log('usage: npm run setup -- <gen|fund|register|profiles|sync|set-endpoint|status|all>');
    process.exit(1);
  }
  await fn();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
