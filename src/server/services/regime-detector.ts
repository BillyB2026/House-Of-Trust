import {
  MarketRegime,
  type RegimeSignal,
  type RegimeState,
} from "../domain/regime";

/**
 * Market regime detector (owner direction, Task 6; plan §4).
 *
 * Regime-deteksjon er IKKE en black-box LLM. Den er deterministiske
 * signal som ejeren kan revidere — momentum, trend, drawdown.
 *
 * This detector now uses LIVE CoinGecko momentum data (30d/90d/200d
 * price-change percentages + ATH drawdown) as the PRIMARY signal source.
 * The old synthetic-history path is kept as a FALLBACK for when CoinGecko
 * is unreachable.
 *
 * Best practices for crypto regime detection (implemented below):
 *   1. BTC-anchored — BTC drives the crypto market. The regime call is
 *      primarily a BTC call, confirmed by ETH.
 *   2. Exclude stablecoins — stable assets (USDC/USDT/DAI/FRAX/RLUSD/
 *      stETH/rETH/cbETH) have ~$1.00 pegs and carry ZERO market-regime
 *      information. Including them dilutes every signal toward neutral.
 *   3. Multi-timeframe momentum — 30d (short), 90d (medium), 200d (trend).
 *      The 200d is the SMA-200 proxy: above 0% = bull trend, below = bear.
 *   4. Drawdown from ATH — deep drawdowns (> -40%) are bear territory
 *      regardless of short-term bounces.
 *   5. ETH confirmation — if ETH agrees with BTC, confidence rises; if
 *      they disagree, the call is weaker (transitional).
 *
 * Signal weighting:
 *   BTC 200d momentum  : weight 2.0 (trend is king)
 *   BTC 90d momentum  : weight 1.5 (medium-term direction)
 *   BTC 30d momentum  : weight 1.0 (short-term, noisier)
 *   BTC drawdown ATH  : weight 1.5 (structural damage check)
 *   ETH 90d momentum  : weight 1.0 (confirmation from #2 crypto)
 *   Total weight      : 7.0
 *
 * Regime call:
 *   bull > bear AND confidence ≥ 0.30 → Bull
 *   bear > bull AND confidence ≥ 0.30 → Bear
 *   |bull - bear| < 1.0 (near-tie)    → Transitional
 *   otherwise (weak/conflicting)       → Ranging
 *
 * Confidence = |bullWeight - bearWeight| / totalWeight.
 */

/**
 * Live momentum + drawdown metrics for one asset, from CoinGecko.
 * All values are percentages (e.g. 12.5 = +12.5%). Null = CoinGecko
 * had no data for this asset/timeframe.
 */
export interface RegimeMetrics {
  assetId: string;
  /** 30-day return (%). Short-term momentum. */
  pct30d: number | null;
  /** 90-day return (%). Medium-term direction. */
  pct90d: number | null;
  /** 200-day return (%). Long-term trend (SMA-200 proxy). */
  pct200d: number | null;
  /** Worst peak-to-trough drawdown in the 200d window (%). Positive number. */
  maxDrawdown: number | null;
}

/**
 * One observed mark, with optional history. Used by the OLD history-based
 * detection path (fallback when live metrics are unavailable).
 */
export interface RegimeMark {
  assetId: string;
  price: string;
  history?: { t: Date; price: string }[];
  /** Optional live metrics — when present, the detector uses these instead
   * of the history array. */
  metrics?: RegimeMetrics;
}

/**
 * The detector interface. Two methods: one for live metrics (primary),
 * one for marks (fallback). The advisory route calls `detectWithMetrics`
 * when CoinGecko data is available; falls back to `detect` otherwise.
 */
export interface MarketRegimeDetector {
  detect(marks: RegimeMark[]): RegimeState;
  detectWithMetrics(assetIds: string[], metrics: Record<string, RegimeMetrics>): RegimeState;
}

// ---------------------------------------------------------------------------
// Stable assets — EXCLUDED from regime detection.
// ---------------------------------------------------------------------------

