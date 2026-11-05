#!/usr/bin/env node
'use strict';

/*
 * Dépensio — téléchargement automatique des logos de marques
 * ----------------------------------------------------------
 * Lit la liste MARQUES de frontend/index.html (+ scripts/marques-extra.txt, optionnel),
 * cherche le logo de chaque marque sur Internet et l'enregistre dans frontend/logos/
 * sous le nom attendu par l'application : <nom normalisé>.svg | .png | .webp
 *
 * Sources essayées dans l'ordre (la première qui répond gagne) :
 *   1. logo.dev      PNG 256 px, logos officiels   (nécessite un token gratuit pk_...)
 *   2. simple-icons  SVG vectoriel, ~3 400 marques (sans clé)
 *   3. site          icône du site lui-même : SVG / apple-touch-icon (sans clé)
 *   4. google        favicon Google 128 px (sans clé)
 *
 * Usage        : node scripts/telecharger-logos.js [options]   (voir --help)
 * Prérequis    : Node 18 ou plus (fetch natif). Aucun package à installer.
 */

const fs = require('fs');
const path = require('path');

// ── Chemins ─────────────────────────────────────────────────────────────
const RACINE  = path.join(__dirname, '..');
const INDEX   = path.join(RACINE, 'frontend', 'index.html');
const DOSSIER = path.join(RACINE, 'frontend', 'logos');
const EXTRA   = path.join(__dirname, 'marques-extra.txt');
const RAPPORT = path.join(__dirname, 'logos-rapport.json');

// ── Réglages ────────────────────────────────────────────────────────────
const EXTENSIONS   = ['svg', 'png', 'webp'];                    // ordre = celui de l'appli
const ID_SOURCES   = ['logo.dev', 'simple-icons', 'site', 'google'];
const TIMEOUT_MS   = 10000;                // délai max par requête
const MAX_IMAGE    = 2 * 1024 * 1024;      // 2 Mo max par image
const MAX_SVG      = 300 * 1024;           // 300 Ko max par SVG
const MAX_HTML     = 600 * 1024;           // on ne lit que le début des pages HTML
const PARALLELE    = 4;                    // marques traitées en même temps
const PAUSE_MS     = 150;                  // pause entre deux marques (politesse)
const SEUIL_SOMBRE = 0.25;                 // en dessous : logo Simple Icons posé sur tuile blanche
const USER_AGENT   = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const AIDE = `
Dépensio — téléchargement des logos de marques

Usage : node scripts/telecharger-logos.js [options]

Options :
  --force          remplace les logos déjà présents (y compris ceux déposés à la main)
  --only=a,b       ne traite que ces marques (--only=netflix,mcdonalds)
  --token=pk_xxx   token Logo.dev (clé PUBLIQUE gratuite) ; ou variable LOGODEV_TOKEN
  --sources=a,b    sources à utiliser, dans cet ordre : ${ID_SOURCES.join(', ')}
  --min=48         largeur minimale (px) des images PNG/WebP acceptées (défaut 48)
  --help           affiche cette aide
`;

// ── Utilitaires ─────────────────────────────────────────────────────────

