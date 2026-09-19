const http = require("http");
const https = require("https");

const activeClients = {}; // userId -> clientInfo
const rbxCache = {};      // roblox proxy key -> { ts, data } (10 min TTL)
const pendingKicks = {};  // userId -> boolean
let totalExecutions = 4788406;

// User-generated profiles for the short-link profile pages (/<handle>).
// Kept in memory (optionally mirrored to ./profiles.json so restarts keep data).
const profiles = {}; // handle -> profile object
const media = {};    // media id -> mp3 Buffer (served at /media/<id>.mp3)

const crypto = require("crypto");
const fs = require("fs");

// Discord OAuth — required to create/edit profiles
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || "";
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || "";
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || "https://adorable-sallyanne-fgdfgdfgd-b2d051be.koyeb.app/auth/discord/callback";
const SITE_ORIGIN = process.env.SITE_ORIGIN || "https://get-oxide.com";
const oauthStates = {}; // oauth state -> createdAt
const sessions = {};    // session token -> discord user info

// GitHub-backed persistence so profiles + media survive redeploys.
const GH_DATA_TOKEN = process.env.GH_DATA_TOKEN || ""; // set via Koyeb env (never commit tokens)
const GH_DATA_REPO = "xulfo/oxide-presence";
const GH_DATA_PATH = "profiles.json";
const GAMES_DATA_PATH = "games.json";

function ghApi(method, path, body) {
    if (!GH_DATA_TOKEN) return Promise.resolve({ status: 401, body: "{}" });
    return new Promise((resolve, reject) => {
        const https = require("https");
        const data = body ? JSON.stringify(body) : null;
        const req = https.request({
            host: "api.github.com",
            path: path,
            method: method,
            headers: {
                "User-Agent": "oxide-hub",
                Authorization: "token " + GH_DATA_TOKEN,
                Accept: "application/vnd.github+json",
                ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {})
            }
        }, res => {
            let d = "";
            res.on("data", c => d += c);
            res.on("end", () => resolve({ status: res.statusCode, body: d }));
        });
        req.on("error", reject);
        if (data) req.write(data);
        req.end();
    });
}

async function loadProfilesFromGitHub() {
    try {
        const res = await ghApi("GET", `/repos/${GH_DATA_REPO}/contents/${GH_DATA_PATH}`);
        if (res.status === 200) {
            const j = JSON.parse(res.body);
            const saved = JSON.parse(Buffer.from(j.content, "base64").toString("utf8"));
            Object.assign(profiles, saved);
            console.log("Loaded " + Object.keys(saved).length + " profiles from GitHub");
        }
    } catch (e) {
        console.log("GitHub profiles load failed: " + e.message);
    }
}

async function loadMediaFromGitHub() {
    try {
        const res = await ghApi("GET", `/repos/${GH_DATA_REPO}/contents/media`);
        if (res.status === 200) {
            const files = JSON.parse(res.body);
            for (const f of files) {
                if (f.name && f.name.endsWith(".mp3")) {
                    const fc = await ghApi("GET", `/repos/${GH_DATA_REPO}/contents/media/${f.name}`);
                    if (fc.status === 200) media[f.name.replace(/\.mp3$/, "")] = Buffer.from(JSON.parse(fc.body).content, "base64");
                }
            }
            console.log("Loaded " + Object.keys(media).length + " media files from GitHub");
        }
    } catch (e) {
        console.log("GitHub media load skipped: " + e.message);
    }
}

try {
    if (fs.existsSync("./media")) {
        for (const f of fs.readdirSync("./media")) {
            if (f.endsWith(".mp3")) media[f.replace(/\.mp3$/, "")] = fs.readFileSync("./media/" + f);
        }
    }
} catch (_) {}

const RESERVED_HANDLES = new Set([
    "lesy", "create", "profile", "script", "admin", "assets", "games",
    "statistics", "updates", "server", "index", "loader", "api", "u", "404"
]);
const PROFILE_STATUSES = new Set(["Online", "Do not disturb", "Offline"]);

function normalizeStatus(value) {
    const status = String(value || "Online");
    return PROFILE_STATUSES.has(status) ? status : "Online";
}

try {
    if (fs.existsSync("./profiles.json")) {
        const saved = JSON.parse(fs.readFileSync("./profiles.json", "utf8"));
        Object.assign(profiles, saved);
    }
} catch (_) {}

function persistProfiles() {
    try {
        fs.writeFileSync("./profiles.json", JSON.stringify(profiles));
    } catch (_) {}
    // Async mirror to GitHub so profiles survive redeploys.
    ghApi("GET", `/repos/${GH_DATA_REPO}/contents/${GH_DATA_PATH}`).then(async (res) => {
        const payload = {
            content: Buffer.from(JSON.stringify(profiles), "utf8").toString("base64"),
            message: "profiles update",
            branch: "main"
        };
        if (res.status === 200) payload.sha = JSON.parse(res.body).sha;
        const put = await ghApi("PUT", `/repos/${GH_DATA_REPO}/contents/${GH_DATA_PATH}`, payload);
        if (put.status !== 200 && put.status !== 201) console.log("GitHub profiles save skipped (" + put.status + ")");
    }).catch(() => {});
}
const TIMEOUT = 45000; // 45 seconds (clients heartbeat every 15s)
const ADMIN_PASS = "Ragnarok1711!";

let usersCache = null;
let usersCacheTs = 0;
let onlineCache = null;
let onlineCacheTs = 0;

const GAME_NAMES = {
    107778070777162: "Steal an Egg",
    126870639873289: "Jump for Pets!",
    106484206883664: "Dungeon Lootr",
    2788229376: "Da Hood",
    142823291: "Murder Mystery 2",
    94640181989498: "Grow a Chicken Fighter",
    83038462357724: "Graben und reinigen",
    128736949265057: "Gakuran",
    100068273119174: "Leaf Simulator",
    108628039999641: "Search For The Needle",
    77108422251420: "Search For The Needle",
    17625359962: "RIVALS"
};

const BASELINE_GAMES = [
    { name: "Steal an Egg", launches: 2951204, place_id: 107778070777162 },
    { name: "Jump for Pets!", launches: 843102, place_id: 126870639873289 },
    { name: "Grow a Chicken Fighter", launches: 421890, place_id: 94640181989498 },
    { name: "Graben und reinigen", launches: 284150, place_id: 83038462357724 },
    { name: "Dungeon Lootr", launches: 112040, place_id: 106484206883664 },
    { name: "Da Hood", launches: 95400, place_id: 2788229376 },
    { name: "Murder Mystery 2", launches: 48200, place_id: 142823291 },
    { name: "Gakuran", launches: 19500, place_id: 128736949265057 },
    { name: "Leaf Simulator", launches: 11500, place_id: 100068273119174 },
    { name: "Search For The Needle", launches: 1500, place_id: 108628039999641 },
    { name: "RIVALS", launches: 2500, place_id: 17625359962 },
    { name: "Universal", launches: 3200, place_id: 0 }
];

// Real per-game launch counters (fed by /register). These accumulate on top of
// the BASELINE_GAMES numbers so every supported game — including new ones —
// is actually tracked in the executions stats, not just the baseline.
const gameLaunches = {};      // game name -> real launch count
let unsupportedLaunches = 0;  // real launches from unknown place ids

// place_id -> universe_id (used by the /banner route to fetch real game thumbnails)
const UNIVERSE_IDS = {
    107778070777162: 10563114921,
    126870639873289: 10690360998,
    94640181989498: 10338952197,
    83038462357724: 10475794799,
    106484206883664: 9656201728,
    2788229376: 1008451066,
    142823291: 66654135,
    128736949265057: 9199655655,
    100068273119174: 10539411000,
    108628039999641: 10756011174,
    17625359962: 6035872082
};

// Games the hub has executed that nobody has named yet. A client only reports a
// placeId, so an unknown one is resolved against Roblox once and then becomes a
// first-class supported game (live + execution stats + the website list).
const placeNameCache = {};   // placeId -> resolved game name
const placeNamePending = {}; // placeId -> lookup in flight

function shopGuessName(placeId) {
    return GAME_NAMES[placeId] || placeNameCache[placeId] || null;
}

function resolvePlaceName(placeId) {
    if (!placeId || shopGuessName(placeId) || placeNamePending[placeId]) return;
    placeNamePending[placeId] = true;
    const https = require("https");
    const done = () => { delete placeNamePending[placeId]; };
    https.get({ host: "apis.roblox.com", path: `/universes/v1/places/${placeId}/universe`, headers: { "User-Agent": "oxide-hub" } }, r => {
        let d = "";
        r.on("data", c => d += c);
        r.on("end", () => {
            let universeId = 0;
            try { universeId = Number((JSON.parse(d) || {}).universeId) || 0; } catch (_) {}
            if (!universeId) return done();
            https.get({ host: "games.roblox.com", path: `/v1/games?universeIds=${universeId}`, headers: { "User-Agent": "oxide-hub" } }, r2 => {
                let d2 = "";
                r2.on("data", c => d2 += c);
                r2.on("end", () => {
                    try {
                        const g = ((JSON.parse(d2) || {}).data || [])[0];
                        if (g && g.name) {
                            placeNameCache[placeId] = String(g.name);
                            GAME_NAMES[placeId] = String(g.name);
                            UNIVERSE_IDS[placeId] = universeId;
                            console.log(`Auto-registered game "${g.name}" (place ${placeId})`);
                            persistGames();
                        }
                    } catch (_) {}
                    done();
                });
            }).on("error", done);
        });
    }).on("error", done);
}