/**
 * Assets excluded from regime detection. Stablecoins and liquid staking
 * receipts trade ~1:1 with their peg — their price carries no market-regime
 * information. Including them dilutes every signal toward neutral and was
 * the root cause of the "always ranging/transitional" bug.
 */
const REGIME_EXCLUDED_ASSETS: Readonly<Set<string>> = new Set([
  "usdc", "usdt", "dai", "frax", "rlusd",
  "steth", "reth", "cbeth",
]);

// ---------------------------------------------------------------------------
// Signal thresholds.
// ---------------------------------------------------------------------------

/** Momentum thresholds (percentages). Above/below → bull/bear. */
const MOMENTUM_THRESHOLDS = {
  // Short-term (30d): ±5% is noise; beyond that it's a signal.
  shortBull: 5,
  shortBear: -5,
  // Medium-term (90d): ±10% separates trend from chop.
  mediumBull: 10,
  mediumBear: -10,
  // Long-term (200d = SMA-200 proxy): sign is what matters.
  // > 0% = above 200d-ago price = bull trend. < 0% = bear trend.
  longBull: 0,
  longBear: 0,
};

/** Drawdown-from-ATH thresholds. */
const DRAWDOWN_THRESHOLDS = {
  // -20% from ATH = healthy pullback (neutral). Beyond -20% = bearish.
  bearThreshold: -20,
  // -40% from ATH = deep bear (strong bear signal).
  deepBearThreshold: -40,
};

/** Signal weights. */
const WEIGHTS = {
  btcLong: 2.0, // 200d trend (king)
  btcMedium: 1.5, // 90d direction
  btcShort: 1.0, // 30d momentum (noisier)
  btcDrawdown: 1.5, // structural damage
  ethConfirm: 1.0, // ETH confirmation
};

/** Confidence threshold for a definitive regime call. Below this → ranging/transitional. */
const CONFIDENCE_THRESHOLD = 0.30;
/** Near-tie threshold. If |bull - bear| < this → transitional. */
const NEAR_TIE_THRESHOLD = 1.0;

// ---------------------------------------------------------------------------
// DemoRegimeDetector — live metrics primary, history fallback.
// ---------------------------------------------------------------------------

