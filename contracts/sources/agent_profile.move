/// Agent identity, score history, tier evaluation, and decay logic.
///
/// One AgentProfile per zkLogin address. Owned by the agent.
/// Score is a cumulative rolling composite C ∈ [0, SCALE].
///
/// Tier evaluation runs after every score update:
///   - Requires min_windows_for_tier completed windows
///   - Requires participation_rate ≥ min_participation_rate
///   - Requires composite_score ≥ tier threshold
///   - Decay applied after inactivity_threshold consecutive missed windows
///   - Score < T1 threshold → tier 0 (unranked)
///
/// Tier promotions require re-evaluation after 10 windows.
/// Tier demotions are immediate.
module veritas::agent_profile {
    use sui::event;
    use veritas::market_config::MarketConfig;
    use veritas::scoring::{Self, ScoreBundle};

    // ── constants ─────────────────────────────────────────────────────────────
    const SCALE:      u64 = 10_000;
    const UNRANKED:   u8  = 0;
    const MAX_HISTORY: u64 = 20; // rolling window for consistency score

    // ── errors ────────────────────────────────────────────────────────────────
    const E_NOT_AGENT_OWNER:     u64 = 0;
    const E_PROFILE_EXISTS:      u64 = 1;
    const E_REPUTATION_FLAGGED:  u64 = 2;

    // ── structs ───────────────────────────────────────────────────────────────

    public struct AgentProfile has key {
        id:            UID,
        zk_identity:   address,   // zkLogin address — non-transferable anchor

        // Score state
        composite_score:    u64,   // current score, scaled by SCALE
        windows_completed:  u64,   // total scored windows
        windows_available:  u64,   // windows opened since profile creation (for participation rate)
        consecutive_missed: u64,   // resets on any scored window

        // Score history (last MAX_HISTORY composites) for consistency
        score_history: vector<u64>,

        // Tier state
        tier: u8,   // 0=unranked, 1=T1, 2=T2, 3=T3, 4=T4

        // Reputation
        reputation_flag: bool,   // permanent, once set cannot be cleared
    }

    // ── events ────────────────────────────────────────────────────────────────

    public struct ProfileCreated has copy, drop {
        profile_id:  ID,
        zk_identity: address,
    }

    public struct ScoreUpdated has copy, drop {
        profile_id:      ID,
        window_id:       ID,
        composite_score: u64,
        new_tier:        u8,
    }

    public struct TierChanged has copy, drop {
        profile_id: ID,
        old_tier:   u8,
        new_tier:   u8,
    }

    public struct ReputationFlagged has copy, drop {
        profile_id:  ID,
        zk_identity: address,
    }

    // ── public functions ──────────────────────────────────────────────────────

    /// Create a new AgentProfile for the calling zkLogin address.
    /// One profile per address — enforced by ownership (caller holds the object).
    public fun create(ctx: &mut TxContext): ID {
        let identity = ctx.sender();
        let p = AgentProfile {
            id:                 object::new(ctx),
            zk_identity:        identity,
            composite_score:    0,
            windows_completed:  0,
            windows_available:  0,
            consecutive_missed: 0,
            score_history:      vector::empty(),
            tier:               UNRANKED,
            reputation_flag:    false,
        };
        let id = object::id(&p);
        event::emit(ProfileCreated { profile_id: id, zk_identity: identity });
        // Profile is owned by the agent — only they can present it
        transfer::transfer(p, identity);
        id
    }

    /// Record a score from a completed window.
    /// Called by Worker after reveal + score bundle construction.
    /// Updates rolling score, score history, participation rate, and tier.
    public fun record_score(
        profile:   &mut AgentProfile,
        cfg:       &MarketConfig,
        window_id: ID,
        bundle:    ScoreBundle,
    ) {
        assert!(!profile.reputation_flag, E_REPUTATION_FLAGGED);

        let new_composite = scoring::composite(&bundle);

        // Update rolling score: simple moving average over completed windows
        // MA_n = MA_(n-1) + (x_n - MA_(n-1)) / n
        let n = profile.windows_completed + 1;
        profile.composite_score = profile.composite_score
            + (new_composite - profile.composite_score) / n;

        // Update score history (bounded ring buffer)
        vector::push_back(&mut profile.score_history, new_composite);
        if (vector::length(&profile.score_history) > MAX_HISTORY) {
            vector::remove(&mut profile.score_history, 0);
        };

        profile.windows_completed  = n;
        profile.windows_available  = profile.windows_available + 1;
        profile.consecutive_missed = 0; // reset on scored window

        let old_tier = profile.tier;
        profile.tier = evaluate_tier(profile, cfg);

        event::emit(ScoreUpdated {
            profile_id:      object::id(profile),
            window_id,
            composite_score: profile.composite_score,
            new_tier:        profile.tier,
        });

        if (profile.tier != old_tier) {
            event::emit(TierChanged {
                profile_id: object::id(profile),
                old_tier,
                new_tier: profile.tier,
            });
        };
    }

