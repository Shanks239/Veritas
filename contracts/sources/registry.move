/// AgentRegistry: deployed agents, endpoint registration, and delegation.
///
/// Separation from AgentProfile is intentional:
///   - AgentProfile = identity + score (exists for all participants)
///   - AgentRegistry entry = deployed agent with an endpoint + delegation pool
///
/// An agent with a profile but no registry entry can participate but not
/// accept delegation. Delegation is opt-in at deployment.
///
/// Custody & rewards (pull model):
///   - Delegated SUI is held in a per-agent `Balance<SUI>` treasury inside the
///     registry (not forwarded to the agent), so it can be reclaimed.
///   - Revenue accrues into a per-delegator `claimable` map; delegators pull
///     their share by calling `claim`, paying their own gas. This avoids an
///     unbounded per-delegator transfer loop paid by the distributor.
///
/// Revenue split: 80% agent / 20% delegators pro-rata by stake.
/// No max delegator cap — market self-regulates crowding.
module veritas::registry {
    use sui::coin::{Self, Coin};
    use sui::balance::{Self, Balance};
    use sui::sui::SUI;
    use sui::event;
    use sui::table::{Self, Table};
    use sui::vec_map::{Self, VecMap};
    use veritas::market_config::AdminCap;

    // ── constants ─────────────────────────────────────────────────────────────
    const AGENT_SHARE_BPS:     u64 = 8_000;   // 80% to agent; delegators get the remainder
    const BPS_SCALE:           u64 = 10_000;

    // ── errors ────────────────────────────────────────────────────────────────
    const E_AGENT_NOT_REGISTERED:   u64 = 0;
    const E_ALREADY_REGISTERED:     u64 = 1;
    const E_INSUFFICIENT_STAKE:     u64 = 2;
    const E_NOT_DELEGATOR:          u64 = 3;
    const E_ZERO_STAKE:             u64 = 4;
    const E_NOTHING_TO_CLAIM:       u64 = 5;

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
        claimable:   VecMap<address, u64>,   // delegator → accrued reward in MIST
        /// Custody pool: holds delegators' staked principal + their as-yet
        /// unclaimed reward share. Agent's own cut is paid out immediately on
        /// distribution and never enters this balance.
        treasury:    Balance<SUI>,
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

    public struct RewardClaimed has copy, drop {
        agent:     address,
        delegator: address,
        amount:    u64,
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
            claimable:   vec_map::empty(),
            treasury:    balance::zero(),
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
    /// Stake is held in the registry treasury (reclaimable via `undelegate`).
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

        // Hold principal in the registry treasury so it can be reclaimed.
        balance::join(&mut entry.treasury, coin::into_balance(stake));

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

    /// Withdraw delegation and reclaim staked principal.
    /// Any unclaimed rewards remain claimable via `claim`.
    /// Returns the principal Coin<SUI> to the caller.
    public fun undelegate(
        registry: &mut AgentRegistry,
        agent:    address,
        ctx:      &mut TxContext,
    ): Coin<SUI> {
        assert!(table::contains(&registry.agents, agent), E_AGENT_NOT_REGISTERED);

        let delegator = ctx.sender();
        let entry     = table::borrow_mut(&mut registry.agents, agent);

        assert!(vec_map::contains(&entry.delegators, &delegator), E_NOT_DELEGATOR);

        let (_, amount) = vec_map::remove(&mut entry.delegators, &delegator);
        entry.total_stake = entry.total_stake - amount;

        let returned = coin::take(&mut entry.treasury, amount, ctx);
        event::emit(Undelegated { agent, delegator, returned: amount });
        returned
    }

    /// Claim accrued reward share for the caller from one agent.
    /// Pull model: the delegator pays their own gas. Returns the reward Coin<SUI>.
    public fun claim(
        registry: &mut AgentRegistry,
        agent:    address,
        ctx:      &mut TxContext,
    ): Coin<SUI> {
        assert!(table::contains(&registry.agents, agent), E_AGENT_NOT_REGISTERED);

        let delegator = ctx.sender();
        let entry     = table::borrow_mut(&mut registry.agents, agent);

        assert!(vec_map::contains(&entry.claimable, &delegator), E_NOTHING_TO_CLAIM);
        let (_, amount) = vec_map::remove(&mut entry.claimable, &delegator);
        assert!(amount > 0, E_NOTHING_TO_CLAIM);

        let reward = coin::take(&mut entry.treasury, amount, ctx);
        event::emit(RewardClaimed { agent, delegator, amount });
        reward
    }

    /// Distribute revenue from a scored window.
    /// Called by Worker with total PnL proceeds.
    /// Agent receives 80% immediately; delegators' 20% accrues into `claimable`
    /// (held in the treasury) for them to pull via `claim`.
    public fun distribute_revenue(
        _:         &AdminCap,
        registry:  &mut AgentRegistry,
        agent:     address,
        window_id: ID,
        mut proceeds:  Coin<SUI>,
        ctx:           &mut TxContext,
    ) {
        assert!(table::contains(&registry.agents, agent), E_AGENT_NOT_REGISTERED);

        let total      = coin::value(&proceeds);
        let agent_cut  = total * AGENT_SHARE_BPS / BPS_SCALE;

        let entry = table::borrow_mut(&mut registry.agents, agent);

        // Agent share — paid out immediately, never custodied.
        let agent_coin = coin::split(&mut proceeds, agent_cut, ctx);
        transfer::public_transfer(agent_coin, entry.owner);

        // Delegator share — accrue pro-rata into claimable, custody in treasury.
        let deleg_cut = coin::value(&proceeds);
        if (entry.total_stake > 0 && deleg_cut > 0) {
            let mut i = 0u64;
            let n = vec_map::length(&entry.delegators);
            while (i < n) {
                let (delegator, stake) = vec_map::get_entry_by_idx(&entry.delegators, i);
                let share = deleg_cut * (*stake) / entry.total_stake;
                if (share > 0) {
                    let d = *delegator;
                    if (vec_map::contains(&entry.claimable, &d)) {
                        let acc = vec_map::get_mut(&mut entry.claimable, &d);
                        *acc = *acc + share;
                    } else {
                        vec_map::insert(&mut entry.claimable, d, share);
                    };
                };
                i = i + 1;
            };
            // Custody the whole delegator coin (rounding dust stays in treasury).
            balance::join(&mut entry.treasury, coin::into_balance(proceeds));
        } else {
            // No delegators — return the remainder to the agent owner.
            transfer::public_transfer(proceeds, entry.owner);
        };

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

    /// Caller's (or any delegator's) current staked principal with `agent`.
    public fun stake_of(registry: &AgentRegistry, agent: address, delegator: address): u64 {
        let entry = table::borrow(&registry.agents, agent);
        if (vec_map::contains(&entry.delegators, &delegator)) {
            *vec_map::get(&entry.delegators, &delegator)
        } else { 0 }
    }

    /// Reward currently claimable by `delegator` from `agent`, in MIST.
    public fun claimable_of(registry: &AgentRegistry, agent: address, delegator: address): u64 {
        let entry = table::borrow(&registry.agents, agent);
        if (vec_map::contains(&entry.claimable, &delegator)) {
            *vec_map::get(&entry.claimable, &delegator)
        } else { 0 }
    }
}
