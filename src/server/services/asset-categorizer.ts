/**
 * AssetCategorizer — the data-driven risk-category scorer.
 *
 * Replaces the hardcoded `ASSET_CATEGORIES` lookup table as the PRIMARY
 * categorization method. The static table remains as a FALLBACK when
 * CoinGecko is unreachable.
 *
 * Scoring model (owner direction: "marketcap, alder og volumen"):
 *
 *   Three dimensions, each scored 0-100 (higher = more stable):
 *
 *   1. Market cap (50% weight) — the dominant predictor of crypto-asset
 *      stability. Large caps are harder to manipulate, have deeper order
 *      books, and more institutional holders.
 *
 *      ≥ $100B  → 100   (mega cap: BTC, ETH)
 *      $20B+    → 75    (large cap: SOL, XRP, BNB)
 *      $5B+     → 50    (mid cap: AVAX, LINK)
 *      $1B+     → 25    (small cap: many L2s, DeFi)
 *      < $1B    → 0     (micro/nano cap)
 *      null     → 0     (unknown — safe default is risky)
 *
 *   2. 24h volume (30% weight) — liquidity proxy. High volume means the
 *      position can be exited without slippage blowing through the stop.
 *
 *      ≥ $5B    → 100
 *      $500M+   → 75
 *      $50M+    → 50
 *      $5M+     → 25
 *      < $5M    → 0
 *      null     → 0
 *
 *   3. Age since genesis (20% weight) — track record. An asset that
 *      survived multiple crypto cycles (5+ years) has proven it can
 *      weather drawdowns; a 6-month-old token has not.
 *
 *      ≥ 1825d  → 100   (5+ years)
 *      1095+    → 75    (3-5 years)
 *      730+     → 50    (2-3 years)
 *      365+     → 25    (1-2 years)
 *      < 365    → 0
 *      null     → 0     (unknown age — can't date it, can't trust it)
 *
 *   Composite = mcapScore × 0.50 + volScore × 0.30 + ageScore × 0.20
 *
 *   Category mapping:
 *     ≥ 70   → conservative
 *     40-69  → balanced
 *     < 40   → aggressive
 *
 * Stablecoin override (pre-scoring):
 *   Known stablecoins + liquid staking receipts → ALWAYS `stable`.
 *   These assets trade ~1:1 with their peg and serve as dry powder —
 *   they are not scored on market-cap/vol/age because their risk profile
 *   is peg-risk, not price-risk. The stable set is defined here (not in
 *   the static bankroll table) so the categorizer is self-contained.
 *
 * Why these weights:
 *   Market cap is 50% because it is the single best predictor of crypto-
 *   asset stability — a $100B asset cannot be rug-pulled; a $10M one can.
 *   Volume is 30% because liquidity determines whether you can EXIT at
 *   the marked price (illiquid assets are riskier than their market cap
 *   suggests). Age is 20% — a meaningful but secondary signal, since even
 *   old assets can fail (LUNA was 3 years old when it collapsed).
 *
 * Math caveat: v0 uses JS Number. Production MUST use a fixed-point
 * decimal lib for market-cap arithmetic (these are $1e12-scale numbers).
 * The scores are integer 0-100 so no precision is lost in the scoring
 * itself; only the raw metric display would need decimal lib in prod.
 */

import type { RiskCategory } from "../domain/bankroll";
import { RiskCategory as RC } from "../domain/bankroll";
import type {
  AssetMarketMetrics,
  MarketMetricsMap,
  CategorizationResult,
} from "../lib/asset-metrics";
import { getGenesisDate, ageInDays } from "../lib/asset-metrics";

// ---------------------------------------------------------------------------
// Stablecoin set — always `stable`, never scored.
// ---------------------------------------------------------------------------

/**
 * Assets that are ALWAYS classified as `stable`, regardless of market
 * data. Two groups:
 *
 *   1. Stablecoins (USDC, USDT, DAI, FRAX, RLUSD) — pegged to $1, serve
 *      as dry powder. Their risk is peg-risk (de-peg events), not price-
 *      risk, so market-cap/vol/age scoring does not apply.
 *
 *   2. Liquid staking receipts (stETH, rETH, cbETH) — trade ~1:1 with
 *      ETH and are redeemable 1:1 for ETH. The existing design (see
 *      bankroll.ts JSDoc) classifies these as stable because they are
 *      "dry powder" — unwindable to stables quickly. The categorizer
 *      preserves this semantic choice.
 *
 * This set is deliberately small and conservative. A new "stablecoin"
 * must be added here explicitly — the categorizer does NOT auto-detect
 * stablecoins from price (a price of $1.0 does not prove a stable peg).
 */
