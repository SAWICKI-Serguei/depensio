# Dépensio

> Vos dépenses, sous contrôle.

Suivi de dépenses personnelles et de facturation récurrente, avec un tableau de bord web.
Les données restent chez vous : tout tourne en local dans Docker.

## Prérequis

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Windows, macOS) ou Docker Engine + Docker Compose (Linux)
- [Git](https://git-scm.com/) (ou téléchargez le ZIP depuis GitHub)

## Installation

Placez-vous dans le dossier de votre choix, puis :

```bash
git clone https://github.com/SAWICKI-Serguei/depensio.git
cd depensio
```

Créez votre fichier de configuration (facultatif : le port par défaut est 3001) :

```bash
# Windows (cmd)
copy .env.example .env
# Windows (PowerShell), Linux, macOS
cp .env.example .env
```

Ouvrez `.env` pour changer le port si besoin, puis lancez :

```bash
docker compose up --build -d
```

Ouvrez ensuite **https://localhost:3001** (ou le port choisi dans `.env`).

> Le certificat HTTPS est généré localement par Caddy. Le navigateur affiche un
> avertissement au premier accès : c'est normal, acceptez l'exception pour `localhost`.

À la première ouverture, l'application vous demande de **définir un mot de passe**.
Il n'y a ni nom d'utilisateur ni adresse e-mail. Ce mot de passe protège ensuite l'accès au tableau de bord.

## Logos des marques (facultatif)

Les logos ne sont pas fournis dans le dépôt (ce sont des marques déposées).
Sans eux, l'appli utilise un logo de secours ou une pastille avec l'initiale.
Pour les télécharger automatiquement dans `frontend/logos/` :

```bash
# Windows PowerShell
docker run --rm -v "${PWD}:/work" -w /work node:20 node scripts/telecharger-logos.js
# Windows cmd
docker run --rm -v "%cd%:/work" -w /work node:20 node scripts/telecharger-logos.js
# Linux / macOS
docker run --rm -v "$(pwd):/work" -w /work node:20 node scripts/telecharger-logos.js
```

Vous pouvez aussi déposer vos propres fichiers (`nom-de-la-marque.svg`, `.png` ou `.webp`)
dans `frontend/logos/`, puis faire Ctrl+F5 dans le navigateur.

## Commandes utiles

| Action | Commande |
|---|---|
| Arrêter | `docker compose down` |
| Redémarrer | `docker compose up -d` |
| Voir les logs | `docker compose logs --tail=50 app` |
| Réinitialiser le mot de passe | `docker compose exec app node reset-password.js` |
| Mettre à jour | `git pull` puis `docker compose up --build -d` |

## Sauvegarde

Les données sont dans le volume Docker `depensio-data`. Ne lancez jamais
`docker compose down -v` : l'option `-v` supprime ce volume et donc toutes vos données.

## Sécurité

- Accès protégé par mot de passe, en HTTPS local.
- Conçu pour un usage personnel sur votre machine. Pour l'exposer sur Internet,
  ajoutez un nom de domaine, un vrai certificat et durcissez la configuration.

## Licence

SAWICKI Sergueï
