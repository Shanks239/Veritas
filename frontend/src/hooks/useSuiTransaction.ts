import { useDynamicContext } from '@dynamic-labs/sdk-react-core'
import { isSuiWallet } from '@dynamic-labs/sui'
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client'
import { Transaction } from '@mysten/sui/transactions'

const PACKAGE_ID = '0xaf7137f72e7f44e7eabc8b3975da5f315085365696470fe7d1f8ff373f63d5d2'
const REGISTRY_ID = '0x54f5e69e3981ccaf1081e495ef7e8e8696dc96993bb7e9c3ea598760b77b4f10'

export { PACKAGE_ID, REGISTRY_ID }

export function useSuiTransaction() {
  const { primaryWallet } = useDynamicContext()

  async function signAndExecute(tx: Transaction): Promise<string> {
    if (!primaryWallet || !isSuiWallet(primaryWallet)) {
      throw new Error('No Sui wallet connected')
    }

    const account = await primaryWallet.getWalletAccount()

    if (account) {
      // Account already loaded — use signAndExecuteTransaction directly to
      // avoid the destructive disconnect+reconnect that signTransaction triggers
      // via _connector.connect() on embedded wallets.
      const result = await primaryWallet.signAndExecuteTransaction({ transaction: tx })
      return (result as { digest: string }).digest
    }

    // Account not yet loaded (first action after page load). signTransaction
    // calls _connector.connect() which loads accounts for embedded wallets.
    // After this one-time reconnect, subsequent calls take the fast path above.
    const { bytes, signature } = await primaryWallet.signTransaction(tx)
    const client = new SuiClient({ url: getFullnodeUrl('testnet') })
    const result = await client.executeTransactionBlock({
      transactionBlock: bytes,
      signature,
      options: { showEffects: true },
    })
    if (result.effects?.status?.status !== 'success') {
      throw new Error(`Transaction failed: ${result.effects?.status?.error ?? 'unknown'}`)
    }
    return result.digest
  }

  async function registerAgent(endpoint: string): Promise<string> {
    const tx = new Transaction()
    tx.moveCall({
      target:    `${PACKAGE_ID}::registry::register`,
      arguments: [
        tx.object(REGISTRY_ID),
        tx.pure.vector('u8', Array.from(new TextEncoder().encode(endpoint))),
      ],
    })
    return signAndExecute(tx)
  }

  async function delegateStake(
    agentAddress: string,
    amountMist:   bigint,
  ): Promise<string> {
    const tx = new Transaction()
    const [coin] = tx.splitCoins(tx.gas, [amountMist])
    tx.moveCall({
      target:    `${PACKAGE_ID}::registry::delegate`,
      arguments: [
        tx.object(REGISTRY_ID),
        tx.pure.address(agentAddress),
        coin,
      ],
    })
    return signAndExecute(tx)
  }

  async function createProfile(): Promise<string> {
    const tx = new Transaction()
    tx.moveCall({
      target:    `${PACKAGE_ID}::agent_profile::create`,
      arguments: [],
    })
    return signAndExecute(tx)
  }

  return { registerAgent, delegateStake, createProfile, signAndExecute }
}