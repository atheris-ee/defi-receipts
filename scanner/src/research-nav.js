// NAV ORACLE (read-only): LST / wrapped-stable redemption-value vs DEX-price discount.
//
// DefiLlama publishes only a USD spot, never an exchange-rate or redemption value. The edge
// (Strategy #2) is the gap between an asset's ON-CHAIN NAV (what it redeems for) and its DEX price.
// Two layers:
//   (1) SPOT discount — every scan, cheap: eth_call NAV vs DefiLlama price ratio (breadth).
//   (2) EXECUTABLE discount — when the spot discount clears a threshold, a size-aware ParaSwap quote
//       (~$25k, net of slippage) confirms the REAL capturable edge — addressing the Phase-0 caveat
//       that DefiLlama spot can overstate. Keyless ParaSwap (Odos keyless is rate-limited to death).
// Still 100% read-only: eth_call (view) + price/quote GETs. Signs nothing, moves nothing.
//
// discountBps > 0  => token cheaper than redemption value  => BUY on DEX, REDEEM at NAV
// discountBps < 0  => token richer than NAV (premium)      => MINT at NAV, SELL on DEX
// `redeemable` gates actionability: a discount on a token with no instant redemption (most LRTs) is
// only a mean-reversion bet, not a locked arb.

import { fetchJSON, log, loadData, saveData } from './utils.js';
import { readFileSync } from 'node:fs';

const DRPC_ENV_FILE = process.env.DRPC_KEY_FILE || './secrets/drpc.env';
function drpcKey() {
  if (process.env.DRPC_KEY) return process.env.DRPC_KEY;
  try { const m = readFileSync(DRPC_ENV_FILE, 'utf8').match(/DRPC_KEY=(.+)/); return m ? m[1].trim() : ''; } catch { return ''; }
}
const KEY = drpcKey();
const drpcUrl = (net) => `https://lb.drpc.org/ogrpc?network=${net}&dkey=${KEY}`;
// Fetch errors embed the full request URL — including the paid dkey, which then lands in the
// journal. Scrub it from anything we log.
const redactKey = (msg) => String(msg || '').replace(/dkey=[A-Za-z0-9_-]+/g, 'dkey=REDACTED');
const NETWORK_ID = { ethereum: 1, arbitrum: 42161, base: 8453, optimism: 10, polygon: 137, bsc: 56, avalanche: 43114, fantom: 250 };
// DefiLlama coins chain prefix differs from the DRPC network name (avax vs avalanche). Default = net.
const LLAMA_CHAIN = { ethereum: 'ethereum', polygon: 'polygon', bsc: 'bsc', avalanche: 'avax', fantom: 'fantom', arbitrum: 'arbitrum', base: 'base', optimism: 'optimism', solana: 'solana' };
const llamaKey = (net, token) => `${LLAMA_CHAIN[net] || net}:${String(token).toLowerCase()}`;
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const ARG_1E18 = '0000000000000000000000000000000000000000000000000de0b6b3a7640000';
const SIZE_USD = 25000; // default executable-quote trade size (per-asset override via a.execSizeUsd for thin chains)

async function ethCall(net, to, data) {
  const res = await fetchJSON(drpcUrl(net), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_call', id: 1, params: [{ to, data }, 'latest'] }), timeout: 12000,
  });
  if (!res || res.error || !res.result || res.result === '0x') return null;
  return res.result;
}
// Decode ONLY the first 32-byte word — some rate fns return a tuple (e.g. MaticX
// convertMaticXToMatic returns (amountInMatic, totalShares, totalPooled); word[0] is the rate).
const e18 = (hex) => Number(BigInt(String(hex).slice(0, 66))) / 1e18;

// Size-aware executable rate via ParaSwap (keyless). Returns underlying-per-token at SIZE_USD, net of
// route slippage, or null if rate-limited / no route. side always SELL of `src`.
async function paraswapSell(net, srcToken, srcDec, destToken, destDec, amountWei) {
  const nid = NETWORK_ID[net];
  if (!nid) return null;
  try {
    const url = `https://apiv5.paraswap.io/prices/?srcToken=${srcToken}&destToken=${destToken}&amount=${amountWei}&srcDecimals=${srcDec}&destDecimals=${destDec}&side=SELL&network=${nid}`;
    const r = await fetchJSON(url, { headers: { 'User-Agent': 'defi-tracker/1.0' }, timeout: 12000 });
    const p = r?.priceRoute;
    if (!p || !p.srcAmount || !p.destAmount) return null;
    return { srcAmount: Number(BigInt(p.srcAmount)) / 10 ** srcDec, destAmount: Number(BigInt(p.destAmount)) / 10 ** destDec, srcUSD: +p.srcUSD || 0, destUSD: +p.destUSD || 0 };
  } catch { return null; }
}