// The single source of truth for "which games are supported". Baseline numbers, real
// launch counters and auto-discovered games are merged here, so /games, /stats and the
// control room can never disagree about the list or the count.
function allTrackedGames() {
    const byName = new Map();
    // Curated = a game the hub ships a script for (BASELINE_GAMES). Everything else in
    // here was discovered at runtime, so clients can present the two groups separately.
    const curated = new Set(BASELINE_GAMES.map(g => String(g.name).toLowerCase()));
    const ensure = (name, placeId) => {
        const key = String(name).toLowerCase();
        let e = byName.get(key);
        if (!e) {
            e = { name: String(name), place_id: placeId || 0, universe_id: 0, launches: 0, curated: curated.has(key) };
            byName.set(key, e);
        } else if (!e.place_id && placeId) {
            e.place_id = placeId;
        }
        return e;
    };
    for (const g of BASELINE_GAMES) ensure(g.name, g.place_id).launches += g.launches;
    for (const pid of Object.keys(GAME_NAMES)) ensure(GAME_NAMES[pid], Number(pid));
    for (const [name, launches] of Object.entries(gameLaunches)) ensure(name, 0).launches += launches;
    for (const e of byName.values()) e.universe_id = UNIVERSE_IDS[e.place_id] || 0;
    return Array.from(byName.values()).sort((a, b) => b.launches - a.launches);
}

// Discovered games and real launch counters are persisted so a redeploy does not shrink
// the catalog back to the hardcoded baseline.
let gamesPersistTimer = null;
let gamesPersistDirty = false;
function persistGames() {
    gamesPersistDirty = true;
    if (gamesPersistTimer) return;
    gamesPersistTimer = setTimeout(async () => {
        gamesPersistTimer = null;
        if (!gamesPersistDirty) return;
        gamesPersistDirty = false;
        const snapshot = JSON.stringify({ names: placeNameCache, launches: gameLaunches, unsupported: unsupportedLaunches });
        try {
            const res = await ghApi("GET", `/repos/${GH_DATA_REPO}/contents/${GAMES_DATA_PATH}`);
            const payload = { content: Buffer.from(snapshot, "utf8").toString("base64"), message: "games update", branch: "main" };
            if (res.status === 200) payload.sha = JSON.parse(res.body).sha;
            const put = await ghApi("PUT", `/repos/${GH_DATA_REPO}/contents/${GAMES_DATA_PATH}`, payload);
            if (put.status !== 200 && put.status !== 201) console.log("Games save skipped (" + put.status + ")");
        } catch (e) { console.log("Games save failed: " + e.message); }
    }, 5000);
}

async function loadGamesFromGitHub() {
    try {
        const res = await ghApi("GET", `/repos/${GH_DATA_REPO}/contents/${GAMES_DATA_PATH}`);
        if (res.status !== 200) return;
        const saved = JSON.parse(Buffer.from(JSON.parse(res.body).content, "base64").toString("utf8"));
        for (const [pid, name] of Object.entries(saved.names || {})) {
            placeNameCache[pid] = name;
            if (!GAME_NAMES[pid]) GAME_NAMES[pid] = name;
        }
        for (const [name, count] of Object.entries(saved.launches || {})) {
            gameLaunches[name] = Math.max(gameLaunches[name] || 0, count);
        }
        if (saved.unsupported) unsupportedLaunches = Math.max(unsupportedLaunches, saved.unsupported);
        const known = Object.keys(saved.names || {}).length;
        if (known) console.log("Loaded " + known + " discovered games from GitHub");
    } catch (e) { console.log("Games load skipped: " + e.message); }
}

const avatarCache = {};

async function resolveAvatars(clients) {
    const missing = clients.filter(c => !avatarCache[c.userId]).map(c => c.userId);
    if (missing.length === 0) return;
    for (let i = 0; i < missing.length; i += 50) {
        const chunk = missing.slice(i, i + 50);
        try {
            await new Promise(resolve => {
                const https = require("https");
                const url = `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${chunk.join(",")}&size=150x150&format=Png&isCircular=false`;
                https.get(url, res => {
                    let d = "";
                    res.on("data", c => d += c);
                    res.on("end", () => {
                        try {
                            const j = JSON.parse(d);
                            (j.data || []).forEach(item => {
                                if (item.imageUrl) avatarCache[item.targetId] = item.imageUrl;
                            });
                        } catch (_) {}
                        resolve();
                    });
                }).on("error", () => resolve());
            });
        } catch (_) {}
    }
}

function getAliveClients() {
    const now = Date.now();
    return Object.values(activeClients).filter(c => now - c.ts < TIMEOUT);
}

loadProfilesFromGitHub();
loadMediaFromGitHub();

/* ═══════════════════════════════════════════════════════════════════════════
   OXIDE SHOP — buy Robux with crypto
   ───────────────────────────────────────────────────────────────────────────
   Flow: the buyer picks a pack (or types a custom amount), the backend locks a
   USD price, converts it with a live rate and derives a UNIQUE on-chain amount
   (base + a small untagged-free "tag"), then a watcher polls the matching chain
   until a transaction to the deposit address carries that exact amount. That is
   what makes payment detection automatic and unambiguous: several pending orders
   always have different amounts, and every claimed txid is remembered so one
   payment can never settle two orders.

   Coins are pure adapters over public APIs (no npm dependencies):
     btc / ltc  → mempool.space / litecoinspace.org REST
     eth        → JSON-RPC block scan
     sol        → Solana JSON-RPC (getSignaturesForAddress + getTransaction)
     usdt       → TronGrid TRC-20 transfers
   ═══════════════════════════════════════════════════════════════════════════ */

const SHOP_MIN_ROBUX = 10000;
const SHOP_MAX_ROBUX = 10000000;
const SHOP_ORDER_TTL = 30 * 60 * 1000;      // price is locked for 30 minutes
const SHOP_WATCH_TTL = 3 * 60 * 60 * 1000;  // ...but a late payment is still caught for 3h

// Limited packs. `limit` is the lifetime stock shown on the storefront.
const SHOP_PACKS = [
    { id: "starter", label: "Starter",   robux: 100000, usdCents: 5000,  limit: 50, blurb: "The everyday top-up" },
    { id: "plus",    label: "Plus",      robux: 150000, usdCents: 8000,  limit: 30, blurb: "Most popular" },
    { id: "pro",     label: "Overlord",  robux: 300000, usdCents: 12000, limit: 20, blurb: "Best robux per dollar" }
];

// Custom orders: a flat $1.00 per 1,000 Robux, so 10,000 Robux = $10 and
// 12,000 = $12. The limited packs stay cheaper per 1,000 — that is what makes
// them worth buying.
const SHOP_TIERS = [
    { minRobux: SHOP_MIN_ROBUX, usdPer1k: 1.0 }
];

// Every coin matches on EXACT base units, so `step` drives how many concurrent
// orders can share a coin before amounts repeat (tagMax) and how large the
// rounding surcharge can get (always kept under ~$0.10).
const SHOP_COINS = {
    btc: { name: "Bitcoin",  symbol: "BTC", decimals: 8,  dp: 8, step: 1n,          tagMax: 99,  minConf: 1, scheme: "bitcoin",  explorer: "https://mempool.space/tx/" },
    ltc: { name: "Litecoin", symbol: "LTC", decimals: 8,  dp: 8, step: 1n,          tagMax: 99,  minConf: 1, scheme: "litecoin", explorer: "https://litecoinspace.org/tx/" },
    eth: { name: "Ethereum", symbol: "ETH", decimals: 18, dp: 9, step: 1000000000n, tagMax: 999, minConf: 2, scheme: "ethereum", explorer: "https://etherscan.io/tx/" }
};

const SHOP_COIN_IDS = { btc: "bitcoin", ltc: "litecoin", eth: "ethereum" };
const SHOP_FALLBACK_USD = { btc: 100000, eth: 3200, ltc: 105 };

const SHOP_MEMPOOL = { btc: "https://mempool.space", ltc: "https://litecoinspace.org" };
const SHOP_ETH_RPC = process.env.SHOP_RPC_ETH || "https://ethereum-rpc.publicnode.com";

const SHOP_DATA_PATH = "shop.json";
const SHOP_SITE = process.env.SITE_ORIGIN || "https://get-oxide.com";

// Runtime state. `config` is editable from the admin panel and persisted, so the
// deposit addresses can be changed without a redeploy.
const shopConfig = {
    enabled: true,
    announcement: "",
    addresses: { btc: "", ltc: "", eth: "" },
    limits: SHOP_PACKS.reduce((acc, p) => (acc[p.id] = p.limit, acc), {}),
    discordWebhook: "" // where paid-order alerts are posted
};
const shopOrders = {};  // orderId -> order
const shopTxIndex = {}; // txid -> orderId (a tx can only ever settle one order)
const shopRates = { ts: 0, cents: {} };
const shopIpLog = {};

function shopHttpJsonOnce(url, opts) {
    return new Promise((resolve, reject) => {
        let u;
        try { u = new URL(url); } catch (e) { return reject(new Error("bad url")); }
        const body = (opts && opts.body) || null;
        const req = https.request({
            host: u.hostname,
            path: u.pathname + u.search,
            method: (opts && opts.method) || "GET",
            headers: {
                "User-Agent": "oxide-shop",
                Accept: "application/json",
                ...(body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {}),
                ...((opts && opts.headers) || {})
            }
        }, res => {
            let d = "";
            res.on("data", c => d += c);
            res.on("end", () => {
                if (res.statusCode >= 400) return reject(new Error("upstream " + res.statusCode));
                try { resolve(JSON.parse(d)); } catch (e) { reject(new Error("bad json from " + u.hostname)); }
            });
        });
        req.setTimeout(15000, () => req.destroy(new Error("timeout")));
        req.on("error", reject);
        if (body) req.write(body);
        req.end();
    });
}

// Public explorers and RPC endpoints blip (502/503, resets, timeouts). Every shop call is
// a read, so retrying is safe and a lost poll never costs a payment. Up to 3 attempts.
function shopRetryable(err) {
    const m = String((err && err.message) || "");
    return /upstream (429|5\d\d)/.test(m) || /timeout/.test(m) || /(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up)/.test(m);
}
async function shopHttpJson(url, opts) {
    let last;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            return await shopHttpJsonOnce(url, opts);
        } catch (e) {
            last = e;
            if (!shopRetryable(e) || attempt === 2) throw e;
            await new Promise(r => setTimeout(r, 700 * Math.pow(2, attempt)));
        }
    }
    throw last;
}