export class DemoRegimeDetector implements MarketRegimeDetector {
  /**
   * PRIMARY detection path — live CoinGecko momentum + drawdown metrics.
   *
   * ALWAYS uses BTC as the anchor, regardless of what assets the trust
   * holds. BTC is the crypto market's regime barometer — you don't need
   * to hold BTC to use it as the market indicator. The trust's actual
   * holdings determine the allocation advice, but the regime call is
   * always a BTC call (confirmed by ETH if available).
   *
   * Filters out stablecoins (they carry no regime information), then
   * reads BTC's metrics from the `metrics` map (which the caller
   * populates from CoinGecko regardless of trust holdings).
   */
  detectWithMetrics(
    assetIds: string[],
    metrics: Record<string, RegimeMetrics>,
  ): RegimeState {
    const observedAt = new Date();

    // BTC is ALWAYS the regime anchor — even if the trust doesn't hold BTC.
    // The caller (trust-book.ts) always fetches BTC history from CoinGecko
    // and populates metrics["btc"] regardless of what's in the trust.
    const anchorMetrics = metrics["btc"];
    if (!anchorMetrics) {
      return {
        regime: MarketRegime.Ranging,
        confidence: 0,
        signals: [],
        observedAt,
        summary:
          "Ranging (default). BTC live metrics unavailable (CoinGecko unreachable); cannot assess regime.",
      };
    }

    const signals: RegimeSignal[] = [];
    const anchorLabel = "BTC";

    // 1. BTC 200d momentum (trend — the SMA-200 proxy).
    const longDir = this.momentumDirection(
      anchorMetrics.pct200d,
      MOMENTUM_THRESHOLDS.longBull,
      MOMENTUM_THRESHOLDS.longBear,
    );
    signals.push({
      name: "btc-trend-200d",
      direction: longDir,
      evidence: `BTC 200d return ${this.fmtPct(anchorMetrics.pct200d)} — ${longDir === "bull" ? "above" : longDir === "bear" ? "below" : "at"} 200d-ago price (SMA-200 proxy).`,
      weight: WEIGHTS.btcLong,
    });

    // 2. BTC 90d momentum (medium-term direction).
    const medDir = this.momentumDirection(
      anchorMetrics.pct90d,
      MOMENTUM_THRESHOLDS.mediumBull,
      MOMENTUM_THRESHOLDS.mediumBear,
    );
    signals.push({
      name: "btc-momentum-90d",
      direction: medDir,
      evidence: `BTC 90d return ${this.fmtPct(anchorMetrics.pct90d)}.`,
      weight: WEIGHTS.btcMedium,
    });

    // 3. BTC 30d momentum (short-term, noisier).
    const shortDir = this.momentumDirection(
      anchorMetrics.pct30d,
      MOMENTUM_THRESHOLDS.shortBull,
      MOMENTUM_THRESHOLDS.shortBear,
    );
    signals.push({
      name: "btc-momentum-30d",
      direction: shortDir,
      evidence: `BTC 30d return ${this.fmtPct(anchorMetrics.pct30d)}.`,
      weight: WEIGHTS.btcShort,
    });

    // 4. BTC drawdown from peak (structural damage check).
    const ddDir = this.drawdownDirection(anchorMetrics.maxDrawdown);
    signals.push({
      name: "btc-drawdown-peak",
      direction: ddDir,
      evidence: `BTC max drawdown ${this.fmtPct(anchorMetrics.maxDrawdown)} in 200d window — ${ddDir === "bear" ? "deep drawdown (> 20%)" : "healthy"}.`,
      weight: WEIGHTS.btcDrawdown,
    });

    // 5. ETH confirmation — check if ETH metrics are available
    // (the caller may fetch ETH history too; for now ETH is informational
    // only when present in the metrics map).
    const ethMetrics = metrics["eth"];
    if (ethMetrics && ethMetrics.pct90d != null) {
      const ethDir = this.momentumDirection(
        ethMetrics.pct90d,
        MOMENTUM_THRESHOLDS.mediumBull,
        MOMENTUM_THRESHOLDS.mediumBear,
      );
      signals.push({
        name: "eth-confirmation-90d",
        direction: ethDir,
        evidence: `ETH 90d return ${this.fmtPct(ethMetrics.pct90d)} — ${ethDir === longDir ? "confirms" : "diverges from"} BTC trend.`,
        weight: WEIGHTS.ethConfirm,
      });
    }

    // Vote.
    const bullWeight = signals
      .filter((s) => s.direction === "bull")
      .reduce((a, s) => a + s.weight, 0);
    const bearWeight = signals
      .filter((s) => s.direction === "bear")
      .reduce((a, s) => a + s.weight, 0);
    const totalWeight = signals.reduce((a, s) => a + s.weight, 0);
    const confidence =
      totalWeight === 0 ? 0 : Math.abs(bullWeight - bearWeight) / totalWeight;

    let regime: MarketRegime;
    const diff = bullWeight - bearWeight;
    if (Math.abs(diff) < NEAR_TIE_THRESHOLD || confidence < 0.05) {
      regime = confidence < 0.05 ? MarketRegime.Ranging : MarketRegime.Transitional;
    } else if (confidence < CONFIDENCE_THRESHOLD) {
      regime = MarketRegime.Transitional;
    } else if (diff > 0) {
      regime = MarketRegime.Bull;
    } else {
      regime = MarketRegime.Bear;
    }

    const summary = `${regime} regime on ${anchorLabel}: bull-weight ${bullWeight.toFixed(1)}, bear-weight ${bearWeight.toFixed(1)}, confidence ${(confidence * 100).toFixed(0)}%. BTC is the market anchor (stablecoins excluded).`;

    return { regime, confidence, signals, observedAt, summary };
  }

