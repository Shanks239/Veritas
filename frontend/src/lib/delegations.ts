import { SuiClient, getFullnodeUrl } from '@mysten/sui/client'
import { Transaction } from '@mysten/sui/transactions'
import { PACKAGE_ID, REGISTRY_ID } from '../hooks/useSuiTransaction'

const client = new SuiClient({ url: getFullnodeUrl('testnet') })

export interface Delegation {
  agent:     string   // agent address staked behind
  stakeSui:  number   // live staked principal, SUI
  claimSui:  number   // accrued reward claimable now, SUI
}

/** Parse a little-endian u64 from a devInspect returnValue byte array. */
function parseU64(bytes: number[] | undefined): bigint {
  if (!bytes) return 0n
  let v = 0n
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i])
  return v
}

async function readU64(fn: string, agent: string, owner: string): Promise<bigint> {
  try {
    const tx = new Transaction()
    tx.moveCall({
      target:    `${PACKAGE_ID}::registry::${fn}`,
      arguments: [tx.object(REGISTRY_ID), tx.pure.address(agent), tx.pure.address(owner)],
    })
    const res = await client.devInspectTransactionBlock({ sender: owner, transactionBlock: tx })
    return parseU64(res.results?.[0]?.returnValues?.[0]?.[0])
  } catch {
    return 0n
  }
}

/**
 * Resolve the connected wallet's delegations: find the agents it holds
 * DelegationReceipts for, then read live stake + claimable for each on-chain.
 */
export async function fetchMyDelegations(owner: string): Promise<Delegation[]> {
  const receipts = await client.getOwnedObjects({
    owner,
    filter: { StructType: `${PACKAGE_ID}::registry::DelegationReceipt` },
    options: { showContent: true },
  })

  const agents = new Set<string>()
  for (const r of receipts.data) {
    const content = r.data?.content
    if (content && content.dataType === 'moveObject') {
      const f = content.fields as { agent?: string }
      if (f.agent) agents.add(f.agent)
    }
  }

  const out: Delegation[] = []
  for (const agent of agents) {
    const [stake, claim] = await Promise.all([
      readU64('stake_of', agent, owner),
      readU64('claimable_of', agent, owner),
    ])
    // Skip fully-exited positions with nothing left to claim.
    if (stake === 0n && claim === 0n) continue
    out.push({
      agent,
      stakeSui: Number(stake) / 1e9,
      claimSui: Number(claim) / 1e9,
    })
  }
  return out
}
