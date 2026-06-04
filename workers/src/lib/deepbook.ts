/**
 * Deepbook V3 order placement for Veritas.
 *
 * The Worker holds a single shared BalanceManager (funded with testnet SUI/DBUSDC).
 * After each agent commits a prediction, the Worker places the agent's limit order
 * on the SUI_DBUSDC pool using the BalanceManager.
 *
 * Pool: SUI_DBUSDC (testnet)
 * Price unit: DBUSDC per SUI (decimal, e.g. 2.50)
 * Quantity unit: SUI (decimal, e.g. 4.0)
 *
 * Agent predictions carry:
 *   order.limitPrice  — scaled 1e6 (e.g. 2_500_000 = $2.50)
 *   order.sizeUsdc    — notional USDC, scaled 1e6 (e.g. 10_000_000 = $10)
 *   order.side        — 'bid' | 'ask'
 */

import { DeepBookClient }  from '@mysten/deepbook-v3';
import type { SuiClient }  from '@mysten/sui/client';
import { Transaction }     from '@mysten/sui/transactions';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { signAndExecute }  from './sui';
import type { PredictionOrder } from '../types';

const POOL_KEY            = 'SUI_DBUSDC';
const BALANCE_MANAGER_KEY = 'VERITAS';

// ── Client factory ────────────────────────────────────────────────────────────

export function buildDeepBookClient(
  client:           SuiClient,
  address:          string,
  balanceManagerId: string,
): DeepBookClient {
  return new DeepBookClient({
    // deepbook-v3 bundles its own @mysten/sui — cast to satisfy its internal type
    client: client as never,
    address,
    env: 'testnet',
    balanceManagers: {
      [BALANCE_MANAGER_KEY]: {
        address:  balanceManagerId,
        tradeCap: undefined,
      },
    },
  });
}

// ── One-time setup ────────────────────────────────────────────────────────────

/**
 * Create and share a new BalanceManager for the Worker keypair.
 * Run once via POST /admin/setup-deepbook, then store the returned ID
 * as BALANCE_MANAGER_ID in wrangler.toml vars.
 */
export async function txCreateBalanceManager(
  client:  SuiClient,
  keypair: Ed25519Keypair,
): Promise<string> {
  const dbClient = new DeepBookClient({
    client: client as never,
    address: keypair.toSuiAddress(),
    env:     'testnet',
  });

  const tx = new Transaction();
  dbClient.balanceManager.createAndShareBalanceManager()(tx as never);

  const digest = await signAndExecute(client, keypair, tx);

  await new Promise(resolve => setTimeout(resolve, 2000));

  const result = await client.getTransactionBlock({
    digest,
    options: { showObjectChanges: true },
  });
  const created = result.objectChanges?.find(
    c => c.type === 'created' && c.objectType?.includes('BalanceManager'),
  );
  if (!created || created.type !== 'created') {
    throw new Error('BalanceManager object not found in tx effects');
  }
  return created.objectId;
}

/**
 * Deposit SUI or DBUSDC into the Worker BalanceManager.
 * coinKey: 'SUI' | 'DBUSDC'
 * amount: human-readable units (e.g. 5.0 for 5 SUI)
 */
export async function txDepositToBalanceManager(
  client:           SuiClient,
  keypair:          Ed25519Keypair,
  balanceManagerId: string,
  coinKey:          string,
  amount:           number,
): Promise<string> {
  const dbClient = buildDeepBookClient(client, keypair.toSuiAddress(), balanceManagerId);
  const tx       = new Transaction();
  dbClient.balanceManager.depositIntoManager(BALANCE_MANAGER_KEY, coinKey, amount)(tx as never);
  return signAndExecute(client, keypair, tx);
}

// ── Order placement ───────────────────────────────────────────────────────────

/**
 * Place a limit order on the SUI_DBUSDC pool.
 * Converts agent prediction units (scaled 1e6) to Deepbook units (decimal).
 *
 * price    = order.limitPrice / 1e6  (DBUSDC per SUI)
 * quantity = order.sizeUsdc / order.limitPrice  (SUI, 1e6 cancels)
 */
export async function txPlaceLimitOrder(
  client:           SuiClient,
  keypair:          Ed25519Keypair,
  balanceManagerId: string,
  order:            PredictionOrder,
  clientOrderId:    string,
): Promise<string> {
  const price    = order.limitPrice / 1_000_000;
  const quantity = order.sizeUsdc   / order.limitPrice;  // 1e6 factors cancel

  const dbClient = buildDeepBookClient(client, keypair.toSuiAddress(), balanceManagerId);
  const tx       = new Transaction();

  dbClient.deepBook.placeLimitOrder({
    poolKey:           POOL_KEY,
    balanceManagerKey: BALANCE_MANAGER_KEY,
    clientOrderId,
    price,
    quantity,
    isBid:       order.side === 'bid',
    payWithDeep: true,
  })(tx as never);

  return signAndExecute(client, keypair, tx);
}
