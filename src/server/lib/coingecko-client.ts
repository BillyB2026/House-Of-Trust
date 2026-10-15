/**
 * CoinGecko live price client (Task 36 — Live market data integration).
 *
 * House-arkitekturen har inntil nå brukt hardkodete REFERENCE_PRICES for
 * NAV / dry-powder / sleeve-allokering. Denne modulen henter live USD-priser
 * fra CoinGeckos gratis `/simple/price`-endepunkt (ingen API-nøkkel kreves
 * for basisbruk) og faller tilbake på REFERENCE_PRICES hvis CoinGecko er
 * nede eller rate-limiter.
 *
 * Strategi (plan §6; owner direction Task 35):
 *   - Cache: modul-nivå in-memory cache, 60 sekunders TTL. Lever så lenge
 *     Node-isolatet lever — OK for v1 dev. Produksjon bytter til Redis.
 *   - Dedup: samtidige kall deler samme fetch-promise (`pendingPromise`)
 *     slik at en burst av requests bare utløser ÉN HTTP-forespørsel.
 *   - Fallback: hvis fetch feiler (nettverksfeil, 429, 5xx, timeout),
 *     returneres REFERENCE_PRICES med `source: "fallback"`. Caller får
 *     ALLTID et svar — aldri kast til caller.
 *   - Per-asset fallback: assets som ikke er på CoinGecko (f.eks. rlusd)
 *     bruker reference-pris (1.0 for stablecoins).
 *
 * API-detaljer:
 *   - Endpoint: https://api.coingecko.com/api/v3/coins/markets
 *   - Query: ?vs_currency=usd&ids=bitcoin,ethereum,...&order=market_cap_desc&per_page=250&page=1&sparkline=false
 *   - Rate limit: ~15 calls/min gratis tier. Vår 60s cache → max 1 call/min.
 *   - Ingen API-nøkkel for gratis tier. Hvis CoinGecko senere krever det,
 *     les `COINGECKO_API_KEY` env og bruk header `x-cg-demo-api-key`.
 *   - Returns: array of { id, symbol, current_price, market_cap, total_volume, ... }.
 *     We parse it into a price-map + market-cap-map + volume-map keyed by
 *     lowercase assetId (via the reverse of COINGECKO_IDS).
 *
 * Math caveat: v0 bruker JS Number. Produksjon MÅ bruke fixed-point decimal
 * lib. Ikke installer i v0 — dette er den eksplisitte JSDoc-advarselen.
 */

import { REFERENCE_PRICES } from "./reference-prices";

/**
 * CoinGecko ID-mapping for alle assets i House-universet.
 *
 * Nøkkel = lowercase assetId (samme case som REFERENCE_PRICES). Verdi =
 * CoinGecko platform-id brukt i `/simple/price?ids=<...>`-spørringen.
 *
 * Gjeldende CoinGecko-mapping (verify mot https://api.coingecko.com/api/v3/coins/list
 * hvis en id endrer seg — stable, men sjekk ved støre CoinGecko-reorgs).
 *
 * Assets UTEN mapping (rlusd): ikke sendes til CoinGecko; fallback til
 * reference-pris (1.0 for stablecoins) gjelder.
 */
const COINGECKO_IDS: Readonly<Record<string, string>> = Object.freeze({
  btc: "bitcoin",
  wbtc: "wrapped-bitcoin",
  eth: "ethereum",
  usdc: "usd-coin",
  usdt: "tether",
  dai: "dai",
  frax: "frax",
  xrp: "ripple",
  xlm: "stellar",
  flr: "flare-networks",
  wflr: "wrapped-flare", // Wrapped Flare
  sol: "solana",
  arb: "arbitrum",
  avax: "avalanche-2",
  op: "optimism",
  uni: "uniswap",
  aave: "aave",
  ldo: "lido-dao",
  doge: "dogecoin",
  steth: "staked-ether",
  reth: "rocket-pool-eth",
  // cbETH — on CoinGecko the platform id is "coinbase-wrapped-eth"
  // (NOT "coinbase-wrapped-btc"; the latter is cbBTC). v1 demo uses cbETH.
  cbeth: "coinbase-wrapped-eth",
  // ISO 20022-aligned tokens (per eier direction)
  xdc: "xdce-crowd-sale", // XDC Network (verified via /search)
  iota: "iota",
  hbar: "hedera-hashgraph",
  xmr: "monero",
  // rlusd: not yet on CoinGecko — falls back to reference price $1.00.
});