// Même normalisation que l'appli : minuscules, sans accents, sans espaces ni ponctuation
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function attendre(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Options de la ligne de commande ─────────────────────────────────────
const opt = {
  force: false,
  token: process.env.LOGODEV_TOKEN || '',
  only: null,
  min: 48,
  sources: null,
  aide: false
};

for (const a of process.argv.slice(2)) {
  if (a === '--force') opt.force = true;
  else if (a === '--help' || a === '-h') opt.aide = true;
  else if (a.startsWith('--token=')) opt.token = a.slice(8).trim();
  else if (a.startsWith('--only=')) opt.only = a.slice(7).split(',').map(norm).filter(Boolean);
  else if (a.startsWith('--min=')) {
    const n = parseInt(a.slice(6), 10);
    opt.min = Number.isNaN(n) ? 48 : Math.max(0, n);
  } else if (a.startsWith('--sources=')) {
    opt.sources = a.slice(10).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  } else {
    console.error('Option inconnue : ' + a + '  (voir --help)');
    process.exit(1);
  }
}

// ── Lecture de la liste des marques ─────────────────────────────────────
// Format attendu dans index.html : "Nom|domaine|Catégorie|alias1,alias2"
function lireMarques() {
  if (!fs.existsSync(INDEX)) {
    console.error('Fichier introuvable : ' + INDEX);
    console.error('Lancez le script depuis le dossier du projet (celui qui contient frontend et scripts).');
    process.exit(1);
  }

  const brut = [];
  const src = fs.readFileSync(INDEX, 'utf8');
  const re = /(["'`])((?:(?!\1)[^|\n\\]){1,60})\|([a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+)\|[A-Z](?:\|(?:(?!\1)[^\n\\])*)?\1/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    brut.push({ nom: m[2].trim(), domaine: m[3].toLowerCase(), origine: 'index.html' });
  }
  const nIndex = brut.length;

  let nExtra = 0;
  if (fs.existsSync(EXTRA)) {
    const reDomaine = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+$/;
    for (const ligne of fs.readFileSync(EXTRA, 'utf8').split(/\r?\n/)) {
      const l = ligne.trim();
      if (!l || l.startsWith('#')) continue;
      const parties = l.split('|').map(s => s.trim());
      const nom = parties[0];
      const dom = (parties[1] || '').toLowerCase();
      if (nom && reDomaine.test(dom)) {
        brut.push({ nom, domaine: dom, origine: 'marques-extra.txt' });
        nExtra++;
      } else {
        console.warn('  ligne ignorée dans marques-extra.txt : ' + l);
      }
    }
  }

  // Une seule entrée par nom de fichier (clé normalisée)
  const uniques = new Map();
  for (const b of brut) {
    b.cle = norm(b.nom);
    if (b.cle && !uniques.has(b.cle)) uniques.set(b.cle, b);
  }
  return { liste: [...uniques.values()], nIndex, nExtra };
}

// ── Réseau ──────────────────────────────────────────────────────────────
async function requete(url, texte) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: 'follow',
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': texte
        ? 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5'
        : 'image/svg+xml,image/png,image/webp,image/*;q=0.8,*/*;q=0.5',
      'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.7'
    }
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);

  if (texte) {
    const html = await res.text();
    return { url: res.url, texte: html.slice(0, MAX_HTML) };
  }

  const taille = Number(res.headers.get('content-length') || 0);
  if (taille > MAX_IMAGE) throw new Error('fichier trop volumineux');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_IMAGE) throw new Error('fichier trop volumineux');
  return { url: res.url, buf };
}

// ── Validation des images ───────────────────────────────────────────────

// SVG sans contenu actif (scripts, gestionnaires d'événements, etc.)
function svgSur(texte) {
  return !/<script|<foreignObject|javascript:|\son[a-z]+\s*=|<!ENTITY/i.test(texte);
}

// Reconnaît le vrai type d'après le contenu (pas d'après l'URL ni l'en-tête)
function typeImage(buf) {
  if (!buf || buf.length < 16) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (buf.length <= MAX_SVG) {
    const texte = buf.toString('utf8');
    if (/<svg[\s>]/i.test(texte.slice(0, 3000)) && svgSur(texte)) return 'svg';
  }
  return null; // ICO, JPEG, GIF, page HTML, etc. : non pris en charge par l'appli
}

function largeur(buf, type) {
  try {
    if (type === 'png') return buf.readUInt32BE(16);
    if (type === 'webp') {
      const fmt = buf.toString('latin1', 12, 16);
      if (fmt === 'VP8X') return 1 + buf.readUIntLE(24, 3);
      if (fmt === 'VP8 ') return buf.readUInt16LE(26) & 0x3fff;
      if (fmt === 'VP8L') return 1 + (((buf[22] & 0x3f) << 8) | buf[21]);
    }
  } catch (e) { /* illisible : on accepte */ }
  return 99999;
}

function valider(buf, minPx) {
  const type = typeImage(buf);
  if (!type) return null;
  if (type !== 'svg' && largeur(buf, type) < minPx) return null;
  return { type, buf };
}

