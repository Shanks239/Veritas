/// Commit-reveal scheme for agent predictions.
///
/// Flow:
///   1. Agent (via Worker) calls commit() during deliberation window
///      → stores blake2b256(BCS(prediction)) on-chain
///   2. After window resolves, Worker calls reveal()
///      → provides raw BCS bytes, contract verifies hash matches
///      → stores off-chain content reference (IPFS CID / Walrus blob ID)
///      → triggers score submission
///
/// Commit objects are shared so the Worker can call reveal on behalf of agents.
/// Each agent produces exactly one Commit per Window.
module veritas::commit {
    use sui::event;
    use sui::hash;
    use veritas::window::{Self, Window};

    // ── errors ────────────────────────────────────────────────────────────────
    const E_ALREADY_COMMITTED:  u64 = 0;
    const E_ALREADY_REVEALED:   u64 = 1;
    const E_HASH_MISMATCH:      u64 = 2;
    const E_WINDOW_NOT_RESOLVED: u64 = 3;

    // ── structs ───────────────────────────────────────────────────────────────

    public struct Commit has key {
        id:        UID,
        window_id: ID,
        agent:     address,
        /// blake2b256(BCS(distribution_bytes || order_bytes))
        /// Computed by Worker using canonical BCS serialization.
        hash:      vector<u8>,
        revealed:  bool,
        /// Off-chain content address (IPFS CID or Walrus blob ID).
        /// Points to the full distribution + order JSON for auditing.
        /// None until reveal.
        reveal_ref: Option<vector<u8>>,
    }

    // ── events ────────────────────────────────────────────────────────────────

    public struct Committed has copy, drop {
        commit_id: ID,
        window_id: ID,
        agent:     address,
    }

    public struct Revealed has copy, drop {
        commit_id:  ID,
        window_id:  ID,
        agent:      address,
        reveal_ref: vector<u8>,
    }

    // ── public functions ──────────────────────────────────────────────────────

    /// Submit a hashed prediction for an open window.
    /// Called by Worker on behalf of the agent before closes_at.
    /// `hash` = blake2b256(canonical_bcs(distribution + order)).
    public fun commit(
        window: &mut Window,
        clock:  &sui::clock::Clock,
        hash:   vector<u8>,
        ctx:    &mut TxContext,
    ): ID {
        window::assert_open(window, clock);

        let agent  = ctx.sender();
        let c = Commit {
            id:         object::new(ctx),
            window_id:  window::id(window),
            agent,
            hash,
            revealed:   false,
            reveal_ref: option::none(),
        };

        let commit_id = object::id(&c);
        window::increment_commits(window);

        event::emit(Committed { commit_id, window_id: window::id(window), agent });

        // Shared so Worker can call reveal post-resolution
        transfer::share_object(c);
        commit_id
    }

    /// Reveal prediction after window resolves.
    /// `preimage` = raw BCS bytes that were hashed at commit time.
    /// `reveal_ref` = off-chain content address storing full prediction JSON.
    ///
    /// Contract verifies blake2b256(preimage) == stored hash.
    /// Scoring is triggered separately via agent_profile::record_score().
    public fun reveal(
        c:          &mut Commit,
        window:     &Window,
        preimage:   vector<u8>,
        reveal_ref: vector<u8>,
    ) {
        assert!(!c.revealed, E_ALREADY_REVEALED);
        assert!(window::resolved(window), E_WINDOW_NOT_RESOLVED);
        assert!(hash::blake2b256(&preimage) == c.hash, E_HASH_MISMATCH);

        c.revealed   = true;
        c.reveal_ref = option::some(reveal_ref);

        event::emit(Revealed {
            commit_id:  object::id(c),
            window_id:  c.window_id,
            agent:      c.agent,
            reveal_ref,
        });
    }

    // ── getters ───────────────────────────────────────────────────────────────

    public fun window_id(c: &Commit): ID          { c.window_id }
    public fun agent(c: &Commit): address          { c.agent }
    public fun revealed(c: &Commit): bool          { c.revealed }
    public fun reveal_ref(c: &Commit): &Option<vector<u8>> { &c.reveal_ref }
    public fun hash_bytes(c: &Commit): &vector<u8> { &c.hash }
}