/**
 * Cache-TTL i millisekunder. 60s = 1 call/min, godt under CoinGeckos
 * gratis-tier rate limit (~15/min).
 */
const CACHE_TTL_MS = 60 * 1000;

/**
 * Fetch-timeout i millisekunder. 5s — hvis CoinGecko ikke svarer innen
 * da, bruk fallback. Vi vil aldri at BFF-en skal henge på en treg
 * upstream.
 */
const FETCH_TIMEOUT_MS = 5 * 1000;

/**
 * Resultat av `fetchLivePrices`. Inneholder en pris-map (lowercase assetId
 * → USD pris), source-flagg (live / fallback), og timestamp for når
 * dataene ble hentet (cache-tid, ikke nåtid, så caller vet hvor fersk
 * prisen er).
 */
export interface LivePriceResult {
  /** Pris-map: lowercase assetId → USD pris. Inkluderer ALLE assets fra
   * REFERENCE_PRICES, med live-pris der CoinGecko har data, reference-pris
   * ellers. */
  prices: Record<string, number>;
  /** Market-cap-map: lowercase assetId → USD market cap. Null-entries
   * are omitted (use `in` operator to check). Populated from the same
   * `/coins/markets` call as prices. Used by the asset-categorizer for
   * the data-driven risk-category scoring. */
  marketCaps: Record<string, number>;
  /** 24h-volume-map: lowercase assetId → USD 24h volume. Same source as
   * marketCaps. Used by the asset-categorizer. */
  volumes: Record<string, number>;
  /** Momentum + drawdown metrics for the regime detector. Per asset:
   * 30d/90d/200d price-change percentages + ATH drawdown percentage.
   * Populated from CoinGecko `/coins/markets` (same call as prices).
   * Used by the regime detector to vote bull/bear/neutral signals. */
  momentum: Record<
    string,
    {
      pct30d: number | null;
      pct90d: number | null;
      pct200d: number | null;
      athChangePct: number | null;
    }
  >;
  /** "live" hvis CoinGecko-kallet lyktes; "fallback" hvis vi falt tilbake til
   * REFERENCE_PRICES. UI-en (Task 38) bruker dette til å vise en Live-pulse
   * badge vs en Fallback-badge. */
  source: "live" | "fallback";
  /** Tidspunktet prisen ble hentet (cache-tid, ikke nåtid). For UI-display. */
  fetchedAt: Date;
}

/**
 * Cache-state — modul-nivå, lever så lenge Node-isolatet lever.
 *
 *   - `cachedResult`     : sist vellykkede resultat (live ELLER fallback).
 *   - `cacheExpiry`      : timestamp for når cachedResult går ut på tid.
 *   - `pendingPromise`   : pågående fetch (for dedup). Null når ingen
 *                          pågående fetch.
 */
let cachedResult: LivePriceResult | null = null;
let cacheExpiry: number = 0;
let pendingPromise: Promise<LivePriceResult> | null = null;

/**
 * Bygg URL for CoinGecko `/coins/markets`-kall. Samler alle CoinGecko-IDs
 * fra `COINGECKO_IDS` i én komma-separert query-string.
 *
 * `/coins/markets` returnerer både pris, market_cap og total_volume i
 * ett kall — vi trenger ikke lenger `/simple/price` separat.
 *
 * Pure function — ingen side-effects. Eksportert kun for testbarhet.
 */
export function buildCoingeckoUrl(): string {
  const ids = Object.values(COINGECKO_IDS).join(",");
  const params = new URLSearchParams({
    vs_currency: "usd",
    ids,
    order: "market_cap_desc",
    per_page: "250",
    page: "1",
    sparkline: "false",
    // Price-change percentages for the regime detector (momentum signals).
    // These give us REAL 30/90/200-day returns without needing historical
    // price arrays — the detector votes bull/bear from these directly.
    price_change_percentage: "30,90,200",
  });
  return `https://api.coingecko.com/api/v3/coins/markets?${params.toString()}`;
}

