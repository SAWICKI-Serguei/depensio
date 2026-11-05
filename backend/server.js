import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import db from "./db.js";
import {
  utilisateurExiste, lireHash, creerUtilisateur, changerMotDePasse, verifierMotDePasse,
  ouvrirSession, fermerSession, fermerToutesSessions, purgerSessionsExpirees,
  cookieSession, cookieEffacement,
  connexionBloquee, connexionEchec, connexionReussie,
  authentifier, exigerAuth, protegerCsrf
} from "./auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, "public");
const PORT = 3000;

const TYPES = ["depense", "revenu"];
const FREQUENCES = ["mensuel", "hebdo", "annuel", "dates"];
const FREQ_CLASSIQUES = ["mensuel", "hebdo", "annuel"];
const MDP_MIN = 8;
const MDP_MAX = 200;

/* =========================================================
   Utilitaires
   ========================================================= */
const pad = n => String(n).padStart(2, "0");
const ISO = /^\d{4}-\d{2}-\d{2}$/;

function dateValide(s) {
  if (typeof s !== "string" || !ISO.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function echeanceSuivante(iso, frequence) {
  const [y, m, d] = iso.split("-").map(Number);
  if (frequence === "hebdo") {
    return new Date(Date.UTC(y, m - 1, d + 7)).toISOString().slice(0, 10);
  }
  const ajout = frequence === "annuel" ? 12 : 1;
  let ny = y, nm = m + ajout;
  while (nm > 12) { nm -= 12; ny += 1; }
  const dernierJour = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${pad(nm)}-${pad(Math.min(d, dernierJour))}`;
}

function parseRec(r) {
  if (!r) return null;
  let dates = null;
  if (r.dates) { try { dates = JSON.parse(r.dates); } catch { dates = null; } }
  return { ...r, dates };
}

const getDep = id => db.prepare("SELECT * FROM depenses WHERE id = ?").get(id);
const getRec = id => parseRec(db.prepare("SELECT * FROM recurrents WHERE id = ?").get(id));

function idParam(req) {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function validerBase(body) {
  if (!body || typeof body !== "object") return { erreur: "Corps de requête invalide." };

  const libelle = String(body.libelle ?? "").trim();
  if (!libelle) return { erreur: "Le libellé est obligatoire." };
  if (libelle.length > 80) return { erreur: "Le libellé ne doit pas dépasser 80 caractères." };

  const categorie = String(body.categorie ?? "").trim();
  if (!categorie || categorie.length > 50) return { erreur: "Catégorie invalide." };

  const montant = Math.round(Number(body.montant) * 100) / 100;
  if (!Number.isFinite(montant) || montant <= 0) return { erreur: "Le montant doit être un nombre positif." };

  const type = TYPES.includes(body.type) ? body.type : "depense";

  const note = String(body.note ?? "").trim();
  if (note.length > 300) return { erreur: "La note ne doit pas dépasser 300 caractères." };

  return { valeurs: { libelle, categorie, montant, type, note } };
}

function validerDates(dates) {
  if (!Array.isArray(dates) || dates.length === 0) return { erreur: "Sélectionnez au moins une date." };
  if (dates.length > 366) return { erreur: "Une plage ne peut pas dépasser 366 jours." };
  const uniques = [...new Set(dates)];
  if (uniques.length !== dates.length) return { erreur: "Dates en double." };
  for (const d of uniques) if (!dateValide(d)) return { erreur: `Date invalide : ${String(d).slice(0, 20)}` };
  return { dates: uniques.sort() };
}

function validerMotDePasse(mdp) {
  if (typeof mdp !== "string") return "Mot de passe invalide.";
  if (mdp.length < MDP_MIN) return `Le mot de passe doit contenir au moins ${MDP_MIN} caractères.`;
  if (mdp.length > MDP_MAX) return `Le mot de passe ne doit pas dépasser ${MDP_MAX} caractères.`;
  return null;
}

function poserCookie(req, res, jeton) { res.setHeader("Set-Cookie", cookieSession(jeton, req.secure)); }
function effacerCookie(req, res)      { res.setHeader("Set-Cookie", cookieEffacement(req.secure)); }

/* =========================================================
   Application
   ========================================================= */
const app = express();
app.set("trust proxy", 1);           // derrière Caddy : req.ip / req.secure fiables
app.disable("x-powered-by");

app.use(express.json({ limit: "1mb" }));

// En-têtes de sécurité de base
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (req.path.startsWith("/api/")) res.setHeader("Cache-Control", "no-store");
  next();
});

app.use(protegerCsrf);
app.use(authentifier);

/* ---------- Authentification (routes publiques) ---------- */
app.get("/login", (req, res) => {
  if (req.session && !("changer" in req.query)) return res.redirect("/");
  res.sendFile(path.join(PUBLIC, "login.html"));
});

app.get("/logout", (req, res) => {
  if (req.jeton) fermerSession(req.jeton);
  effacerCookie(req, res);
  res.redirect("/login");
});

app.get("/api/auth/etat", (req, res) => {
  res.json({ configure: utilisateurExiste(), connecte: !!req.session });
});

// Première utilisation : définir le mot de passe
app.post("/api/auth/creer", async (req, res, next) => {
  try {
    if (utilisateurExiste()) return res.status(409).json({ erreur: "Un mot de passe est déjà défini." });
    const { motDePasse, confirmation } = req.body || {};
    const err = validerMotDePasse(motDePasse);
    if (err) return res.status(400).json({ erreur: err });
    if (motDePasse !== confirmation) return res.status(400).json({ erreur: "La confirmation ne correspond pas." });

    await creerUtilisateur(motDePasse);
    const jeton = ouvrirSession();
    poserCookie(req, res, jeton);
    res.status(201).json({ ok: true });
  } catch (e) { next(e); }
});

app.post("/api/auth/connexion", async (req, res, next) => {
  try {
    if (!utilisateurExiste()) return res.status(409).json({ erreur: "Aucun mot de passe n'est défini." });

    const ip = req.ip;
    const reste = connexionBloquee(ip);
    if (reste) return res.status(429).json({ erreur: "Trop de tentatives. Réessayez plus tard." });

    const { motDePasse } = req.body || {};
    if (typeof motDePasse !== "string" || motDePasse.length > MDP_MAX) {
      connexionEchec(ip);
      return res.status(400).json({ erreur: "Mot de passe invalide." });
    }

    const ok = await verifierMotDePasse(motDePasse, lireHash());
    if (!ok) {
      connexionEchec(ip);
      return res.status(401).json({ erreur: "Mot de passe incorrect." });
    }

    connexionReussie(ip);
    const jeton = ouvrirSession();
    poserCookie(req, res, jeton);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.post("/api/auth/deconnexion", (req, res) => {
  if (req.jeton) fermerSession(req.jeton);
  effacerCookie(req, res);
  res.json({ ok: true });
});

// Changement de mot de passe (session requise) : ferme toutes les autres sessions
app.post("/api/auth/mot-de-passe", async (req, res, next) => {
  try {
    if (!req.session) return res.status(401).json({ erreur: "Non authentifié." });

    const ip = req.ip;
    const reste = connexionBloquee(ip);
    if (reste) return res.status(429).json({ erreur: "Trop de tentatives. Réessayez plus tard." });

    const { actuel, nouveau, confirmation } = req.body || {};
    if (typeof actuel !== "string" || actuel.length > MDP_MAX) return res.status(400).json({ erreur: "Mot de passe actuel invalide." });
    const err = validerMotDePasse(nouveau);
    if (err) return res.status(400).json({ erreur: err });
    if (nouveau !== confirmation) return res.status(400).json({ erreur: "La confirmation ne correspond pas." });

    const ok = await verifierMotDePasse(actuel, lireHash());
    if (!ok) {
      connexionEchec(ip);
      return res.status(401).json({ erreur: "Mot de passe actuel incorrect." });
    }
    connexionReussie(ip);

    await changerMotDePasse(nouveau);
    fermerToutesSessions();
    const jeton = ouvrirSession();
    poserCookie(req, res, jeton);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ---------- À partir d'ici : session obligatoire ---------- */
app.use(exigerAuth);
app.use(express.static(PUBLIC, { index: "index.html" }));

/* =========================================================
   API — Transactions
   ========================================================= */
app.get("/api/depenses", (req, res) => {
  res.json(db.prepare("SELECT * FROM depenses ORDER BY date DESC, id DESC").all());
});

app.post("/api/depenses", (req, res) => {
  const v = validerBase(req.body);
  if (v.erreur) return res.status(400).json({ erreur: v.erreur });
  const { date } = req.body;
  if (!dateValide(date)) return res.status(400).json({ erreur: "Date invalide." });

  const { libelle, categorie, montant, type, note } = v.valeurs;
  const r = db.prepare(
    "INSERT INTO depenses (date, libelle, categorie, montant, type, note) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(date, libelle, categorie, montant, type, note);
  res.status(201).json(getDep(r.lastInsertRowid));
});

app.put("/api/depenses/:id", (req, res) => {
  const id = idParam(req);
  if (!id) return res.status(400).json({ erreur: "Identifiant invalide." });
  if (!getDep(id)) return res.status(404).json({ erreur: "Transaction introuvable." });

  const v = validerBase(req.body);
  if (v.erreur) return res.status(400).json({ erreur: v.erreur });
  const { date } = req.body;
  if (!dateValide(date)) return res.status(400).json({ erreur: "Date invalide." });

  const { libelle, categorie, montant, type, note } = v.valeurs;
  db.prepare(
    "UPDATE depenses SET date = ?, libelle = ?, categorie = ?, montant = ?, type = ?, note = ? WHERE id = ?"
  ).run(date, libelle, categorie, montant, type, note, id);
  res.json(getDep(id));
});

app.delete("/api/depenses/:id", (req, res) => {
  const id = idParam(req);
  if (!id) return res.status(400).json({ erreur: "Identifiant invalide." });
  const r = db.prepare("DELETE FROM depenses WHERE id = ?").run(id);
  if (!r.changes) return res.status(404).json({ erreur: "Transaction introuvable." });
  res.json({ ok: true });
});

/* =========================================================
   API — Récurrents
   ========================================================= */
app.get("/api/recurrents", (req, res) => {
  res.json(db.prepare("SELECT * FROM recurrents ORDER BY prochaineEcheance ASC, id ASC").all().map(parseRec));
});

app.post("/api/recurrents", (req, res) => {
  const v = validerBase(req.body);
  if (v.erreur) return res.status(400).json({ erreur: v.erreur });
  const { frequence } = req.body;
  if (!FREQUENCES.includes(frequence)) return res.status(400).json({ erreur: "Fréquence invalide." });
  const { libelle, categorie, montant, type, note } = v.valeurs;

  if (frequence === "dates") {
    const vd = validerDates(req.body.dates);
    if (vd.erreur) return res.status(400).json({ erreur: vd.erreur });
    const dates = vd.dates;

    const creer = db.transaction(() => {
      const r = db.prepare(
        "INSERT INTO recurrents (libelle, categorie, montant, frequence, prochaineEcheance, type, dates, note) VALUES (?, ?, ?, 'dates', ?, ?, ?, ?)"
      ).run(libelle, categorie, montant, dates[0], type, JSON.stringify(dates), note);
      const recId = r.lastInsertRowid;
      const ins = db.prepare(
        "INSERT INTO depenses (date, libelle, categorie, montant, type, recurrentId, note) VALUES (?, ?, ?, ?, ?, ?, ?)"
      );
      for (const d of dates) ins.run(d, libelle, categorie, montant, type, recId, note);
      return recId;
    });
    return res.status(201).json(getRec(creer()));
  }

  const { prochaineEcheance } = req.body;
  if (!dateValide(prochaineEcheance)) return res.status(400).json({ erreur: "Date d'échéance invalide." });
  const r = db.prepare(
    "INSERT INTO recurrents (libelle, categorie, montant, frequence, prochaineEcheance, type, note) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(libelle, categorie, montant, frequence, prochaineEcheance, type, note);
  res.status(201).json(getRec(r.lastInsertRowid));
});

app.put("/api/recurrents/:id", (req, res) => {
  const id = idParam(req);
  if (!id) return res.status(400).json({ erreur: "Identifiant invalide." });
  const rec = getRec(id);
  if (!rec) return res.status(404).json({ erreur: "Récurrence introuvable." });

  const v = validerBase(req.body);
  if (v.erreur) return res.status(400).json({ erreur: v.erreur });
  const { libelle, categorie, montant, type, note } = v.valeurs;

  if (rec.frequence === "dates") {
    const maj = db.transaction(() => {
      db.prepare(
        "UPDATE recurrents SET libelle = ?, categorie = ?, montant = ?, type = ?, note = ? WHERE id = ?"
      ).run(libelle, categorie, montant, type, note, id);
      db.prepare(
        "UPDATE depenses SET libelle = ?, categorie = ?, type = ?, note = ? WHERE recurrentId = ?"
      ).run(libelle, categorie, type, note, id);
      db.prepare(
        "UPDATE depenses SET montant = ? WHERE recurrentId = ? AND date >= ?"
      ).run(montant, id, todayISO());
    });
    maj();
    return res.json(getRec(id));
  }

  const frequence = FREQ_CLASSIQUES.includes(req.body.frequence) ? req.body.frequence : rec.frequence;
  const { prochaineEcheance } = req.body;
  if (!dateValide(prochaineEcheance)) return res.status(400).json({ erreur: "Date d'échéance invalide." });

  db.prepare(
    "UPDATE recurrents SET libelle = ?, categorie = ?, montant = ?, frequence = ?, prochaineEcheance = ?, type = ?, note = ? WHERE id = ?"
  ).run(libelle, categorie, montant, frequence, prochaineEcheance, type, note, id);
  res.json(getRec(id));
});

// Valider l'échéance : crée la transaction et avance la date
app.post("/api/recurrents/:id/valider", (req, res) => {
  const id = idParam(req);
  if (!id) return res.status(400).json({ erreur: "Identifiant invalide." });
  const rec = getRec(id);
  if (!rec) return res.status(404).json({ erreur: "Récurrence introuvable." });
  if (rec.frequence === "dates") return res.status(400).json({ erreur: "Une plage de dates n'a pas d'échéance à valider." });
  if (!dateValide(rec.prochaineEcheance)) return res.status(400).json({ erreur: "Échéance invalide." });

  const valider = db.transaction(() => {
    const r = db.prepare(
      "INSERT INTO depenses (date, libelle, categorie, montant, type, recurrentId, note) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(rec.prochaineEcheance, rec.libelle, rec.categorie, rec.montant, rec.type, rec.id, rec.note || "");
    db.prepare("UPDATE recurrents SET prochaineEcheance = ? WHERE id = ?")
      .run(echeanceSuivante(rec.prochaineEcheance, rec.frequence), id);
    return r.lastInsertRowid;
  });
  const depId = valider();
  res.json({ ok: true, recurrent: getRec(id), depense: getDep(depId) });
});

// Passer l'échéance : avance la date sans créer de transaction
app.post("/api/recurrents/:id/passer", (req, res) => {
  const id = idParam(req);
  if (!id) return res.status(400).json({ erreur: "Identifiant invalide." });
  const rec = getRec(id);
  if (!rec) return res.status(404).json({ erreur: "Récurrence introuvable." });
  if (rec.frequence === "dates") return res.status(400).json({ erreur: "Une plage de dates n'a pas d'échéance à passer." });
  if (!dateValide(rec.prochaineEcheance)) return res.status(400).json({ erreur: "Échéance invalide." });

  db.prepare("UPDATE recurrents SET prochaineEcheance = ? WHERE id = ?")
    .run(echeanceSuivante(rec.prochaineEcheance, rec.frequence), id);
  res.json({ ok: true, recurrent: getRec(id) });
});

app.delete("/api/recurrents/:id", (req, res) => {
  const id = idParam(req);
  if (!id) return res.status(400).json({ erreur: "Identifiant invalide." });
  const rec = getRec(id);
  if (!rec) return res.status(404).json({ erreur: "Récurrence introuvable." });

  const supprimer = db.transaction(() => {
    if (rec.frequence === "dates") {
      db.prepare("DELETE FROM depenses WHERE recurrentId = ? AND date > ?").run(id, todayISO());
    }
    db.prepare("DELETE FROM recurrents WHERE id = ?").run(id);
  });
  supprimer();
  res.json({ ok: true });
});

/* =========================================================
   404 API + gestion des erreurs
   ========================================================= */
app.use("/api", (req, res) => res.status(404).json({ erreur: "Route introuvable." }));

app.use((err, req, res, next) => {
  if (err && err.type === "entity.parse.failed") return res.status(400).json({ erreur: "JSON invalide." });
  if (err && err.type === "entity.too.large") return res.status(413).json({ erreur: "Requête trop volumineuse." });
  console.error(err);
  res.status(500).json({ erreur: "Erreur interne du serveur." });
});

/* ---------- démarrage ---------- */
purgerSessionsExpirees();
setInterval(purgerSessionsExpirees, 6 * 60 * 60 * 1000).unref();

app.listen(PORT, () => console.log(`Dépensio démarré sur le port ${PORT}`));
