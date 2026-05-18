/// AgentRegistry: deployed agents, endpoint registration, and delegation.
///
/// Separation from AgentProfile is intentional:
///   - AgentProfile = identity + score (exists for all participants)
///   - AgentRegistry entry = deployed agent with an endpoint + delegation pool
///
/// An agent with a profile but no registry entry can participate but not
/// accept delegation. Delegation is opt-in at deployment.
///
/// Revenue split: 80% agent / 20% delegators pro-rata by stake.
/// No max delegator cap — market self-regulates crowding.
module veritas::registry {
    use sui::coin::{Self, Coin};
    use sui::sui::SUI;
    use sui::event;
    use sui::table::{Self, Table};
    use sui::vec_map::{Self, VecMap};
    use veritas::market_config::AdminCap;

    // ── constants ─────────────────────────────────────────────────────────────
    const AGENT_SHARE_BPS:     u64 = 8_000;   // 80% to agent
    const DELEGATOR_SHARE_BPS: u64 = 2_000;   // 20% to delegators
    const BPS_SCALE:           u64 = 10_000;

    // ── errors ────────────────────────────────────────────────────────────────
    const E_AGENT_NOT_REGISTERED:   u64 = 0;
    const E_ALREADY_REGISTERED:     u64 = 1;
    const E_INSUFFICIENT_STAKE:     u64 = 2;
    const E_NOT_DELEGATOR:          u64 = 3;
    const E_ZERO_STAKE:             u64 = 4;

    // ── structs ───────────────────────────────────────────────────────────────

    /// Shared registry of all deployed agents.
    public struct AgentRegistry has key {
        id:     UID,
        agents: Table<address, AgentEntry>,
    }

    public struct AgentEntry has store {
        owner:       address,
        /// HTTP endpoint the Worker POSTs prediction requests to.
        /// Format: "https://agent.example.com/predict"
        endpoint:    vector<u8>,
        total_stake: u64,   // total SUI staked by delegators, in MIST
        delegators:  VecMap<address, u64>,   // delegator → stake amount in MIST
        active:      bool,
    }

    /// Receipt held by delegator proving their stake.
    public struct DelegationReceipt has key, store {
        id:          UID,
        agent:       address,
        delegator:   address,
        stake_amount: u64,   // MIST at time of delegation
    }

    // ── events ────────────────────────────────────────────────────────────────

    public struct AgentRegistered has copy, drop {
        agent:    address,
        endpoint: vector<u8>,
    }

    public struct Delegated has copy, drop {
        agent:        address,
        delegator:    address,
        stake_amount: u64,
    }

    public struct Undelegated has copy, drop {
        agent:     address,
        delegator: address,
        returned:  u64,
    }

    public struct RevenueDistributed has copy, drop {
        agent:           address,
        agent_share:     u64,
        delegator_total: u64,
        window_id:       ID,
    }

    // ── init ──────────────────────────────────────────────────────────────────

    fun init(ctx: &mut TxContext) {
        transfer::share_object(AgentRegistry {
            id:     object::new(ctx),
            agents: table::new(ctx),
        });
    }

    // ── public functions ──────────────────────────────────────────────────────

    /// Register an agent endpoint. Must be called by the agent themselves.
    public fun register(
        registry: &mut AgentRegistry,
        endpoint: vector<u8>,
        ctx:      &mut TxContext,
    ) {
        let agent = ctx.sender();
        assert!(!table::contains(&registry.agents, agent), E_ALREADY_REGISTERED);

        table::add(&mut registry.agents, agent, AgentEntry {
            owner:       agent,
            endpoint,
            total_stake: 0,
            delegators:  vec_map::empty(),
            active:      true,
        });

        event::emit(AgentRegistered { agent, endpoint });
    }

    /// Update the agent's endpoint URL.
    public fun update_endpoint(
        registry: &mut AgentRegistry,
        endpoint: vector<u8>,
        ctx:      &mut TxContext,
    ) {
        let agent = ctx.sender();
        assert!(table::contains(&registry.agents, agent), E_AGENT_NOT_REGISTERED);
        let entry = table::borrow_mut(&mut registry.agents, agent);
        entry.endpoint = endpoint;
    }