/**
 * Hent live USD-priser fra CoinGecko for alle assets i House-universet.
 *
 * Cache-strategi:
 *   - Hvis cache er gyldig (ikke utløpt), returneres cached resultat
 *     umiddelbart — ingen nettverks-IO.
 *   - Hvis cache er utløpt ELLER ikke eksisterer: start en ny fetch (lagret
 *     i `pendingPromise`). Samtidige kall får samme promise (dedup).
 *
 * Fallback-strategi:
 *   - Hvis fetch feiler (nettverksfeil, 429, 5xx, timeout): returner
 *     REFERENCE_PRICES med `source: "fallback"`. Caller får ALLTID et svar.
 *   - For assets ikke på CoinGecko (rlusd): bruk reference-pris.
 *
 * Aldri kast til caller. Hvis noe går galt, returneres fallback-data.
 *
 * @returns LivePriceResult med pris-map + source + fetchedAt.
 */
export async function fetchLivePrices(): Promise<LivePriceResult> {
  // 1. Cache hit — return umiddelbart.
  const now = Date.now();
  if (cachedResult && now < cacheExpiry) {
    return cachedResult;
  }

  // 2. Dedup — hvis en fetch allerede pågår, vent på den.
  if (pendingPromise) {
    return pendingPromise;
  }

  // 3. Start ny fetch. Lagre promise for dedup.
  pendingPromise = doFetchLivePrices().finally(() => {
    pendingPromise = null;
  });
  return pendingPromise;
}

/**
 * Intern fetch-implementasjon. Gjør selve HTTP-kallet, bygger LivePriceResult,
 * håndterer fallback ved feil.
 *
 * Cache-oppdatering: VELLYKKET fetch oppdaterer `cachedResult` + `cacheExpiry`.
 * FEILET fetch oppdaterer IKKE cache (slik at neste kall prøver på nytt
 * umiddelbart — ikke vent 60s på nytt forsøk).
 */
async function doFetchLivePrices(): Promise<LivePriceResult> {
  const fetchedAt = new Date();

  try {
    const url = buildCoingeckoUrl();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          ...coingeckoAuthHeaders(),
        },
        // next: { revalidate: 0 } — vi har egen cache, ikke bruk Next.js
        // fetch-cache for prisdata (force-dynamic route uansett).
        cache: "no-store",
      });
    } finally {
      clearTimeout(timeout);
    }

    // 429 = rate-limited; 5xx = CoinGecko-serverfeil; begge → fallback.
    if (!response.ok) {
      return fallbackResult(fetchedAt);
    }

    const json = (await response.json()) as Array<{
      id: string;
      symbol?: string;
      current_price?: number;
      market_cap?: number;
      total_volume?: number;
      market_cap_rank?: number;
      price_change_percentage_30d?: number;
      price_change_percentage_90d?: number;
      price_change_percentage_200d?: number;
      ath?: number;
      ath_change_percentage?: number;
    }>;

    // 4. Bygg maps: start med ALLE reference-priser, overskriv med live
    // der CoinGecko har data. Vi bygger en reverse-map (coingeckoId →
    // assetId) fordi `/coins/markets` returnerer en array med CoinGecko-id
    // som feltet `id`, ikke som key.
    const prices: Record<string, number> = { ...REFERENCE_PRICES };
    const marketCaps: Record<string, number> = {};
    const volumes: Record<string, number> = {};
    const momentum: Record<string, { pct30d: number | null; pct90d: number | null; pct200d: number | null; athChangePct: number | null }> = {};

    const reverseMap: Record<string, string> = {};
    for (const [assetId, cgId] of Object.entries(COINGECKO_IDS)) {
      reverseMap[cgId] = assetId;
    }

    for (const coin of json) {
      const assetId = reverseMap[coin.id];
      if (!assetId) continue;
      if (typeof coin.current_price === "number" && Number.isFinite(coin.current_price)) {
        prices[assetId] = coin.current_price;
      }
      if (typeof coin.market_cap === "number" && Number.isFinite(coin.market_cap)) {
        marketCaps[assetId] = coin.market_cap;
      }
      if (typeof coin.total_volume === "number" && Number.isFinite(coin.total_volume)) {
        volumes[assetId] = coin.total_volume;
      }
      momentum[assetId] = {
        pct30d: typeof coin.price_change_percentage_30d === "number" && Number.isFinite(coin.price_change_percentage_30d) ? coin.price_change_percentage_30d : null,
        pct90d: typeof coin.price_change_percentage_90d === "number" && Number.isFinite(coin.price_change_percentage_90d) ? coin.price_change_percentage_90d : null,
        pct200d: typeof coin.price_change_percentage_200d === "number" && Number.isFinite(coin.price_change_percentage_200d) ? coin.price_change_percentage_200d : null,
        athChangePct: typeof coin.ath_change_percentage === "number" && Number.isFinite(coin.ath_change_percentage) ? coin.ath_change_percentage : null,
      };
    }

    const result: LivePriceResult = {
      prices,
      marketCaps,
      volumes,
      momentum,
      source: "live",
      fetchedAt,
    };

    // Cache kun vellykkede resultater.
    cachedResult = result;
    cacheExpiry = Date.now() + CACHE_TTL_MS;

    return result;
  } catch {
    // Fetch feilet (nettverksfeil, timeout via AbortController, JSON-parse,
    // etc.). Returner fallback — aldri kast til caller.
    return fallbackResult(fetchedAt);
  }
}