const STABLE_ASSETS: Readonly<Set<string>> = new Set([
  "usdc", "usdt", "dai", "frax", "rlusd",
  "steth", "reth", "cbeth",
]);

// ---------------------------------------------------------------------------
// Scoring thresholds.
// ---------------------------------------------------------------------------

/** Market-cap tier boundaries (USD). [tier, score] pairs, evaluated
 * top-down (first match wins). */
const MCAP_TIERS: ReadonlyArray<[number, number]> = [
  [100_000_000_000, 100], // ≥ $100B → 100 (mega: BTC, ETH)
  [20_000_000_000, 75], //   ≥ $20B  → 75  (large: SOL, XRP, BNB)
  [5_000_000_000, 50], //    ≥ $5B   → 50  (mid: AVAX, LINK, DOT)
  [1_000_000_000, 25], //     ≥ $1B   → 25  (small: many L2s, DeFi)
] as const;
/** Below $1B → score 0. Null → score 0. */

/** 24h-volume tier boundaries (USD). */
const VOL_TIERS: ReadonlyArray<[number, number]> = [
  [5_000_000_000, 100], //  ≥ $5B   → 100
  [500_000_000, 75], //     ≥ $500M → 75
  [50_000_000, 50], //      ≥ $50M  → 50
  [5_000_000, 25], //       ≥ $5M   → 25
] as const;
/** Below $5M → score 0. Null → score 0. */

/** Age tier boundaries (days since genesis). */
const AGE_TIERS: ReadonlyArray<[number, number]> = [
  [1825, 100], // ≥ 5 years → 100
  [1095, 75], //   ≥ 3 years → 75
  [730, 50], //     ≥ 2 years → 50
  [365, 25], //      ≥ 1 year  → 25
] as const;
/** Below 365 days → score 0. Null → score 0. */

/** Composite-score → category thresholds. */
const CONSERVATIVE_THRESHOLD = 70;
const BALANCED_THRESHOLD = 40;

/** Scoring weights (must sum to 1.0). */
const WEIGHT_MCAP = 0.50;
const WEIGHT_VOL = 0.30;
const WEIGHT_AGE = 0.20;

// ---------------------------------------------------------------------------
// Scoring functions — pure, no I/O.
// ---------------------------------------------------------------------------

/** Score market cap (USD) on the 0-100 scale. Null → 0. */
function scoreMarketCap(mcapUsd: number | null): number {
  if (mcapUsd == null || !Number.isFinite(mcapUsd)) return 0;
  for (const [threshold, score] of MCAP_TIERS) {
    if (mcapUsd >= threshold) return score;
  }
  return 0; // below $1B
}

/** Score 24h volume (USD) on the 0-100 scale. Null → 0. */
function scoreVolume(volUsd: number | null): number {
  if (volUsd == null || !Number.isFinite(volUsd)) return 0;
  for (const [threshold, score] of VOL_TIERS) {
    if (volUsd >= threshold) return score;
  }
  return 0; // below $5M
}

/** Score age (days since genesis) on the 0-100 scale. Null → 0. */
function scoreAge(ageDays: number | null): number {
  if (ageDays == null || !Number.isFinite(ageDays)) return 0;
  for (const [threshold, score] of AGE_TIERS) {
    if (ageDays >= threshold) return score;
  }
  return 0; // below 365 days
}

/** Map a 0-100 composite score to a RiskCategory. */
function scoreToCategory(score: number): RiskCategory {
  if (score >= CONSERVATIVE_THRESHOLD) return RC.Conservative;
  if (score >= BALANCED_THRESHOLD) return RC.Balanced;
  return RC.Aggressive;
}

// ---------------------------------------------------------------------------
// Categorizer — produces a live category map from market metrics.
// ---------------------------------------------------------------------------

/**
 * Categorize a single asset. Returns the full result (category, score,
 * breakdown, reason) so the UI can show WHY the asset got its category.
 *
 * Pure function (given the metrics + genesis date). No I/O.
 */
