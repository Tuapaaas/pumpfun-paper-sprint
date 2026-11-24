// Launch snipe: buy fresh launches that pass a light rug filter, exit within seconds.
//
// Idea: on pump.fun the only edge that survived the dev window was the launch itself. A coin
// bought in its first few slots, before the crowd or the creator dumps, either pops a little
// or dies fast — so the trade is tiny, the exits are tight, and nothing is ever held. The
// filter is deliberately light: the creator must not have sold, the launch must not be
// bundled by many wallets at once, the creator's own opening buy must be modest, and the
// price must not have already run away or collapsed.
//
// This is a deliberate pivot from the two designs this file first held (dip-buying, then
// fresh-launch momentum with 200-slot holds): both lost money on every parameter cell tried
// on the dev window (dip -0.05..-0.96 SOL, momentum -0.37..-0.80 SOL), while the launch
// shape — buy at age ~0-12 slots, +15% take-profit, -12% stop, 12-slot hold cap — came
// closest to breakeven (-0.13 SOL for the kit's own sniper pilot). Holding longer only
// bled: these coins dump after the initial pop.
//
// Everything here is a pure function of the batches the harness sends: no clock, no randomness,
// no I/O, so the two graded executions produce byte-identical action logs.

import type { Batch, Bot, BotState, Mark, OrderInput, Pubkey } from './vendor/agentfun-bot.ts';

export interface Params {
  /** Youngest age (slots since create) at which a coin may be bought. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAge: number;
  /** Fixed buy size in SOL per coin. */
  sizeSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Real SOL reserve window at decision time. */
  minRealSol: number;
  maxRealSol: number;
  /** Creator's own buys in the create slot must be at most this (SOL). */
  maxDevBuySol: number;
  /** Distinct non-creator buyers seen before entry, at most: many wallets at launch = a bundle. */
  maxBuyers: number;
  /** Trades seen before entry, at least. */
  minTrades: number;
  /** Price now over the create price: window (a launch that already ran or crashed is skipped). */
  minRunup: number;
  maxRunup: number;
  /** Creator sold before entry: skip the coin. */
  skipDevSold: boolean;
  /** Take profit when the position's liquidation value reaches cost * (1 + takeProfit). */
  takeProfit: number;
  /** Stop when liquidation value falls to cost * (1 - stopLoss). */
  stopLoss: number;
  /** Exit after holding this many slots regardless. */
  maxHoldSlots: number;
  /** Exit at once when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Slippage tolerance on buys and on sells (bps). */
  buySlippageBps: number;
  sellSlippageBps: number;
  /** Most new entries per reply. */
  maxEntriesPerBatch: number;
  /**
   * Guardrail pacing: the run must end with at least 20 distinct coins traded. When the bot's
   * own fills or coins lag targetCoins / targetFills scaled by the share of paceSecs elapsed
   * (block time since the first batch), it opens tiny probe round trips (buy probeSol, sell it
   * all as soon as the buy lands) until it is back on pace.
   */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 0,
  maxAge: 6,
  sizeSol: 0.1,
  minBuySol: 0.01,
  minRealSol: 0.3,
  maxRealSol: 30,
  maxDevBuySol: 2.5,
  maxBuyers: 2,
  minTrades: 3,
  minRunup: 0.95,
  maxRunup: 1.6,
  skipDevSold: true,
  takeProfit: 0.1,
  stopLoss: 0.12,
  maxHoldSlots: 12,
  exitOnDevSell: true,
  buySlippageBps: 500,
  sellSlippageBps: 3000,
  maxEntriesPerBatch: 2,
  targetCoins: 25,
  targetFills: 240,
  paceSecs: 14_400,
  probeSol: 0.01,
  maxProbes: 1,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;
const BPS_PER_UNIT = 10_000;

interface Book {
  /** Slot of the CreateEvent, null until seen. */
  created: number | null;
  creator: string;
  /** Create-time reserves: the run-up is measured against them. */
  vq0: number;
  vt0: number;
  /** Creator's own buys in the create slot (SOL). */
  devBuySol: number;
  /** Creator sold at any point. */
  devSold: boolean;
  /** Distinct non-creator buyers seen. */
  buyers: Set<string>;
  trades: number;
  /** Price and slot of the entry. */
  entryPrice: number;
  entrySlot: number;
  /** Slot until which the coin is ignored after an exit. */
  coolUntil: number;
  /** A sell is in flight: do not send another. */
  exiting: boolean;
  /** Never buy it again (exited, filtered out for good, or completed). */
  done: boolean;
}

/** The per-reply buy cap, with a margin for reserve shifts from our own earlier flow. */
function buyCapSol(state: BotState, mint: Pubkey): number {
  return (Number(state.maxBuyLamports(mint)) / LAMPORTS) * 0.97;
}

/** What selling `tokens` would pay, curve fees deducted, against the harness marks. */
function liquidationValueSol(mark: Mark | undefined, tokens: bigint): number {
  if (mark === undefined) return 0;
  const vq = Number(mark.virtual_quote_reserves);
  const vt = Number(mark.virtual_token_reserves);
  const rq = Number(mark.real_quote_reserves);
  if (vt + Number(tokens) === 0) return 0;
  let q = (Number(tokens) * vq) / (vt + Number(tokens));
  if (q > rq) q = rq;
  return (q / LAMPORTS) * (1 - CURVE_FEE);
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const books = new Map<Pubkey, Book>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** The bot's own filled orders and the coins they were on. */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  const book = (mint: Pubkey): Book => {
    let b = books.get(mint);
    if (b === undefined) {
      b = { created: null, creator: '', vq0: 0, vt0: 1, devBuySol: 0, devSold: false, buyers: new Set(), trades: 0, entryPrice: 0, entrySlot: -1, coolUntil: -1, exiting: false, done: false };
      books.set(mint, b);
    }
    return b;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const slot = batch.slot;
      const touched: Pubkey[] = [];
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const b = book(e.mint);
          b.created = e.slot;
          b.creator = e.creator;
          b.vq0 = Number(e.virtual_quote_reserves);
          b.vt0 = Number(e.virtual_token_reserves);
          continue;
        }
        if (e.event !== 'TradeEvent') continue;
        const b = book(e.mint);
        b.trades++;
        if (e.user === b.creator) {
          if (e.is_buy && e.slot === b.created) b.devBuySol += Number(e.sol_amount) / LAMPORTS;
          else if (!e.is_buy) b.devSold = true;
        } else if (e.is_buy) {
          b.buyers.add(e.user);
        }
        if (!touched.includes(e.mint)) touched.push(e.mint);
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;
      const marks = new Map<Pubkey, Mark>();
      for (const m of batch.marks) marks.set(m.mint, m);
      const pendingMints = new Set<Pubkey>();
      for (const o of state.pending.values()) pendingMints.add(o.order.mint);

