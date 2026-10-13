/**
 * Asset metrics — genesis dates + market-data types for the live
 * data-driven categorizer (replaces the hardcoded ASSET_CATEGORIES table
 * as the PRIMARY categorization method).
 *
 * Design (owner direction):
 *   "find en mere real time og mere forudsiglig/nøjagtig måde at
 *    kategorisere conservative, balanced og aggressive aktiver. Det skal
 *    benytte best practices som marketcap, alder og volumen"
 *
 * Two data sources:
 *   1. Market cap + 24h volume: LIVE from CoinGecko `/coins/markets`
 *      (60s cache, same pattern as coingecko-client.ts). Fetched once
 *      per advisory refresh, shared across all positions.
 *   2. Genesis date (age): STATIC table. Genesis dates are historical
 *      facts that never change — no API call needed. Unknown assets
 *      get age=null → age score=0 → pushes toward aggressive (the safe
 *      default for unproven assets).
 *
 * The categorizer (asset-categorizer.ts) combines these three dimensions
 * into a 0-100 composite score and maps it to a RiskCategory. The result
 * is a live category map that overrides the static ASSET_CATEGORIES
 * fallback table in bankroll.ts.
 */

/**
 * Genesis-date table for known assets.
 *
 * These are the dates each asset's blockchain went live (genesis block /
 * mainnet launch), NOT the CoinGecko listing date. For risk purposes,
 * "how long has this asset existed as a tradeable on-chain asset" is the
 * relevant measure of track record.
 *
 * Sources: official project docs / blockchain explorers. These are stable
 * historical facts — they never change, so a static table is correct and
 * no API call is needed.
 *
 * Assets NOT in this table get `null` → the categorizer treats unknown
 * age as score 0 (pushes toward aggressive). This is the safe default: an
 * asset we can't date is an asset we can't trust.
 */
const GENESIS_DATES: Readonly<Record<string, string>> = Object.freeze({
  // stablecoins
  usdc: "2018-10-08", // Centre Consortium launch
  usdt: "2014-10-06", // Tether launch on Omni
  dai: "2017-12-27", // MakerDAO DAI launch
  frax: "2020-12-21", // Frax Finance launch
  rlusd: "2024-12-17", // Ripple RLUSD launch
  // liquid staking receipts
  steth: "2020-12-31", // Lido stETH launch
  reth: "2022-05-18", // Rocket Pool rETH mainnet
  cbeth: "2022-06-16", // Coinbase cbETH launch
  // conservative (blue-chips)
  btc: "2009-01-03", // Bitcoin genesis block
  wbtc: "2019-01-31", // Wrapped Bitcoin launch
  eth: "2015-07-30", // Ethereum mainnet (frontier)
  // balanced — established L1/L2 + DeFi blue-chips
  sol: "2020-03-16", // Solana mainnet beta
  arb: "2023-03-16", // Arbitrum One (ARB token airdrop / TGE)
  op: "2022-05-31", // Optimism (OP token airdrop / TGE)
  avax: "2020-09-21", // Avalanche mainnet
  uni: "2020-09-17", // Uniswap UNI token launch
  aave: "2020-10-01", // Aave V2 + AAVE token
  ldo: "2020-12-19", // Lido LDO token launch
  // XRP-ecosystem L1s
  xrp: "2012-06-13", // XRP Ledger launch
  xlm: "2014-07-31", // Stellar network launch
  flr: "2023-07-14", // Flare network mainnet (FTSO)
  // ISO 20022-aligned tokens (per eier direction)
  xdc: "2019-05-31", // XinFin / XDC Network mainnet
  iota: "2016-06-13", // IOTA mainnet launch
  hbar: "2019-09-16", // Hedera mainnet open access
  xmr: "2014-04-18", // Monero launch
  // aggressive (demo)
  doge: "2013-12-08", // Dogecoin launch
});

/** Fixed reference date — used so age calculations are deterministic in
 * tests and replays. In the advisor, we use `new Date()` for live runs
 * but the categorizer accepts an optional `now` param for testability. */
const DEFAULT_NOW = new Date("2026-10-09T12:00:00.000Z");

/**
 * Get the genesis date for an asset. Case-insensitive. Returns null for
 * unknown assets — the categorizer treats null age as score 0.
 *
 * Pure function; no side-effects or I/O. Safe to call from server + seed.
 */
export function getGenesisDate(assetId: string): Date | null {
  const iso = GENESIS_DATES[assetId.toLowerCase()];
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Compute age in days from a genesis date to `now` (default: the fixed
 * reference date). Returns null if genesis is null (unknown asset).
 *
 * Rounded down — 730.9 days = 730 days. The age-score tiers are wide
 * enough (365-day bands) that sub-day precision is irrelevant.
 */
export function ageInDays(
  genesis: Date | null,
  now: Date = DEFAULT_NOW,
): number | null {
  if (!genesis) return null;
  const ms = now.getTime() - genesis.getTime();
  if (ms <= 0) return 0; // future-dated genesis → 0 (shouldn't happen)
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

/**
 * Market metrics for one asset — the live data the categorizer needs.
 *
 *   - `marketCapUsd`   : current market capitalisation in USD. The
 *                         strongest single predictor of crypto-asset
 *                         stability (large cap = harder to manipulate,
 *                         deeper order books, more institutional holders).
 *   - `volume24hUsd`   : 24-hour trading volume in USD. Liquidity proxy
 *                         — high volume means the position can be exited
 *                         without moving the market.
 *   - `priceUsd`       : current USD price (same as what fetchLivePrices
 *                         returns — included here so the categorizer has
 *                         everything in one struct).
 *
 * All fields are `number | null` — null means "CoinGecko had no data for
 * this asset". The categorizer treats null as score 0 (the safe default
 * for unknown assets).
 */
export interface AssetMarketMetrics {
  marketCapUsd: number | null;
  volume24hUsd: number | null;
  priceUsd: number | null;
}

/**
 * A map of assetId (lowercase) → market metrics. Produced by the
 * CoinGecko client (extended to fetch `/coins/markets`) and consumed
 * by the categorizer.
 */
export type MarketMetricsMap = Record<string, AssetMarketMetrics>;

/**
 * The full categorization result for one asset — the category, the
 * composite score, the per-dimension breakdown, and a human-readable
 * reason. Surfaced so the UI can show WHY an asset got its category
 * (transparency = the owner can audit the data-driven call).
 */
export interface CategorizationResult {
  assetId: string;
  category: RiskCategory;
  /** 0-100 composite score. Higher = more conservative/stable. */
  score: number;
  /** Per-dimension scores (0-100 each). */
  scores: {
    marketCap: number;
    volume: number;
    age: number;
  };
  /** The raw metrics used (null = unknown/not available). */
  metrics: {
    marketCapUsd: number | null;
    volume24hUsd: number | null;
    ageDays: number | null;
  };
  /** Why this category — one sentence with the numbers. */
  reason: string;
  /** "live" if metrics came from CoinGecko; "fallback" if static table. */
  source: "live" | "fallback";
}

/** Re-export RiskCategory so callers can import everything from here. */
import type { RiskCategory } from "../domain/bankroll";
