// HoHoHost — self-hosted family wishlists with gift reservations, Secret Santa and more.
// Zero dependencies: Node 22 (node:http + node:sqlite). License: AGPL-3.0-or-later.

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { previewLink, downloadImage, sniffImage } = require("./lib/scrape");

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const PUBLIC_DIR = path.join(__dirname, "public");
const IMAGES_DIR = path.join(DATA_DIR, "images");
const SETUP_CODE = (process.env.SETUP_CODE || "").trim(); // optionnel : protège l'assistant de 1er démarrage
const VERSION = (() => { try { return require("./package.json").version; } catch { return "dev"; } })();
const DEFAULT_TITLE = "Noël en famille";

const SESSION_DAYS = 120;
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

fs.mkdirSync(IMAGES_DIR, { recursive: true });

// =====================================================================
// Base de données
// =====================================================================
const DB_FILE = fs.existsSync(path.join(DATA_DIR, "noel.db")) ? "noel.db" : "hoho-host.db"; // compat. anciennes installs
const db = new DatabaseSync(path.join(DATA_DIR, DB_FILE));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    prenom TEXT NOT NULL,
    nom TEXT NOT NULL,
    login_key TEXT NOT NULL UNIQUE,
    pin_hash TEXT,
    is_admin INTEGER NOT NULL DEFAULT 0,
    activated_at INTEGER,
    failed INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS lists (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    manager_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY,
    list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    titre TEXT NOT NULL,
    lien TEXT, image TEXT, prix TEXT, categorie TEXT, note TEXT,
    coup_de_coeur INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    archived_at INTEGER,
    deleted_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS reservations (
    item_id INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
`);

// ---------- v2.1 : nouvelles tables / colonnes ----------
db.exec(`
  CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    asker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    texte TEXT NOT NULL,
    reponse TEXT,
    created_at INTEGER NOT NULL,
    answered_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY,
    list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    texte TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS list_managers (
    list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (list_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS list_views (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    seen_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, list_id)
  );
  CREATE TABLE IF NOT EXISTS secret_draws (
    id INTEGER PRIMARY KEY,
    budget TEXT,
    config TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS secret_pairs (
    draw_id INTEGER NOT NULL REFERENCES secret_draws(id) ON DELETE CASCADE,
    giver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    receiver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (draw_id, giver_id)
  );
`);
const hasCol = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
if (!hasCol("reservations", "statut")) db.exec(`ALTER TABLE reservations ADD COLUMN statut TEXT NOT NULL DEFAULT 'reserve'`);

const q = (sql) => db.prepare(sql);
const now = () => Date.now();

// ---------- Sauvegarde automatique quotidienne (data/backups, 14 jours) ----------
const BACKUP_DIR = path.join(DATA_DIR, "backups");
function backup() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(BACKUP_DIR, `backup-${day}.db`);
    if (!fs.existsSync(file)) {
      db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
      console.log(`Sauvegarde : ${path.basename(file)}`);
    }
    const old = fs.readdirSync(BACKUP_DIR).filter((f) => /^(noel|backup)-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().slice(0, -14);
    for (const f of old) fs.unlinkSync(path.join(BACKUP_DIR, f));
  } catch (e) {
    console.error("Sauvegarde impossible :", e.message);
  }
}
setTimeout(backup, 5000).unref();
setInterval(backup, 3600e3).unref();

// « Élodie  Martin » → « elodie martin »
const norm = (s) =>
  String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
const clean = (s, max) => {
  const v = String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  return v || null;
};
const loginKey = (prenom, nom) => `${norm(prenom)}|${norm(nom)}`;

function createUser(prenom, nom, isAdmin = false) {
  const t = now();
  const { lastInsertRowid: id } = q(
    "INSERT INTO users (prenom, nom, login_key, is_admin, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(prenom, nom, loginKey(prenom, nom), isAdmin ? 1 : 0, t);
  q("INSERT INTO lists (name, user_id, manager_id, created_at) VALUES (?, ?, ?, ?)").run(prenom, id, id, t);
  return Number(id);
}

// Réglages (titre du site…)
db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
const getSetting = (k, d) => { const r = q("SELECT value FROM settings WHERE key = ?").get(k); return r ? r.value : d; };
const setSetting = (k, v) => q("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(k, v);
const needsSetup = () => !q("SELECT COUNT(*) n FROM users").get().n;
if (needsSetup()) console.log("Aucun compte : ouvre l'app dans ton navigateur pour lancer l'assistant de démarrage.");

// Nom affiché : « Marie », ou « Marie D. » si deux Marie
function displayNames() {
  const users = q("SELECT id, prenom, nom FROM users").all();
  const count = {};
  for (const u of users) count[norm(u.prenom)] = (count[norm(u.prenom)] || 0) + 1;
  const map = {};
  for (const u of users) map[u.id] = count[norm(u.prenom)] > 1 ? `${u.prenom} ${u.nom.charAt(0).toUpperCase()}.` : u.prenom;
  return map;
}

// =====================================================================
// Auth
// =====================================================================
function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  return `${salt.toString("hex")}:${crypto.scryptSync(pin, salt, 32).toString("hex")}`;
}
function checkPin(pin, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(":");
  const test = crypto.scryptSync(String(pin), Buffer.from(salt, "hex"), 32);
  return crypto.timingSafeEqual(test, Buffer.from(hash, "hex"));
}
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

function startSession(res, req, userId) {
  const token = crypto.randomBytes(32).toString("hex");
  q("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(
    sha(token), userId, now() + SESSION_DAYS * 864e5
  );
  const secure = req.headers["x-forwarded-proto"] === "https" || /https/.test(req.headers["cf-visitor"] || "");
  res.setHeader(
    "Set-Cookie",
    `noel_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? "; Secure" : ""}`
  );
}

function sessionUser(req) {
  const m = (req.headers.cookie || "").match(/(?:^|;\s*)noel_session=([a-f0-9]{64})/);
  if (!m) return null;
  const row = q(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
                 WHERE s.token_hash = ? AND s.expires_at > ?`).get(sha(m[1]), now());
  return row || null;
}

// Limite par IP (en plus du blocage par compte)
const ipFails = new Map();
const clientIp = (req) =>
  req.headers["cf-connecting-ip"] || (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress;
function ipGuard(req) {
  const e = ipFails.get(clientIp(req));
  if (e && e.reset > now() && e.n >= 30) fail(429, "Trop de tentatives depuis cet appareil. Réessaie dans 15 minutes.");
}
function ipFail(req) {
  const ip = clientIp(req);
  const e = ipFails.get(ip);
  if (!e || e.reset < now()) ipFails.set(ip, { n: 1, reset: now() + LOCK_MS });
  else e.n++;
}

const validPin = (p) => /^\d{6}$/.test(String(p || ""));

// =====================================================================
// Helpers HTTP
// =====================================================================
function fail(status, message, extra) {
  throw Object.assign(new Error(message), { status, extra });
}

const SEC_HEADERS = {
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "DENY",
};

function sendJSON(res, status, body) {
  res.writeHead(status, { ...SEC_HEADERS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".avif": "image/avif", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8", ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json; charset=utf-8", ".json": "application/json; charset=utf-8",
};

function serveFile(res, baseDir, rel, cache) {
  const file = path.normalize(path.join(baseDir, rel));
  if (!file.startsWith(baseDir + path.sep)) return sendJSON(res, 403, { erreur: "Interdit" });
  fs.readFile(file, (err, buf) => {
    if (err) return sendJSON(res, 404, { erreur: "Introuvable" });
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      ...SEC_HEADERS,
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": cache || "no-cache",
      ...(ext === ".html" && {
        "Content-Security-Policy":
          "default-src 'self'; img-src * data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
      }),
    });
    res.end(buf);
  });
}

const escHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function serveIndex(res) {
  fs.readFile(path.join(PUBLIC_DIR, "index.html"), "utf8", (err, html) => {
    if (err) return sendJSON(res, 500, { erreur: "index.html introuvable" });
    const titre = escHtml(getSetting("titre", DEFAULT_TITLE));
    res.writeHead(200, {
      ...SEC_HEADERS,
      "Content-Type": MIME[".html"],
      "Cache-Control": "no-cache",
      "Content-Security-Policy":
        "default-src 'self'; img-src * data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    });
    res.end(html.replace(/\{\{TITLE\}\}/g, titre).replace(/\{\{VERSION\}\}/g, escHtml(VERSION)));
  });
}
function serveManifest(res) {
  const titre = getSetting("titre", DEFAULT_TITLE);
  res.writeHead(200, { ...SEC_HEADERS, "Content-Type": "application/manifest+json; charset=utf-8", "Cache-Control": "no-cache" });
  res.end(JSON.stringify({
    id: "/", name: titre, short_name: titre.length > 12 ? "HoHoHost" : titre, start_url: "/", display: "standalone",
    background_color: "#f5efe4", theme_color: "#1f3d30",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
    ],
    share_target: { action: "/partage", method: "GET", params: { title: "title", text: "text", url: "url" } },
  }));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    if (!/application\/json/.test(req.headers["content-type"] || "")) return reject(Object.assign(new Error("JSON attendu"), { status: 415 }));
    const chunks = [];
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > limit) {
        reject(Object.assign(new Error("Requête trop volumineuse"), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(n ? JSON.parse(Buffer.concat(chunks)) : {});
      } catch {
        reject(Object.assign(new Error("JSON invalide"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

// =====================================================================
// Métier
// =====================================================================
const getList = (id) => q("SELECT * FROM lists WHERE id = ?").get(id) || fail(404, "Liste introuvable");
const getItem = (id) => q("SELECT * FROM items WHERE id = ? AND deleted_at IS NULL").get(id) || fail(404, "Article introuvable");
const managerIds = (list) => [list.manager_id, ...q("SELECT user_id FROM list_managers WHERE list_id = ?").all(list.id).map((r) => r.user_id)];
const canManage = (list, me) => managerIds(list).includes(me.id);
// Qui répond aux questions : le destinataire, ou les gestionnaires pour une liste gérée
const isAnswerer = (list, me) => (list.user_id ? list.user_id === me.id : canManage(list, me));
const joinNames = (arr) => (arr.length <= 1 ? arr.join("") : arr.slice(0, -1).join(", ") + " et " + arr[arr.length - 1]);
function parsePrice(s) {
  const m = String(s || "").replace(/[\s\u00a0\u202f]/g, "").match(/(\d+(?:[.,]\d{1,2})?)/);
  if (!m) return null;
  const n = Number(m[1].replace(",", "."));
  return isFinite(n) && n > 0 ? n : null;
}

function publicUser(u) {
  return { id: u.id, prenom: u.prenom, nom: u.nom, admin: !!u.is_admin, nomAffiche: displayNames()[u.id] };
}

function allCategories() {
  return q(`SELECT DISTINCT categorie c FROM items WHERE categorie IS NOT NULL AND deleted_at IS NULL ORDER BY c COLLATE NOCASE`)
    .all().map((r) => r.c);
}

function itemFields(body) {
  const titre = clean(body.titre, 200);
  if (!titre) fail(400, "Donne au moins un nom à l'article");
  let lien = extractUrl(body.lien);
  if (lien) {
    try { new URL(lien); } catch { fail(400, "Le lien n'est pas valide"); }
  }
  return {
    titre, lien,
    prix: clean(body.prix, 40),
    categorie: clean(body.categorie, 40),
    note: clean(body.note, 300),
    coup_de_coeur: body.coupDeCoeur ? 1 : 0,
  };
}

// « Découvre ce produit sur Amazon https://amzn.eu/d/xyz » → https://amzn.eu/d/xyz
function extractUrl(v) {
  const t = clean(v, 2000);
  if (!t) return null;
  const m = t.match(/https?:\/\/[^\s<>"']+/i);
  if (m) return m[0].replace(/[).,;!?»]+$/, "");
  if (/\s/.test(t)) return null;
  return /^[\w-]+(\.[\w-]+)+(\/|$)/.test(t) ? "https://" + t : null;
}

// Image : fichier local existant, ou URL distante téléchargée et stockée chez nous
async function resolveImage(input) {
  const v = clean(input, 2000);
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) {
    try {
      const { buf, ext } = await downloadImage(v);
      const name = `${crypto.randomBytes(12).toString("hex")}.${ext}`;
      fs.writeFileSync(path.join(IMAGES_DIR, name), buf);
      return name;
    } catch {
      // le site refuse le téléchargement : on garde le lien direct (sauf vignette Amazon introuvable)
      return /amazon-adsystem\.com/i.test(v) ? null : v;
    }
  }
  if (/^[\w.-]+$/.test(v) && fs.existsSync(path.join(IMAGES_DIR, v))) return v;
  return null;
}

function serializeItem(it, { hideResa, me, names }) {
  const out = {
    id: it.id, titre: it.titre, lien: it.lien, image: it.image, prix: it.prix,
    categorie: it.categorie, note: it.note, coupDeCoeur: !!it.coup_de_coeur, creeLe: it.created_at,
  };
  if (!hideResa) {
    out.reservation = it.resa_user ? { par: names[it.resa_user], moi: it.resa_user === me.id } : null;
  }
  return out;
}

// =====================================================================
// Routes
// =====================================================================
const routes = [];
const route = (method, pattern, handler, opts = {}) => routes.push({ method, pattern, handler, ...opts });

// ---------- Session ----------
// ---------- Config publique, santé, assistant de démarrage ----------
route("GET", "/api/health", () => ({ ok: true, version: VERSION }), { public: true });

route("GET", "/api/config", () => ({
  titre: getSetting("titre", DEFAULT_TITLE),
  setup: needsSetup(),
  setupCodeRequis: needsSetup() && !!SETUP_CODE,
  version: VERSION,
}), { public: true });

route("POST", "/api/setup", ({ body, req, res }) => {
  ipGuard(req);
  if (!needsSetup()) fail(409, "L'application est déjà configurée");
  if (SETUP_CODE && String(body.setupCode || "").trim() !== SETUP_CODE) {
    ipFail(req);
    fail(403, "Code d'installation incorrect (variable SETUP_CODE)");
  }
  const titre = clean(body.titre, 60) || DEFAULT_TITLE;
  const prenom = clean(body.prenom, 40);
  const nom = clean(body.nom, 60);
  if (!prenom || !nom) fail(400, "Prénom et nom obligatoires");
  if (!validPin(body.code)) fail(400, "Le code doit faire exactement 6 chiffres");
  setSetting("titre", titre);
  const id = createUser(prenom, nom, true);
  q("UPDATE users SET pin_hash = ?, activated_at = ? WHERE id = ?").run(hashPin(body.code), now(), id);
  startSession(res, req, id);
  console.log(`Installation terminée : « ${titre} », admin ${prenom} ${nom}.`);
  return { moi: publicUser(q("SELECT * FROM users WHERE id = ?").get(id)) };
}, { public: true });

route("PUT", "/api/admin/reglages", ({ body }) => {
  const titre = clean(body.titre, 60) || fail(400, "Le titre ne peut pas être vide");
  setSetting("titre", titre);
  return { titre };
}, { admin: true });

route("GET", "/api/moi", ({ me }) => ({ moi: me ? publicUser(me) : null }), { public: true });

route("POST", "/api/identifier", ({ body, req }) => {
  ipGuard(req);
  if (needsSetup()) fail(409, "L'application n'est pas encore configurée", { setup: true });
  const u = q("SELECT * FROM users WHERE login_key = ?").get(loginKey(body.prenom, body.nom));
  if (!u) {
    ipFail(req);
    fail(404, "Je ne te trouve pas dans la famille 🤔 Vérifie l'orthographe, ou demande à l'admin de t'ajouter.");
  }
  return { etape: u.pin_hash ? "code" : "creer", prenom: u.prenom };
}, { public: true });

route("POST", "/api/connexion", ({ body, req, res }) => {
  ipGuard(req);
  const u = q("SELECT * FROM users WHERE login_key = ?").get(loginKey(body.prenom, body.nom));
  if (!u) fail(404, "Personne introuvable");
  if (!u.pin_hash) fail(409, "Code pas encore créé", { etape: "creer" });
  if (u.locked_until > now()) fail(429, `Trop d'essais. Réessaie dans ${Math.ceil((u.locked_until - now()) / 60000)} min.`);
  if (!validPin(body.code) || !checkPin(body.code, u.pin_hash)) {
    ipFail(req);
    const failed = u.failed + 1;
    if (failed >= MAX_FAILS) {
      q("UPDATE users SET failed = 0, locked_until = ? WHERE id = ?").run(now() + LOCK_MS, u.id);
      fail(429, "Trop d'essais : compte bloqué 15 minutes.");
    }
    q("UPDATE users SET failed = ? WHERE id = ?").run(failed, u.id);
    const left = MAX_FAILS - failed;
    fail(401, `Code incorrect — encore ${left} essai${left > 1 ? "s" : ""}.`);
  }
  q("UPDATE users SET failed = 0, locked_until = 0 WHERE id = ?").run(u.id);
  startSession(res, req, u.id);
  return { moi: publicUser(u) };
}, { public: true });

route("POST", "/api/activer", ({ body, req, res }) => {
  ipGuard(req);
  const u = q("SELECT * FROM users WHERE login_key = ?").get(loginKey(body.prenom, body.nom));
  if (!u) fail(404, "Personne introuvable");
  if (u.pin_hash) fail(409, "Ce compte a déjà un code", { etape: "code" });
  if (!validPin(body.code)) fail(400, "Le code doit faire exactement 6 chiffres");
  q("UPDATE users SET pin_hash = ?, activated_at = ?, failed = 0, locked_until = 0 WHERE id = ?").run(hashPin(body.code), now(), u.id);
  startSession(res, req, u.id);
  return { moi: publicUser(u) };
}, { public: true });

route("POST", "/api/deconnexion", ({ req, res }) => {
  const m = (req.headers.cookie || "").match(/noel_session=([a-f0-9]{64})/);
  if (m) q("DELETE FROM sessions WHERE token_hash = ?").run(sha(m[1]));
  res.setHeader("Set-Cookie", "noel_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
  return { ok: true };
}, { public: true });

route("POST", "/api/moi/code", ({ me, body }) => {
  if (!checkPin(String(body.ancien || ""), me.pin_hash)) fail(400, "L'ancien code ne correspond pas");
  if (!validPin(body.nouveau)) fail(400, "Le nouveau code doit faire 6 chiffres");
  q("UPDATE users SET pin_hash = ? WHERE id = ?").run(hashPin(body.nouveau), me.id);
  return { ok: true };
});

// ---------- Listes ----------
const listName = (l, names) => (l.user_id ? names[l.user_id] : l.name);
const seenAt = (me, listId) => (q("SELECT seen_at FROM list_views WHERE user_id = ? AND list_id = ?").get(me.id, listId) || {}).seen_at;

route("GET", "/api/membres", () => {
  const names = displayNames();
  return { membres: q("SELECT id FROM users ORDER BY prenom COLLATE NOCASE").all().map((u) => ({ id: u.id, nom: names[u.id] })) };
});

route("GET", "/api/listes", ({ me }) => {
  const names = displayNames();
  const rows = q(`
    SELECT l.*,
      (SELECT COUNT(*) FROM items i WHERE i.list_id = l.id AND i.archived_at IS NULL AND i.deleted_at IS NULL) AS total,
      (SELECT COUNT(*) FROM items i JOIN reservations r ON r.item_id = i.id
         WHERE i.list_id = l.id AND i.archived_at IS NULL AND i.deleted_at IS NULL) AS pris,
      (SELECT seen_at FROM list_views v WHERE v.list_id = l.id AND v.user_id = ?) AS seen
    FROM lists l`).all(me.id);
  const listes = rows.map((l) => {
    const managers = managerIds(l);
    const jeGere = managers.includes(me.id);
    const destinataire = l.user_id === me.id;
    const repondeur = isAnswerer(l, me);
    const out = {
      id: l.id,
      nom: listName(l, names),
      moi: destinataire,
      geree: !l.user_id,
      gerePar: !l.user_id ? joinNames(managers.map((id) => names[id])) : null,
      jeGere,
      total: l.total,
    };
    if (!destinataire) out.disponibles = l.total - l.pris;
    if (!destinataire && !jeGere) {
      const since = l.seen || 0;
      out.nouveautes =
        q("SELECT COUNT(*) n FROM items WHERE list_id = ? AND archived_at IS NULL AND deleted_at IS NULL AND created_at > ?").get(l.id, since).n +
        q("SELECT COUNT(*) n FROM messages WHERE list_id = ? AND user_id != ? AND created_at > ?").get(l.id, me.id, since).n;
    }
    if (repondeur) {
      out.questionsEnAttente = q(`SELECT COUNT(*) n FROM questions qu JOIN items i ON i.id = qu.item_id
        WHERE i.list_id = ? AND qu.reponse IS NULL AND i.deleted_at IS NULL AND i.archived_at IS NULL`).get(l.id).n;
    }
    return out;
  });
  const rank = (l) => (l.moi ? 0 : l.jeGere ? 1 : 2);
  listes.sort((a, b) => rank(a) - rank(b) || a.nom.localeCompare(b.nom, "fr"));
  return { listes };
});

route("POST", "/api/listes", ({ me, body }) => {
  const name = clean(body.nom, 40);
  if (!name) fail(400, "Indique le prénom de la personne");
  const { lastInsertRowid } = q("INSERT INTO lists (name, user_id, manager_id, created_at) VALUES (?, NULL, ?, ?)").run(name, me.id, now());
  return { id: Number(lastInsertRowid) };
});

route("PATCH", /^\/api\/listes\/(\d+)$/, ({ me, body, params }) => {
  const list = getList(params[0]);
  if (!canManage(list, me) || list.user_id) fail(403, "Tu ne peux pas renommer cette liste");
  const name = clean(body.nom, 40) || fail(400, "Nom vide");
  q("UPDATE lists SET name = ? WHERE id = ?").run(name, list.id);
  return { ok: true };
});

route("DELETE", /^\/api\/listes\/(\d+)$/, ({ me, params }) => {
  const list = getList(params[0]);
  if (!canManage(list, me) || list.user_id) fail(403, "Tu ne peux pas supprimer cette liste");
  q("DELETE FROM lists WHERE id = ?").run(list.id);
  return { ok: true };
});

route("POST", /^\/api\/listes\/(\d+)\/gestionnaires$/, ({ me, body, params }) => {
  const list = getList(params[0]);
  if (!canManage(list, me) || list.user_id) fail(403, "Seuls les gestionnaires peuvent ajouter quelqu'un");
  const uid = Number(body.userId);
  if (!q("SELECT 1 FROM users WHERE id = ?").get(uid)) fail(404, "Membre introuvable");
  if (uid !== list.manager_id) q("INSERT OR IGNORE INTO list_managers (list_id, user_id) VALUES (?, ?)").run(list.id, uid);
  return { ok: true };
});

route("DELETE", /^\/api\/listes\/(\d+)\/gestionnaires\/(\d+)$/, ({ me, params }) => {
  const list = getList(params[0]);
  if (!canManage(list, me) || list.user_id) fail(403, "Interdit");
  if (Number(params[1]) === list.manager_id) fail(400, "La personne qui a créé la liste reste gestionnaire");
  q("DELETE FROM list_managers WHERE list_id = ? AND user_id = ?").run(list.id, params[1]);
  return { ok: true };
});

route("GET", /^\/api\/listes\/(\d+)$/, ({ me, params }) => {
  const list = getList(params[0]);
  const names = displayNames();
  const destinataire = list.user_id === me.id;
  const managers = managerIds(list);
  const jeGere = managers.includes(me.id);
  const repondeur = isAnswerer(list, me);
  const prevSeen = seenAt(me, list.id);
  q(`INSERT INTO list_views (user_id, list_id, seen_at) VALUES (?, ?, ?)
     ON CONFLICT (user_id, list_id) DO UPDATE SET seen_at = excluded.seen_at`).run(me.id, list.id, now());

  const items = q(`
    SELECT i.*, r.user_id AS resa_user FROM items i LEFT JOIN reservations r ON r.item_id = i.id
    WHERE i.list_id = ? AND i.archived_at IS NULL AND i.deleted_at IS NULL
    ORDER BY i.coup_de_coeur DESC, i.created_at DESC`).all(list.id);
  const qs = q(`SELECT qu.* FROM questions qu JOIN items i ON i.id = qu.item_id WHERE i.list_id = ? ORDER BY qu.created_at`).all(list.id);

  return {
    liste: {
      id: list.id,
      nom: listName(list, names),
      moi: destinataire,
      geree: !list.user_id,
      gerePar: !list.user_id ? joinNames(managers.map((id) => names[id])) : null,
      gestionnaires: !list.user_id ? managers.map((id) => ({ id, nom: names[id], createur: id === list.manager_id })) : [],
      peutModifier: jeGere,
      peutRepondre: repondeur,
    },
    articles: items.map((it) => ({
      ...serializeItem(it, { hideResa: destinataire, me, names }),
      nouveau: !destinataire && !jeGere && prevSeen != null && it.created_at > prevSeen,
      questions: qs.filter((x) => x.item_id === it.id).map((x) => ({
        id: x.id, texte: x.texte, reponse: x.reponse, moi: x.asker_id === me.id, le: x.created_at,
      })),
    })),
    messages: destinataire ? null : q("SELECT * FROM messages WHERE list_id = ? ORDER BY created_at").all(list.id).map((m) => ({
      id: m.id, par: names[m.user_id], moi: m.user_id === me.id, texte: m.texte, le: m.created_at,
      nouveau: prevSeen != null && m.created_at > prevSeen && m.user_id !== me.id,
    })),
    categories: allCategories(),
  };
});

// ---------- Discussion cachée ----------
route("POST", /^\/api\/listes\/(\d+)\/messages$/, ({ me, body, params }) => {
  const list = getList(params[0]);
  if (list.user_id === me.id) fail(403, "Cette discussion est cachée pour toi 🤫");
  const texte = clean(body.texte, 1000) || fail(400, "Message vide");
  q("INSERT INTO messages (list_id, user_id, texte, created_at) VALUES (?, ?, ?, ?)").run(list.id, me.id, texte, now());
  return { ok: true };
});

route("DELETE", /^\/api\/messages\/(\d+)$/, ({ me, params }) => {
  const m = q("SELECT * FROM messages WHERE id = ?").get(params[0]) || fail(404, "Message introuvable");
  if (m.user_id !== me.id && !me.is_admin) fail(403, "Tu ne peux supprimer que tes messages");
  q("DELETE FROM messages WHERE id = ?").run(m.id);
  return { ok: true };
});

// ---------- Questions anonymes ----------
route("POST", /^\/api\/articles\/(\d+)\/questions$/, ({ me, body, params }) => {
  const it = getItem(params[0]);
  const list = getList(it.list_id);
  if (isAnswerer(list, me)) fail(400, "C'est à toi qu'on pose les questions sur cette liste 😉");
  const texte = clean(body.texte, 300) || fail(400, "Question vide");
  q("INSERT INTO questions (item_id, asker_id, texte, created_at) VALUES (?, ?, ?, ?)").run(it.id, me.id, texte, now());
  return { ok: true };
});

route("POST", /^\/api\/questions\/(\d+)\/reponse$/, ({ me, body, params }) => {
  const qu = q("SELECT * FROM questions WHERE id = ?").get(params[0]) || fail(404, "Question introuvable");
  const list = getList(getItem(qu.item_id).list_id);
  if (!isAnswerer(list, me)) fail(403, "Seul le destinataire peut répondre");
  const reponse = clean(body.reponse, 300) || fail(400, "Réponse vide");
  q("UPDATE questions SET reponse = ?, answered_at = ? WHERE id = ?").run(reponse, now(), qu.id);
  return { ok: true };
});

route("DELETE", /^\/api\/questions\/(\d+)$/, ({ me, params }) => {
  const qu = q("SELECT * FROM questions WHERE id = ?").get(params[0]) || fail(404, "Question introuvable");
  const list = getList(getItem(qu.item_id).list_id);
  if (qu.asker_id !== me.id && !isAnswerer(list, me)) fail(403, "Interdit");
  q("DELETE FROM questions WHERE id = ?").run(qu.id);
  return { ok: true };
});

// ---------- Articles ----------
route("POST", /^\/api\/listes\/(\d+)\/articles$/, async ({ me, body, params }) => {
  const list = getList(params[0]);
  if (!canManage(list, me)) fail(403, "Ce n'est pas ta liste");
  const f = itemFields(body);
  const image = await resolveImage(body.image);
  const t = now();
  const { lastInsertRowid } = q(`
    INSERT INTO items (list_id, titre, lien, image, prix, categorie, note, coup_de_coeur, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(list.id, f.titre, f.lien, image, f.prix, f.categorie, f.note, f.coup_de_coeur, t, t);
  return { id: Number(lastInsertRowid) };
});

route("PUT", /^\/api\/articles\/(\d+)$/, async ({ me, body, params }) => {
  const it = getItem(params[0]);
  if (!canManage(getList(it.list_id), me)) fail(403, "Ce n'est pas ta liste");
  const f = itemFields(body);
  const image = body.image === it.image ? it.image : await resolveImage(body.image);
  q(`UPDATE items SET titre=?, lien=?, image=?, prix=?, categorie=?, note=?, coup_de_coeur=?, updated_at=? WHERE id=?`)
    .run(f.titre, f.lien, image, f.prix, f.categorie, f.note, f.coup_de_coeur, now(), it.id);
  return { ok: true };
});

route("DELETE", /^\/api\/articles\/(\d+)$/, ({ me, params }) => {
  const it = getItem(params[0]);
  if (!canManage(getList(it.list_id), me)) fail(403, "Ce n'est pas ta liste");
  const resa = q("SELECT 1 FROM reservations WHERE item_id = ?").get(it.id);
  if (resa) q("UPDATE items SET deleted_at = ? WHERE id = ?").run(now(), it.id);
  else q("DELETE FROM items WHERE id = ?").run(it.id);
  return { ok: true };
});

route("POST", /^\/api\/articles\/(\d+)\/reserver$/, ({ me, params }) => {
  const it = getItem(params[0]);
  if (it.archived_at) fail(410, "Cet article est archivé");
  const list = getList(it.list_id);
  if (list.user_id === me.id) fail(403, "Tu ne peux pas réserver tes propres cadeaux 😄");
  const r = q("SELECT user_id FROM reservations WHERE item_id = ?").get(it.id);
  if (r) fail(409, r.user_id === me.id ? "Tu l'as déjà réservé" : `Déjà réservé par ${displayNames()[r.user_id]}`);
  q("INSERT INTO reservations (item_id, user_id, created_at) VALUES (?, ?, ?)").run(it.id, me.id, now());
  return { ok: true };
});

route("POST", /^\/api\/articles\/(\d+)\/annuler$/, ({ me, params }) => {
  const id = Number(params[0]);
  const r = q("SELECT user_id FROM reservations WHERE item_id = ?").get(id);
  if (!r) return { ok: true };
  if (r.user_id !== me.id) fail(403, "Seule la personne qui a réservé peut annuler");
  q("DELETE FROM reservations WHERE item_id = ?").run(id);
  q("DELETE FROM items WHERE id = ? AND deleted_at IS NOT NULL").run(id);
  return { ok: true };
});

const STATUTS = ["reserve", "achete", "emballe"];
route("POST", /^\/api\/articles\/(\d+)\/statut$/, ({ me, body, params }) => {
  if (!STATUTS.includes(body.statut)) fail(400, "Statut inconnu");
  const r = q("SELECT user_id FROM reservations WHERE item_id = ?").get(params[0]) || fail(404, "Réservation introuvable");
  if (r.user_id !== me.id) fail(403, "Ce n'est pas ta réservation");
  q("UPDATE reservations SET statut = ? WHERE item_id = ?").run(body.statut, params[0]);
  return { ok: true };
});

route("GET", "/api/reservations", ({ me }) => {
  const names = displayNames();
  const rows = q(`
    SELECT i.*, r.statut, l.id AS l_id, l.name AS l_name, l.user_id AS l_user, l.manager_id AS l_manager
    FROM reservations r JOIN items i ON i.id = r.item_id JOIN lists l ON l.id = i.list_id
    WHERE r.user_id = ? AND i.archived_at IS NULL
    ORDER BY l.name, i.created_at DESC`).all(me.id);
  return {
    reservations: rows.map((it) => ({
      ...serializeItem(it, { hideResa: true, me, names }),
      statut: it.statut,
      prixNum: parsePrice(it.prix),
      retire: !!it.deleted_at,
      liste: { id: it.l_id, nom: it.l_user ? names[it.l_user] : it.l_name },
      retirePar: it.deleted_at ? names[it.l_manager] : null,
    })),
  };
});

// ---------- Père Noël secret ----------
function drawPairs(ids, exclusions) {
  const banned = new Set(exclusions.flatMap(([a, b]) => [`${a}>${b}`, `${b}>${a}`]));
  const givers = [...ids].sort(() => Math.random() - 0.5);
  const taken = new Set();
  const result = new Map();
  let steps = 0;
  function dfs(i) {
    if (++steps > 200000) return false;
    if (i === givers.length) return true;
    const g = givers[i];
    const cands = ids.filter((r) => r !== g && !taken.has(r) && !banned.has(`${g}>${r}`)).sort(() => Math.random() - 0.5);
    for (const r of cands) {
      taken.add(r); result.set(g, r);
      if (dfs(i + 1)) return true;
      taken.delete(r); result.delete(g);
    }
    return false;
  }
  return dfs(0) ? result : null;
}

const currentDraw = () => q("SELECT * FROM secret_draws ORDER BY id DESC LIMIT 1").get();

route("GET", "/api/secret", ({ me }) => {
  const d = currentDraw();
  if (!d) return { actif: false };
  const pair = q("SELECT receiver_id FROM secret_pairs WHERE draw_id = ? AND giver_id = ?").get(d.id, me.id);
  if (!pair) return { actif: true, participe: false };
  const names = displayNames();
  const list = q("SELECT id FROM lists WHERE user_id = ?").get(pair.receiver_id);
  return { actif: true, participe: true, pour: { nom: names[pair.receiver_id], listeId: list && list.id }, budget: d.budget, le: d.created_at };
});

route("GET", "/api/admin/secret", () => {
  const d = currentDraw();
  if (!d) return { actif: false };
  const names = displayNames();
  const cfg = JSON.parse(d.config || "{}");
  return {
    actif: true, le: d.created_at, budget: d.budget,
    participants: (cfg.participants || []).map((id) => ({ id, nom: names[id] })).filter((p) => p.nom),
    exclusions: (cfg.exclusions || []).map(([a, b]) => [a, b]),
  };
}, { admin: true });

route("POST", "/api/admin/secret", ({ body }) => {
  const ids = [...new Set((body.participants || []).map(Number))].filter((id) => q("SELECT 1 FROM users WHERE id = ?").get(id));
  if (ids.length < 3) fail(400, "Il faut au moins 3 participants");
  const exclusions = (body.exclusions || []).map(([a, b]) => [Number(a), Number(b)]).filter(([a, b]) => ids.includes(a) && ids.includes(b) && a !== b);
  const pairs = drawPairs(ids, exclusions);
  if (!pairs) fail(400, "Tirage impossible avec ces exclusions. Retire-en une ou ajoute des participants.");
  const budget = clean(body.budget, 40);
  db.exec("BEGIN");
  try {
    q("DELETE FROM secret_draws").run();
    const { lastInsertRowid } = q("INSERT INTO secret_draws (budget, config, created_at) VALUES (?, ?, ?)").run(budget, JSON.stringify({ participants: ids, exclusions }), now());
    for (const [g, r] of pairs) q("INSERT INTO secret_pairs (draw_id, giver_id, receiver_id) VALUES (?, ?, ?)").run(lastInsertRowid, g, r);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return { ok: true, participants: ids.length };
}, { admin: true });

route("DELETE", "/api/admin/secret", () => {
  q("DELETE FROM secret_draws").run();
  return { ok: true };
}, { admin: true });

// ---------- Aide à l'ajout ----------
route("POST", "/api/apercu-lien", async ({ body }) => {
  const url = extractUrl(body.url) || fail(400, "Je ne trouve pas de lien dans ce texte");
  try {
    return await previewLink(url);
  } catch (e) {
    fail(422, "Ce site ne veut pas donner ses infos automatiquement. Complète à la main 🙂");
  }
});

route("POST", "/api/image", ({ body }) => {
  const m = String(body.data || "").match(/^data:image\/[\w+.-]+;base64,(.+)$/);
  if (!m) fail(400, "Image invalide");
  const buf = Buffer.from(m[1], "base64");
  const ext = sniffImage(buf) || fail(400, "Format d'image non pris en charge");
  const name = `${crypto.randomBytes(12).toString("hex")}.${ext}`;
  fs.writeFileSync(path.join(IMAGES_DIR, name), buf);
  return { image: name };
}, { limit: 12 * 1024 * 1024 });

// ---------- Admin ----------
route("GET", "/api/admin/membres", ({ me }) => {
  const names = displayNames();
  return {
    membres: q("SELECT * FROM users ORDER BY prenom COLLATE NOCASE, nom COLLATE NOCASE").all().map((u) => ({
      id: u.id, prenom: u.prenom, nom: u.nom, nomAffiche: names[u.id], admin: !!u.is_admin,
      active: !!u.pin_hash, activeLe: u.activated_at, bloque: u.locked_until > now(), moi: u.id === me.id,
    })),
    saison: q(`SELECT COUNT(*) n FROM items i JOIN reservations r ON r.item_id = i.id WHERE i.archived_at IS NULL`).get().n,
  };
}, { admin: true });

route("POST", "/api/admin/membres", ({ body }) => {
  const prenom = clean(body.prenom, 40);
  const nom = clean(body.nom, 60);
  if (!prenom || !nom) fail(400, "Prénom et nom obligatoires");
  if (q("SELECT 1 FROM users WHERE login_key = ?").get(loginKey(prenom, nom))) fail(409, `${prenom} ${nom} est déjà dans la famille`);
  return { id: createUser(prenom, nom) };
}, { admin: true });

route("POST", /^\/api\/admin\/membres\/(\d+)\/reinitialiser$/, ({ params }) => {
  q("UPDATE users SET pin_hash = NULL, activated_at = NULL, failed = 0, locked_until = 0 WHERE id = ?").run(params[0]);
  q("DELETE FROM sessions WHERE user_id = ?").run(params[0]);
  return { ok: true };
}, { admin: true });

route("POST", /^\/api\/admin\/membres\/(\d+)\/debloquer$/, ({ params }) => {
  q("UPDATE users SET failed = 0, locked_until = 0 WHERE id = ?").run(params[0]);
  return { ok: true };
}, { admin: true });

route("POST", /^\/api\/admin\/membres\/(\d+)\/admin$/, ({ me, params, body }) => {
  if (Number(params[0]) === me.id) fail(400, "Tu ne peux pas modifier ton propre rôle");
  q("UPDATE users SET is_admin = ? WHERE id = ?").run(body.admin ? 1 : 0, params[0]);
  return { ok: true };
}, { admin: true });

route("DELETE", /^\/api\/admin\/membres\/(\d+)$/, ({ me, params }) => {
  if (Number(params[0]) === me.id) fail(400, "Tu ne peux pas te supprimer toi-même");
  q("DELETE FROM users WHERE id = ?").run(params[0]);
  return { ok: true };
}, { admin: true });

route("POST", "/api/admin/nouvelle-saison", () => {
  const t = now();
  const r = q(`UPDATE items SET archived_at = ? WHERE archived_at IS NULL AND id IN (SELECT item_id FROM reservations)`).run(t);
  q("DELETE FROM items WHERE deleted_at IS NOT NULL AND id NOT IN (SELECT item_id FROM reservations)").run();
  return { archives: Number(r.changes) };
}, { admin: true });

// =====================================================================
// Serveur
// =====================================================================
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  try {
    if (p.startsWith("/api/")) {
      const r = routes.find((r) => r.method === req.method && (typeof r.pattern === "string" ? r.pattern === p : r.pattern.test(p)));
      if (!r) fail(404, "Route inconnue");
      const params = typeof r.pattern === "string" ? [] : p.match(r.pattern).slice(1);
      const me = sessionUser(req);
      if (!r.public && !me) return sendJSON(res, 401, { erreur: "Connecte-toi pour continuer", code: "AUTH" });
      if (r.admin && !me.is_admin) fail(403, "Réservé à l'admin");
      const body = req.method === "GET" || req.method === "DELETE" ? {} : await readBody(req, r.limit || 64 * 1024);
      const out = await r.handler({ req, res, me, body, params });
      return sendJSON(res, 200, out);
    }
    if (p === "/robots.txt") {
      res.writeHead(200, { ...SEC_HEADERS, "Content-Type": "text/plain" });
      return res.end("User-agent: *\nDisallow: /\n");
    }
    if (p.startsWith("/images/")) return serveFile(res, IMAGES_DIR, decodeURIComponent(p.slice(8)), "public, max-age=604800");
    if (p === "/" || p === "/index.html" || p === "/partage") return serveIndex(res);
    if (p === "/manifest.webmanifest") return serveManifest(res);
    return serveFile(res, PUBLIC_DIR, decodeURIComponent(p.slice(1)));
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    return sendJSON(res, status, { erreur: status === 500 ? "Erreur serveur" : e.message, ...(e.extra || {}) });
  }
});

// Ménage des sessions expirées
setInterval(() => q("DELETE FROM sessions WHERE expires_at < ?").run(now()), 6 * 3600e3).unref();

server.listen(PORT, () => console.log(`HoHoHost ${VERSION} sur http://localhost:${PORT}`));