  /**
   * FALLBACK detection path — old history-based algorithm.
   *
   * Used when CoinGecko is unreachable (source="fallback"). Picks BTC/ETH
   * from the marks and computes signals from the synthetic history arrays.
   * Still excludes stablecoins from the reference selection.
   */
  detect(marks: RegimeMark[]): RegimeState {
    const observedAt = new Date();

    // Filter out stablecoins — they must NEVER be the regime reference.
    const nonStableMarks = marks.filter(
      (m) => !REGIME_EXCLUDED_ASSETS.has(m.assetId.toLowerCase()),
    );

    const ref = this.pickReference(nonStableMarks);

    if (!ref) {
      return {
        regime: MarketRegime.Ranging,
        confidence: 0,
        signals: [],
        observedAt,
        summary:
          "No non-stable marks supplied; defaulting to ranging with no signals.",
      };
    }

    if (!ref.history || ref.history.length < 2) {
      const signals: RegimeSignal[] = [
        {
          name: "sma-200",
          direction: "neutral",
          evidence: `${ref.assetId}: no history supplied; SMA-200 not computable.`,
          weight: 1,
        },
        {
          name: "momentum-30",
          direction: "neutral",
          evidence: `${ref.assetId}: no history supplied; 30-day momentum not computable.`,
          weight: 1,
        },
        {
          name: "realized-vol",
          direction: "neutral",
          evidence:
            "60d annualized realized vol assumed ~55% (crypto-typical; no live data).",
          weight: 0.5,
        },
      ];
      return {
        regime: MarketRegime.Ranging,
        confidence: 0,
        signals,
        observedAt,
        summary: `Ranging (fallback). Reference ${ref.assetId} @ ${ref.price}; CoinGecko unreachable, no live history.`,
      };
    }

    // Real history → real signals (old algorithm, unchanged).
    const history = ref.history;
    const currentPrice = Number(ref.price);
    const prices = history.map((h) => Number(h.price));
    const ts = history.map((h) => h.t.getTime());

    const signals: RegimeSignal[] = [];

    const sma = prices.reduce((a, b) => a + b, 0) / prices.length;
    const smaDirection: RegimeSignal["direction"] =
      currentPrice > sma ? "bull" : currentPrice < sma ? "bear" : "neutral";
    signals.push({
      name: "sma-200",
      direction: smaDirection,
      evidence: `${ref.assetId} price ${currentPrice.toFixed(2)} vs SMA(${history.length}) ${sma.toFixed(2)}${
        history.length < 30 ? " (noisy: <30 samples)" : ""
      }`,
      weight: 1,
    });

    const first = prices[0];
    const last = prices[prices.length - 1];
    const logReturn = Math.log(last / first);
    const momentumDirection: RegimeSignal["direction"] =
      logReturn > 0.05 ? "bull" : logReturn < -0.05 ? "bear" : "neutral";
    signals.push({
      name: "momentum-30",
      direction: momentumDirection,
      evidence: `${ref.assetId} log-return ${(logReturn * 100).toFixed(2)}% over ${this.windowDays(ts)}d window.`,
      weight: 1,
    });

    const dailyReturns: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      if (prices[i - 1] > 0) {
        dailyReturns.push(Math.log(prices[i] / prices[i - 1]));
      }
    }
    const vol = this.annualizedVol(dailyReturns);
    signals.push({
      name: "realized-vol",
      direction: "neutral",
      evidence: `${ref.assetId} realized vol ${vol.toFixed(1)}% annualized over ${dailyReturns.length + 1} samples.`,
      weight: 0.5,
    });

    let peak = prices[0];
    let maxDd = 0;
    for (const p of prices) {
      if (p > peak) peak = p;
      const dd = (peak - p) / peak;
      if (dd > maxDd) maxDd = dd;
    }
    const ddDirection: RegimeSignal["direction"] =
      maxDd > 0.25 ? "bear" : "neutral";
    signals.push({
      name: "drawdown-from-peak",
      direction: ddDirection,
      evidence: `${ref.assetId} drawdown from peak ${(maxDd * 100).toFixed(2)}%${maxDd > 0.25 ? " (> 25% bear threshold)" : ""}.`,
      weight: 1,
    });

