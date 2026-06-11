import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import https from "https";
import http from "http";

// Paths are repo-relative by default (this file lives in scanner/src/), overridable by env so a
// system install can point data/cache/config wherever it likes.
const BASE = process.env.RECEIPTS_SCANNER_DIR || join(fileURLToPath(new URL(".", import.meta.url)), "..");
const DATA_DIR = process.env.RECEIPTS_DATA_DIR || join(BASE, "data");
const CACHE_DIR = process.env.RECEIPTS_CACHE_DIR || join(BASE, "cache");

export function loadConfig() {
  return JSON.parse(readFileSync(process.env.RECEIPTS_CONFIG || join(BASE, "config/settings.json"), "utf8"));
}

export function cached(key, ttlSeconds = 300) {
  const file = join(CACHE_DIR, `${key}.json`);
  if (!existsSync(file)) return null;
  const stat = JSON.parse(readFileSync(file, "utf8"));
  if (Date.now() - stat._ts > ttlSeconds * 1000) return null;
  return stat.data;
}

export function setCache(key, data) {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(join(CACHE_DIR, `${key}.json`), JSON.stringify({ _ts: Date.now(), data }));
}

export function saveData(filename, data) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(join(DATA_DIR, filename), JSON.stringify(data, null, 2));
}

export function loadData(filename) {
  const file = join(DATA_DIR, filename);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8"));
}

export function fetchJSON(url, options = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const parsed = new URL(url);
    const reqOpts = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      port: parsed.port || (url.startsWith("https") ? 443 : 80),
      method: options.method || "GET",
      timeout: options.timeout || 15000,
      headers: { "User-Agent": "DeFiTracker/1.0", ...options.headers },
    };
    if (options.body) {
      reqOpts.headers["Content-Length"] = Buffer.byteLength(options.body);
    }
    const req = mod.request(reqOpts, (res) => {
      let body = "";
      res.on("data", c => body += c);
      res.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error("JSON parse error from " + url + ": " + body.slice(0, 200))); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout: " + url)); });
    if (options.body) req.write(options.body);
    req.end();
  });
}

export function riskScore(pool) {
  let risk = 0;
  if (pool.ilRisk === "yes" || (pool.symbol && pool.symbol.includes("-") && !pool.stablecoin)) risk += 2;
  if ((pool.tvlUsd || 0) < 500000) risk += 2;
  if ((pool.tvlUsd || 0) < 100000) risk += 2;
  if (pool.poolMeta === "new" || (pool.exposure && pool.exposure === "single")) risk -= 1;
  if ((pool.apy || 0) > 500) risk += 2;
  if ((pool.apy || 0) > 1000) risk += 1;
  const trusted = ["aave","compound","lido","makerdao","curve","convex","uniswap","pendle","morpho","eigenlayer","jito","marinade","raydium","kamino","drift","jupiter"];
  if (trusted.includes((pool.project || "").toLowerCase())) risk -= 1;
  return Math.max(1, Math.min(10, risk + 3));
}

export function formatPct(n) {
  if (n == null) return "N/A";
  return n.toFixed(2) + "%";
}

export function formatUSD(n) {
  if (n == null) return "N/A";
  if (n >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K";
  return "$" + n.toFixed(2);
}

export function log(msg) {
  const ts = new Date().toISOString();
  console.log("[" + ts + "] " + msg);
}