// ── Source 1 : Logo.dev ─────────────────────────────────────────────────
async function sourceLogoDev(b) {
  const url = 'https://img.logo.dev/' + encodeURIComponent(b.domaine) +
    '?token=' + encodeURIComponent(opt.token) +
    '&size=256&format=png&fallback=404';
  try {
    const { buf } = await requete(url, false);
    return valider(buf, 0);
  } catch (e) {
    if (/HTTP 404/.test(e.message)) return null; // pas de logo pour ce domaine
    throw e;
  }
}

// ── Source 2 : Simple Icons (via cdn.simpleicons.org) ───────────────────
function luminance(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  if (Number.isNaN(n)) return 1;
  const r = (n >> 16) & 255, g = (n >> 8) & 255, bl = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * bl) / 255;
}

// Logo de couleur très sombre : on le pose sur une tuile blanche pour qu'il reste visible
function adapterSvg(svg) {
  const ouverture = svg.match(/<svg\b[^>]*>/i);
  if (!ouverture) return svg;
  const f = ouverture[0].match(/\sfill="#?([0-9a-f]{3,8})"/i);
  const couleur = f ? '#' + f[1] : '#111111';
  const sombre = f ? luminance(f[1]) < SEUIL_SOMBRE : true;
  if (!sombre) return svg;
  const interieur = svg
    .slice(svg.indexOf(ouverture[0]) + ouverture[0].length)
    .replace(/<\/svg>\s*$/i, '');
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
    '<rect width="32" height="32" rx="7" fill="#ffffff"/>' +
    '<g transform="translate(4 4)" fill="' + couleur + '">' + interieur + '</g></svg>';
}

async function sourceSimpleIcons(b) {
  const slugSI = norm(b.nom.toLowerCase().replace(/\+/g, 'plus').replace(/\./g, 'dot').replace(/&/g, 'and'));
  const labelDomaine = norm(b.domaine.replace(/^www\./, '').split('.')[0]);
  const candidats = [...new Set([slugSI, b.cle, labelDomaine].filter(Boolean))];

  for (const slug of candidats) {
    try {
      const { buf } = await requete('https://cdn.simpleicons.org/' + slug, false);
      if (typeImage(buf) !== 'svg') continue;
      const svg = adapterSvg(buf.toString('utf8'));
      const v = valider(Buffer.from(svg, 'utf8'), 0);
      if (v) return { ...v, detail: 'slug ' + slug };
    } catch (e) { /* slug inconnu : suivant */ }
  }
  return null;
}

// ── Source 3 : icône du site lui-même ───────────────────────────────────
function attributs(balise) {
  const a = {};
  balise.replace(
    /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g,
    (_, nom, v1, v2, v3) => {
      a[nom.toLowerCase()] = v1 !== undefined ? v1 : (v2 !== undefined ? v2 : v3);
      return '';
    }
  );
  return a;
}

// Classe les icônes déclarées dans la page : SVG > apple-touch-icon > plus grandes icônes
function iconesDeLaPage(html, base) {
  const trouvees = [];
  for (const balise of (html.match(/<link\b[^>]*>/gi) || [])) {
    const a = attributs(balise);
    const rel = (a.rel || '').toLowerCase();
    if (!a.href || !/icon/.test(rel) || /mask-icon/.test(rel)) continue;
    let url;
    try { url = new URL(a.href.replace(/&amp;/g, '&'), base).href; } catch (e) { continue; }
    const taille = parseInt((a.sizes || '').split('x')[0], 10) || 0;
    const estSvg = /svg/i.test(a.type || '') || /\.svg(\?|$)/i.test(url);
    const estApple = /apple-touch-icon/.test(rel);
    trouvees.push({ url, score: estSvg ? 1000 : (estApple ? 500 + taille : taille) });
  }
  trouvees.sort((x, y) => y.score - x.score);
  return [...new Map(trouvees.map(t => [t.url, t])).values()];
}