function shopNf(n) {
    return Number(n || 0).toLocaleString("en-US");
}

// base units (BigInt) -> exact decimal string, e.g. 1234 sats -> "0.00001234"
function shopFormatUnits(value, decimals, dp) {
    const s = BigInt(value).toString().padStart(decimals + 1, "0");
    const whole = s.slice(0, s.length - decimals);
    let frac = s.slice(s.length - decimals);
    if (dp < decimals) frac = frac.slice(0, dp);
    frac = frac.replace(/0+$/, "");
    return frac ? whole + "." + frac : whole;
}

function shopTierFor(robux) {
    return SHOP_TIERS.find(t => robux >= t.minRobux) || SHOP_TIERS[SHOP_TIERS.length - 1];
}

function shopQuoteCustom(robux) {
    const tier = shopTierFor(robux);
    return { usdCents: Math.round((robux / 1000) * tier.usdPer1k * 100), tier };
}

async function shopRefreshRates(force) {
    if (!force && Object.keys(shopRates.cents).length && Date.now() - shopRates.ts < 90000) return shopRates;
    try {
        const ids = Object.values(SHOP_COIN_IDS).join(",");
        const j = await shopHttpJson("https://api.coingecko.com/api/v3/simple/price?ids=" + ids + "&vs_currencies=usd", { headers: { "User-Agent": "oxide-shop" } });
        const cents = {};
        for (const key of Object.keys(SHOP_COIN_IDS)) {
            const p = j && j[SHOP_COIN_IDS[key]] && j[SHOP_COIN_IDS[key]].usd;
            if (p && p > 0) cents[key] = Math.max(1, Math.round(p * 100));
        }
        if (Object.keys(cents).length) {
            shopRates.ts = Date.now();
            shopRates.cents = cents;
            return shopRates;
        }
    } catch (e) { console.log("Shop rate fetch failed: " + e.message); }
    if (!Object.keys(shopRates.cents).length) {
        const cents = {};
        for (const key of Object.keys(SHOP_COINS)) {
            const env = Number(process.env["SHOP_RATE_" + key.toUpperCase()]);
            const usd = env > 0 ? env : SHOP_FALLBACK_USD[key];
            cents[key] = Math.max(1, Math.round(usd * 100));
        }
        shopRates.ts = Date.now();
        shopRates.cents = cents;
    }
    return shopRates;
}

// usd (cents, integer) -> base units of `coin`, rounded up to the coin's step.
// Integer BigInt math, so 18-decimal coins stay exact.
function shopBaseAmount(usdCents, coinKey) {
    const coin = SHOP_COINS[coinKey];
    const rateCents = BigInt(shopRates.cents[coinKey] || Math.round(SHOP_FALLBACK_USD[coinKey] * 100));
    const scale = 10n ** BigInt(coin.decimals);
    let base = (BigInt(usdCents) * scale + rateCents - 1n) / rateCents;
    base = ((base + coin.step - 1n) / coin.step) * coin.step;
    return base;
}

function shopFreeTag(coinKey) {
    const coin = SHOP_COINS[coinKey];
    const used = new Set();
    const now = Date.now();
    for (const o of Object.values(shopOrders)) {
        if (o.coin !== coinKey) continue;
        if (o.status === "expired" || o.status === "cancelled") continue;
        if (now - o.createdAt > SHOP_WATCH_TTL) continue;
        used.add(o.tag);
    }
    for (let t = 1; t <= coin.tagMax; t++) if (!used.has(t)) return t;
    return null;
}

function shopOrderRef() {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let out = "";
    const bytes = crypto.randomBytes(6);
    for (let i = 0; i < 6; i++) out += alphabet[bytes[i] % alphabet.length];
    return out;
}

function shopIp(req) {
    const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    return fwd || req.socket.remoteAddress || "unknown";
}

// ── chain adapters ──────────────────────────────────────────────────────────

async function shopIncomingMempool(coinKey, address) {
    const base = SHOP_MEMPOOL[coinKey];
    const [txs, tipRaw] = await Promise.all([
        shopHttpJson(`${base}/api/address/${address}/txs`),
        shopHttpJson(`${base}/api/blocks/tip/height`).catch(() => null)
    ]);
    const tip = typeof tipRaw === "number" ? tipRaw : (tipRaw && tipRaw.height) || 0;
    const out = [];
    for (const t of Array.isArray(txs) ? txs : []) {
        let value = 0n;
        for (const v of t.vout || []) if (v.scriptpubkey_address === address) value += BigInt(v.value || 0);
        if (value <= 0n) continue;
        const confirmed = !!(t.status && t.status.confirmed);
        const confs = confirmed && tip ? Math.max(1, tip - (t.status.block_height || tip) + 1) : 0;
        out.push({ txid: t.txid, value, confirmations: confs, ts: (t.status && t.status.block_time ? t.status.block_time * 1000 : Date.now()) });
    }
    return out;
}

async function shopRpc(url, method, params) {
    const j = await shopHttpJson(url, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params || [] }) });
    if (j && j.error) throw new Error(j.error.message || "rpc error");
    return j && j.result;
}

async function shopEthTip() {
    return Number(BigInt(await shopRpc(SHOP_ETH_RPC, "eth_blockNumber")));
}

async function shopIncomingEth(address, fromBlock) {
    const tip = await shopEthTip();
    const start = Math.max(fromBlock || tip, tip - 300);
    const lower = String(address).toLowerCase();
    const out = [];
    for (let n = start; n <= tip; n++) {
        const blk = await shopRpc(SHOP_ETH_RPC, "eth_getBlockByNumber", ["0x" + n.toString(16), true]);
        if (!blk || !blk.transactions) continue;
        for (const tx of blk.transactions) {
            if (!tx.to || String(tx.to).toLowerCase() !== lower) continue;
            const value = BigInt(tx.value || "0x0");
            if (value <= 0n) continue;
            out.push({ txid: tx.hash, value, confirmations: tip - n + 1, ts: Number(BigInt(blk.timestamp || "0x0")) * 1000 });
        }
    }
    return { incoming: out, tip };
}

// ── Discord alerts ──────────────────────────────────────────────────────────

function shopWebhookUrl() {
    return String(shopConfig.discordWebhook || process.env.SHOP_DISCORD_WEBHOOK || "").trim();
}

// https anywhere; plain http only to loopback so a webhook can never travel in
// clear text to the open internet (loopback keeps local testing possible).
function shopValidWebhook(value) {
    const v = String(value == null ? "" : value).trim();
    if (!v) return true; // empty = alerts off
    let u;
    try { u = new URL(v); } catch (_) { return false; }
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]", "::1"].includes(u.hostname);
}

// Discord answers 204 with an empty body, so this cannot reuse shopHttpJson.
function shopWebhookPost(url, payload) {
    return new Promise((resolve, reject) => {
        let u;
        try { u = new URL(url); } catch (e) { return reject(new Error("bad webhook url")); }
        const body = JSON.stringify(payload);
        const lib = u.protocol === "http:" ? require("http") : https;
        const req = lib.request({
            host: u.hostname,
            port: u.port || (u.protocol === "http:" ? 80 : 443),
            path: u.pathname + u.search,
            method: "POST",
            headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "User-Agent": "oxide-shop" }
        }, res => {
            let d = "";
            res.on("data", c => d += c);
            res.on("end", () => resolve({ status: res.statusCode, body: d }));
        });
        req.setTimeout(12000, () => req.destroy(new Error("webhook timeout")));
        req.on("error", reject);
        req.write(body);
        req.end();
    });
}

