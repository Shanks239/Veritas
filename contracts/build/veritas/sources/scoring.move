/// Score computation helpers.
///
/// All values use fixed-point arithmetic scaled by SCALE = 10_000.
/// A score of 7_500 means 0.75.
///
/// Composite score:
///   C = (w_acc * brier_score + w_pnl * pnl_norm + w_dd * (SCALE - drawdown)) / SCALE
///
/// Where:
///   brier_score = SCALE - brier_raw        (inverted: lower Brier → higher score)
///   pnl_norm    = sigmoid(PnL / position)  (approximated via piecewise linear)
///   drawdown    = normalized max adverse excursion [0, SCALE]
///
/// Scoring components are submitted by the Worker (trusted oracle for hackathon).
/// Production path: ZK proof of score computation submitted alongside reveal.
module veritas::scoring {
    use veritas::market_config::{Self, MarketConfig};

    // ── constants ─────────────────────────────────────────────────────────────
    const SCALE: u64 = 10_000;

    // ── errors ────────────────────────────────────────────────────────────────
    const E_SCORE_OUT_OF_RANGE:     u64 = 0;
    const E_COMPOSITE_MISMATCH:     u64 = 1;
    const E_INVALID_DISTRIBUTION:   u64 = 2;

    /// Tolerance for composite score verification (rounding drift from sigmoid).
    const COMPOSITE_TOLERANCE: u64 = 10; // 0.001

    // ── public structs ────────────────────────────────────────────────────────

    /// Validated score bundle. Produced by verify_and_build(), stored in AgentProfile.
    public struct ScoreBundle has copy, drop, store {
        brier_score: u64,   // (1 - Brier) * SCALE, higher is better
        pnl_norm:    u64,   // sigmoid(PnL/position) * SCALE
        drawdown:    u64,   // max adverse excursion / position * SCALE, lower is better
        composite:   u64,   // weighted composite C * SCALE
    }

    // ── public functions ──────────────────────────────────────────────────────

    /// Accept Worker-submitted score components, verify internal consistency,
    /// and return a validated ScoreBundle.
    ///
    /// Called during agent_profile::record_score() after reveal.
    /// Worker submits all four values; contract verifies composite formula.
    public fun verify_and_build(
        cfg:         &MarketConfig,
        brier_score: u64,
        pnl_norm:    u64,
        drawdown:    u64,
        composite:   u64,
    ): ScoreBundle {
        // All components must be in [0, SCALE]
        assert!(brier_score <= SCALE, E_SCORE_OUT_OF_RANGE);
        assert!(pnl_norm    <= SCALE, E_SCORE_OUT_OF_RANGE);
        assert!(drawdown    <= SCALE, E_SCORE_OUT_OF_RANGE);
        assert!(composite   <= SCALE, E_SCORE_OUT_OF_RANGE);

        // Verify composite matches formula within tolerance
        let (w_acc, w_pnl, w_dd) = market_config::weights(cfg);
        let expected = compute_composite(w_acc, w_pnl, w_dd, brier_score, pnl_norm, drawdown);
        let diff = if (composite >= expected) {
            composite - expected
        } else {
            expected - composite
        };
        assert!(diff <= COMPOSITE_TOLERANCE, E_COMPOSITE_MISMATCH);

        ScoreBundle { brier_score, pnl_norm, drawdown, composite }
    }

    /// Sigmoid approximation via 13-point piecewise linear table.
    /// Input: signed ratio PnL/position, represented as (ratio_scaled: u64, negative: bool)
    ///        where ratio_scaled = |PnL/position| * SCALE
    /// Output: sigmoid value in [0, SCALE]
    ///
    /// Breakpoints (x * SCALE, sigmoid(x) * SCALE):
    ///   (-6, 25), (-5, 67), (-4, 180), (-3, 474), (-2, 1192),
    ///   (-1, 2689), (0, 5000), (1, 7311), (2, 8808), (3, 9526),
    ///   (4, 9820),  (5, 9933), (6, 9975)
    /// Piecewise linear sigmoid. No recursion — Move forbids it.
    /// Positive branch is computed directly; negative branch mirrors via SCALE - pos.
    public fun sigmoid(ratio_scaled: u64, negative: bool): u64 {
        // Breakpoint x-values (scaled by SCALE = 10_000; 10_000 = x of 1.0)
        let xs     = vector[0u64, 10_000, 20_000, 30_000, 40_000, 50_000, 60_000];
        // sigmoid(x) * SCALE at each positive breakpoint
        let pos_ys = vector[5_000u64, 7_311, 8_808, 9_526, 9_820, 9_933, 9_975];

        // Compute positive value first
        let pos = if (ratio_scaled >= 60_000) {
            9_975
        } else {
            // Linear scan to find segment
            let mut i = 0u64;
            while (i < 5 && ratio_scaled >= *vector::borrow(&xs, i + 1)) {
                i = i + 1;
            };
            let x0 = *vector::borrow(&xs, i);
            let x1 = *vector::borrow(&xs, i + 1);
            let y0 = *vector::borrow(&pos_ys, i);
            let y1 = *vector::borrow(&pos_ys, i + 1);
            // Linear interpolation
            y0 + (y1 - y0) * (ratio_scaled - x0) / (x1 - x0)
        };

        // Mirror for negative input: sigmoid(-x) = 1 - sigmoid(x)
        if (negative) { SCALE - pos } else { pos }
    }

    // ── getters on ScoreBundle ────────────────────────────────────────────────

    public fun composite(s: &ScoreBundle): u64   { s.composite }
    public fun brier_score(s: &ScoreBundle): u64 { s.brier_score }
    public fun pnl_norm(s: &ScoreBundle): u64    { s.pnl_norm }
    public fun drawdown(s: &ScoreBundle): u64     { s.drawdown }

    // ── internal ──────────────────────────────────────────────────────────────

    fun compute_composite(
        w_acc: u64, w_pnl: u64, w_dd: u64,
        brier_score: u64, pnl_norm: u64, drawdown: u64,
    ): u64 {
        (w_acc * brier_score + w_pnl * pnl_norm + w_dd * (SCALE - drawdown)) / SCALE
    }
}