/**
 * Bygg fallback-resultat fra REFERENCE_PRICES. Brukes når CoinGecko er
 * uopprettelig. Cache IKKE — neste kall prøver CoinGecko på nytt.
 */
function fallbackResult(fetchedAt: Date): LivePriceResult {
  return {
    prices: { ...REFERENCE_PRICES },
    marketCaps: {},
    volumes: {},
    momentum: {},
    source: "fallback",
    fetchedAt,
  };
}

/**
 * Hvis `COINGECKO_API_KEY` env er satt, returner headers for demo-API-key.
 * Gratis tier krever ikke nøkkel, men CoinGecko kan innføre det senere.
 */
function coingeckoAuthHeaders(): Record<string, string> {
  const key = process.env.COINGECKO_API_KEY;
  if (!key) return {};
  return { "x-cg-demo-api-key": key };
}

/**
 * Tving cache til å utløpe ved neste kall. Eksportert for testbarhet og
 * for fremtidig "refresh prices"-knapp i UI-en (Task 38+).
 *
 * Side-effect: nuller `cachedResult` og setter `cacheExpiry` til 0. Hvis en
 * pågående fetch er i gang, lar vi den fullføre (den vil enten oppdatere
 * cache eller la være ved feil).
 */
export function invalidateLivePriceCache(): void {
  cachedResult = null;
  cacheExpiry = 0;
}

/**
 * Hent cache-state for diagnostikk (UI kan vise "last updated X sek siden").
 * Eksportert for Task 38+ UI-bruk. Returnerer null hvis cache er tom.
 */
export function getLivePriceCacheState(): {
  source: "live" | "fallback";
  fetchedAt: Date;
  expiresAt: Date;
  isExpired: boolean;
} | null {
  if (!cachedResult) return null;
  return {
    source: cachedResult.source,
    fetchedAt: cachedResult.fetchedAt,
    expiresAt: new Date(cacheExpiry),
    isExpired: Date.now() >= cacheExpiry,
  };
}

/**
 * Exporter COINGECKO_IDS for testbarhet og for at UI-en (Task 38) kan vise
 * "N assets tracked live" (antall mappet til CoinGecko).
 */
export const COINGECKO_ID_MAPPING: Readonly<Record<string, string>> =
  COINGECKO_IDS;

// ---------------------------------------------------------------------------
// BTC historical price fetcher — for the regime detector.
// ---------------------------------------------------------------------------