export function categorizeAssetByMetrics(
  assetId: string,
  metrics: AssetMarketMetrics,
  now: Date = new Date(),
): CategorizationResult {
  const key = assetId.toLowerCase();

  // Stable override — always stable, never scored.
  if (STABLE_ASSETS.has(key)) {
    return {
      assetId,
      category: RC.Stable,
      score: 100,
      scores: { marketCap: 100, volume: 100, age: 100 },
      metrics: {
        marketCapUsd: metrics.marketCapUsd,
        volume24hUsd: metrics.volume24hUsd,
        ageDays: ageInDays(getGenesisDate(assetId), now),
      },
      reason: `${assetId} is a stablecoin / liquid staking receipt — always classified as stable (dry powder, not scored on mcap/vol/age).`,
      source: "live",
    };
  }

  const genesis = getGenesisDate(assetId);
  const ageDays = ageInDays(genesis, now);

  const mcapScore = scoreMarketCap(metrics.marketCapUsd);
  const volScore = scoreVolume(metrics.volume24hUsd);
  const ageScore = scoreAge(ageDays);

  const composite =
    mcapScore * WEIGHT_MCAP + volScore * WEIGHT_VOL + ageScore * WEIGHT_AGE;
  const score = Math.round(composite);
  const category = scoreToCategory(score);

  const mcapStr = metrics.marketCapUsd != null
    ? `$${formatCompact(metrics.marketCapUsd)}`
    : "unknown";
  const volStr = metrics.volume24hUsd != null
    ? `$${formatCompact(metrics.volume24hUsd)}`
    : "unknown";
  const ageStr = ageDays != null ? `${ageDays}d` : "unknown";

  const reason =
    `${assetId}: market cap ${mcapStr} (score ${mcapScore}), ` +
    `24h volume ${volStr} (score ${volScore}), ` +
    `age ${ageStr} (score ${ageScore}) → ` +
    `composite ${score} → ${category}.`;

  return {
    assetId,
    category,
    score,
    scores: { marketCap: mcapScore, volume: volScore, age: ageScore },
    metrics: {
      marketCapUsd: metrics.marketCapUsd,
      volume24hUsd: metrics.volume24hUsd,
      ageDays,
    },
    reason,
    source: "live",
  };
}

/**
 * Build a complete category map for a set of assets.
 *
 * Takes the live market-metrics map (from CoinGecko) and produces:
 *   - `categoryMap` : Record<lowercase assetId, RiskCategory> — the
 *                     override map consumed by `categorizeAsset` in
 *                     bankroll.ts.
 *   - `details`     : Record<lowercase assetId, CategorizationResult> —
 *                     per-asset score breakdown for UI/debugging.
 *
 * Assets with no live metrics (CoinGecko had no data) get score 0 across
 * all dimensions → aggressive. This is the safe default: if we can't
 * measure an asset's market data, we can't vouch for its stability.
 */
export function buildCategoryMap(
  assetIds: string[],
  marketMetrics: MarketMetricsMap,
  now: Date = new Date(),
): {
  categoryMap: Record<string, RiskCategory>;
  details: Record<string, CategorizationResult>;
} {
  const categoryMap: Record<string, RiskCategory> = {};
  const details: Record<string, CategorizationResult> = {};

  for (const assetId of assetIds) {
    const key = assetId.toLowerCase();
    const metrics: AssetMarketMetrics =
      marketMetrics[key] ?? {
        marketCapUsd: null,
        volume24hUsd: null,
        priceUsd: null,
      };
    const result = categorizeAssetByMetrics(assetId, metrics, now);
    categoryMap[key] = result.category;
    details[key] = result;
  }

  return { categoryMap, details };
}

// ---------------------------------------------------------------------------
// Formatting helper.
// ---------------------------------------------------------------------------

/**
 * Format a USD amount compactly: $1.2T, $350B, $15B, $800M, $2.5M.
 * Used in the reason strings so they are readable in the UI.
 */
function formatCompact(usd: number): string {
  if (usd >= 1e12) return `${(usd / 1e12).toFixed(1)}T`;
  if (usd >= 1e9) return `${(usd / 1e9).toFixed(0)}B`;
  if (usd >= 1e6) return `${(usd / 1e6).toFixed(0)}M`;
  if (usd >= 1e3) return `${(usd / 1e3).toFixed(0)}K`;
  return usd.toFixed(0);
}

// ---------------------------------------------------------------------------
// Re-exports.
// ---------------------------------------------------------------------------

export { STABLE_ASSETS };