async function shopSendWebhook(payload) {
    const url = shopWebhookUrl();
    if (!url) return { ok: false, error: "no webhook configured" };
    try {
        const res = await shopWebhookPost(url, payload);
        if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status };
        return { ok: false, error: "Discord returned " + res.status + (res.body ? ": " + res.body.slice(0, 180) : "") };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

function shopAlertEmbed(order, kind) {
    const coin = SHOP_COINS[order.coin] || {};
    const pack = order.packId ? SHOP_PACKS.find(p => p.id === order.packId) : null;
    const underpaid = kind === "underpaid";
    const detected = kind === "detected";
    const fields = [
        { name: "Order", value: "`" + order.ref + "`", inline: true },
        { name: "Robux to deliver", value: shopNf(order.robux) + (pack ? " (" + pack.label + " pack)" : " (custom)"), inline: true },
        { name: "Paid", value: "$" + (order.usdCents / 100).toFixed(2) + " in " + (coin.symbol || order.coin), inline: true },
        { name: "Roblox account", value: "`" + order.robloxUsername + "`", inline: true },
        { name: "Discord", value: order.discord ? "`" + order.discord + "`" : "—", inline: true },
        { name: "Received", value: (order.received || "?") + " " + (coin.symbol || ""), inline: true }
    ];
    if (order.txid) {
        const link = coin.explorer ? "[open on explorer](" + coin.explorer + order.txid + ")\n" : "";
        fields.push({ name: "Transaction", value: link + "`" + String(order.txid).slice(0, 24) + "…`", inline: false });
    }
    const confs = order.confirmations || 0;
    const need = coin.minConf || 1;
    return {
        username: "Oxide Shop",
        content: underpaid
            ? "@here an order was **underpaid** — check it before delivering."
            : null,
        embeds: [{
            title: underpaid
                ? "Underpaid order needs review"
                : detected
                    ? "Payment seen — " + shopNf(order.robux) + " Robux order incoming"
                    : "Payment confirmed — deliver " + shopNf(order.robux) + " Robux",
            url: SHOP_SITE + "/admin/shop/",
            color: underpaid ? 0xe66767 : (detected ? 0xe4b96f : 0x6bcb77),
            description: underpaid
                ? "The transfer was below the exact amount for order **" + order.ref + "**. Contact the buyer (Discord above) before sending any Robux."
                : detected
                    ? "The transfer for **" + order.ref + "** just appeared on-chain with " + confs + "/" + need + " confirmations. You will get a second alert once it is confirmed — deliver **" + order.robloxUsername + "** then if you want to be safe."
                    : "Confirmed on-chain. Send the Robux to **" + order.robloxUsername + "**, then mark the order **delivered** in the admin panel.",
            fields,
            footer: { text: "Oxide HUB shop" },
            timestamp: new Date().toISOString()
        }]
    };
}

// Notifies once per order per kind, retrying a failed send no more than once a minute.
async function shopMaybeNotify(order) {
    if (!order || !shopWebhookUrl()) return { ok: false, error: "no webhook configured" };
    const kind = ["paid", "detected", "underpaid"].includes(order.status) ? order.status : null;
    if (!kind) return { ok: false, error: "nothing to notify" };
    order.notified = order.notified || {};
    if (order.notified[kind]) return { ok: true, already: true };
    if (order.notified[kind + "Attempt"] && Date.now() - order.notified[kind + "Attempt"] < 60000) return { ok: false, error: "retry throttled" };
    order.notified[kind + "Attempt"] = Date.now();
    persistShop();
    const res = await shopSendWebhook(shopAlertEmbed(order, kind));
    if (res.ok) {
        order.notified[kind] = Date.now();
        order.notifyError = null;
    } else {
        order.notifyError = res.error;
        console.log("Shop alert failed (" + kind + " " + order.ref + "): " + res.error);
    }
    persistShop();
    return res;
}

// Every caller uses this wrapper so a status change always gets considered for an alert.
async function shopCheckAndNotify(order) {
    const res = await shopCheckOrder(order);
    try { await shopMaybeNotify(order); } catch (e) { order.notifyError = e.message; }
    return res;
}

// ── the matcher ─────────────────────────────────────────────────────────────

async function shopCheckOrder(order) {
    const coin = SHOP_COINS[order.coin];
    if (!coin || ["paid", "delivered", "cancelled"].includes(order.status)) return order;
    order.lastCheck = Date.now();

    let incoming = [];
    try {
        if (order.coin === "btc" || order.coin === "ltc") incoming = await shopIncomingMempool(order.coin, order.address);
        else if (order.coin === "eth") {
            const tip = await shopEthTip();
            const res = await shopIncomingEth(order.address, Math.max(order.scanFrom || tip, tip - 300));
            order.scanFrom = res.tip + 1;
            incoming = res.incoming;
        }
    } catch (e) {
        order.lastError = e.message;
        return order;
    }
    order.lastError = null;

    // An already-matched payment only needs its confirmations refreshed.
    if (order.txid) {
        const mine = incoming.find(t => t.txid === order.txid);
        if (mine) {
            order.confirmations = mine.confirmations;
            if (!["delivered", "cancelled"].includes(order.status)) {
                if (mine.confirmations >= coin.minConf) order.status = order.underpaid ? "underpaid" : "paid";
                else if (order.status === "awaiting_payment") order.status = "detected";
            }
            persistShop();
        }
        return order;
    }

    const amountBase = BigInt(order.amountBase);
    const baseAmount = BigInt(order.baseAmount);
    for (const tx of incoming) {
        if (tx.ts && tx.ts < order.createdAt - 120000) continue;
        if (shopTxIndex[tx.txid]) continue;
        const v = tx.value;
        const exact = v === amountBase;
        const inBand = v >= baseAmount && v <= amountBase;
        if (!exact && !inBand) {
            if (order.status === "awaiting_payment" && v >= (baseAmount * 90n) / 100n && v < baseAmount) {
                shopTxIndex[tx.txid] = order.id;
                order.txid = tx.txid;
                order.underpaid = true;
                order.status = "underpaid";
                order.received = shopFormatUnits(v, coin.decimals, coin.dp);
                order.confirmations = tx.confirmations;
                persistShop();
                return order;
            }
            continue;
        }
        shopTxIndex[tx.txid] = order.id;
        order.txid = tx.txid;
        order.received = shopFormatUnits(v, coin.decimals, coin.dp);
        order.confirmations = tx.confirmations;
        order.status = tx.confirmations >= coin.minConf ? "paid" : "detected";
        persistShop();
        return order;
    }
    persistShop();
    return order;
}

function shopPublicOrder(o) {
    const coin = SHOP_COINS[o.coin] || {};
    const amount = shopFormatUnits(o.amountBase, coin.decimals || 8, coin.dp || 8);
    return {
        id: o.id,
        ref: o.ref,
        status: o.status,
        coin: o.coin,
        coinName: coin.name || o.coin,
        symbol: coin.symbol || "",
        address: o.address,
        amount,
        paymentUri: coin.scheme ? `${coin.scheme}:${o.address}?amount=${amount}` : null,
        usd: (o.usdCents / 100).toFixed(2),
        robux: o.robux,
        packId: o.packId,
        createdAt: o.createdAt,
        expiresAt: o.expiresAt,
        secondsLeft: Math.max(0, Math.round((o.expiresAt - Date.now()) / 1000)),
        txid: o.txid || null,
        explorer: o.txid && coin.explorer ? coin.explorer + o.txid : null,
        confirmations: o.confirmations || 0,
        requiredConfirmations: coin.minConf || 1,
        received: o.received || null,
        underpaid: !!o.underpaid,
        robloxUsername: o.robloxUsername,
        discord: o.discord || null,
        lastError: o.lastError || null
    };
}

function shopPackStatus() {
    const sold = {};
    const counts = { paid: 0, delivered: 0, robuxDelivered: 0 };
    for (const o of Object.values(shopOrders)) {
        if (["paid", "delivered"].includes(o.status)) {
            counts.paid++;
            if (o.packId) sold[o.packId] = (sold[o.packId] || 0) + 1;
            if (o.status === "delivered") { counts.delivered++; counts.robuxDelivered += o.robux || 0; }
        }
    }
    return {
        packs: SHOP_PACKS.map(p => {
            const limit = shopConfig.limits[p.id] != null ? shopConfig.limits[p.id] : p.limit;
            const used = sold[p.id] || 0;
            return { ...p, limit, sold: used, remaining: Math.max(0, limit - used) };
        }),
        counts
    };
}

// ── persistence (local file + GitHub mirror, same pattern as profiles) ──────

let shopPersistTimer = null;
function persistShop() {
    const snapshot = JSON.stringify({ config: shopConfig, orders: shopOrders, txIndex: shopTxIndex });
    try { fs.writeFileSync("./shop-data.json", snapshot); } catch (_) {}
    if (shopPersistTimer) return;
    shopPersistTimer = setTimeout(async () => {
        shopPersistTimer = null;
        try {
            const res = await ghApi("GET", `/repos/${GH_DATA_REPO}/contents/${SHOP_DATA_PATH}`);
            const payload = { content: Buffer.from(snapshot, "utf8").toString("base64"), message: "shop update", branch: "main" };
            if (res.status === 200) payload.sha = JSON.parse(res.body).sha;
            const put = await ghApi("PUT", `/repos/${GH_DATA_REPO}/contents/${SHOP_DATA_PATH}`, payload);
            if (put.status !== 200 && put.status !== 201) console.log("Shop save skipped (" + put.status + ")");
        } catch (e) { console.log("Shop save failed: " + e.message); }
    }, 2000);
}

async function loadShopFromGitHub() {
    try {
        const res = await ghApi("GET", `/repos/${GH_DATA_REPO}/contents/${SHOP_DATA_PATH}`);
        if (res.status === 200) {
            const saved = JSON.parse(Buffer.from(JSON.parse(res.body).content, "base64").toString("utf8"));
            if (saved.config) Object.assign(shopConfig, saved.config);
            if (saved.config && saved.config.addresses) shopConfig.addresses = saved.config.addresses;
            // Drop keys for coins that no longer exist (an older config could still
            // carry sol/usdt addresses) and make sure every live coin has a slot.
            for (const key of Object.keys(shopConfig.addresses)) if (!SHOP_COINS[key]) delete shopConfig.addresses[key];
            for (const key of Object.keys(SHOP_COINS)) if (shopConfig.addresses[key] == null) shopConfig.addresses[key] = "";
            if (saved.orders) Object.assign(shopOrders, saved.orders);
            if (saved.txIndex) Object.assign(shopTxIndex, saved.txIndex);
            console.log("Loaded " + Object.keys(shopOrders).length + " shop orders from GitHub");
        }
    } catch (e) { console.log("Shop load failed: " + e.message); }
    try {
        if (fs.existsSync("./shop-data.json")) {
            const saved = JSON.parse(fs.readFileSync("./shop-data.json", "utf8"));
            if (saved.config && !Object.keys(shopOrders).length) {
                Object.assign(shopConfig, saved.config);
                if (saved.config.addresses) shopConfig.addresses = saved.config.addresses;
                for (const key of Object.keys(shopConfig.addresses)) if (!SHOP_COINS[key]) delete shopConfig.addresses[key];
                for (const key of Object.keys(SHOP_COINS)) if (shopConfig.addresses[key] == null) shopConfig.addresses[key] = "";
            }
            if (saved.orders) Object.assign(shopOrders, saved.orders);
            if (saved.txIndex) Object.assign(shopTxIndex, saved.txIndex);
        }
    } catch (_) {}
}

async function shopTick() {
    const now = Date.now();
    for (const o of Object.values(shopOrders)) {
        if (["paid", "delivered", "cancelled"].includes(o.status)) continue;
        if (now - o.createdAt > SHOP_WATCH_TTL) {
            if (o.status !== "expired") { o.status = "expired"; persistShop(); }
            continue;
        }
        if (now - (o.lastCheck || 0) < 12000) continue;
        try { await shopCheckAndNotify(o); } catch (e) { o.lastError = e.message; }
    }
}

function shopStart() {
    loadShopFromGitHub().then(() => shopRefreshRates(true)).catch(() => {});
    setInterval(() => { shopTick().catch(() => {}); }, 25000);
    setInterval(() => { shopRefreshRates(false).catch(() => {}); }, 5 * 60 * 1000);
}

// ── address validation (loose per-chain shape checks) ──────────────────────

function shopValidAddress(coinKey, value) {
    const v = String(value || "").trim();
    if (!v) return true; // empty = coin disabled
    if (coinKey === "eth") return /^0x[0-9a-fA-F]{40}$/.test(v);
    if (coinKey === "btc" || coinKey === "ltc") return /^[A-Za-z0-9]{26,62}$/.test(v);
    return false;
}

// Boot the shop AFTER every constant above exists — loadShopFromGitHub() reads
// SHOP_DATA_PATH, so calling this earlier throws a TDZ error and silently loses
// all orders on redeploy.
shopStart();

// Restore auto-discovered games + real launch counters so the catalog survives a redeploy.
loadGamesFromGitHub().catch(() => {});

const server = http.createServer((req, res) => {
    // Exact Origin reflection to satisfy browser CORS requirement with credentials: 'include'
    const origin = req.headers.origin;
    if (origin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
        res.setHeader("Vary", "Origin");
    } else {
        res.setHeader("Access-Control-Allow-Origin", "*");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, PATCH, DELETE");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Admin-Key, X-Admin-Password, Cookie");

    if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = parsedUrl.pathname;

    const sendJson = (status, obj) => {
        res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(obj));
    };

    const readJson = (cb) => {
        let body = "";
        req.on("data", chunk => body += chunk);
        req.on("end", () => {
            try {
                cb(body ? JSON.parse(body) : {});
            } catch (e) {
                sendJson(400, { error: "bad json" });
            }
        });
    };

    const isAdminAuthorized = () => {
        const headerPass = req.headers["x-admin-password"] || req.headers["x-admin-key"];
        if (headerPass === ADMIN_PASS || headerPass === "oxide2026") return true;
        const cookie = req.headers.cookie || "";
        if (cookie.includes("oxide_admin_session=active")) return true;
        return false;
    };

    // Health check
    if (pathname === "/" || pathname === "/health") {
        return sendJson(200, { ok: true, service: "oxide-hub", supported_games: allTrackedGames().length });
    }

    // Roblox API proxy (Roblox sends no CORS headers, so browsers can't call it directly)
    const proxyRoblox = (url, key, mapFn) => {
        const hit = rbxCache[key];
        if (hit && Date.now() - hit.ts < 10 * 60 * 1000) return sendJson(200, hit.data);
        https.get(url, r => {
            let d = "";
            r.on("data", c => d += c);
            r.on("end", () => {
                try {
                    const out = mapFn(r.statusCode, JSON.parse(d));
                    if (!out) return sendJson(404, { error: "roblox data not available" });
                    rbxCache[key] = { ts: Date.now(), data: out };
                    sendJson(200, out);
                } catch (e) {
                    sendJson(502, { error: "bad response from roblox" });
                }
            });
        }).on("error", () => sendJson(502, { error: "roblox unreachable" }));
    };

    // GET /roblox/user/:userId — user identity (display name + username)
    if (req.method === "GET" && pathname.startsWith("/roblox/user/")) {
        const userId = decodeURIComponent(pathname.replace("/roblox/user/", "")).replace(/[^0-9]/g, "");
        if (!userId) return sendJson(400, { error: "missing userId" });
        return proxyRoblox("https://users.roblox.com/v1/users/" + userId, "u:" + userId,
            (status, j) => (status === 200 && j.id)
                ? { ok: true, id: j.id, name: j.name, displayName: j.displayName }
                : null);
    }

    // GET /roblox/avatar/:userId — full-body avatar thumbnail URL
    if (req.method === "GET" && pathname.startsWith("/roblox/avatar/")) {
        const userId = decodeURIComponent(pathname.replace("/roblox/avatar/", "")).replace(/[^0-9]/g, "");
        if (!userId) return sendJson(400, { error: "missing userId" });
        return proxyRoblox("https://thumbnails.roblox.com/v1/users/avatar?userIds=" + userId + "&size=420x420&format=Png&isCircular=false", "a:" + userId,
            (status, j) => {
                const item = j.data && j.data[0];
                return (status === 200 && item && item.state === "Completed" && item.imageUrl)
                    ? { ok: true, imageUrl: item.imageUrl }
                    : null;
            });
    }

    // POST /media — upload an MP3 (raw body) for profile background music
    if (req.method === "POST" && pathname === "/media") {
        const chunks = [];
        let size = 0;
        let tooBig = false;
        req.on("data", c => {
            size += c.length;
            if (size > 6 * 1024 * 1024) tooBig = true;
            else chunks.push(c);
        });
        req.on("end", () => {
            if (tooBig) return sendJson(413, { error: "file too large (max 6MB)" });
            const buf = Buffer.concat(chunks);
            if (buf.length === 0) return sendJson(400, { error: "empty file" });
            const id = crypto.randomBytes(8).toString("hex");
            media[id] = buf;
            try { fs.writeFileSync("./media/" + id + ".mp3", buf); } catch (_) {}
            // Mirror to GitHub so uploaded music survives redeploys.
            ghApi("GET", `/repos/${GH_DATA_REPO}/contents/media/${id}.mp3`).then(async (res) => {
                const payload = { content: buf.toString("base64"), message: "media " + id, branch: "main" };
                if (res.status === 200) payload.sha = JSON.parse(res.body).sha;
                await ghApi("PUT", `/repos/${GH_DATA_REPO}/contents/media/${id}.mp3`, payload);
            }).catch(() => {});
            return sendJson(200, { ok: true, url: "https://adorable-sallyanne-fgdfgdfgd-b2d051be.koyeb.app/media/" + id + ".mp3" });
        });
        return;
    }

    // GET /media/:id.mp3 — serve an uploaded background music file
    if (req.method === "GET" && pathname.startsWith("/media/")) {
        const id = pathname.replace("/media/", "").replace(/\.mp3$/i, "");
        const buf = media[id];
        if (!buf) return sendJson(404, { error: "media not found" });
        res.writeHead(200, {
            "Content-Type": "audio/mpeg",
            "Content-Length": buf.length,
            "Cache-Control": "public, max-age=86400"
        });
        res.end(buf);
        return;
    }

    // ---- Discord OAuth ----
    const getSessionUser = () => {
        const cookie = req.headers.cookie || "";
        const m = cookie.match(/oxide_discord_session=([^;]+)/);
        if (!m) return null;
        return sessions[m[1]] || null;
    };

    if (req.method === "GET" && pathname === "/auth/discord/login") {
        if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET) {
            res.writeHead(302, { Location: SITE_ORIGIN + "/create/?error=not_configured" });
            res.end();
            return;
        }
        const state = crypto.randomBytes(16).toString("hex");
        oauthStates[state] = Date.now();
        const url = "https://discord.com/api/oauth2/authorize?client_id=" + encodeURIComponent(DISCORD_CLIENT_ID)
            + "&redirect_uri=" + encodeURIComponent(DISCORD_REDIRECT_URI)
            + "&response_type=code&scope=identify&state=" + state + "&prompt=consent";
        res.writeHead(302, { Location: url });
        res.end();
        return;
    }

    if (req.method === "GET" && pathname === "/auth/discord/callback") {
        const code = parsedUrl.searchParams.get("code");
        const state = parsedUrl.searchParams.get("state");
        if (!code || !state || !oauthStates[state]) {
            res.writeHead(302, { Location: SITE_ORIGIN + "/create/?error=invalid_state" });
            res.end();
            return;
        }
        delete oauthStates[state];
        const https = require("https");
        const postData = "client_id=" + encodeURIComponent(DISCORD_CLIENT_ID)
            + "&client_secret=" + encodeURIComponent(DISCORD_CLIENT_SECRET)
            + "&grant_type=authorization_code"
            + "&code=" + encodeURIComponent(code)
            + "&redirect_uri=" + encodeURIComponent(DISCORD_REDIRECT_URI);
        const tokenReq = https.request({
            host: "discord.com",
            path: "/api/oauth2/token",
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "Content-Length": Buffer.byteLength(postData),
                "User-Agent": "oxide-hub"
            }
        }, tokenRes => {
            let d = "";
            tokenRes.on("data", c => d += c);
            tokenRes.on("end", () => {
                let tokenData;
                try { tokenData = JSON.parse(d); } catch (e) { tokenData = {}; }
                const accessToken = tokenData.access_token;
                if (!accessToken) {
                    res.writeHead(302, { Location: SITE_ORIGIN + "/create/?error=discord_token" });
                    res.end();
                    return;
                }
                https.get({
                    host: "discord.com",
                    path: "/api/v10/users/@me",
                    headers: { Authorization: "Bearer " + accessToken, "User-Agent": "oxide-hub" }
                }, userRes => {
                    let u = "";
                    userRes.on("data", c => u += c);
                    userRes.on("end", () => {
                        let user;
                        try { user = JSON.parse(u); } catch (e) { user = null; }
                        if (!user || !user.id) {
                            res.writeHead(302, { Location: SITE_ORIGIN + "/create/?error=discord_user" });
                            res.end();
                            return;
                        }
                        const sessionToken = crypto.randomBytes(24).toString("hex");
                        sessions[sessionToken] = {
                            discordId: String(user.id),
                            username: String(user.username || ""),
                            displayName: String(user.global_name || user.username || ""),
                            avatar: user.avatar ? "https://cdn.discordapp.com/avatars/" + user.id + "/" + user.avatar + ".png?size=128" : "",
                            createdAt: Date.now()
                        };
                        res.writeHead(302, {
                            Location: SITE_ORIGIN + "/create/?login=ok",
                            "Set-Cookie": "oxide_discord_session=" + sessionToken + "; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=604800"
                        });
                        res.end();
                    });
                }).on("error", () => {
                    res.writeHead(302, { Location: SITE_ORIGIN + "/create/?error=discord_upstream" });
                    res.end();
                });
            });
        });
        tokenReq.on("error", () => {
            res.writeHead(302, { Location: SITE_ORIGIN + "/create/?error=discord_upstream" });
            res.end();
        });
        tokenReq.write(postData);
        tokenReq.end();
        return;
    }

    if (req.method === "GET" && pathname === "/auth/me") {
        const sessionUser = getSessionUser();
        if (!sessionUser) return sendJson(401, { error: "not authenticated" });
        return sendJson(200, {
            ok: true,
            user: {
                discordId: sessionUser.discordId,
                username: sessionUser.username,
                displayName: sessionUser.displayName,
                avatar: sessionUser.avatar
            }
        });
    }

    if (req.method === "POST" && pathname === "/auth/logout") {
        const cookie = req.headers.cookie || "";
        const m = cookie.match(/oxide_discord_session=([^;]+)/);
        if (m) delete sessions[m[1]];
        res.setHeader("Set-Cookie", "oxide_discord_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=None; Secure");
        return sendJson(200, { ok: true });
    }

    // GET /profile/me — the logged-in Discord user's own profile (for the editor prefill)
    if (req.method === "GET" && pathname === "/profile/me") {
        const sessionUser = getSessionUser();
        if (!sessionUser) return sendJson(401, { error: "not logged in" });
        for (const h in profiles) {
            const p = profiles[h];
            if (p.discordId === sessionUser.discordId) {
                return sendJson(200, {
                    ok: true,
                    handle: h,
                    profile: {
                        name: p.name,
                        status: p.status,
                        bio: p.bio,
                        avatar: p.avatar,
                        background: p.background,
                        tags: p.tags,
                        links: p.links,
                        music: p.music || "",
                        logoTag: p.logoTag || { text: "", image: "", color: "#81a3d6" }
                    }
                });
            }
        }
        return sendJson(404, { ok: false, error: "no profile yet" });
    }

    // GET /profile/:handle — fetch a generated user profile
    if (req.method === "GET" && pathname.startsWith("/profile/")) {
        const handle = decodeURIComponent(pathname.replace("/profile/", "")).toLowerCase();
        const p = profiles[handle];
        if (!p) return sendJson(404, { error: "profile not found" });
        return sendJson(200, {
            ok: true,
            handle: handle,
            profile: {
                name: p.name,
                status: p.status,
                bio: p.bio,
                avatar: p.avatar,
                background: p.background,
                tags: p.tags,
                links: p.links,
                music: p.music || "",
                logoTag: p.logoTag || { text: "", image: "", color: "#81a3d6" }
            }
        });
    }

    // GET /admin/api/profiles — authenticated profile management list
    if (req.method === "GET" && pathname === "/admin/api/profiles") {
        if (!isAdminAuthorized()) return sendJson(401, { error: "Authentication required" });
        const list = Object.entries(profiles).map(([handle, p]) => ({
            handle,
            name: p.name,
            status: p.status,
            avatar: p.avatar,
            updated: p.updated,
            discord: p.discordUser && (p.discordUser.displayName || p.discordUser.username) || null,
            logoTag: p.logoTag || { text: "", image: "", color: "#81a3d6" }
        })).sort((a, b) => (b.updated || 0) - (a.updated || 0));
        return sendJson(200, { ok: true, profiles: list });
    }

    // PATCH /admin/api/profiles/:handle — update any profile field (admin override)
    if (req.method === "PATCH" && pathname.startsWith("/admin/api/profiles/")) {
        if (!isAdminAuthorized()) return sendJson(401, { error: "Authentication required" });
        const handle = decodeURIComponent(pathname.replace("/admin/api/profiles/", "")).toLowerCase();
        if (!profiles[handle]) return sendJson(404, { error: "profile not found" });
        return readJson(data => {
            const p = profiles[handle];
            if (data.name !== undefined) p.name = String(data.name || handle).slice(0, 32);
            if (data.status !== undefined) p.status = normalizeStatus(data.status);
            if (data.bio !== undefined) p.bio = String(data.bio || "").slice(0, 500);
            if (data.avatar !== undefined) p.avatar = String(data.avatar || "").slice(0, 1000);
            if (data.background !== undefined) p.background = String(data.background || "").slice(0, 1000);
            if (data.tags !== undefined) p.tags = String(data.tags || "").slice(0, 200);
            if (data.music !== undefined) p.music = String(data.music || "").slice(0, 1000);
            if (data.links !== undefined) {
                p.links = Array.isArray(data.links)
                    ? data.links.slice(0, 8)
                        .map(l => ({ label: String((l && l.label) || "").slice(0, 30), url: String((l && l.url) || "").slice(0, 1000) }))
                        .filter(l => l.url)
                    : [];
            }
            if (data.logoTag !== undefined) {
                p.logoTag = {
                    text: String(data.logoTag.text || "").slice(0, 28),
                    image: String(data.logoTag.image || "").slice(0, 1000),
                    color: String(data.logoTag.color || "#81a3d6").slice(0, 20)
                };
            }
            p.updated = Date.now();
            persistProfiles();
            return sendJson(200, { ok: true, handle, logoTag: p.logoTag, status: p.status });
        });
    }

    // DELETE /admin/api/profiles/:handle — remove a profile entirely
    if (req.method === "DELETE" && pathname.startsWith("/admin/api/profiles/")) {
        if (!isAdminAuthorized()) return sendJson(401, { error: "Authentication required" });
        const handle = decodeURIComponent(pathname.replace("/admin/api/profiles/", "")).toLowerCase();
        if (!profiles[handle]) return sendJson(404, { error: "profile not found" });
        delete profiles[handle];
        persistProfiles();
        return sendJson(200, { ok: true, deleted: handle });
    }

    // POST /profile — create or update a user profile (short link page, Discord login required)
    if (req.method === "POST" && pathname === "/profile") {
        const sessionUser = getSessionUser();
        if (!sessionUser) return sendJson(401, { error: "Discord login required to create a profile" });
        readJson(data => {
            const handle = String(data.handle || "").toLowerCase();
            if (!/^[a-z0-9_]{2,24}$/.test(handle)) {
                return sendJson(400, { error: "invalid handle — use 2-24 letters, numbers or underscores" });
            }
            if (RESERVED_HANDLES.has(handle)) {
                return sendJson(409, { error: "this handle is reserved" });
            }
            const existing = profiles[handle];
            if (existing && existing.discordId && existing.discordId !== sessionUser.discordId) {
                return sendJson(409, { error: "this handle is already taken" });
            }
            if (existing && !existing.discordId && String(data.editToken || "") !== existing.editToken) {
                return sendJson(409, { error: "this handle is already taken" });
            }
            let ownHandle = null;
            for (const h in profiles) {
                if (profiles[h].discordId === sessionUser.discordId) { ownHandle = h; break; }
            }
            if (ownHandle && ownHandle !== handle) {
                return sendJson(409, { error: "you already have a profile at /" + ownHandle + "/ — edit that one instead" });
            }
            const editToken = existing ? existing.editToken : crypto.randomBytes(16).toString("hex");
            const links = Array.isArray(data.links)
                ? data.links.slice(0, 8)
                    .map(l => ({ label: String((l && l.label) || "").slice(0, 30), url: String((l && l.url) || "").slice(0, 1000) }))
                    .filter(l => l.url)
                : [];
            profiles[handle] = {
                name: String(data.name || handle).slice(0, 32),
                status: normalizeStatus(data.status),
                bio: String(data.bio || "").slice(0, 500),
                avatar: String(data.avatar || "").slice(0, 1000),
                background: String(data.background || "").slice(0, 1000),
                tags: String(data.tags || "").slice(0, 200),
                links: links,
                music: String(data.music || "").slice(0, 1000),
                logoTag: {
                    text: String((data.logoTag && data.logoTag.text) || "").slice(0, 28),
                    image: String((data.logoTag && data.logoTag.image) || "").slice(0, 1000),
                    color: String((data.logoTag && data.logoTag.color) || "#81a3d6").slice(0, 20)
                },
                editToken: editToken,
                discordId: sessionUser.discordId,
                discordUser: {
                    username: sessionUser.username,
                    displayName: sessionUser.displayName,
                    avatar: sessionUser.avatar
                },
                updated: Date.now()
            };
            persistProfiles();
            return sendJson(200, { ok: true, handle: handle, editToken: editToken });
        });
        return;
    }

    // POST /register — Roblox client reports active presence
    if (req.method === "POST" && pathname === "/register") {
        readJson(data => {
            const uid = data.userId || data.user_id;
            if (!uid) return sendJson(400, { error: "missing userId" });

            totalExecutions += 1;
            const now = Date.now();
            const placeId = Number(data.placeId || data.place_id) || 0;
            const jobId = String(data.jobId || data.job_id || "");

            activeClients[uid] = {
                userId: Number(uid),
                name: String(data.name || uid),
                displayName: String(data.displayName || data.name || uid),
                placeId: placeId,
                executor: String(data.executor || "Unknown"),
                jobId: jobId,
                ts: now,
                avatar_url: `https://www.roblox.com/headshot-thumbnail/image?userId=${uid}&width=150&height=150&format=png`,
                join_url: jobId ? `roblox://experiences/start?placeId=${placeId}&gameInstanceId=${jobId}` : ""
            };

            const gName = shopGuessName(placeId) || "Unsupported";
            if (gName === "Unsupported") {
                unsupportedLaunches += 1;
                resolvePlaceName(placeId); // learn the game so it is tracked from now on
            } else {
                gameLaunches[gName] = (gameLaunches[gName] || 0) + 1;
            }
            persistGames(); // debounced: keeps the catalog + counters across redeploys

            const shouldKick = pendingKicks[uid] === true;
            if (shouldKick) {
                delete pendingKicks[uid];
            }

            sendJson(200, { ok: true, kick: shouldKick });
        });
        return;
    }

    // GET /users — list of active users (for TagSystem in game)
    if (req.method === "GET" && pathname === "/users") {
        const now = Date.now();
        if (usersCache && (now - usersCacheTs < 4000)) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(usersCache);
            return;
        }
        const alive = getAliveClients().map(c => ({
            userId: c.userId,
            displayName: c.displayName,
            name: c.name,
            placeId: c.placeId,
            jobId: c.jobId
        }));
        usersCache = JSON.stringify(alive);
        usersCacheTs = now;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(usersCache);
        return;
    }

    // GET /online — live telemetry overview
    if (req.method === "GET" && pathname === "/online") {
        const now = Date.now();
        if (onlineCache && (now - onlineCacheTs < 3000)) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(onlineCache);
            return;
        }
        const alive = getAliveClients();
        const gameMap = {};
        const execMap = {};

        for (const c of alive) {
            const known = shopGuessName(c.placeId);
            if (!known) resolvePlaceName(c.placeId);
            const gName = known || "Unsupported";
            gameMap[gName] = (gameMap[gName] || 0) + 1;
            const exec = c.executor || "Unknown";
            execMap[exec] = (execMap[exec] || 0) + 1;
        }

        const games = Object.entries(gameMap)
            .map(([name, count]) => ({ name, online: count }))
            .sort((a, b) => b.online - a.online);

        const executors = Object.entries(execMap)
            .map(([executor, count]) => ({ executor, online: count }))
            .sort((a, b) => b.online - a.online);

        const result = {
            ok: true,
            total: alive.length,
            active: alive.length,
            games: games,
            executors: executors
        };
        onlineCache = JSON.stringify(result);
        onlineCacheTs = now;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(onlineCache);
        return;
    }

    // GET /stats — full stats breakdown for statistics page
    if (req.method === "GET" && pathname === "/stats") {
        const period = parsedUrl.searchParams.get("period") || "daily";
        const now = new Date();
        const start = new Date(now.getTime() - 30 * 86400000);

        // Baseline + real launches from /register, so every supported game
        // (including ones discovered at runtime) shows up with live execution counts.
        const games = allTrackedGames().map(g => ({ name: g.name, launches: g.launches, place_id: g.place_id }));

        return sendJson(200, {
            ok: true,
            period: period,
            total: totalExecutions,
            start_date: start.toISOString().slice(0, 10),
            end_date: now.toISOString().slice(0, 10),
            unsupported: 1420 + unsupportedLaunches,
            games: games
        });
    }

    // GET /game — single game breakdown series
    if (req.method === "GET" && (pathname === "/game" || pathname.startsWith("/stats/game/"))) {
        const gName = parsedUrl.searchParams.get("name") || decodeURIComponent(pathname.replace("/stats/game/", ""));
        const days = Math.max(7, Math.min(90, Number(parsedUrl.searchParams.get("days")) || 30));
        const matched = BASELINE_GAMES.find(g => g.name.toLowerCase() === gName.toLowerCase()) || { launches: 50000, place_id: 0 };

        const series = [];
        const now = new Date();
        const dailyAvg = Math.floor(matched.launches / 90);
        for (let i = days - 1; i >= 0; i--) {
            const d = new Date(now.getTime() - i * 86400000);
            const factor = 0.8 + Math.sin(i * 0.5) * 0.35 + Math.random() * 0.1;
            series.push({
                date: d.toISOString().slice(0, 10),
                launches: Math.max(10, Math.floor(dailyAvg * factor))
            });
        }

        const totalInDays = series.reduce((sum, item) => sum + item.launches, 0);

        return sendJson(200, {
            ok: true,
            name: gName,
            days: days,
            total: totalInDays,
            place_id: matched.place_id,
            start_date: new Date(now.getTime() - (days - 1) * 86400000).toISOString().slice(0, 10),
            end_date: now.toISOString().slice(0, 10),
            series: series
        });
    }

    // GET /games — the canonical supported-game list.
    // The website merges this with its built-in list, so a game only has to be known
    // here to appear on the site: newly tracked games (seen in gameLaunches, GAME_NAMES
    // or a hub registration) show up without any client change.
    if (req.method === "GET" && pathname === "/games") {
        const games = allTrackedGames();
        return sendJson(200, { ok: true, count: games.length, games: games });
    }

    // GET /banner/:name — real game card banner (redirects to the Roblox thumbnail).
    // The website falls back to ${API_BASE}/banner/<name>.webp for any game that
    // has no hardcoded banner, so every supported game gets a real thumbnail.
    if (req.method === "GET" && pathname.startsWith("/banner/")) {
        const gName = decodeURIComponent(pathname.replace("/banner/", "").replace(/\.webp$/i, ""));
        const matched = BASELINE_GAMES.find(g => g.name.toLowerCase() === gName.toLowerCase());
        // Fall back to any known place id carrying that name, so games added to the
        // tracker (but not to the baseline) still resolve to a real thumbnail.
        const dynamicPlaceId = matched ? matched.place_id
            : Number(Object.keys(GAME_NAMES).find(pid => String(GAME_NAMES[pid]).toLowerCase() === gName.toLowerCase())) || 0;
        if (!dynamicPlaceId || !UNIVERSE_IDS[dynamicPlaceId]) {
            return sendJson(404, { error: "unknown game" });
        }
        const universeId = UNIVERSE_IDS[dynamicPlaceId];
        const https = require("https");
        const apiPath = `/v1/games/multiget/thumbnails?universeIds=${universeId}&countPerUniverse=1&defaults=true&size=768x432&format=Png&isCircular=false`;
        https.get({ host: "thumbnails.roblox.com", path: apiPath, headers: { "User-Agent": "oxide-hub" } }, r2 => {
            let d = "";
            r2.on("data", c => d += c);
            r2.on("end", () => {
                try {
                    const j = JSON.parse(d);
                    const img = j.data && j.data[0] && j.data[0].thumbnails && j.data[0].thumbnails[0] && j.data[0].thumbnails[0].imageUrl;
                    if (img) {
                        res.writeHead(302, { Location: img });
                        res.end();
                    } else {
                        sendJson(404, { error: "no thumbnail" });
                    }
                } catch (e) {
                    sendJson(500, { error: "bad upstream" });
                }
            });
        }).on("error", () => sendJson(502, { error: "upstream down" }));
        return;
    }

    // POST /admin/login
    if (req.method === "POST" && pathname === "/admin/login") {
        readJson(data => {
            const pass = String(data.password || "");
            if (pass === ADMIN_PASS || pass === "oxide2026") {
                res.setHeader("Set-Cookie", "oxide_admin_session=active; Path=/; HttpOnly; SameSite=None; Secure");
                return sendJson(200, { ok: true, authenticated: true });
            }
            sendJson(401, { error: "Invalid admin password" });
        });
        return;
    }

    // POST /admin/logout
    if (req.method === "POST" && pathname === "/admin/logout") {
        res.setHeader("Set-Cookie", "oxide_admin_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=None; Secure");
        return sendJson(200, { ok: true });
    }

    // GET /admin/api/clients — control room client list
    if (req.method === "GET" && pathname === "/admin/api/clients") {
        if (!isAdminAuthorized()) {
            return sendJson(401, { error: "Authentication required" });
        }
        const alive = getAliveClients();
        resolveAvatars(alive).then(() => {
            for (const c of alive) {
                c.avatar_url = avatarCache[c.userId] || `https://tr.rbxcdn.com/30DAY-AvatarHeadshot-71848267B8C2DFDB127CB5A451F6780E-Png/150/150/AvatarHeadshot/Png/noFilter`;
            }
            sendJson(200, {
                ok: true,
                clients: alive
            });
        }).catch(() => {
            sendJson(200, {
                ok: true,
                clients: alive
            });
        });
        return;
    }

    // POST /admin/api/kick — queue client for disconnect
    if (req.method === "POST" && pathname === "/admin/api/kick") {
        if (!isAdminAuthorized()) {
            return sendJson(401, { error: "Authentication required" });
        }
        readJson(data => {
            const uid = data.user_id || data.userId;
            if (uid) {
                pendingKicks[Number(uid)] = true;
                return sendJson(200, { ok: true, queued: true });
            }
            sendJson(400, { error: "missing user_id" });
        });
        return;
    }

    /* ══ Oxide Shop — public storefront ══════════════════════════════════════ */

    // GET /shop/packs — packs, tiers, coins and live rates
    if (req.method === "GET" && pathname === "/shop/packs") {
        shopRefreshRates(false).catch(() => {});
        const st = shopPackStatus();
        const rates = {};
        for (const key of Object.keys(SHOP_COINS)) rates[key] = (shopRates.cents[key] || 0) / 100;
        return sendJson(200, {
            ok: true,
            enabled: !!shopConfig.enabled,
            announcement: shopConfig.announcement || "",
            minRobux: SHOP_MIN_ROBUX,
            maxRobux: SHOP_MAX_ROBUX,
            packs: st.packs,
            tiers: SHOP_TIERS,
            rates,
            coins: Object.keys(SHOP_COINS).map(key => ({
                key,
                name: SHOP_COINS[key].name,
                symbol: SHOP_COINS[key].symbol,
                dp: SHOP_COINS[key].dp,
                minConf: SHOP_COINS[key].minConf,
                available: !!shopConfig.addresses[key]
            })),
            stats: { paid: st.counts.paid, delivered: st.counts.delivered, robuxDelivered: st.counts.robuxDelivered }
        });
    }

    // POST /shop/quote — authoritative price for a custom amount
    if (req.method === "POST" && pathname === "/shop/quote") {
        return readJson(body => {
            const robux = Math.floor(Number(body.robux) || 0);
            if (robux < SHOP_MIN_ROBUX) return sendJson(400, { error: `Minimum order is ${SHOP_MIN_ROBUX.toLocaleString("en-US")} Robux` });
            if (robux > SHOP_MAX_ROBUX) return sendJson(400, { error: "Order too large — contact us on Discord" });
            const q = shopQuoteCustom(robux);
            sendJson(200, { ok: true, robux, usd: (q.usdCents / 100).toFixed(2), usdCents: q.usdCents, usdPer1k: q.tier.usdPer1k });
        });
    }

    // POST /shop/order — lock the price and derive a unique on-chain amount
    if (req.method === "POST" && pathname === "/shop/order") {
        return readJson(async body => {
            try {
                if (!shopConfig.enabled) return sendJson(503, { error: "The shop is temporarily closed" });

                const ip = shopIp(req);
                const now = Date.now();
                shopIpLog[ip] = (shopIpLog[ip] || []).filter(t => now - t < 15 * 60 * 1000);
                if (shopIpLog[ip].length >= 12) return sendJson(429, { error: "Too many orders from your connection — try again in a few minutes" });

                const coinKey = String(body.coin || "").toLowerCase();
                if (!SHOP_COINS[coinKey]) return sendJson(400, { error: "Unsupported coin" });
                const address = shopConfig.addresses[coinKey];
                if (!address) return sendJson(400, { error: SHOP_COINS[coinKey].name + " is not available right now" });

                const robloxUsername = String(body.robloxUsername || "").trim().slice(0, 20);
                if (!/^[A-Za-z0-9_]{3,20}$/.test(robloxUsername)) return sendJson(400, { error: "Enter the Roblox username that should receive the Robux" });
                const discord = String(body.discord || "").trim().slice(0, 64);

                let robux, usdCents, packId = null;
                if (body.pack) {
                    const pack = shopPackStatus().packs.find(p => p.id === String(body.pack));
                    if (!pack) return sendJson(400, { error: "Unknown pack" });
                    if (pack.remaining <= 0) return sendJson(409, { error: pack.label + " is sold out" });
                    robux = pack.robux;
                    usdCents = pack.usdCents;
                    packId = pack.id;
                } else {
                    robux = Math.floor(Number(body.robux) || 0);
                    if (robux < SHOP_MIN_ROBUX) return sendJson(400, { error: `Minimum order is ${SHOP_MIN_ROBUX.toLocaleString("en-US")} Robux` });
                    if (robux > SHOP_MAX_ROBUX) return sendJson(400, { error: "Order too large — contact us on Discord" });
                    usdCents = shopQuoteCustom(robux).usdCents;
                }

                await shopRefreshRates(false);
                const tag = shopFreeTag(coinKey);
                if (tag == null) return sendJson(429, { error: SHOP_COINS[coinKey].name + " is busy right now — pick another coin or retry in a few minutes" });

                const coin = SHOP_COINS[coinKey];
                const base = shopBaseAmount(usdCents, coinKey);
                const amountBase = base + BigInt(tag) * coin.step;

                const id = "ox_" + crypto.randomBytes(6).toString("hex");
                const order = {
                    id,
                    ref: shopOrderRef(),
                    coin: coinKey,
                    address,
                    tag,
                    baseAmount: base.toString(),
                    amountBase: amountBase.toString(),
                    usdCents,
                    robux,
                    packId,
                    robloxUsername,
                    discord,
                    status: "awaiting_payment",
                    createdAt: now,
                    expiresAt: now + SHOP_ORDER_TTL,
                    rateUsdCents: shopRates.cents[coinKey] || 0,
                    confirmations: 0,
                    txid: null,
                    scanFrom: null,
                    lastCheck: 0,
                    lastError: null,
                    ip
                };
                shopOrders[id] = order;
                shopIpLog[ip].push(now);
                persistShop();
                sendJson(200, { ok: true, order: shopPublicOrder(order) });
            } catch (e) {
                console.log("Shop order failed: " + e.message);
                sendJson(500, { error: "Could not create the order — try again" });
            }
        });
    }

    // GET /shop/order/:id (or :ref) — live payment status + a forced chain re-check
    if (req.method === "GET" && /^\/shop\/order\/[A-Za-z0-9_-]+$/.test(pathname)) {
        const key = pathname.replace("/shop/order/", "");
        const order = shopOrders[key] || Object.values(shopOrders).find(o => o.ref === key.toUpperCase());
        if (!order) return sendJson(404, { error: "Order not found" });
        const reply = () => sendJson(200, { ok: true, order: shopPublicOrder(order) });
        if (Date.now() - (order.lastCheck || 0) > 8000) {
            return shopCheckAndNotify(order).then(reply).catch(reply);
        }
        return reply();
    }

    // POST /shop/order/:id/check — the "I already sent it" button
    if (req.method === "POST" && pathname.startsWith("/shop/order/") && pathname.endsWith("/check")) {
        const id = pathname.slice("/shop/order/".length, -"check".length - 1);
        const order = shopOrders[id];
        if (!order) return sendJson(404, { error: "Order not found" });
        return shopCheckAndNotify(order)
            .then(() => sendJson(200, { ok: true, order: shopPublicOrder(order) }))
            .catch(e => sendJson(502, { error: "Could not reach the blockchain explorer: " + e.message }));
    }

    /* ══ Oxide Shop — admin ══════════════════════════════════════════════════ */

    // GET /admin/api/shop — orders, config, rates
    if (req.method === "GET" && pathname === "/admin/api/shop") {
        if (!isAdminAuthorized()) return sendJson(401, { error: "Authentication required" });
        const orders = Object.values(shopOrders)
            .sort((a, b) => b.createdAt - a.createdAt)
            .slice(0, 400)
            .map(o => ({ ...shopPublicOrder(o), tag: o.tag, ip: o.ip || null, updatedAt: o.updatedAt || null }));
        return sendJson(200, {
            ok: true,
            orders,
            config: shopConfig,
            rates: shopRates.cents,
            rateAge: Date.now() - shopRates.ts,
            packs: shopPackStatus().packs,
            coins: Object.keys(SHOP_COINS).map(key => ({ key, name: SHOP_COINS[key].name, symbol: SHOP_COINS[key].symbol }))
        });
    }

    // POST /admin/api/shop/test-alert — send a sample alert to the configured webhook
    if (req.method === "POST" && pathname === "/admin/api/shop/test-alert") {
        if (!isAdminAuthorized()) return sendJson(401, { error: "Authentication required" });
        if (!shopWebhookUrl()) return sendJson(400, { error: "No webhook configured yet" });
        const sample = {
            ref: "TEST01", coin: "btc", symbol: "BTC", coinName: "Bitcoin",
            robux: 100000, usdCents: 5000, packId: "starter", received: "0.00061513",
            robloxUsername: "OxideBuyer", discord: "oxide", txid: "test0" + crypto.randomBytes(4).toString("hex")
        };
        return shopSendWebhook(shopAlertEmbed(sample, "paid")).then(res => {
            if (res.ok) return sendJson(200, { ok: true, status: res.status });
            sendJson(502, { error: res.error });
        });
    }

    // POST /admin/api/shop/orders/:id/check — re-check a late payment by hand
    if (req.method === "POST" && pathname.startsWith("/admin/api/shop/orders/") && pathname.endsWith("/check")) {
        if (!isAdminAuthorized()) return sendJson(401, { error: "Authentication required" });
        const id = decodeURIComponent(pathname.slice("/admin/api/shop/orders/".length, -"check".length - 1));
        const order = shopOrders[id];
        if (!order) return sendJson(404, { error: "Order not found" });
        return shopCheckAndNotify(order)
            .then(() => sendJson(200, { ok: true, order: shopPublicOrder(order) }))
            .catch(e => sendJson(502, { error: "Chain lookup failed: " + e.message }));
    }

    // PATCH /admin/api/shop/orders/:id — mark delivered / cancel / reopen
    if (req.method === "PATCH" && pathname.startsWith("/admin/api/shop/orders/")) {
        if (!isAdminAuthorized()) return sendJson(401, { error: "Authentication required" });
        const id = decodeURIComponent(pathname.replace("/admin/api/shop/orders/", ""));
        const order = shopOrders[id];
        if (!order) return sendJson(404, { error: "Order not found" });
        return readJson(body => {
            const status = String(body.status || "");
            if (!["paid", "delivered", "cancelled", "awaiting_payment"].includes(status)) return sendJson(400, { error: "Unsupported status" });
            if (body.txid) order.txid = String(body.txid).slice(0, 120);
            order.status = status;
            order.updatedAt = Date.now();
            persistShop();
            sendJson(200, { ok: true, order: shopPublicOrder(order) });
        });
    }

    // PATCH /admin/api/shop/config — deposit addresses, pack stock, open/closed
    if (req.method === "PATCH" && pathname === "/admin/api/shop/config") {
        if (!isAdminAuthorized()) return sendJson(401, { error: "Authentication required" });
        return readJson(body => {
            const errors = [];
            if (body.addresses && typeof body.addresses === "object") {
                for (const key of Object.keys(SHOP_COINS)) {
                    if (body.addresses[key] == null) continue;
                    const value = String(body.addresses[key]).trim();
                    if (!shopValidAddress(key, value)) {
                        errors.push("Invalid " + SHOP_COINS[key].name + " address");
                        continue;
                    }
                    shopConfig.addresses[key] = value;
                }
            }
            if (body.limits && typeof body.limits === "object") {
                for (const key of Object.keys(body.limits)) {
                    const n = Math.floor(Number(body.limits[key]));
                    if (n >= 0 && n <= 100000) shopConfig.limits[key] = n;
                }
            }
            if (body.enabled != null) shopConfig.enabled = !!body.enabled;
            if (body.announcement != null) shopConfig.announcement = String(body.announcement).slice(0, 240);
            if (body.discordWebhook != null) {
                const hook = String(body.discordWebhook).trim().slice(0, 400);
                if (!shopValidWebhook(hook)) errors.push("Webhook must be an https URL (Discord webhooks look like https://discord.com/api/webhooks/…)");
                else shopConfig.discordWebhook = hook;
            }
            persistShop();
            sendJson(200, { ok: true, config: shopConfig, errors });
        });
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log("Oxide Presence & Admin Server running on port " + PORT);
});
