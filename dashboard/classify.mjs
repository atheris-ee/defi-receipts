// Intent-based classification for dashboard sections.
// Tags each opportunity with {_assetClass,_fiatPeg,_isStable,_pairType,_legs,_section}.
// Prefers scanner-provided flags (o.isStable / o.stablePair / o.nonMajorToken) over symbol heuristics.

const strip = (s) => String(s || '').toUpperCase().trim()
  .replace(/\.(ARB|BASE|OP|AVAX|SOL|ETH|POLY|BSC|E)$/, ''); // chain-suffix / bridged markers

const ETH     = new Set(['ETH', 'WETH']);
const ETH_LST = new Set(['STETH','WSTETH','RETH','CBETH','OSETH','METH','SWETH','SFRXETH','WOETH','OETH','ETHX','ANKRETH','FRXETH','SFRAXETH']);
const ETH_LRT = new Set(['WEETH','EZETH','RSETH','PUFETH','RSWETH','WEETHS','UNIETH']);
const BTC     = new Set(['BTC','WBTC','BTCB','CBBTC','TBTC','LBTC','UBTC','SOLVBTC','KBTC']);
const SOL     = new Set(['SOL','WSOL']);
const SOL_LST = new Set(['JITOSOL','MSOL','JUPSOL','BSOL','BONKSOL','DSOL','HSOL','VSOL','INF']);
const MAJOR   = new Set(['BNB','WBNB','BNBX','SLISBNB','ANKRBNB','AVAX','WAVAX','SAVAX','GGAVAX','MATIC','WMATIC','MATICX','POL','TRX','SUI','APT','SEI','TIA','INJ','NEAR','ATOM','DOT','ADA','LINK','AAVE','UNI','CRV','YCRV','PENDLE','LDO','MKR','SKY','ENA','SENA','JTO','JUP','OP','ARB','HYPE','WHYPE','BERA','XMR','ZEC','WLD']);
const COMMOD  = new Set(['PAXG','XAUT','XAU']);
const USD_STABLE = new Set(['USDC','USDT','DAI','USDS','USDE','SUSDE','GHO','FRAX','SFRAX','CRVUSD','SCRVUSD','SUSD','SUSDS','SUSD3','USD1','FDUSD','PYUSD','RLUSD','USDP','TUSD','USDD','USDX','DEUSD','USDA','LVLUSD','USD0','GUSD','USDL','USDB','BOLD','USR','REUSD','REUSDE','MSUSD','MSUSDC','USDF','DOLA','SDOLA','SDAI','USDY','USYC','OUSD','WOUSD','APYUSD','APXUSD','SUPERUSDC','COREUSDC','AMBERUSDC','HIGHYIELDTERMAUSD','YIELDUSDT','USDAT','SUSDAT','SRUSDAT','JRUSDAT','FAUSDE','IDAI','IUSDC','IUSDT']);

function fiatOf(sym) {
  const s = strip(sym);
  if (/EUR/.test(s)) return 'EUR';
  if (/CHF/.test(s)) return 'CHF';
  if (/GBP/.test(s)) return 'GBP';
  if (/CAD/.test(s)) return 'CAD';
  if (/(JPY|MXN|TRY|BRL|AUD|SGD|NGN|CNY|HKD)/.test(s)) return 'FX';
  return 'USD';
}
function isStableSym(sym) {
  const s = strip(sym);
  if (USD_STABLE.has(s)) return true;
  if (ETH.has(s)||ETH_LST.has(s)||ETH_LRT.has(s)||BTC.has(s)||SOL.has(s)||SOL_LST.has(s)||MAJOR.has(s)||COMMOD.has(s)) return false;
  if (/(USD|EUR|CHF|GBP|CAD|DAI|GHO|FRAX)/.test(s)) return true; // long-tail fiat-peg names
  return false;
}
export function classifyToken(sym) {
  const s = strip(sym);
  if (ETH.has(s))     return { assetClass:'eth',     isStable:false, fiatPeg:null };
  if (ETH_LST.has(s)) return { assetClass:'eth-lst', isStable:false, fiatPeg:null };
  if (ETH_LRT.has(s)) return { assetClass:'eth-lrt', isStable:false, fiatPeg:null };
  if (BTC.has(s))     return { assetClass:'btc',     isStable:false, fiatPeg:null };
  if (SOL.has(s))     return { assetClass:'sol',     isStable:false, fiatPeg:null };
  if (SOL_LST.has(s)) return { assetClass:'sol-lst', isStable:false, fiatPeg:null };
  if (COMMOD.has(s))  return { assetClass:'commodity', isStable:false, fiatPeg:null };
  if (isStableSym(s)) return { assetClass:'stable',  isStable:true,  fiatPeg:fiatOf(s) };
  if (MAJOR.has(s))   return { assetClass:'major',   isStable:false, fiatPeg:null };
  return { assetClass:'other', isStable:false, fiatPeg:null };
}
export function classifyPair(pairStr) {
  const legs = String(pairStr || '').toUpperCase().split(/[-/]/).map((x) => strip(x)).filter(Boolean);
  const cls = legs.map(classifyToken);
  const stables = cls.filter((c) => c.isStable);
  const vols = cls.filter((c) => !c.isStable);
  let pairType = 'single';
  if (legs.length >= 2) pairType = vols.length === 0 ? 'stable-stable' : (stables.length === 0 ? 'volatile-volatile' : 'stable-volatile');
  const fiats = [...new Set(stables.map((c) => c.fiatPeg).filter(Boolean))];
  return { legs, cls, pairType, fiats, allStable: legs.length > 0 && vols.length === 0, volLeg: vols[0] };
}

