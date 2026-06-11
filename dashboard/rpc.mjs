// Minimal JSON-RPC + ABI helper for the pool resolver.
// Vanilla Node, no external deps (same constraint as the rest of the dashboard).
// Talks to DRPC via the URLs in chains.mjs.

import { CHAINS } from './chains.mjs';

const RPC_TIMEOUT_MS = 8000;

export const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

// ---- single eth_call -----------------------------------------------------

export async function ethCall(chainKey, to, data) {
  const rpc = CHAINS[chainKey]?.rpc;
  if (!rpc) throw new Error(`no rpc for chain "${chainKey}"`);
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_call', id: 1, params: [{ to, data }, 'latest'] }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`rpc ${chainKey} http ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`rpc ${chainKey}: ${json.error.message || JSON.stringify(json.error)}`);
  return json.result;
}

// Batched JSON-RPC — same chain, multiple calls in one POST. DRPC supports
// array-form requests; keeps round-trips low when probing fee tiers etc.
export async function ethCallBatch(chainKey, calls) {
  const rpc = CHAINS[chainKey]?.rpc;
  if (!rpc) throw new Error(`no rpc for chain "${chainKey}"`);
  const body = calls.map((c, i) => ({
    jsonrpc: '2.0', method: 'eth_call', id: i,
    params: [{ to: c.to, data: c.data }, 'latest'],
  }));
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`rpc ${chainKey} http ${res.status}`);
  const arr = await res.json();
  // Sort by id (batch responses can come back unordered).
  const out = new Array(calls.length).fill(null);
  for (const r of arr) {
    if (r.error) out[r.id] = { error: r.error.message || JSON.stringify(r.error) };
    else out[r.id] = { result: r.result };
  }
  return out;
}

// ---- ABI primitives ------------------------------------------------------

// Pad an address to a 32-byte calldata word (no 0x prefix).
export function encAddr(a) {
  const hex = String(a || '').toLowerCase().replace(/^0x/, '');
  if (hex.length !== 40) throw new Error(`bad address: ${a}`);
  return hex.padStart(64, '0');
}

// Pad a uint to a 32-byte calldata word (no 0x prefix).
export function encUint(n) {
  return BigInt(n).toString(16).padStart(64, '0');
}

// Decode a 32-byte address-typed return word ("0x000…<20 bytes>").
export function decAddr(hex) {
  if (!hex || hex === '0x' || hex === '0x0') return null;
  const clean = hex.replace(/^0x/, '').padStart(64, '0');
  const addr = '0x' + clean.slice(-40);
  return addr === ZERO_ADDR ? null : addr;
}

export function decUint(hex) {
  if (!hex || hex === '0x') return 0n;
  return BigInt(hex);
}

// Lexicographically lower of two addresses (Uniswap requires token0 < token1).
export function sortTokens(a, b) {
  const la = String(a).toLowerCase(); const lb = String(b).toLowerCase();
  return la < lb ? [la, lb] : [lb, la];
}