    const bullWeight = signals
      .filter((s) => s.direction === "bull")
      .reduce((a, s) => a + s.weight, 0);
    const bearWeight = signals
      .filter((s) => s.direction === "bear")
      .reduce((a, s) => a + s.weight, 0);
    const totalWeight = signals.reduce((a, s) => a + s.weight, 0);
    const confidence =
      totalWeight === 0 ? 0 : Math.abs(bullWeight - bearWeight) / totalWeight;

    let regime: MarketRegime;
    if (Math.abs(bullWeight - bearWeight) < 0.5 || confidence < 0.15) {
      regime = confidence < 0.05 ? MarketRegime.Ranging : MarketRegime.Transitional;
    } else if (bullWeight > bearWeight) {
      regime = MarketRegime.Bull;
    } else {
      regime = MarketRegime.Bear;
    }

    const summary = `${regime} regime detected on ${ref.assetId} (fallback): bull-weight ${bullWeight.toFixed(2)}, bear-weight ${bearWeight.toFixed(2)}, confidence ${(confidence * 100).toFixed(0)}%. CoinGecko was unreachable; using synthetic history.`;

    return { regime, confidence, signals, observedAt, summary };
  }

  // -----------------------------------------------------------------------
  // Helpers.
  // -----------------------------------------------------------------------

  /**
   * Pick the reference asset for the fallback path. Prefer BTC, fall
   * back to ETH, fall back to WBTC, fall back to the first non-stable
   * mark. Stablecoins are NEVER picked — they've been filtered out
   * before this method is called, but we double-check for safety.
   */
  private pickReference(marks: RegimeMark[]): RegimeMark | undefined {
    const nonStable = marks.filter(
      (m) => !REGIME_EXCLUDED_ASSETS.has(m.assetId.toLowerCase()),
    );
    return (
      nonStable.find((m) => m.assetId.toLowerCase() === "btc") ??
      nonStable.find((m) => m.assetId.toLowerCase() === "eth") ??
      nonStable.find((m) => m.assetId.toLowerCase() === "wbtc") ??
      nonStable[0]
    );
  }

  /** Classify a momentum percentage as bull/bear/neutral. */
  private momentumDirection(
    pct: number | null,
    bullThreshold: number,
    bearThreshold: number,
  ): RegimeSignal["direction"] {
    if (pct == null || !Number.isFinite(pct)) return "neutral";
    if (pct > bullThreshold) return "bull";
    if (pct < bearThreshold) return "bear";
    return "neutral";
  }

  /** Classify drawdown (%) as bear/neutral. Positive number (e.g. 35 = 35% drawdown). */
  private drawdownDirection(
    maxDrawdown: number | null,
  ): RegimeSignal["direction"] {
    if (maxDrawdown == null || !Number.isFinite(maxDrawdown)) return "neutral";
    // maxDrawdown is positive (e.g. 35 = 35% drawdown from peak).
    if (maxDrawdown > 20) return "bear";
    return "neutral";
  }

  /** Format a percentage for display (null → "unknown"). */
  private fmtPct(pct: number | null): string {
    if (pct == null) return "unknown";
    const sign = pct >= 0 ? "+" : "";
    return `${sign}${pct.toFixed(1)}%`;
  }

  /** Number of days spanned by the history. */
  private windowDays(ts: number[]): number {
    if (ts.length < 2) return 0;
    const ms = Math.abs(ts[ts.length - 1] - ts[0]);
    return Math.round(ms / (1000 * 60 * 60 * 24));
  }

  /** Annualized realized vol. Stdev of daily log-returns × sqrt(365). */
  private annualizedVol(returns: number[]): number {
    if (returns.length < 2) return 0;
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance =
      returns.reduce((a, r) => a + (r - mean) ** 2, 0) /
      (returns.length - 1);
    const stdev = Math.sqrt(variance);
    return stdev * Math.sqrt(365) * 100;
  }
}

/**
 * Factory. The v0 detector is the DemoRegimeDetector; a later phase
 * will swap in a detector that pulls history from the MarketService.
 */
export function createRegimeDetector(): MarketRegimeDetector {
  return new DemoRegimeDetector();
}
