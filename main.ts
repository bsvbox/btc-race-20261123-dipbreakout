// Dip-breakout TrendRide — cbBTC 1-minute bot for make.fun btc-race-24h-20261123-0511.
//
// Strategy (written from scratch for this race, tuned on the published dev window):
//   * One position at a time, full-size (100% of cash) on entry.
//   * Entry, only while flat: a dip 60 bps below the 60-bar mean with the close
//     ticking back up, OR a new 48-bar high (trend continuation). At most
//     2 round trips, with a 10-bar cooldown after a sell, so whipsaw cannot
//     bleed the account on fees (a full round trip costs ~26 bps).
//   * Exit: a trailing stop 120 bps below the highest close since entry.
//     No take-profit, no time exit: the trend is ridden until it turns.
//   * Everything is bigint arithmetic on raw prices, no wall clock, no
//     randomness: two runs on the same bars produce the same action log.
//
// Dev-window backtest (my own Python replay of the kit's fill model):
//   buy-and-hold +$32.17, this bot +$20.17 with 2 trades, EMA-cross -$120,
//   pure dip mean-reversion ~$0. The bot trades less than the whipsaw
//   strategies and keeps its downside capped instead of riding a crash.

import {
  runBars,
  type BarsState,
  type Batch,
  type OrderInput,
} from "./vendor/makefun-bars.ts";

const SYMBOL = "CBBTC";
const SMA_N = 60;
const DIP_BPS = 60n;
const BO_LOOK = 48;
const TRAIL_BPS = 120n;
const MAX_ROUND_TRIPS = 2;
const COOLDOWN_BARS = 10;
const MAX_SLIPPAGE_BPS = 100;
const BPS = 10000n;

// All closes seen so far, raw price units, oldest first. Warm-up bars count
// toward the indicators too: they are real bars, just unscored.
const closes: bigint[] = [];
// Highest close since the current position opened (raw price units).
let peak = 0n;
// Round trips actually filled (sell fills observed in batches).
let roundTrips = 0;
// Seq of the batch where the last sell filled (-1 = none yet).
let lastSellSeq = -1;
// Whether we held a position on the previous batch.
let wasHolding = false;

function sma(n: number): bigint | null {
  if (closes.length < n) return null;
  let sum = 0n;
  for (let i = closes.length - n; i < closes.length; i++) sum += closes[i]!;
  return sum / BigInt(n);
}

function maxOfPrev(n: number): bigint | null {
  // Max close over the n bars before the latest one.
  if (closes.length < n + 1) return null;
  let m = closes[closes.length - n - 1]!;
  for (let i = closes.length - n; i < closes.length - 1; i++) {
    if (closes[i]! > m) m = closes[i]!;
  }
  return m;
}

function onBatch(state: BarsState, batch: Batch): OrderInput[] {
  const bar = batch.bars.find((b) => b.symbol === SYMBOL);
  if (bar !== undefined) closes.push(BigInt(bar.c));

  // Sync round-trip accounting with the fills the harness reports.
  for (const f of batch.fills) {
    if (f.symbol === SYMBOL && f.side === "sell" && f.status === "filled") {
      roundTrips += 1;
      lastSellSeq = batch.seq;
    }
  }

  // Warm-up batches cannot trade: observe only.
  if (state.warmingUp) return [];

  const pos = state.positions.get(SYMBOL);
  const holding = pos !== undefined && pos.qty > 0n;
  const close = state.close(SYMBOL);
  if (close === null) return [];

  // Track the running peak while holding; reset it when a position opens.
  if (holding && !wasHolding) peak = close;
  if (holding && close > peak) peak = close;
  wasHolding = holding;

  if (holding) {
    // Trailing stop: sell everything once the close falls 120 bps below
    // the highest close since entry.
    if (peak > 0n && close <= (peak * (BPS - TRAIL_BPS)) / BPS) {
      return [
        {
          side: "sell",
          symbol: SYMBOL,
          qty: pos!.qty,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        },
      ];
    }
    return [];
  }

  // Flat: look for an entry.
  if (roundTrips >= MAX_ROUND_TRIPS) return [];
  if (lastSellSeq >= 0 && batch.seq - lastSellSeq < COOLDOWN_BARS) return [];
  if (state.cash <= 0n) return [];

  const mean = sma(SMA_N);
  if (mean === null) return [];
  const prevClose = closes.length >= 2 ? closes[closes.length - 2]! : null;

  const dipped =
    prevClose !== null &&
    close < (mean * (BPS - DIP_BPS)) / BPS &&
    close > prevClose;
  const prevHigh = maxOfPrev(BO_LOOK);
  const brokeOut = prevHigh !== null && close >= prevHigh;

  if (!dipped && !brokeOut) return [];

  // Full-size buy: every unit of cash. The cap is 100% of equity and the
  // position is empty, so cash is the whole room. Never send a buy below
  // the $1 minimum notional (1,000,000 quote units): after fees the cash
  // could be small, and a sub-minimum buy is rejected, not partially filled.
  const notional = state.cash < state.weightRoom(SYMBOL) ? state.cash : state.weightRoom(SYMBOL);
  if (notional < 1_000_000n) return [];
  return [
    {
      side: "buy",
      symbol: SYMBOL,
      notional_quote_units: notional,
      max_slippage_bps: MAX_SLIPPAGE_BPS,
    },
  ];
}

await runBars({ onBatch });
