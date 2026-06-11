// PHASE-0 MEASUREMENT (read-only): on-chain incentive-program sniffer via the Merkl API.
//
// The scanner is structurally blind to Merkl — the primary incentive router for Base/Arbitrum/
// Optimism programs — because everything comes from DefiLlama, which only lists a pool AFTER it is
// adapter-covered + TVL-qualified + 30d-aged (by which point the early high-APY window is gone).
// This module polls Merkl LIVE opportunities, keeps a first-seen registry, and tracks how each
// program's APR decays from when WE first saw it. That decay curve IS the falsifiable Strategy-#1
// edge measurement — captured directly, with zero capital and no signing.

import { fetchJSON, loadData, saveData, log } from './utils.js';

const CHAINS = [
  { id: 8453, name: 'base' },
  { id: 42161, name: 'arbitrum' },
  { id: 10, name: 'optimism' },
];
const REGISTRY = 'incentive-registry.json';

async function fetchChain(id) {
  try {
    const r = await fetchJSON(`https://api.merkl.xyz/v4/opportunities?chainId=${id}&status=LIVE&items=100`, { timeout: 12000 });
    return Array.isArray(r) ? r : [];
  } catch (e) { log(`[INCENTIVE] merkl chain ${id} error: ${e.message}`); return []; }
}

const num = (v) => (v == null || isNaN(Number(v)) ? 0 : Number(v));
const hoursSince = (iso) => { const t = Date.parse(iso); return isNaN(t) ? null : (Date.now() - t) / 3.6e6; };

export async function scanIncentives() {
  log('[INCENTIVE] Polling Merkl live opportunities (Base/Arbitrum/Optimism)...');
  const nowIso = new Date().toISOString();
  const reg = loadData(REGISTRY) || {};

  const all = [];
  for (const c of CHAINS) {
    const opps = await fetchChain(c.id);
    for (const o of opps) {
      const apr = num(o.apr);
      const tvl = num(o.tvl);
      if (apr <= 0 || tvl <= 0) continue;
      all.push({
        id: String(o.id),
        name: o.name,
        protocol: o.protocol?.name || o.protocol || '',
        chain: c.name,
        apr: +apr.toFixed(2),
        maxApr: +num(o.maxApr).toFixed(2),
        tvl,
        dailyRewards: +num(o.dailyRewards).toFixed(2),
        action: o.action,
        depositUrl: o.depositUrl || (o.depositUrls && o.depositUrls[0]) || null,
        campaignStart: o.earliestCampaignStart || o.lastCampaignCreatedAt || null,
      });
    }
  }

  // Update registry: record first-sight APR/TVL; track decay for known ones.
  const enriched = [];
  let newCount = 0;
  const seenIds = new Set();
  for (const o of all) {
    seenIds.add(o.id);
    if (!reg[o.id]) {
      reg[o.id] = { firstSeen: nowIso, firstApr: o.apr, firstTvl: o.tvl, name: o.name, protocol: o.protocol, chain: o.chain };
      newCount++;
    }
    const r = reg[o.id];
    r.lastSeen = nowIso; r.lastApr = o.apr; r.lastTvl = o.tvl;
    const ageH = hoursSince(r.firstSeen);
    enriched.push({
      ...o,
      firstSeenApr: r.firstApr,
      aprRatio: r.firstApr > 0 ? +(o.apr / r.firstApr).toFixed(3) : null, // <1 = decaying as expected
      tvlGrowth: r.firstTvl > 0 ? +(o.tvl / r.firstTvl).toFixed(3) : null, // >1 = mercenary inflow diluting
      ageHoursSinceFirstSeen: ageH != null ? +ageH.toFixed(1) : null,
      campaignAgeHours: o.campaignStart ? +(hoursSince(o.campaignStart) || 0).toFixed(1) : null,
    });
  }
  // prune registry entries not seen for >14 days (program ended)
  for (const id of Object.keys(reg)) {
    if (!seenIds.has(id) && hoursSince(reg[id].lastSeen) > 24 * 14) delete reg[id];
  }
  saveData(REGISTRY, reg);

  enriched.sort((a, b) => b.apr - a.apr);
  // "fresh window": campaigns we first saw recently AND still paying high — the entry zone
  const freshHighApr = enriched.filter((o) => o.ageHoursSinceFirstSeen != null && o.ageHoursSinceFirstSeen <= 72 && o.apr >= 20);
  const newThisScan = enriched.filter((o) => reg[o.id]?.firstSeen === nowIso);

  log(`[INCENTIVE] ${all.length} live programs; ${newCount} NEW this scan; ${freshHighApr.length} fresh(<72h)+highAPR(>20%)`);
  return {
    timestamp: nowIso,
    total_live: all.length,
    new_this_scan: newThisScan.slice(0, 30),
    fresh_high_apr: freshHighApr.slice(0, 30),
    top_live: enriched.slice(0, 40),
    summary: {
      live: all.length, new_this_scan: newCount, fresh_high_apr: freshHighApr.length,
      tracked_registry: Object.keys(reg).length,
      max_apr: enriched.length ? enriched[0].apr : 0,
    },
    note: 'Merkl incentive programs — invisible to the DefiLlama scanner. aprRatio<1 = decaying as TVL floods in (Strategy #1 dilution curve). Registry accumulates first-seen APR so decay is measurable over time.',
  };
}
