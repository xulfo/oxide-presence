const http = require("http");

const activeClients = {}; // userId -> clientInfo
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
        const uniqueNames = new Set(Object.values(GAME_NAMES));
        uniqueNames.add("Universal");
        return sendJson(200, { ok: true, service: "oxide-hub", supported_games: uniqueNames.size });
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

            const gName = GAME_NAMES[placeId] || "Unsupported";
            if (gName === "Unsupported") {
                unsupportedLaunches += 1;
            } else {
                gameLaunches[gName] = (gameLaunches[gName] || 0) + 1;
            }

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
            const gName = GAME_NAMES[c.placeId] || "Unsupported";
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
        // (including new ones) shows up with live execution counts.
        const games = BASELINE_GAMES
            .map(g => ({
                name: g.name,
                launches: g.launches + (gameLaunches[g.name] || 0),
                place_id: g.place_id
            }))
            .sort((a, b) => b.launches - a.launches);

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

    // GET /banner/:name — real game card banner (redirects to the Roblox thumbnail).
    // The website falls back to ${API_BASE}/banner/<name>.webp for any game that
    // has no hardcoded banner, so every supported game gets a real thumbnail.
    if (req.method === "GET" && pathname.startsWith("/banner/")) {
        const gName = decodeURIComponent(pathname.replace("/banner/", "").replace(/\.webp$/i, ""));
        const matched = BASELINE_GAMES.find(g => g.name.toLowerCase() === gName.toLowerCase());
        if (!matched || !UNIVERSE_IDS[matched.place_id]) {
            return sendJson(404, { error: "unknown game" });
        }
        const universeId = UNIVERSE_IDS[matched.place_id];
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

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log("Oxide Presence & Admin Server running on port " + PORT);
});
