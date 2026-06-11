// JSON-backed persistence for tracked wallets and pinned strategies.
// All state in /var/lib/defi-tracker-dashboard/. Atomic writes via rename.

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';

const STATE_DIR = process.env.DASH_STATE_DIR || new URL('../state', import.meta.url).pathname;
const WALLETS_FILE = join(STATE_DIR, 'wallets.json');
const PINS_FILE = join(STATE_DIR, 'pins.json');

function ensureDir() {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
}

function readJSON(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

function writeJSON(path, data) {
  ensureDir();
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

// ---- Wallets -------------------------------------------------------------
// Each wallet: { address, label, addedAt }
export function listWallets() {
  return readJSON(WALLETS_FILE, []);
}

export function addWallet({ address, label }) {
  const addr = String(address || '').trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) throw new Error('Invalid EVM address');
  const lc = addr.toLowerCase();
  const wallets = listWallets();
  if (wallets.some((w) => w.address.toLowerCase() === lc)) throw new Error('Wallet already tracked');
  wallets.push({
    address: addr,
    label: String(label || '').trim().slice(0, 40) || 'wallet',
    addedAt: new Date().toISOString(),
  });
  writeJSON(WALLETS_FILE, wallets);
  return wallets;
}

export function removeWallet(address) {
  const lc = String(address || '').toLowerCase();
  const wallets = listWallets().filter((w) => w.address.toLowerCase() !== lc);
  writeJSON(WALLETS_FILE, wallets);
  // Cascade: remove pins for this wallet
  const pins = listPins().filter((p) => p.walletAddress.toLowerCase() !== lc);
  writeJSON(PINS_FILE, pins);
  return wallets;
}

export function findWallet(address) {
  const lc = String(address || '').toLowerCase();
  return listWallets().find((w) => w.address.toLowerCase() === lc) || null;
}

// ---- Pins ----------------------------------------------------------------
// Each pin: { id, walletAddress, fingerprint, snapshot, status, pinnedAt, updatedAt, notes }
// snapshot = { category, action, expectedReturn, risk, chain, tvl, minCapitalUsd }
// status: 'planned' | 'active' | 'closed'

// Stable short fingerprint from category+normalized-action. Survives ranking changes
// within the same scan; will break if the agent rewords the action between scans.
export function fingerprintOf(strategy) {
  const norm = (strategy.category || '') + '|' + String(strategy.action || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 →>\-+().%$]/g, '')
    .trim();
  return createHash('sha1').update(norm).digest('hex').slice(0, 10);
}

export function listPins(walletAddress = null) {
  const pins = readJSON(PINS_FILE, []);
  if (!walletAddress) return pins;
  const lc = String(walletAddress).toLowerCase();
  return pins.filter((p) => p.walletAddress.toLowerCase() === lc);
}

export function addPin({ walletAddress, strategy, notes }) {
  if (!findWallet(walletAddress)) throw new Error('Unknown wallet');
  const fingerprint = fingerprintOf(strategy);
  const lc = walletAddress.toLowerCase();
  const pins = listPins();
  // No duplicate pins (same wallet + same fingerprint)
  if (pins.some((p) => p.walletAddress.toLowerCase() === lc && p.fingerprint === fingerprint)) {
    throw new Error('Strategy already pinned to this wallet');
  }
  const now = new Date().toISOString();
  const snapshot = {
    category: strategy.category,
    action: strategy.action,
    expectedReturn: strategy.expectedReturn,
    risk: strategy.risk,
    chain: strategy._chain || null,
    tvl: strategy.tvl || null,
    minCapitalUsd: strategy.minCapitalUsd || null,
  };
  pins.push({
    id: randomBytes(4).toString('hex'),
    walletAddress,
    fingerprint,
    snapshot,
    status: 'planned',
    pinnedAt: now,
    updatedAt: now,
    notes: String(notes || '').slice(0, 200),
  });
  writeJSON(PINS_FILE, pins);
  return pins;
}

export function updatePinStatus(id, status) {
  if (!['planned', 'active', 'closed'].includes(status)) throw new Error('Invalid status');
  const pins = listPins();
  const pin = pins.find((p) => p.id === id);
  if (!pin) throw new Error('Pin not found');
  pin.status = status;
  pin.updatedAt = new Date().toISOString();
  writeJSON(PINS_FILE, pins);
  return pins;
}

export function removePin(id) {
  const pins = listPins().filter((p) => p.id !== id);
  writeJSON(PINS_FILE, pins);
  return pins;
}
