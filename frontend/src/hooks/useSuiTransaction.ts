import { useDynamicContext } from '@dynamic-labs/sdk-react-core'
import { isSuiWallet } from '@dynamic-labs/sui'
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client'
import { Transaction } from '@mysten/sui/transactions'

const PACKAGE_ID = '0xe22583e78de798c4e7a715cd43edcdd7b39b623517e8e35cf6248b2002f30d5c'
const REGISTRY_ID = '0x7277640f858b92bfb926552392297657dcfb5d1d52afb4b1dbc751669721c19d'

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

  function walletAddr(): string {
    if (!primaryWallet) throw new Error('No wallet connected')
    return (primaryWallet as unknown as { address: string }).address
  }

  /** Pull accrued reward share from one agent. Returns the claimed Coin to the caller. */
  async function claimRewards(agentAddress: string): Promise<string> {
    const tx = new Transaction()
    const coin = tx.moveCall({
      target:    `${PACKAGE_ID}::registry::claim`,
      arguments: [tx.object(REGISTRY_ID), tx.pure.address(agentAddress)],
    })
    tx.transferObjects([coin], walletAddr())
    return signAndExecute(tx)
  }

  /** Withdraw staked principal from one agent. Returns the principal Coin to the caller. */
  async function undelegateStake(agentAddress: string): Promise<string> {
    const tx = new Transaction()
    const coin = tx.moveCall({
      target:    `${PACKAGE_ID}::registry::undelegate`,
      arguments: [tx.object(REGISTRY_ID), tx.pure.address(agentAddress)],
    })
    tx.transferObjects([coin], walletAddr())
    return signAndExecute(tx)
  }

  async function updateEndpoint(endpoint: string): Promise<string> {
    const tx = new Transaction()
    tx.moveCall({
      target:    `${PACKAGE_ID}::registry::update_endpoint`,
      arguments: [
        tx.object(REGISTRY_ID),
        tx.pure.vector('u8', Array.from(new TextEncoder().encode(endpoint))),
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

  return { registerAgent, updateEndpoint, delegateStake, claimRewards, undelegateStake, createProfile, signAndExecute }
}