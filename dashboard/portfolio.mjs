// Per-wallet token balance fetcher.
// Uses native JSON-RPC over fetch (no deps). One batched POST per chain via JSON-RPC array form.
// USD prices from DefiLlama's coins API (free, no key, accepts chain:addr keys).

import { CHAINS } from './chains.mjs';

const ERC20_BALANCEOF = '0x70a08231'; // balanceOf(address)
const ZERO_ADDR_PAD = '0'.repeat(24);

function encodeBalanceOf(addr) {
  return ERC20_BALANCEOF + ZERO_ADDR_PAD + addr.toLowerCase().replace(/^0x/, '');
}

async function rpcBatch(rpc, calls) {
  const body = calls.map((c, i) => ({ jsonrpc: '2.0', id: i, method: c.method, params: c.params }));
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error('RPC HTTP ' + res.status);
  const arr = await res.json();
  // JSON-RPC batch responses may be out of order; sort by id.
  return Array.from(arr).sort((a, b) => a.id - b.id);
}

function bigintToFloat(raw, decimals) {
  if (raw === 0n) return 0;
  const d = BigInt(decimals);
  const div = 10n ** d;
  const whole = raw / div;
  const frac = raw - whole * div;
  return Number(whole) + Number(frac) / Number(div);
}

async function fetchChainBalances(walletAddr, chainKey) {
  const cfg = CHAINS[chainKey];
  if (!cfg) return null;
  const tokens = Object.entries(cfg.tokens);
  const calls = [
    { method: 'eth_getBalance', params: [walletAddr, 'latest'] }, // native
    ...tokens.map(([, info]) => ({
      method: 'eth_call',
      params: [{ to: info.addr, data: encodeBalanceOf(walletAddr) }, 'latest'],
    })),
  ];
  let results;
  try {
    results = await rpcBatch(cfg.rpc, calls);
  } catch (e) {
    return { chain: chainKey, error: e.message };
  }
  const out = { chain: chainKey, label: cfg.label, balances: {} };
  // Native
  const nativeRes = results[0];
  if (nativeRes && !nativeRes.error && nativeRes.result) {
    const raw = BigInt(nativeRes.result);
    if (raw > 0n) {
      out.balances[cfg.nativeSymbol] = {
        amount: bigintToFloat(raw, 18),
        decimals: 18,
        addr: 'native',
        priceId: cfg.nativeCoinId,
      };
    }
  }
  // ERC20s
  tokens.forEach(([symbol, info], i) => {
    const r = results[i + 1];
    if (!r || r.error || !r.result || r.result === '0x' || r.result === '0x0') return;
    let raw;
    try { raw = BigInt(r.result); } catch { return; }
    if (raw === 0n) return;
    out.balances[symbol] = {
      amount: bigintToFloat(raw, info.decimals),
      decimals: info.decimals,
      addr: info.addr,
      priceId: chainKey + ':' + info.addr.toLowerCase(),
    };
  });
  return out;
}

// Resolve a batch of priceIds to USD via DefiLlama coins API.
// Accepts: "coingecko:ethereum" or "<chain>:<addr>".
async function fetchPrices(priceIds) {
  const unique = [...new Set(priceIds)].filter(Boolean);
  if (!unique.length) return {};
  // DefiLlama coins API accepts comma-joined IDs; chunk to keep URL < 2KB.
  const out = {};
  for (let i = 0; i < unique.length; i += 25) {
    const chunk = unique.slice(i, i + 25);
    const url = 'https://coins.llama.fi/prices/current/' + chunk.map(encodeURIComponent).join(',');
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
      const j = await res.json();
      for (const [k, v] of Object.entries(j.coins || {})) {
        if (v && typeof v.price === 'number') out[k] = v.price;
      }
    } catch {
      // best-effort: prices missing → entries show no USD
    }
  }
  return out;
}

// ---- public: fetch a wallet's full portfolio ----
// Returns { wallet, totalUsd, chains: [{chain, label, totalUsd, balances: [{symbol, amount, usd, addr}], error?}] }
// Cached for 90s per address.

const cache = new Map();
const TTL_MS = 90 * 1000;

export async function fetchPortfolio(walletAddr, { force = false } = {}) {
  const key = walletAddr.toLowerCase();
  const now = Date.now();
  if (!force) {
    const hit = cache.get(key);
    if (hit && now - hit.ts < TTL_MS) return hit.data;
  }
  const chainKeys = Object.keys(CHAINS);
  const chainResults = await Promise.all(chainKeys.map((k) => fetchChainBalances(walletAddr, k)));
  // Collect price IDs to resolve in one fetch
  const priceIds = [];
  for (const cr of chainResults) {
    if (cr && cr.balances) {
      for (const b of Object.values(cr.balances)) priceIds.push(b.priceId);
    }
  }
  const prices = await fetchPrices(priceIds);

  const chains = chainResults.map((cr) => {
    if (!cr) return null;
    if (cr.error) return { chain: cr.chain, label: CHAINS[cr.chain]?.label || cr.chain, error: cr.error, totalUsd: 0, balances: [] };
    const balances = Object.entries(cr.balances).map(([symbol, b]) => {
      const price = prices[b.priceId];
      const usd = typeof price === 'number' ? b.amount * price : null;
      return { symbol, amount: b.amount, addr: b.addr, price: price || null, usd };
    }).filter((b) => (b.usd ?? 0) > 0.5 || b.amount >= 0.001); // hide dust
    balances.sort((a, b) => (b.usd || 0) - (a.usd || 0));
    const totalUsd = balances.reduce((s, b) => s + (b.usd || 0), 0);
    return { chain: cr.chain, label: cr.label, balances, totalUsd };
  }).filter(Boolean);

  const totalUsd = chains.reduce((s, c) => s + (c.totalUsd || 0), 0);
  const data = {
    wallet: walletAddr,
    totalUsd,
    chains: chains.sort((a, b) => (b.totalUsd || 0) - (a.totalUsd || 0)),
    fetchedAt: new Date().toISOString(),
  };
  cache.set(key, { ts: now, data });
  return data;
}

// Flatten all holdings into a SYMBOL set (case-preserved) for "wallet has the source token" checks.
export function symbolSet(portfolio) {
  const set = new Set();
  for (const c of portfolio.chains || []) {
    for (const b of c.balances || []) set.add(b.symbol.toUpperCase());
  }
  return set;
}