// Solana DEX rate via Jupiter (keyless lite-api). Same return shape as paraswapSell (no USD values).
async function jupiterSell(srcMint, srcDec, dstMint, dstDec, amountRaw) {
  try {
    const r = await fetchJSON(`https://lite-api.jup.ag/swap/v1/quote?inputMint=${srcMint}&outputMint=${dstMint}&amount=${amountRaw}&slippageBps=50&restrictIntermediateTokens=true`, { headers: { 'User-Agent': 'defi-tracker/1.0' }, timeout: 12000 });
    if (!r || !r.outAmount || !r.inAmount) return null;
    return { srcAmount: Number(r.inAmount) / 10 ** srcDec, destAmount: Number(r.outAmount) / 10 ** dstDec, srcUSD: 0, destUSD: 0 };
  } catch { return null; }
}
// Route a size-aware sell to the right aggregator: Solana -> Jupiter, EVM -> ParaSwap.
const dexSell = (net, src, srcDec, dst, dstDec, amt) =>
  net === 'solana' ? jupiterSell(src, srcDec, dst, dstDec, amt) : paraswapSell(net, src, srcDec, dst, dstDec, amt);

// Asset spec. dexUnderlying = the ERC-20 traded against on the DEX (WETH for ETH-LSTs; the stable for
// 4626 vaults). redeemable = is there an instant/queued redemption that makes a discount capturable.
const NAV_ASSETS = [
  { sym: 'wstETH', net: 'ethereum', token: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0', selector: '0x035faf82', dec: 18, underlyingKey: 'coingecko:ethereum', dexUnderlying: WETH, underDec: 18, redeemable: true, redemption: 'Lido withdrawal queue (~1-5 days)' },
  { sym: 'rETH',   net: 'ethereum', token: '0xae78736Cd615f374D3085123A210448E74Fc6393', selector: '0xe6aa216c', dec: 18, underlyingKey: 'coingecko:ethereum', dexUnderlying: WETH, underDec: 18, redeemable: true, redemption: 'Rocket Pool burn (instant if deposit pool has ETH, else queue)' },
  { sym: 'cbETH',  net: 'ethereum', token: '0xBe9895146f7AF43049ca1c1AE358B0541Ea49704', selector: '0x3ba0b9a9', dec: 18, underlyingKey: 'coingecko:ethereum', dexUnderlying: WETH, underDec: 18, redeemable: true, redemption: 'Coinbase unwrap (centralized, KYC)' },
  { sym: 'sDAI',   net: 'ethereum', token: '0x83F20F44975D03b1b09e64809B757c47f942BEeA', selector: '0x07a2d13a' + ARG_1E18, dec: 18, underlyingKey: 'ethereum:0x6b175474e89094c44da98b954eedeac495271d0f', dexUnderlying: '0x6B175474E89094C44Da98b954EedeAC495271d0F', underDec: 18, redeemable: true, redemption: 'ERC-4626 instant DAI redemption' },
  { sym: 'sUSDe',  net: 'ethereum', token: '0x9D39A5DE30e57443BfF2A8307A4256c8797A3497', selector: '0x07a2d13a' + ARG_1E18, dec: 18, underlyingKey: 'ethereum:0x4c9edd5852cd905f086c759e8383e09bff1e68b3', dexUnderlying: '0x4c9EDD5852cd905f086C759E8383e09bff1E68B3', underDec: 18, redeemable: false, redemption: 'ERC-4626 with 7-day cooldown to USDe (not instant)' },
  // --- expanded set: asset-verification workflow + live eth_call gate (2026-05-29). 14 of 16
  // candidates passed; ezETH/rsETH dropped (rate-provider reverts on token). NAV read uses navContract.
  { sym: 'ETHx', net: 'ethereum', token: '0xA35b1B31Ce002FBF2058D22F30f95D405200A15b', navContract: '0xcf5EA1b38380f6aF39068375516Daf40Ed70D299', selector: '0xe6aa216c', dec: 18, underlyingKey: 'coingecko:ethereum', dexUnderlying: WETH, underDec: 18, redeemable: true, redemption: 'Stader withdraw queue (validator exit, days)' },
  { sym: 'ankrETH', net: 'ethereum', token: '0xE95A203B1a91a908F9B9CE46459d101078c2c3cb', selector: '0x6c58d43d' + ARG_1E18, dec: 18, underlyingKey: 'coingecko:ethereum', dexUnderlying: WETH, underDec: 18, redeemable: true, redemption: 'Ankr exit queue or 0.5%-fee flash unstake' },
  { sym: 'swETH', net: 'ethereum', token: '0xf951E335afb289353dc249e82926178EaC7DEd78', selector: '0x679aefce', dec: 18, underlyingKey: 'coingecko:ethereum', dexUnderlying: WETH, underDec: 18, redeemable: true, redemption: 'Swell unstake queue (>=24h)' },
  { sym: 'mETH', net: 'ethereum', token: '0xd5F7838F5C461fefF7FE49ea5ebaF7728bB0ADfa', navContract: '0xe3cBd06D7dadB3F4e6557bAb7EdD924CD1489E8f', selector: '0x5890c11c' + ARG_1E18, dec: 18, underlyingKey: 'coingecko:ethereum', dexUnderlying: WETH, underDec: 18, redeemable: true, redemption: 'Mantle FIFO unstake queue' },
  { sym: 'sfrxETH', net: 'ethereum', token: '0xac3E018457B222d93114458476f3E3416Abbe38F', selector: '0x07a2d13a' + ARG_1E18, dec: 18, underlyingKey: 'ethereum:0x5e8422345238f34275888049021821e8e08caa1f', dexUnderlying: '0x5E8422345238F34275888049021821E8E08CAa1f', underDec: 18, redeemable: true, redemption: 'instant ERC-4626 unwrap to frxETH at NAV' },
  { sym: 'wOETH', net: 'ethereum', token: '0xDcEe70654261AF21C44c093C300eD3Bb97b78192', selector: '0x07a2d13a' + ARG_1E18, dec: 18, underlyingKey: 'ethereum:0x856c4efb76c1d1ae02e20ceb03a2a6a08b0b8dc3', dexUnderlying: '0x856c4Efb76C1D1AE02e20CEB03A2A6a08b0b8dC3', underDec: 18, redeemable: true, redemption: 'instant ERC-4626 unwrap to OETH at NAV' },
  { sym: 'osETH', net: 'ethereum', token: '0xf1C9acDc66974dFB6dEcB12aA385b9cD01190E38', navContract: '0x2A261e60FB14586B474C208b1B7AC6D0f5000306', selector: '0x07a2d13a' + ARG_1E18, dec: 18, underlyingKey: 'coingecko:ethereum', dexUnderlying: WETH, underDec: 18, redeemable: false, redemption: 'no at-will 1:1 native redeem (overcollateralized mint)' },
  { sym: 'weETH', net: 'ethereum', token: '0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee', selector: '0x679aefce', dec: 18, underlyingKey: 'coingecko:ethereum', dexUnderlying: WETH, underDec: 18, redeemable: true, redemption: 'ether.fi buffer (instant when liquid, else queue)' },
  { sym: 'pufETH', net: 'ethereum', token: '0xD9A442856C234a39a81a089C06451EBAa4306a72', selector: '0x07a2d13a' + ARG_1E18, dec: 18, underlyingKey: 'coingecko:ethereum', dexUnderlying: WETH, underDec: 18, redeemable: true, redemption: 'Puffer instant redeem 1% fee when liquid, else queue' },
  { sym: 'rswETH', net: 'ethereum', token: '0xFAe103DC9cf190eD75350761e95403b7b8aFa6c0', selector: '0xa7b9544e', dec: 18, underlyingKey: 'coingecko:ethereum', dexUnderlying: WETH, underDec: 18, redeemable: true, redemption: 'Swell v2 unstake (~1-day buffer)' },
  { sym: 'sUSDS', net: 'ethereum', token: '0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD', selector: '0x07a2d13a' + ARG_1E18, dec: 18, underlyingKey: 'ethereum:0xdc035d45d973e3ec169d2276ddab16f1e407384f', dexUnderlying: '0xdC035D45d973E3EC169d2276DDab16f1e407384F', underDec: 18, redeemable: true, redemption: 'instant ERC-4626 to USDS (Sky SSR), no fee' },
  { sym: 'scrvUSD', net: 'ethereum', token: '0x0655977FEb2f289A4aB78af67BAB0d17aAb84367', selector: '0x07a2d13a' + ARG_1E18, dec: 18, underlyingKey: 'ethereum:0xf939e0a03fb07f59a73314e73794be0e57ac1b4e', dexUnderlying: '0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E', underDec: 18, redeemable: true, redemption: 'instant ERC-4626 to crvUSD, no lockup' },
  { sym: 'sDOLA', net: 'ethereum', token: '0xb45ad160634c528Cc3D2926d9807104FA3157305', selector: '0x07a2d13a' + ARG_1E18, dec: 18, underlyingKey: 'ethereum:0x865377367054516e17014ccded1e7d814edc9ce4', dexUnderlying: '0x865377367054516e17014CcdED1e7d814EDC9ce4', underDec: 18, redeemable: true, redemption: 'instant ERC-4626 to DOLA at NAV' },
  { sym: 'sFRAX', net: 'ethereum', token: '0xA663B02CF0a4b149d2aD41910CB81e23e1c41c32', selector: '0x07a2d13a' + ARG_1E18, dec: 18, underlyingKey: 'ethereum:0x853d955acef822db058eb8505911ed77f175b99e', dexUnderlying: '0x853d955aCEf822Db058eb8505911ED77F175b99e', underDec: 18, redeemable: true, redemption: 'instant to FRAX at NAV, no fee' },
  // --- multichain altchain LSTs (workflow-verified + live eth_call-gated 2026-05-29). net=DEX
  // chain; navNet=NAV-read chain when different (MaticX reads ETH mainnet); invert for token-per-native. ---
  { sym: 'MaticX', net: 'polygon', navNet: 'ethereum', token: '0xfa68FB4628DFF1028CFEc22b4162FCcd0d45efb6', navContract: '0xf03A7Eb46d01d9EcAA104558C732Cf82f6B6B645', selector: '0x75a85ef5' + ARG_1E18, dec: 18, underlyingKey: 'coingecko:polygon-ecosystem-token', dexUnderlying: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', underDec: 18, redeemable: true, execSizeUsd: 25000, redemption: 'Stader instant-pool (small fee) or Polygon unbonding ~3-4d' },
  { sym: 'ankrMATIC', net: 'polygon', token: '0x0E9b89007eEE9c958c0EDA24eF70723C2C93dD58', selector: '0x71ca337d', invert: true, dec: 18, underlyingKey: 'coingecko:polygon-ecosystem-token', dexUnderlying: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', underDec: 18, redeemable: true, execSizeUsd: 5000, redemption: 'Ankr Polygon instant swap, 0.5% fee (pool-depth capped)' },
  { sym: 'sAVAX', net: 'avalanche', token: '0x2b2C81e08f1Af8835a78Bb2A90AE924ACE0eA4bE', selector: '0x4a36d6c1' + ARG_1E18, dec: 18, underlyingKey: 'coingecko:avalanche-2', dexUnderlying: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7', underDec: 18, redeemable: true, execSizeUsd: 25000, redemption: 'BENQI 15-day unstake cooldown' },
  { sym: 'ggAVAX', net: 'avalanche', token: '0xA25EaF2906FA1a3a13EdAc9B9657108Af7B703e3', selector: '0x07a2d13a' + ARG_1E18, dec: 18, underlyingKey: 'coingecko:avalanche-2', dexUnderlying: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7', underDec: 18, redeemable: true, execSizeUsd: 2000, redemption: 'GoGoPool ERC-4626, redemption liquidity-gated (may queue)' },
  { sym: 'BNBx', net: 'bsc', token: '0x1bdd3Cf7F79cfB8EdbB955f20ad99211551BA275', navContract: '0x3b961e83400D51e6E1AF5c450d3C7d7b80588d28', selector: '0xca0506e8' + ARG_1E18, dec: 18, underlyingKey: 'coingecko:binancecoin', dexUnderlying: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', underDec: 18, redeemable: true, execSizeUsd: 2000, redemption: 'Stader BNB unbonding ~7-15d' },
  { sym: 'slisBNB', net: 'bsc', token: '0xB0b84D294e0C75A6abe60171b70edEb2EFd14A1B', navContract: '0x1adB950d8bB3dA4bE104211D5AB038628e477fE6', selector: '0xce6298e1' + ARG_1E18, dec: 18, underlyingKey: 'coingecko:binancecoin', dexUnderlying: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', underDec: 18, redeemable: true, execSizeUsd: 25000, redemption: 'Lista/Synclub BNB unbonding ~7-15d' },
  { sym: 'ankrBNB', net: 'bsc', token: '0x52F24a5e03aee338Da5fd9Df68D2b6FAe1178827', selector: '0x6c58d43d' + ARG_1E18, dec: 18, underlyingKey: 'coingecko:binancecoin', dexUnderlying: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', underDec: 18, redeemable: true, execSizeUsd: 5000, redemption: 'Ankr BNB unbonding ~7-15d (or instant swap w/ fee)' },
  // --- ETH-LST L2 deployments (Arbitrum/Base/Optimism), workflow-verified + DefiLlama price-gated
  // (2026-05-29). navNet=ethereum (NAV read reuses the verified mainnet selector); token/DEX on the L2.
  // Capturing an L2 discount needs an L1 bridge (~7d canonical or ~5-30bps fast) — see redemption. ---
  { sym: 'wstETH.arb', net: 'arbitrum', navNet: 'ethereum', token: '0x5979D7b546E38E414F7E9822514be443A4800529', navContract: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0', selector: '0x035faf82', dec: 18, underlyingKey: 'coingecko:ethereum', dexUnderlying: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', underDec: 18, redeemable: true, execSizeUsd: 25000, frictionBps: 25, redemption: 'bridge arbitrum->L1 (~7d canonical or fast-bridge ~5-30bps) then redeem wstETH at NAV' },
  { sym: 'weETH.arb', net: 'arbitrum', navNet: 'ethereum', token: '0x35751007a407ca6feffe80b3cb397736d2cf4dbe', navContract: '0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee', selector: '0x679aefce', dec: 18, underlyingKey: 'coingecko:ethereum', dexUnderlying: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', underDec: 18, redeemable: true, execSizeUsd: 8000, frictionBps: 25, redemption: 'bridge arbitrum->L1 (~7d canonical or fast-bridge ~5-30bps) then redeem weETH at NAV' },
  { sym: 'rETH.arb', net: 'arbitrum', navNet: 'ethereum', token: '0xec70dcb4a1efa46b8f2d97c310c9c4790ba5ffa8', navContract: '0xae78736Cd615f374D3085123A210448E74Fc6393', selector: '0xe6aa216c', dec: 18, underlyingKey: 'coingecko:ethereum', dexUnderlying: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', underDec: 18, redeemable: true, execSizeUsd: 5000, frictionBps: 25, redemption: 'bridge arbitrum->L1 (~7d canonical or fast-bridge ~5-30bps) then redeem rETH at NAV' },
  { sym: 'wstETH.base', net: 'base', navNet: 'ethereum', token: '0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452', navContract: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0', selector: '0x035faf82', dec: 18, underlyingKey: 'coingecko:ethereum', dexUnderlying: '0x4200000000000000000000000000000000000006', underDec: 18, redeemable: true, execSizeUsd: 12000, frictionBps: 25, redemption: 'bridge base->L1 (~7d canonical or fast-bridge ~5-30bps) then redeem wstETH at NAV' },
  { sym: 'cbETH.base', net: 'base', navNet: 'ethereum', token: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', navContract: '0xBe9895146f7AF43049ca1c1AE358B0541Ea49704', selector: '0x3ba0b9a9', dec: 18, underlyingKey: 'coingecko:ethereum', dexUnderlying: '0x4200000000000000000000000000000000000006', underDec: 18, redeemable: true, execSizeUsd: 6000, frictionBps: 25, redemption: 'bridge base->L1 (~7d canonical or fast-bridge ~5-30bps) then redeem cbETH at NAV' },
  { sym: 'weETH.base', net: 'base', navNet: 'ethereum', token: '0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A', navContract: '0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee', selector: '0x679aefce', dec: 18, underlyingKey: 'coingecko:ethereum', dexUnderlying: '0x4200000000000000000000000000000000000006', underDec: 18, redeemable: true, execSizeUsd: 4000, frictionBps: 25, redemption: 'bridge base->L1 (~7d canonical or fast-bridge ~5-30bps) then redeem weETH at NAV' },
  { sym: 'rETH.base', net: 'base', navNet: 'ethereum', token: '0xb6fe221fe9eef5aba221c348ba20a1bf5e73624c', navContract: '0xae78736Cd615f374D3085123A210448E74Fc6393', selector: '0xe6aa216c', dec: 18, underlyingKey: 'coingecko:ethereum', dexUnderlying: '0x4200000000000000000000000000000000000006', underDec: 18, redeemable: true, execSizeUsd: 2500, frictionBps: 25, redemption: 'bridge base->L1 (~7d canonical or fast-bridge ~5-30bps) then redeem rETH at NAV' },
  { sym: 'wstETH.op', net: 'optimism', navNet: 'ethereum', token: '0x1F32b1c2345538c0c6f582fCB022739c4A194Ebb', navContract: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0', selector: '0x035faf82', dec: 18, underlyingKey: 'coingecko:ethereum', dexUnderlying: '0x4200000000000000000000000000000000000006', underDec: 18, redeemable: true, execSizeUsd: 12000, frictionBps: 25, redemption: 'bridge optimism->L1 (~7d canonical or fast-bridge ~5-30bps) then redeem wstETH at NAV' },
  { sym: 'rETH.op', net: 'optimism', navNet: 'ethereum', token: '0x9bCef72be871e61ED4fBbc7630889beE758eb81D', navContract: '0xae78736Cd615f374D3085123A210448E74Fc6393', selector: '0xe6aa216c', dec: 18, underlyingKey: 'coingecko:ethereum', dexUnderlying: '0x4200000000000000000000000000000000000006', underDec: 18, redeemable: true, execSizeUsd: 2500, frictionBps: 25, redemption: 'bridge optimism->L1 (~7d canonical or fast-bridge ~5-30bps) then redeem rETH at NAV' },
  { sym: 'cbETH.arb', net: 'arbitrum', navNet: 'ethereum', token: '0x1DEBd73E752bEaF79865Fd6446b0c970eaE7732f', navContract: '0xBe9895146f7AF43049ca1c1AE358B0541Ea49704', selector: '0x3ba0b9a9', dec: 18, underlyingKey: 'coingecko:ethereum', dexUnderlying: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', underDec: 18, redeemable: true, execSizeUsd: 4000, frictionBps: 25, redemption: 'bridge arbitrum->L1 (~7d canonical or fast-bridge ~5-30bps) then redeem cbETH at NAV' },
  // --- Solana LSTs (2026-05-29). NAV from Sanctum sol-value API (navSource = LST symbol), spot from
  // DefiLlama solana: prefix, exec from Jupiter (dexUnderlying = wSOL mint). All 9-decimal. ---
  { sym: 'jitoSOL', net: 'solana', navSource: 'jitoSOL', token: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', dec: 9, underlyingKey: 'solana:So11111111111111111111111111111111111111112', dexUnderlying: 'So11111111111111111111111111111111111111112', underDec: 9, redeemable: true, execSizeUsd: 25000, redemption: 'Sanctum/Jito instant unstake (~fee) or epoch unstake ~2-3d at NAV' },
  { sym: 'mSOL', net: 'solana', navSource: 'mSOL', token: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', dec: 9, underlyingKey: 'solana:So11111111111111111111111111111111111111112', dexUnderlying: 'So11111111111111111111111111111111111111112', underDec: 9, redeemable: true, execSizeUsd: 25000, redemption: 'Marinade instant unstake (~0.3% fee) or delayed ~2-3d epoch at NAV' },
  { sym: 'bSOL', net: 'solana', navSource: 'bSOL', token: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1', dec: 9, underlyingKey: 'solana:So11111111111111111111111111111111111111112', dexUnderlying: 'So11111111111111111111111111111111111111112', underDec: 9, redeemable: true, execSizeUsd: 10000, redemption: 'Sanctum/BlazeStake instant unstake (~fee) or epoch at NAV' },
  // More Solana LSTs (2026-05-29) — Sanctum NAV + DefiLlama-symbol-verified + Jupiter-liquid. All
  // currently trade at a ~34-42bps PREMIUM (non-actionable, mintableAtNav unset); actionable only if
  // one dips to a DISCOUNT (redeemable via Sanctum instant-unstake). (INF/compassSOL excluded:
  // INF=Sanctum index token w/ ambiguous Sanctum sol-value err; compassSOL not priced by DefiLlama.)
  { sym: 'jupSOL', net: 'solana', navSource: 'jupSOL', token: 'jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v', dec: 9, underlyingKey: 'solana:So11111111111111111111111111111111111111112', dexUnderlying: 'So11111111111111111111111111111111111111112', underDec: 9, redeemable: true, execSizeUsd: 15000, redemption: 'Sanctum instant unstake (~fee) or epoch ~2-3d at NAV' },
  { sym: 'dSOL', net: 'solana', navSource: 'dSOL', token: 'Dso1bDeDjCQxTrWHqUUi63oBvV7Mdm6WaobLbQ7gnPQ', dec: 9, underlyingKey: 'solana:So11111111111111111111111111111111111111112', dexUnderlying: 'So11111111111111111111111111111111111111112', underDec: 9, redeemable: true, execSizeUsd: 10000, redemption: 'Drift/Sanctum instant unstake (~fee) or epoch ~2-3d at NAV' },
  { sym: 'hSOL', net: 'solana', navSource: 'hSOL', token: 'he1iusmfkpAdwvxLNGV8Y1iSbj4rUy6yMhEA3fotn9A', dec: 9, underlyingKey: 'solana:So11111111111111111111111111111111111111112', dexUnderlying: 'So11111111111111111111111111111111111111112', underDec: 9, redeemable: true, execSizeUsd: 8000, redemption: 'Helius/Sanctum instant unstake (~fee) or epoch ~2-3d at NAV' },
  { sym: 'bonkSOL', net: 'solana', navSource: 'bonkSOL', token: 'BonK1YhkXEGLZzwtcvRTip3gAL9nCeQD7ppZBLXhtTs', dec: 9, underlyingKey: 'solana:So11111111111111111111111111111111111111112', dexUnderlying: 'So11111111111111111111111111111111111111112', underDec: 9, redeemable: true, execSizeUsd: 8000, redemption: 'BonkSOL/Sanctum instant unstake (~fee) or epoch ~2-3d at NAV' },
  { sym: 'vSOL', net: 'solana', navSource: 'vSOL', token: 'vSoLxydx6akxyMD9XEcPvGYNGq6Nn66oqVb3UkGkei7', dec: 9, underlyingKey: 'solana:So11111111111111111111111111111111111111112', dexUnderlying: 'So11111111111111111111111111111111111111112', underDec: 9, redeemable: true, execSizeUsd: 5000, redemption: 'Sanctum instant unstake (~fee) or epoch ~2-3d at NAV' },
];

const EXEC_THRESHOLD_BPS = 10;   // only burn a ParaSwap quote when spot says there might be an edge
const ACTIONABLE_BPS = 15;       // surface as an opportunity at/above this (executable-confirmed)
const MAX_SANE_BPS = 500;        // exec edge beyond this = slippage artifact (pool can't absorb $25k) -> illiquid
const EXEC_GATE_MS = 25 * 60 * 1000; // re-quote executable at most ~every 25 min (ParaSwap courtesy)

export async function scanNav() {
  log('[NAV] NAV vs DEX — on-chain rate + spot, executable confirm on candidates...');
  if (!KEY) { log('[NAV] no DRPC key — skipping'); return { timestamp: new Date().toISOString(), assets: [], note: 'no DRPC key' }; }

  // 1) NAV reads. Solana LSTs get SOL-value (NAV) from Sanctum's batch API; EVM via eth_call.
  const rates = {};
  const solAssets = NAV_ASSETS.filter((a) => a.net === 'solana');
  if (solAssets.length) {
    try {
      const q = solAssets.map((a) => `lst=${encodeURIComponent(a.navSource)}`).join('&');
      const r = await fetchJSON(`https://extra-api.sanctum.so/v1/sol-value/current?${q}`, { timeout: 12000 });
      const sv = r?.solValues || {};
      for (const a of solAssets) rates[a.sym] = sv[a.navSource] != null ? Number(sv[a.navSource]) / 1e9 : null;
      log(`[NAV] Sanctum SOL-values for ${Object.keys(sv).length}/${solAssets.length} Solana LSTs`);
    } catch (e) { log(`[NAV] sanctum error: ${redactKey(e.message)}`); }
  }
  for (const a of NAV_ASSETS) {
    if (a.net === 'solana') continue; // NAV already set from Sanctum
    // NAV read can differ from the DEX token in TWO ways: a separate contract (ETHx/mETH/osETH read a
    // pool-manager/rate-provider; the token reverts) AND a separate CHAIN (MaticX's rate fn lives on
    // ETH mainnet while the token trades on Polygon — navNet). `invert` handles token-per-native reads
    // (ankrMATIC ratio()): NAV = 1/raw.
    try {
      const hex = await ethCall(a.navNet || a.net, a.navContract || a.token, a.selector);
      let nv = hex ? e18(hex) : null;
      if (nv != null && a.invert) nv = nv > 0 ? 1 / nv : null;
      rates[a.sym] = nv;
    } catch (e) { rates[a.sym] = null; log(`[NAV] ${a.sym} eth_call error: ${redactKey(e.message)}`); }
  }

  // 2) DefiLlama spot (one call). Token key uses the DefiLlama chain prefix (avax != avalanche).
  const keys = [...new Set(NAV_ASSETS.flatMap((a) => [llamaKey(a.net, a.token), a.underlyingKey]))];
  let coins = {};
  try { coins = (await fetchJSON(`https://coins.llama.fi/prices/current/${keys.join(',')}`, { timeout: 12000 }))?.coins || {}; }
  catch (e) { log(`[NAV] coins error: ${redactKey(e.message)}`); }
  const px = (k) => coins[k]?.price ?? coins[k.toLowerCase()] ?? null;

  // executable-quote gate (don't hammer ParaSwap every 5 min)
  const st = loadData('nav-exec-state.json') || {};
  const doExec = !st.lastExecMs || (Date.now() - st.lastExecMs) >= EXEC_GATE_MS;
  const execCache = st.cache || {};

  const assets = [];
  for (const a of NAV_ASSETS) {
    const navRate = rates[a.sym];
    const sizeUsd = a.execSizeUsd || SIZE_USD; // smaller on thin altchain LSTs
    const pToken = px(llamaKey(a.net, a.token));
    const pUnder = px(a.underlyingKey);
    // DEX rate (underlying per token): prefer DefiLlama; for tokens it doesn't price (e.g. ankrMATIC)
    // fall back to a small ParaSwap probe — gated to the exec window + cached. Sizing the probe needs
    // the underlying USD price (have it) and the token's value ~= navRate * pUnder.
    let dexRate = (pToken && pUnder) ? pToken / pUnder : null;
    let dexSource = dexRate != null ? 'defillama' : null;
    if (dexRate == null && pUnder && navRate != null && NETWORK_ID[a.net]) {
      const cached = execCache[a.sym] || {};
      if (doExec) {
        const estTokenPx = navRate * pUnder;
        const probeTok = BigInt(Math.round((2000 / estTokenPx) * 10 ** a.dec)).toString();
        const q = await dexSell(a.net, a.token, a.dec, a.dexUnderlying, a.underDec, probeTok);
        if (q && q.srcAmount > 0) {
          dexRate = q.destAmount / q.srcAmount; dexSource = 'paraswap';
          execCache[a.sym] = { ...cached, fallbackDexRate: dexRate };
        } else if (cached.fallbackDexRate) { dexRate = cached.fallbackDexRate; dexSource = 'paraswap-cached'; }
      } else if (cached.fallbackDexRate) { dexRate = cached.fallbackDexRate; dexSource = 'paraswap-cached'; }
    }
    if (navRate == null || dexRate == null) {
      assets.push({ sym: a.sym, net: a.net, navRate: navRate != null ? +navRate.toFixed(6) : null, spotDiscountBps: null, redeemable: a.redeemable, redemption: a.redemption + ' [no DEX price]' }); continue;
    }
    const spotBps = ((navRate - dexRate) / navRate) * 1e4;

    // 3) executable confirmation when the spot discount looks interesting. The quote either CONFIRMS
    // the spot-direction edge (survives slippage at SIZE_USD) or NEGATES it (edge evaporated / pool
    // too thin) — it must never flip a thin-liquidity buy into a fake sellable "premium".
    let exec = execCache[a.sym] || null;
    if (doExec && Math.abs(spotBps) >= EXEC_THRESHOLD_BPS) {
      const expectDiscount = spotBps > 0;
      let q, edgeBps = null, execRate = null;
      if (expectDiscount) { // BUY token with underlying (sell underlying -> token)
        const amtWei = BigInt(Math.round((sizeUsd / pUnder) * 10 ** a.underDec)).toString();
        q = await dexSell(a.net, a.dexUnderlying, a.underDec, a.token, a.dec, amtWei);
        if (q && q.destAmount > 0) { execRate = q.srcAmount / q.destAmount; edgeBps = ((navRate - execRate) / navRate) * 1e4; }
      } else { // SELL token for underlying
        const amtWei = BigInt(Math.round((sizeUsd / pToken) * 10 ** a.dec)).toString();
        q = await dexSell(a.net, a.token, a.dec, a.dexUnderlying, a.underDec, amtWei);
        if (q && q.srcAmount > 0) { execRate = q.destAmount / q.srcAmount; edgeBps = ((execRate - navRate) / navRate) * 1e4; }
      }
      // edgeBps > 0 = spot-direction edge survived slippage; < 0 = evaporated (phantom); huge = pool
      // can't absorb the exec size (slippage artifact, e.g. ankrETH buy moving price 24%).
      if (edgeBps != null) exec = { edgeBps: +edgeBps.toFixed(2), expectDiscount, execRate: +execRate.toFixed(6), sizeUsd, ts: new Date().toISOString() };
      else exec = exec || { edgeBps: null, note: 'paraswap rate-limited/no-route' };
      execCache[a.sym] = exec;
    }

    // Resolve the confirmed (signed) executable edge: + = capturable discount, - = capturable premium.
    let execSigned = null, illiquid = false;
    if (exec && exec.edgeBps != null) {
      illiquid = exec.edgeBps < 0 || Math.abs(exec.edgeBps) > MAX_SANE_BPS; // negated or artifact
      if (!illiquid) execSigned = exec.expectDiscount ? exec.edgeBps : -exec.edgeBps;
    }
    const effBps = execSigned != null ? execSigned : (illiquid ? 0 : spotBps);
    // Net of redemption friction (bridge cost for cross-layer L2 deployments) — a gap is only capturable
    // if it clears the friction. netEdge keeps the sign but shrinks the magnitude toward zero.
    const friction = a.frictionBps || 0;
    const netMag = Math.max(0, Math.abs(effBps) - friction);
    const netEdgeBps = effBps < 0 ? -netMag : netMag;
    assets.push({
      sym: a.sym, net: a.net, navRate: +navRate.toFixed(6), dexRate: +dexRate.toFixed(6), dexSource,
      spotDiscountBps: +spotBps.toFixed(2),
      execDiscountBps: execSigned != null ? +execSigned.toFixed(2) : null, // confirmed signed edge (null if not run / illiquid)
      illiquid: illiquid || undefined,
      execRate: exec?.execRate ?? null, execSizeUsd: execSigned != null ? (exec?.sizeUsd || sizeUsd) : null,
      effDiscountBps: +effBps.toFixed(2), absBps: +Math.abs(effBps).toFixed(2),
      frictionBps: friction || undefined, netEdgeBps: friction ? +netEdgeBps.toFixed(2) : undefined,
      direction: effBps > 0 ? 'BUY_DEX_REDEEM' : 'MINT_SELL_DEX',
      redeemable: a.redeemable, mintableAtNav: a.mintableAtNav || undefined, redemption: a.redemption,
    });
  }
  if (doExec) { st.lastExecMs = Date.now(); st.cache = execCache; saveData('nav-exec-state.json', st); }

  assets.sort((x, y) => (y.absBps || 0) - (x.absBps || 0));
  // Actionable = EXEC-CONFIRMED edge (not spot-only, not illiquid), clears ACTIONABLE_BPS NET of
  // friction, AND is genuinely capturable on BOTH legs:
  //   DISCOUNT (DEX < NAV, effBps>0): buy on DEX + REDEEM at NAV — needs `redeemable` (a real unstake).
  //   PREMIUM  (DEX > NAV, effBps<0): MINT at NAV + sell on DEX — needs `mintableAtNav`. This is the
  //     bug we fixed: for stake-pool LSTs you CANNOT acquire at NAV (minting is fee'd/worse than the
  //     DEX, and the DEX buy side is itself above NAV — verified on jitoSOL: buy +37.9bps, sell +37.8bps),
  //     so the "premium" is the market's fair convenience value, NOT an arb. mintableAtNav defaults
  //     false; set it true ONLY for assets with a verified instant mint-at-NAV (e.g. ERC-4626 deposit).
  const actionable = assets.filter((a) => a.execDiscountBps != null && !a.illiquid
    && (Math.abs(a.execDiscountBps) - (a.frictionBps || 0)) >= ACTIONABLE_BPS
    && (a.effDiscountBps > 0 ? a.redeemable : a.mintableAtNav === true));
  log(`[NAV] ${assets.length} assets; ${actionable.length} actionable (|edge|>=${ACTIONABLE_BPS}bps, redeemable); exec-confirmed=${assets.filter((a) => a.execDiscountBps != null).length}`);
  return {
    timestamp: new Date().toISOString(), assets, actionable,
    max_abs_bps: assets.length ? Math.max(...assets.map((a) => a.absBps || 0)) : 0,
    exec_size_usd: SIZE_USD,
    note: `On-chain NAV vs DEX. effDiscountBps prefers the size-aware ParaSwap executable rate ($${SIZE_USD}) over DefiLlama spot. >0 = buy-DEX-redeem; <0 = mint-sell premium. redeemable=false means discount is a mean-reversion bet, not a locked arb.`,
  };
}