/**
 * BTC daily price history (200 days), fetched from CoinGecko's
 * `/coins/bitcoin/market_chart` endpoint. Used by the regime detector
 * to compute REAL momentum signals (30d/90d/200d returns + drawdown).
 *
 * Why BTC only: BTC is the crypto market's regime anchor. The detector
 * uses BTC's momentum + ETH's confirmation. We don't need history for
 * every asset — just BTC (and optionally ETH, added later if needed).
 *
 * Cache: separate from the prices cache. 5-minute TTL (300s) because
 * daily-price history changes slowly and we want to stay well under
 * CoinGecko's rate limit. The `/market_chart` endpoint is more
 * rate-limited than `/coins/markets` on the free tier.
 */
const HISTORY_CACHE_TTL_MS = 5 * 60 * 1000;
let cachedBtcHistory: number[] | null = null;
let btcHistoryExpiry = 0;
let pendingBtcHistory: Promise<number[] | null> | null = null;

/**
 * Fetch BTC's 200-day daily price history from CoinGecko.
 *
 * Returns an array of ~200 daily prices (USD), oldest first. Returns
 * null if CoinGecko is unreachable or returns malformed data — the
 * caller (regime detector) falls back to the old synthetic-history path.
 *
 * Uses the same dedup + fallback pattern as fetchLivePrices.
 */
export async function fetchBtcHistory(): Promise<number[] | null> {
  const now = Date.now();
  if (cachedBtcHistory && now < btcHistoryExpiry) {
    return cachedBtcHistory;
  }
  if (pendingBtcHistory) {
    return pendingBtcHistory;
  }
  pendingBtcHistory = doFetchBtcHistory().finally(() => {
    pendingBtcHistory = null;
  });
  return pendingBtcHistory;
}

async function doFetchBtcHistory(): Promise<number[] | null> {
  try {
    const url =
      "https://api.coingecko.com/api/v3/coins/bitcoin/market_chart" +
      "?vs_currency=usd&days=200&interval=daily";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        headers: { Accept: "application/json", ...coingeckoAuthHeaders() },
        cache: "no-store",
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) return null;

    const json = (await response.json()) as {
      prices?: [number, number][];
    };
    if (!json.prices || !Array.isArray(json.prices)) return null;

    // Extract just the price values (drop timestamps — we only need prices).
    const prices = json.prices
      .map((p) => p[1])
      .filter((p) => typeof p === "number" && Number.isFinite(p) && p > 0);

    if (prices.length < 30) return null; // need at least 30 samples

    cachedBtcHistory = prices;
    btcHistoryExpiry = Date.now() + HISTORY_CACHE_TTL_MS;
    return prices;
  } catch {
    return null;
  }
}

/**
 * Compute real momentum + drawdown signals from BTC's daily price history.
 *
 * Returns:
 *   - pct30d   : 30-day return (%)
 *   - pct90d   : 90-day return (%)
 *   - pct200d  : 200-day return (%) — the SMA-200 proxy
 *   - maxDrawdown : worst peak-to-trough drop in the window (%)
 *   - currentPrice : last price in the array
 *
 * Returns null for any field that can't be computed (not enough samples).
 */
export function computeMomentumFromHistory(
  prices: number[],
): {
  pct30d: number | null;
  pct90d: number | null;
  pct200d: number | null;
  maxDrawdown: number | null;
  currentPrice: number | null;
} {
  if (prices.length < 2) {
    return { pct30d: null, pct90d: null, pct200d: null, maxDrawdown: null, currentPrice: null };
  }
  const last = prices[prices.length - 1];
  const pct = (days: number): number | null => {
    if (prices.length < days + 1) return null;
    const past = prices[prices.length - 1 - days];
    return past > 0 ? (last / past - 1) * 100 : null;
  };

  // Max drawdown over the full window.
  let peak = prices[0];
  let maxDd = 0;
  for (const p of prices) {
    if (p > peak) peak = p;
    const dd = (peak - p) / peak;
    if (dd > maxDd) maxDd = dd;
  }

  return {
    pct30d: pct(30),
    pct90d: pct(90),
    pct200d: pct(prices.length - 1), // full-window return
    maxDrawdown: maxDd * 100,
    currentPrice: last,
  };
}