async function sourceSite(b) {
  const d = b.domaine.replace(/^www\./, '');
  for (const hote of ['https://' + d, 'https://www.' + d]) {
    let candidats = [];
    try {
      const page = await requete(hote + '/', true);
      candidats = iconesDeLaPage(page.texte, page.url);
    } catch (e) { /* page inaccessible : on tente quand même le chemin usuel */ }
    candidats.push({ url: hote + '/apple-touch-icon.png' });

    for (const c of candidats.slice(0, 5)) {
      try {
        const { buf } = await requete(c.url, false);
        const v = valider(buf, opt.min);
        if (v) return { ...v, detail: c.url };
      } catch (e) { /* suivant */ }
    }
  }
  return null;
}

// ── Source 4 : favicon Google ───────────────────────────────────────────
async function sourceGoogle(b) {
  const url = 'https://www.google.com/s2/favicons?sz=128&domain=' + encodeURIComponent(b.domaine);
  const { buf } = await requete(url, false);
  return valider(buf, opt.min); // l'icône « globe » générique (16 px) est refusée ici
}

const IMPLEMENTATIONS = {
  'logo.dev': sourceLogoDev,
  'simple-icons': sourceSimpleIcons,
  'site': sourceSite,
  'google': sourceGoogle
};

function choisirSources() {
  let ids = opt.sources || ID_SOURCES;
  const inconnues = ids.filter(id => !ID_SOURCES.includes(id));
  if (inconnues.length) {
    console.error('Source inconnue : ' + inconnues.join(', ') + '  (disponibles : ' + ID_SOURCES.join(', ') + ')');
    process.exit(1);
  }
  if (ids.includes('logo.dev') && !opt.token) {
    if (opt.sources) {
      console.error('La source logo.dev demande un token : --token=pk_... ou variable LOGODEV_TOKEN.');
      process.exit(1);
    }
    ids = ids.filter(id => id !== 'logo.dev');
  }
  return ids.map(id => ({ id, essayer: IMPLEMENTATIONS[id] }));
}