// Fallback token/pair extraction from the action text (for curated top_strategies which carry no _open).
function symbolFromAction(action) {
  const a = String(action || '');
  let m = a.match(/:\s*([A-Za-z0-9.\-/]+)\s+on\s/);                              if (m) return m[1]; // CLM "...: PAIR on proj"
  m = a.match(/(?:Deposit into\s+\S+|Recursive loop|loop)\s+([A-Za-z0-9.\-/]+)\s+on\s/i); if (m) return m[1];
  m = a.match(/Borrow\s+([A-Za-z0-9.\-/]+)\s+from/i);                            if (m) return m[1]; // CARRY
  m = a.match(/Buy spot\s+([A-Za-z0-9.\-]+)/i);                                  if (m) return m[1]; // FUNDING
  m = a.match(/\b([A-Z0-9]{2,}[-/][A-Z0-9.]{2,})\b/);                            if (m) return m[1]; // any PAIR
  m = a.match(/\b([A-Z][A-Z0-9.]{2,})\b/);                                       if (m) return m[1]; // any TICKER
  return '';
}

const ARB_CATS   = new Set(['ARB','FLASH_ARB','DEPEG_ARB','NAV_ARB','LIQUIDATION']);
const CARRY_CATS = new Set(['CARRY','FREE_CARRY','RECURSIVE','FREE_LOOP','SPREAD']);

function sectionOf(o, c) {
  const cat = o.category;
  if (ARB_CATS.has(cat)) return 'arb';
  if (c._isStable) return 'stable';
  if (cat === 'CLM') return 'lp';
  if (cat === 'FUNDING') return 'neutral';
  if (cat === 'ALPHA' && o.alphaType === 'PENDLE_BASIS') return 'neutral';
  if (CARRY_CATS.has(cat)) return 'leverage';
  if (cat === 'ALPHA') return 'alpha';
  const ac = c._assetClass;
  if (ac === 'eth' || ac === 'eth-lst' || ac === 'eth-lrt') return 'eth';
  if (ac === 'btc') return 'btc';
  if (ac === 'sol' || ac === 'sol-lst') return 'sol';
  return 'other';
}

export function classifyOpportunity(o) {
  const open = o._open || {};
  const raw = open.pair || open.symbol || open.token || symbolFromAction(o.action) || '';
  const isPair = /[-/]/.test(raw) || o.category === 'CLM';
  let _assetClass, _fiatPeg = null, _isStable = false, _pairType, _legs;
  if (isPair && raw) {
    const p = classifyPair(raw);
    _pairType = p.pairType;
    _isStable = p.allStable;
    const nonUsd = p.fiats.filter((f) => f !== 'USD');
    _fiatPeg = nonUsd.length === 0 ? (p.fiats.length ? 'USD' : null) : (nonUsd.length === 1 ? nonUsd[0] : 'MIXED');
    _assetClass = p.allStable ? 'stable' : (p.volLeg ? p.volLeg.assetClass : 'other');
    _legs = p.legs;
  } else {
    const t = classifyToken(raw);
    _pairType = 'single'; _isStable = t.isStable; _fiatPeg = t.fiatPeg; _assetClass = t.assetClass;
    _legs = raw ? [strip(raw)] : [];
  }
  if (o.isStable === true) { _isStable = true; if (!_fiatPeg) _fiatPeg = 'USD'; }
  if (o.stablePair === true) { _isStable = true; _pairType = 'stable-stable'; }
  if (o.nonMajorToken === true && _assetClass === 'other') _assetClass = 'longtail';
  const _section = sectionOf(o, { _assetClass, _isStable });
  return { _assetClass, _fiatPeg, _isStable, _pairType, _legs, _section };
}

export const SECTIONS = [
  { id:'stable',   label:'Stablecoin Farms',     emoji:'\u{1F4B5}', blurb:'Earn on stable assets — minimal price risk. Grouped by fiat peg.', fiatGroups:true },
  { id:'lp',       label:'Liquidity Pools',       emoji:'\u{1F30A}', blurb:'Provide liquidity (concentrated / AMM) on volatile pairs. Fee yield with impermanent-loss risk.' },
  { id:'neutral',  label:'Market-Neutral Income', emoji:'⚖️', blurb:'Delta-neutral: funding-rate harvest & fixed-yield basis. No directional bet.' },
  { id:'eth',      label:'ETH & Staking',         emoji:'\u{1F537}', blurb:'Yield on ETH and liquid-staking / restaking tokens.' },
  { id:'btc',      label:'BTC Yield',             emoji:'\u{1F7E0}', blurb:'Yield on BTC and wrapped/bridged BTC.' },
  { id:'sol',      label:'SOL & Staking',         emoji:'\u{1F7E3}', blurb:'Yield on SOL and SOL liquid-staking tokens.' },
  { id:'leverage', label:'Leverage & Carry',      emoji:'\u{1F501}', blurb:'Borrow-and-stake carries, lending spreads, recursive leverage loops.' },
  { id:'alpha',    label:'Asymmetric Plays',      emoji:'\u{1F3AF}', blurb:'Convex / high-upside structures. Higher risk by design.' },
  { id:'other',    label:'Other Yield',           emoji:'•',    blurb:'Single-asset yields on majors and long-tail tokens.' },
  { id:'arb',      label:'Arb & Liquidations',    emoji:'⚡',    blurb:'MEV-competitive — informational, usually not manually actionable.' },
];
export const SECTION_BY_ID = Object.fromEntries(SECTIONS.map((s) => [s.id, s]));