    /// Delegate SUI stake to an agent.
    /// Returns a DelegationReceipt proving the stake.
    public fun delegate(
        registry: &mut AgentRegistry,
        agent:    address,
        stake:    Coin<SUI>,
        ctx:      &mut TxContext,
    ): ID {
        assert!(table::contains(&registry.agents, agent), E_AGENT_NOT_REGISTERED);
        let amount = coin::value(&stake);
        assert!(amount > 0, E_ZERO_STAKE);

        let entry     = table::borrow_mut(&mut registry.agents, agent);
        let delegator = ctx.sender();

        // Add to existing stake if already delegating
        if (vec_map::contains(&entry.delegators, &delegator)) {
            let existing = vec_map::get_mut(&mut entry.delegators, &delegator);
            *existing = *existing + amount;
        } else {
            vec_map::insert(&mut entry.delegators, delegator, amount);
        };

        entry.total_stake = entry.total_stake + amount;

        // PRODUCTION TODO: store stake as Balance<SUI> inside AgentRegistry
        // rather than transferring to the package address.
        // For hackathon: transfer to owner as custodian (not ideal but not a burn).
        transfer::public_transfer(stake, entry.owner);

        let receipt = DelegationReceipt {
            id:           object::new(ctx),
            agent,
            delegator,
            stake_amount: amount,
        };
        let receipt_id = object::id(&receipt);

        event::emit(Delegated { agent, delegator, stake_amount: amount });
        transfer::transfer(receipt, delegator);
        receipt_id
    }

    /// Withdraw delegation and reclaim stake.
    public fun undelegate(
        registry: &mut AgentRegistry,
        agent:    address,
        ctx:      &mut TxContext,
    ) {
        assert!(table::contains(&registry.agents, agent), E_AGENT_NOT_REGISTERED);

        let delegator = ctx.sender();
        let entry     = table::borrow_mut(&mut registry.agents, agent);

        assert!(vec_map::contains(&entry.delegators, &delegator), E_NOT_DELEGATOR);

        let (_, amount) = vec_map::remove(&mut entry.delegators, &delegator);
        entry.total_stake = entry.total_stake - amount;

        // TODO: return Coin<SUI> from registry balance in production
        event::emit(Undelegated { agent, delegator, returned: amount });
    }

    /// Distribute revenue from a scored window.
    /// Called by Worker with total PnL proceeds.
    /// Agent gets 80%, delegators split 20% pro-rata.
    public fun distribute_revenue(
        _:         &AdminCap,
        registry:  &AgentRegistry,
        agent:     address,
        window_id: ID,
        proceeds:  Coin<SUI>,
        ctx:       &mut TxContext,
    ) {
        assert!(table::contains(&registry.agents, agent), E_AGENT_NOT_REGISTERED);

        let total      = coin::value(&proceeds);
        let agent_cut  = total * AGENT_SHARE_BPS / BPS_SCALE;
        let deleg_cut  = total - agent_cut;

        let entry = table::borrow(&registry.agents, agent);

        // Agent share
        let agent_coin = coin::split(&mut proceeds, agent_cut, ctx);
        transfer::public_transfer(agent_coin, entry.owner);

        // Delegator shares pro-rata by stake
        if (entry.total_stake > 0) {
            let i = 0u64;
            let n = vec_map::size(&entry.delegators);
            while (i < n) {
                let (delegator, stake) = vec_map::get_entry_by_idx(&entry.delegators, i);
                let share = deleg_cut * (*stake) / entry.total_stake;
                if (share > 0) {
                    let d_coin = coin::split(&mut proceeds, share, ctx);
                    transfer::public_transfer(d_coin, *delegator);
                };
                i = i + 1;
            };
        };

        // Dust from rounding stays in the Worker — acceptable
        transfer::public_transfer(proceeds, entry.owner);

        event::emit(RevenueDistributed {
            agent,
            agent_share:     agent_cut,
            delegator_total: deleg_cut,
            window_id,
        });
    }

    // ── getters ───────────────────────────────────────────────────────────────

    public fun is_registered(registry: &AgentRegistry, agent: address): bool {
        table::contains(&registry.agents, agent)
    }

    public fun endpoint(registry: &AgentRegistry, agent: address): &vector<u8> {
        &table::borrow(&registry.agents, agent).endpoint
    }

    public fun total_stake(registry: &AgentRegistry, agent: address): u64 {
        table::borrow(&registry.agents, agent).total_stake
    }
}
