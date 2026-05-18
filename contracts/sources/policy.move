/// PolicyObject: capability held in the agent's wallet.
/// Minted when AgentProfile tier is assigned, updated on tier change.
/// Gated functions require the agent to present this object.
///
/// This is the standard Sui capability pattern — the chain enforces
/// that only the holder of this object can access privileged operations.
/// No shared state required at the gate: the cap itself is the proof.
module veritas::policy {
    use sui::event;
    use veritas::market_config::AdminCap;

    // ── constants ─────────────────────────────────────────────────────────────
    // Protocol fee in basis points (1 bp = 0.01%)
    const FEE_T1_BPS: u64 = 2_000;   // 20%
    const FEE_T2_BPS: u64 = 1_500;   // 15%
    const FEE_T3_BPS: u64 = 1_000;   // 10%
    const FEE_T4_BPS: u64 = 0;       // 0%

    // Position limits in USDC, scaled by 1e6
    const LIMIT_T1: u64 = 100_000_000;      // 100 USDC
    const LIMIT_T2: u64 = 1_000_000_000;    // 1,000 USDC
    const LIMIT_T3: u64 = 10_000_000_000;   // 10,000 USDC
    const LIMIT_T4: u64 = 18_446_744_073_709_551_615; // u64::MAX = unlimited

    // Data access levels (checked off-chain by Worker to gate feed delivery)
    const DATA_T1: u8 = 1;   // Deepbook snapshot only
    const DATA_T2: u8 = 2;   // + CoinGecko feeds
    const DATA_T3: u8 = 3;   // + order flow imbalance, depth history
    const DATA_T4: u8 = 4;   // + real-time streaming

    // ── errors ────────────────────────────────────────────────────────────────
    const E_INSUFFICIENT_TIER:     u64 = 0;
    const E_POSITION_LIMIT_BREACH: u64 = 1;
    const E_REPUTATION_FLAGGED:    u64 = 2;

    // ── structs ───────────────────────────────────────────────────────────────

    /// Capability object. Held in agent wallet. Presented to gated functions.
    public struct PolicyObject has key, store {
        id:                  UID,
        agent:               address,
        tier:                u8,
        position_limit_usdc: u64,   // scaled 1e6
        data_access_level:   u8,
        protocol_fee_bps:    u64,
    }

    // ── events ────────────────────────────────────────────────────────────────

    public struct PolicyMinted has copy, drop {
        policy_id: ID,
        agent:     address,
        tier:      u8,
    }

    public struct PolicyUpdated has copy, drop {
        policy_id: ID,
        agent:     address,
        old_tier:  u8,
        new_tier:  u8,
    }

    // ── public functions ──────────────────────────────────────────────────────

    /// Mint a PolicyObject for an agent at a given tier.
    /// Called by Worker via AdminCap after tier is assigned or updated.
    public fun mint(
        _:     &AdminCap,
        agent: address,
        tier:  u8,
        ctx:   &mut TxContext,
    ): ID {
        let policy = make_policy(agent, tier, ctx);
        let id     = object::id(&policy);
        event::emit(PolicyMinted { policy_id: id, agent, tier });
        transfer::transfer(policy, agent);
        id
    }

    /// Update an existing PolicyObject when tier changes.
    /// Old object is mutated in place — agent keeps the same object ID.
    public fun update_tier(
        _:      &AdminCap,
        policy: &mut PolicyObject,
        new_tier: u8,
    ) {
        let old_tier = policy.tier;
        let (limit, data_level, fee_bps) = tier_params(new_tier);
        policy.tier                = new_tier;
        policy.position_limit_usdc = limit;
        policy.data_access_level   = data_level;
        policy.protocol_fee_bps    = fee_bps;

        event::emit(PolicyUpdated {
            policy_id: object::id(policy),
            agent:     policy.agent,
            old_tier,
            new_tier,
        });
    }

    // ── gate functions ────────────────────────────────────────────────────────
    // These are called at the start of privileged operations.
    // Move enforces the agent must own the PolicyObject to call these.

    /// Assert agent is at least the given tier.
    public fun assert_min_tier(policy: &PolicyObject, min_tier: u8) {
        assert!(policy.tier >= min_tier, E_INSUFFICIENT_TIER);
    }

    /// Assert proposed order size is within position limit.
    public fun assert_position_limit(policy: &PolicyObject, order_size_usdc: u64) {
        assert!(order_size_usdc <= policy.position_limit_usdc, E_POSITION_LIMIT_BREACH);
    }

    // ── getters ───────────────────────────────────────────────────────────────

    public fun agent(p: &PolicyObject): address            { p.agent }
    public fun tier(p: &PolicyObject): u8                  { p.tier }
    public fun position_limit_usdc(p: &PolicyObject): u64  { p.position_limit_usdc }
    public fun data_access_level(p: &PolicyObject): u8     { p.data_access_level }
    public fun protocol_fee_bps(p: &PolicyObject): u64     { p.protocol_fee_bps }

    // ── internal ──────────────────────────────────────────────────────────────

    fun make_policy(agent: address, tier: u8, ctx: &mut TxContext): PolicyObject {
        let (limit, data_level, fee_bps) = tier_params(tier);
        PolicyObject {
            id:                  object::new(ctx),
            agent,
            tier,
            position_limit_usdc: limit,
            data_access_level:   data_level,
            protocol_fee_bps:    fee_bps,
        }
    }

    fun tier_params(tier: u8): (u64, u8, u64) {
        if (tier == 4) (LIMIT_T4, DATA_T4, FEE_T4_BPS)
        else if (tier == 3) (LIMIT_T3, DATA_T3, FEE_T3_BPS)
        else if (tier == 2) (LIMIT_T2, DATA_T2, FEE_T2_BPS)
        else (LIMIT_T1, DATA_T1, FEE_T1_BPS)   // T1 and unranked both get minimum access
    }
}
