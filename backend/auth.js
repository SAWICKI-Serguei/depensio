import crypto from "node:crypto";
import { promisify } from "node:util";
import db from "./db.js";

const scrypt = promisify(crypto.scrypt);

/* ---------- paramètres ---------- */
const SCRYPT_N = 16384;          // coût CPU (2^14)
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const LONGUEUR_CLE = 64;

export const COOKIE_NOM = "depensio_sid";
const DUREE_SESSION_MS   = 30 * 24 * 60 * 60 * 1000;  // 30 jours
const RENOUVELLEMENT_MS  = 24 * 60 * 60 * 1000;       // prolongée si > 1 jour d'écoulé

const MAX_ECHECS = 5;
const BLOCAGE_MS = 15 * 60 * 1000;                    // 15 minutes

/* ---------- mots de passe (scrypt + sel aléatoire) ---------- */
export async function hasherMotDePasse(motDePasse) {
  const sel = crypto.randomBytes(16);
  const cle = await scrypt(motDePasse.normalize("NFKC"), sel, LONGUEUR_CLE, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P
  });
  return `scrypt$${SCRYPT_N}$${sel.toString("base64")}$${cle.toString("base64")}`;
}

export async function verifierMotDePasse(motDePasse, stocke) {
  if (typeof motDePasse !== "string" || typeof stocke !== "string") return false;
  const [algo, n, selB64, cleB64] = stocke.split("$");
  if (algo !== "scrypt" || !n || !selB64 || !cleB64) return false;
  const sel = Buffer.from(selB64, "base64");
  const attendu = Buffer.from(cleB64, "base64");
  const cle = await scrypt(motDePasse.normalize("NFKC"), sel, attendu.length, {
    N: Number(n), r: SCRYPT_R, p: SCRYPT_P
  });
  return cle.length === attendu.length && crypto.timingSafeEqual(cle, attendu);
}

/* ---------- utilisateur unique ---------- */
export function utilisateurExiste() {
  return !!db.prepare("SELECT 1 FROM utilisateur WHERE id = 1").get();
}

export function lireHash() {
  const u = db.prepare("SELECT motDePasseHash FROM utilisateur WHERE id = 1").get();
  return u ? u.motDePasseHash : null;
}

export async function creerUtilisateur(motDePasse) {
  const hash = await hasherMotDePasse(motDePasse);
  db.prepare("INSERT INTO utilisateur (id, motDePasseHash, creeLe) VALUES (1, ?, ?)")
    .run(hash, new Date().toISOString());
}

export async function changerMotDePasse(motDePasse) {
  const hash = await hasherMotDePasse(motDePasse);
  db.prepare("UPDATE utilisateur SET motDePasseHash = ? WHERE id = 1").run(hash);
}

/* ---------- sessions (le jeton n'est stocké qu'haché) ---------- */
function hacherJeton(jeton) {
  return crypto.createHash("sha256").update(jeton).digest("hex");
}

export function ouvrirSession() {
  const jeton = crypto.randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO sessions (id, creeLe, expireLe) VALUES (?, ?, ?)")
    .run(hacherJeton(jeton), new Date().toISOString(), Date.now() + DUREE_SESSION_MS);
  return jeton;
}

export function lireSession(jeton) {
  if (typeof jeton !== "string" || jeton.length < 20 || jeton.length > 100) return null;
  const id = hacherJeton(jeton);
  const s = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
  if (!s) return null;
  const maintenant = Date.now();
  if (s.expireLe <= maintenant) {
    db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    return null;
  }
  if (maintenant + DUREE_SESSION_MS - s.expireLe > RENOUVELLEMENT_MS) {
    db.prepare("UPDATE sessions SET expireLe = ? WHERE id = ?").run(maintenant + DUREE_SESSION_MS, id);
  }
  return s;
}

