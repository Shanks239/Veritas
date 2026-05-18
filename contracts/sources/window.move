/// Window lifecycle: open → commit phase → execute → resolve.
/// Each Window is an independent shared object.
/// Multiple windows run concurrently — new one opens every window_interval_secs.
module veritas::window {
    use sui::clock::{Self, Clock};
    use sui::event;
    use veritas::market_config::MarketConfig;

    // ── errors ────────────────────────────────────────────────────────────────
    const E_COMMIT_DEADLINE_PASSED: u64 = 0;
    const E_HORIZON_NOT_ELAPSED:    u64 = 1;
    const E_ALREADY_RESOLVED:       u64 = 2;

    // ── structs ───────────────────────────────────────────────────────────────

    public struct Window has key {
        id: UID,
        opens_at:     u64,   // ms timestamp — Deepbook snapshot reference point
        closes_at:    u64,   // opens_at + deliberation_secs * 1000
        resolves_at:  u64,   // closes_at + horizon_secs * 1000
        /// Deepbook mid-price at resolves_at, scaled by 1e6.
        /// None until resolve() is called.
        outcome_price: Option<u64>,
        commit_count:  u64,
        resolved:      bool,
    }

    // ── events ────────────────────────────────────────────────────────────────

    public struct WindowOpened has copy, drop {
        window_id:   ID,
        opens_at:    u64,
        closes_at:   u64,
        resolves_at: u64,
    }

    public struct WindowResolved has copy, drop {
        window_id:     ID,
        outcome_price: u64,
        commit_count:  u64,
    }

    // ── public functions ──────────────────────────────────────────────────────

    /// Open a new prediction window.
    /// Permissionless — Worker calls this on interval, but anyone can trigger
    /// as a liveness fallback if the Worker is down.
    public fun open(
        cfg:   &MarketConfig,
        clock: &Clock,
        ctx:   &mut TxContext,
    ): ID {
        let now         = clock::timestamp_ms(clock);
        let closes_at   = now + market_config::deliberation_secs(cfg) * 1000;
        let resolves_at = closes_at + market_config::horizon_secs(cfg) * 1000;

        let w = Window {
            id: object::new(ctx),
            opens_at: now,
            closes_at,
            resolves_at,
            outcome_price: option::none(),
            commit_count:  0,
            resolved:      false,
        };

        let id = object::id(&w);
        event::emit(WindowOpened { window_id: id, opens_at: now, closes_at, resolves_at });
        transfer::share_object(w);
        id
    }

    /// Record the outcome price and mark window resolved.
    /// Called by Worker after horizon elapses, using Deepbook mid-price feed.
    /// Price authenticity enforced off-chain via signed feed data.
    /// Production path: replace with oracle attestation or ZK price proof.
    public fun resolve(
        window:        &mut Window,
        clock:         &Clock,
        outcome_price: u64,
    ) {
        assert!(!window.resolved, E_ALREADY_RESOLVED);
        assert!(
            clock::timestamp_ms(clock) >= window.resolves_at,
            E_HORIZON_NOT_ELAPSED
        );

        window.outcome_price = option::some(outcome_price);
        window.resolved      = true;

        event::emit(WindowResolved {
            window_id:     object::id(window),
            outcome_price,
            commit_count:  window.commit_count,
        });
    }

    // ── package-internal mutators (called by commit.move) ─────────────────────

    /// Asserts commit deadline has not passed. Aborts if it has.
    public(package) fun assert_open(window: &Window, clock: &Clock) {
        assert!(
            clock::timestamp_ms(clock) < window.closes_at,
            E_COMMIT_DEADLINE_PASSED
        );
    }

    public(package) fun increment_commits(window: &mut Window) {
        window.commit_count = window.commit_count + 1;
    }

    // ── getters ───────────────────────────────────────────────────────────────

    public fun id(w: &Window): ID            { object::id(w) }
    public fun opens_at(w: &Window): u64     { w.opens_at }
    public fun closes_at(w: &Window): u64    { w.closes_at }
    public fun resolves_at(w: &Window): u64  { w.resolves_at }
    public fun resolved(w: &Window): bool    { w.resolved }
    public fun commit_count(w: &Window): u64 { w.commit_count }

    public fun outcome_price(w: &Window): Option<u64> { w.outcome_price }
    public fun outcome_price_value(w: &Window): u64   {
        *option::borrow(&w.outcome_price)
    }
}
