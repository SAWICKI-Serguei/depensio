import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "depensio.db"));
db.pragma("journal_mode = WAL");

/* ---------- schéma ---------- */
db.exec(`
  CREATE TABLE IF NOT EXISTS depenses (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    date        TEXT    NOT NULL,
    libelle     TEXT    NOT NULL,
    categorie   TEXT    NOT NULL,
    montant     REAL    NOT NULL,
    type        TEXT    NOT NULL DEFAULT 'depense',
    recurrentId INTEGER,
    note        TEXT    NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS recurrents (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    libelle           TEXT    NOT NULL,
    categorie         TEXT    NOT NULL,
    montant           REAL    NOT NULL,
    frequence         TEXT    NOT NULL,
    prochaineEcheance TEXT,
    actif             INTEGER NOT NULL DEFAULT 1,
    type              TEXT    NOT NULL DEFAULT 'depense',
    dates             TEXT,
    note              TEXT    NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS utilisateur (
    id             INTEGER PRIMARY KEY CHECK (id = 1),
    motDePasseHash TEXT NOT NULL,
    creeLe         TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id       TEXT    PRIMARY KEY,
    creeLe   TEXT    NOT NULL,
    expireLe INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_depenses_date ON depenses(date);
  CREATE INDEX IF NOT EXISTS idx_depenses_rec  ON depenses(recurrentId);
  CREATE INDEX IF NOT EXISTS idx_sessions_exp  ON sessions(expireLe);
`);

/* ---------- migrations (noms de tables/colonnes = constantes internes uniquement) ---------- */
function ajouterColonneSiAbsente(table, colonne, definition) {
  const colonnes = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!colonnes.includes(colonne)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${colonne} ${definition}`);
  }
}

ajouterColonneSiAbsente("depenses",   "type",        "TEXT NOT NULL DEFAULT 'depense'");
ajouterColonneSiAbsente("depenses",   "recurrentId", "INTEGER");
ajouterColonneSiAbsente("depenses",   "note",        "TEXT NOT NULL DEFAULT ''");
ajouterColonneSiAbsente("recurrents", "type",        "TEXT NOT NULL DEFAULT 'depense'");
ajouterColonneSiAbsente("recurrents", "dates",       "TEXT");
ajouterColonneSiAbsente("recurrents", "note",        "TEXT NOT NULL DEFAULT ''");

export default db;