export function fermerSession(jeton) {
  if (typeof jeton !== "string") return;
  db.prepare("DELETE FROM sessions WHERE id = ?").run(hacherJeton(jeton));
}

export function fermerToutesSessions() {
  db.prepare("DELETE FROM sessions").run();
}

export function purgerSessionsExpirees() {
  db.prepare("DELETE FROM sessions WHERE expireLe <= ?").run(Date.now());
}

/* ---------- cookies ---------- */
export function lireCookies(req) {
  const out = {};
  const entete = req.headers.cookie;
  if (!entete) return out;
  for (const partie of entete.split(";")) {
    const i = partie.indexOf("=");
    if (i < 0) continue;
    const cle = partie.slice(0, i).trim();
    const val = partie.slice(i + 1).trim();
    try { out[cle] = decodeURIComponent(val); } catch { out[cle] = val; }
  }
  return out;
}

export function cookieSession(jeton, secure) {
  return [
    `${COOKIE_NOM}=${jeton}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.floor(DUREE_SESSION_MS / 1000)}`,
    secure ? "Secure" : ""
  ].filter(Boolean).join("; ");
}

export function cookieEffacement(secure) {
  return [
    `${COOKIE_NOM}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
    secure ? "Secure" : ""
  ].filter(Boolean).join("; ");
}

/* ---------- anti-brute-force (par IP, en mémoire) ---------- */
const tentatives = new Map();

export function connexionBloquee(ip) {
  const t = tentatives.get(ip);
  if (!t || !t.bloqueJusqua) return 0;
  const reste = t.bloqueJusqua - Date.now();
  if (reste <= 0) { tentatives.delete(ip); return 0; }
  return Math.ceil(reste / 1000);
}

export function connexionEchec(ip) {
  const t = tentatives.get(ip) || { echecs: 0, bloqueJusqua: 0, maj: 0 };
  t.echecs += 1;
  t.maj = Date.now();
  if (t.echecs >= MAX_ECHECS) {
    t.bloqueJusqua = Date.now() + BLOCAGE_MS;
    t.echecs = 0;
  }
  tentatives.set(ip, t);
}

export function connexionReussie(ip) {
  tentatives.delete(ip);
}

setInterval(() => {
  const limite = Date.now() - 2 * BLOCAGE_MS;
  for (const [ip, t] of tentatives) {
    if ((t.maj || 0) < limite && (!t.bloqueJusqua || t.bloqueJusqua < Date.now())) tentatives.delete(ip);
  }
}, 10 * 60 * 1000).unref();

/* ---------- middlewares ---------- */

// Lit le cookie et attache la session (ou null) à la requête.
export function authentifier(req, res, next) {
  const cookies = lireCookies(req);
  req.jeton = cookies[COOKIE_NOM] || null;
  req.session = lireSession(req.jeton);
  next();
}

// Bloque tout ce qui n'est pas authentifié : API → 401 JSON, page → redirection /login.
export function exigerAuth(req, res, next) {
  if (req.session) return next();
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ erreur: "Non authentifié. Rechargez la page pour vous connecter." });
  }
  if (req.method === "GET" || req.method === "HEAD") return res.redirect("/login");
  return res.status(401).send("Non authentifié.");
}

// Protection CSRF : toute écriture sur /api doit provenir de la même origine.
export function protegerCsrf(req, res, next) {
  if (!req.path.startsWith("/api/")) return next();
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();

  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") {
    return res.status(403).json({ erreur: "Requête inter-site refusée." });
  }

  const origine = req.headers.origin;
  if (origine !== undefined) {
    if (origine === "null") return res.status(403).json({ erreur: "Origine refusée." });
    let hoteOrigine;
    try { hoteOrigine = new URL(origine).host; } catch { return res.status(403).json({ erreur: "Origine invalide." }); }
    if (hoteOrigine !== req.headers.host) {
      return res.status(403).json({ erreur: "Origine refusée." });
    }
  }
  next();
}