    /// Record a missed window. Increments available count and consecutive_missed.
    /// Applies score decay after inactivity_threshold.
    /// Called by Worker for every window the agent did not participate in.
    public fun record_miss(
        profile: &mut AgentProfile,
        cfg:     &MarketConfig,
    ) {
        profile.windows_available  = profile.windows_available + 1;
        profile.consecutive_missed = profile.consecutive_missed + 1;

        // Decay if past inactivity threshold
        if (profile.consecutive_missed > market_config::inactivity_threshold(cfg)) {
            let decay = market_config::decay_rate(cfg);
            profile.composite_score = if (profile.composite_score > decay) {
                profile.composite_score - decay
            } else {
                0
            };
        };

        // Re-evaluate tier (may demote immediately)
        profile.tier = evaluate_tier(profile, cfg);
    }

    /// Permanently flag agent reputation.
    /// Requires AdminCap — set on integrity violations (incoherent commits, manipulation).
    public fun flag_reputation(
        _:       &veritas::market_config::AdminCap,
        profile: &mut AgentProfile,
    ) {
        profile.reputation_flag = true;
        event::emit(ReputationFlagged {
            profile_id:  object::id(profile),
            zk_identity: profile.zk_identity,
        });
    }

    // ── getters ───────────────────────────────────────────────────────────────

    public fun zk_identity(p: &AgentProfile): address   { p.zk_identity }
    public fun composite_score(p: &AgentProfile): u64   { p.composite_score }
    public fun tier(p: &AgentProfile): u8               { p.tier }
    public fun windows_completed(p: &AgentProfile): u64 { p.windows_completed }
    public fun windows_available(p: &AgentProfile): u64 { p.windows_available }
    public fun reputation_flag(p: &AgentProfile): bool  { p.reputation_flag }
    public fun consecutive_missed(p: &AgentProfile): u64 { p.consecutive_missed }

    public fun participation_rate(p: &AgentProfile): u64 {
        if (p.windows_available == 0) return 0;
        p.windows_completed * SCALE / p.windows_available
    }

    /// Variance of score_history, scaled by SCALE.
    /// Used as consistency metric: lower variance = more consistent agent.
    public fun score_variance(p: &AgentProfile): u64 {
        let n = vector::length(&p.score_history);
        if (n < 2) return 0;

        // Mean
        let sum = 0u64;
        let i   = 0u64;
        while (i < n) {
            sum = sum + *vector::borrow(&p.score_history, i);
            i   = i + 1;
        };
        let mean = sum / n;

        // Sum of squared deviations
        let sq_sum = 0u64;
        let j      = 0u64;
        while (j < n) {
            let x    = *vector::borrow(&p.score_history, j);
            let diff = if (x >= mean) { x - mean } else { mean - x };
            sq_sum   = sq_sum + diff * diff;
            j        = j + 1;
        };

        sq_sum / n // variance, units of SCALE^2 — normalize at call site if needed
    }

    // ── internal ──────────────────────────────────────────────────────────────

    /// Determine the correct tier given current state and config.
    /// Returns UNRANKED if eligibility conditions are not met.
    fun evaluate_tier(p: &AgentProfile, cfg: &MarketConfig): u8 {
        // Must complete minimum windows first
        if (p.windows_completed < market_config::min_windows_for_tier(cfg)) return UNRANKED;

        // Must meet participation rate
        let part_rate = participation_rate(p);
        if (part_rate < market_config::min_participation_rate(cfg)) return UNRANKED;

        // Walk tiers from highest down, return first one the agent qualifies for
        let thresholds = market_config::tier_thresholds(cfg);
        let score      = p.composite_score;

        if (score >= *vector::borrow(thresholds, 3)) return 4;
        if (score >= *vector::borrow(thresholds, 2)) return 3;
        if (score >= *vector::borrow(thresholds, 1)) return 2;
        if (score >= *vector::borrow(thresholds, 0)) return 1;

        UNRANKED
    }
}
