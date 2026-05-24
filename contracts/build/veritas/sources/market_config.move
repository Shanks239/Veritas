/// Global configuration object for Veritas.
/// One instance exists per deployment, shared across all modules.
/// Admin controls timing params and scoring weights.
module veritas::market_config {
    use sui::tx_context::TxContext;

    // ── constants ─────────────────────────────────────────────────────────────
    /// Fixed-point scale. All scores, weights, rates expressed as parts per SCALE.
    const SCALE: u64 = 10_000;

    // ── errors ────────────────────────────────────────────────────────────────
    const E_WEIGHTS_MUST_SUM_TO_SCALE: u64 = 0;
    const E_ZERO_INTERVAL:             u64 = 1;

    // ── structs ───────────────────────────────────────────────────────────────

    /// Capability granting administrative control over MarketConfig.
    /// Minted once in init, transferred to deployer.
    public struct AdminCap has key, store { id: UID }

    /// Shared object. All modules read from this.
    public struct MarketConfig has key {
        id: UID,

        // Window timing
        deliberation_secs:    u64,   // how long agents have to compute + commit
        horizon_secs:         u64,   // how long after execution before outcome locks
        window_interval_secs: u64,   // how often a new window opens

        // Tier thresholds — index maps to tier (0=T1, 1=T2, 2=T3, 3=T4)
        // Each value is minimum composite score required, scaled by SCALE
        tier_thresholds: vector<u64>,

        // Scoring weights — must sum to SCALE
        weight_accuracy:  u64,   // default 4_000 (40%)
        weight_pnl:       u64,   // default 4_000 (40%)
        weight_drawdown:  u64,   // default 2_000 (20%)

        // Activity and decay params
        inactivity_threshold:    u64,   // consecutive missed windows before decay starts
        decay_rate:              u64,   // score lost per missed window after threshold, scaled by SCALE
        min_windows_for_tier:    u64,   // minimum windows before any tier is assigned
        min_participation_rate:  u64,   // minimum participation rate for tier eligibility, scaled by SCALE
    }

    // ── init ──────────────────────────────────────────────────────────────────

    fun init(ctx: &mut TxContext) {
        transfer::transfer(
            AdminCap { id: object::new(ctx) },
            ctx.sender(),
        );

        transfer::share_object(MarketConfig {
            id: object::new(ctx),
            deliberation_secs:    60,
            horizon_secs:         300,
            window_interval_secs: 60,
            // T1 ≥ 0.50, T2 ≥ 0.65, T3 ≥ 0.80, T4 ≥ 0.92
            tier_thresholds:      vector[5_000, 6_500, 8_000, 9_200],
            weight_accuracy:      4_000,
            weight_pnl:           4_000,
            weight_drawdown:      2_000,
            inactivity_threshold:    5,
            decay_rate:              200,   // 0.02 per missed window
            min_windows_for_tier:    10,
            min_participation_rate:  7_000, // 70%
        });
    }

    // ── admin mutations ───────────────────────────────────────────────────────

    public fun update_timing(
        _:   &AdminCap,
        cfg: &mut MarketConfig,
        deliberation_secs:    u64,
        horizon_secs:         u64,
        window_interval_secs: u64,
    ) {
        assert!(window_interval_secs > 0, E_ZERO_INTERVAL);
        cfg.deliberation_secs    = deliberation_secs;
        cfg.horizon_secs         = horizon_secs;
        cfg.window_interval_secs = window_interval_secs;
    }

    public fun update_weights(
        _:   &AdminCap,
        cfg: &mut MarketConfig,
        weight_accuracy:  u64,
        weight_pnl:       u64,
        weight_drawdown:  u64,
    ) {
        assert!(
            weight_accuracy + weight_pnl + weight_drawdown == SCALE,
            E_WEIGHTS_MUST_SUM_TO_SCALE
        );
        cfg.weight_accuracy  = weight_accuracy;
        cfg.weight_pnl       = weight_pnl;
        cfg.weight_drawdown  = weight_drawdown;
    }

    public fun update_decay_params(
        _:   &AdminCap,
        cfg: &mut MarketConfig,
        inactivity_threshold:   u64,
        decay_rate:             u64,
        min_windows_for_tier:   u64,
        min_participation_rate: u64,
    ) {
        cfg.inactivity_threshold    = inactivity_threshold;
        cfg.decay_rate              = decay_rate;
        cfg.min_windows_for_tier    = min_windows_for_tier;
        cfg.min_participation_rate  = min_participation_rate;
    }

    // ── getters ───────────────────────────────────────────────────────────────

    public fun scale(): u64 { SCALE }

    public fun deliberation_secs(cfg: &MarketConfig):    u64 { cfg.deliberation_secs }
    public fun horizon_secs(cfg: &MarketConfig):         u64 { cfg.horizon_secs }
    public fun window_interval_secs(cfg: &MarketConfig): u64 { cfg.window_interval_secs }
    public fun tier_thresholds(cfg: &MarketConfig): &vector<u64> { &cfg.tier_thresholds }

    public fun weights(cfg: &MarketConfig): (u64, u64, u64) {
        (cfg.weight_accuracy, cfg.weight_pnl, cfg.weight_drawdown)
    }

    public fun inactivity_threshold(cfg: &MarketConfig):   u64 { cfg.inactivity_threshold }
    public fun decay_rate(cfg: &MarketConfig):             u64 { cfg.decay_rate }
    public fun min_windows_for_tier(cfg: &MarketConfig):   u64 { cfg.min_windows_for_tier }
    public fun min_participation_rate(cfg: &MarketConfig): u64 { cfg.min_participation_rate }
}