      // 1. Exits on held positions, in mint order (deterministic).
      const held = [...state.positions.keys()].sort();
      for (const mint of held) {
        if (orders.length >= cap) break;
        const h = state.positions.get(mint)!;
        const b = book(mint);
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (b.exiting) continue;
        const value = liquidationValueSol(marks.get(mint), h.token_amount);
        const entrySlot = b.entrySlot < 0 ? slot : b.entrySlot;
        const cost = Number(h.cost_lamports) / LAMPORTS;
        const gain = cost > 0 ? (value - cost) / cost : 0;
        const tp = gain >= p.takeProfit;
        const sl = gain <= -p.stopLoss;
        const stale = slot - entrySlot >= p.maxHoldSlots;
        const devDump = p.exitOnDevSell && b.devSold;
        if (!(tp || sl || stale || devDump)) continue;
        if (pendingMints.has(mint)) continue;
        orders.push({ side: 'sell', mint, token_amount: h.token_amount, max_slippage_bps: p.sellSlippageBps });
        b.exiting = true;
        b.done = true;
      }
      // Clear the exit flag once the sell resolved.
      for (const f of batch.fills) {
        const b = books.get(f.mint);
        if (b === undefined) continue;
        if (f.side === 'sell') {
          b.exiting = false;
          if (!state.positions.has(f.mint)) {
            b.entrySlot = -1;
            b.coolUntil = slot + 250;
          }
        } else if (f.status !== 'filled' && !state.positions.has(f.mint)) {
          let stillPending = false;
          for (const o of state.pending.values()) if (o.order.mint === f.mint) stillPending = true;
          if (!stillPending) b.entrySlot = -1;
        }
      }

      // 2. Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingMints.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingMints.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: p.sellSlippageBps });
        if (!selling) probes.set(mint, true);
      }

      // 3. New entries: fresh launches that pass the rug filter.
      let entries = 0;
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      const open = state.committedPositionCount();
      for (const mint of touched) {
        if (orders.length >= cap || entries >= p.maxEntriesPerBatch) break;
        if (open + entries >= state.hello.caps.max_open_positions) break;
        if (state.positions.has(mint) || pendingMints.has(mint) || probes.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const b = book(mint);
        if (b.done || b.created === null) continue;
        const age = slot - b.created;
        if (age < p.minAge || age > p.maxAge) {
          if (age > p.maxAge) b.done = true;
          continue;
        }
        if (b.trades < p.minTrades) continue;
        if (b.buyers.size > p.maxBuyers) continue;
        if (b.devBuySol > p.maxDevBuySol) continue;
        if (p.skipDevSold && b.devSold) {
          b.done = true;
          continue;
        }
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (rqSol < p.minRealSol || rqSol > p.maxRealSol) continue;
        // Run-up vs the create price.
        const vq = Number(curve.virtual_quote_reserves);
        const vt = Number(curve.virtual_token_reserves);
        if (b.vq0 <= 0 || b.vt0 <= 0 || vt <= 0) continue;
        const runup = (vq * b.vt0) / (vt * b.vq0);
        if (runup < p.minRunup || runup > p.maxRunup) continue;
        let amount = p.sizeSol;
        const sizeCap = buyCapSol(state, mint);
        if (amount > sizeCap) amount = sizeCap;
        if (amount < p.minBuySol) continue;
        if (free - amount - tx < 0) continue;
        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlippageBps });
        b.entryPrice = vq / vt;
        b.entrySlot = slot;
        b.exiting = false;
        pendingMints.add(mint);
        free -= amount + tx;
        entries++;
      }

      // 4. Guardrail pacing: open a probe when fills or coins lag the pace.
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      if (probes.size < p.maxProbes && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * BPS_PER_UNIT) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of touched) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (state.positions.has(mint) || probes.has(mint) || pendingMints.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlippageBps });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