// ── Enregistrement ──────────────────────────────────────────────────────
function enregistrer(cle, type, buf) {
  if (opt.force) {
    // évite qu'un ancien .svg masque le nouveau .png (l'appli teste svg, puis png, puis webp)
    for (const e of EXTENSIONS) {
      const f = path.join(DOSSIER, cle + '.' + e);
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  }
  fs.writeFileSync(path.join(DOSSIER, cle + '.' + type), buf);
}

async function traiter(b, ctx) {
  if (!opt.force) {
    const ext = EXTENSIONS.find(e => fs.existsSync(path.join(DOSSIER, b.cle + '.' + e)));
    if (ext) return { ...b, statut: 'existant', fichier: b.cle + '.' + ext };
  }

  for (const s of ctx.sources) {
    if (ctx.coupees.has(s.id)) continue;
    try {
      const r = await s.essayer(b);
      if (r) {
        enregistrer(b.cle, r.type, r.buf);
        return { ...b, statut: 'ok', source: s.id, fichier: b.cle + '.' + r.type, detail: r.detail || '' };
      }
    } catch (e) {
      if (s.id === 'logo.dev' && /HTTP (401|402|403|429)/.test(e.message) && !ctx.coupees.has(s.id)) {
        ctx.coupees.add(s.id);
        console.warn('\n  /!\\ Logo.dev désactivé pour la suite (' + e.message + ') : token refusé ou quota atteint.\n');
      }
      // autres erreurs (réseau, délai dépassé) : on passe à la source suivante
    }
  }
  return { ...b, statut: 'absent' };
}

// Exécute fn sur chaque élément, n à la fois
async function pool(items, n, fn) {
  const resultats = new Array(items.length);
  let suivant = 0;
  async function ouvrier() {
    for (;;) {
      const k = suivant++;
      if (k >= items.length) return;
      resultats[k] = await fn(items[k]);
      await attendre(PAUSE_MS);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, ouvrier));
  return resultats;
}

// ── Programme principal ─────────────────────────────────────────────────
async function main() {
  if (opt.aide) { console.log(AIDE); return; }

  if (typeof fetch !== 'function') {
    console.error('Node 18 ou plus est nécessaire (fetch natif). Version actuelle : ' + process.version);
    process.exit(1);
  }
  if (/^sk_/.test(opt.token)) {
    console.error('Utilisez la clé PUBLIQUE Logo.dev (pk_...), jamais la clé secrète (sk_...).');
    process.exit(1);
  }
  if (opt.token && !/^pk_/.test(opt.token)) {
    console.warn('Attention : un token Logo.dev commence normalement par pk_.');
  }

  const { liste, nIndex, nExtra } = lireMarques();
  console.log('\nDépensio — téléchargement des logos');
  console.log('Marques lues : ' + nIndex + ' dans index.html' + (nExtra ? ' + ' + nExtra + ' dans marques-extra.txt' : ''));
  if (nIndex < 20) {
    console.warn('  /!\\ Très peu de marques trouvées dans index.html : le format de MARQUES est peut-être différent de "Nom|domaine|Cat|alias".');
  }

  let marques = liste;
  if (opt.only) {
    marques = liste.filter(b => opt.only.includes(b.cle));
    if (!marques.length) {
      console.error('Aucune marque ne correspond à --only=' + opt.only.join(','));
      process.exit(1);
    }
  }

  const sources = choisirSources();
  console.log('Sources      : ' + sources.map(s => s.id).join(' > ') +
    (!opt.token && !opt.sources ? '   (logo.dev inactif : pas de token)' : ''));
  console.log('Dossier      : ' + DOSSIER);
  console.log('Mode         : ' + (opt.force ? 'remplacement des logos existants' : 'les logos existants sont conservés') + '\n');

  fs.mkdirSync(DOSSIER, { recursive: true });

  const ctx = { sources, coupees: new Set() };
  const t0 = Date.now();
  const total = marques.length;
  let fini = 0;

  const resultats = await pool(marques, PARALLELE, async b => {
    const r = await traiter(b, ctx);
    fini++;
    const num = String(fini).padStart(String(total).length, ' ');
    const nom = b.cle.padEnd(22).slice(0, 22);
    if (r.statut === 'ok') {
      console.log('[' + num + '/' + total + '] OK      ' + nom + ' ' + r.source.padEnd(13) + ' -> ' + r.fichier);
    } else if (r.statut === 'existant') {
      console.log('[' + num + '/' + total + '] deja    ' + nom + ' ' + r.fichier);
    } else {
      console.log('[' + num + '/' + total + '] ABSENT  ' + nom + ' aucun logo trouvé (' + b.domaine + ')');
    }
    return r;
  });

  // ── Bilan ──
  const ok = resultats.filter(r => r.statut === 'ok');
  const existants = resultats.filter(r => r.statut === 'existant');
  const absents = resultats.filter(r => r.statut === 'absent');
  const parSource = {};
  for (const r of ok) parSource[r.source] = (parSource[r.source] || 0) + 1;
  const detailSources = Object.keys(parSource).map(k => k + ' ' + parSource[k]).join(', ');

  console.log('\n──────────────── Bilan (' + Math.round((Date.now() - t0) / 1000) + ' s) ────────────────');
  console.log('Téléchargés    : ' + ok.length + (detailSources ? '   (' + detailSources + ')' : ''));
  console.log('Déjà présents  : ' + existants.length);
  console.log('Introuvables   : ' + absents.length);
  if (absents.length) {
    console.log('\nÀ ajouter à la main dans frontend\\logos\\ (nom exact du fichier à gauche) :');
    for (const r of absents) console.log('  ' + r.cle + '.png   ←   ' + r.nom + '  (' + r.domaine + ')');
  }

  fs.writeFileSync(RAPPORT, JSON.stringify({
    date: new Date().toISOString(),
    sources: sources.map(s => s.id),
    resume: { telecharges: ok.length, existants: existants.length, introuvables: absents.length, parSource },
    resultats
  }, null, 2));
  console.log('\nRapport détaillé : ' + RAPPORT);
  console.log('Rechargez l\'appli avec Ctrl+F5 pour voir les logos.\n');
}

main().catch(e => {
  console.error('Erreur fatale : ' + (e && e.message ? e.message : e));
  process.exit(1);
});
