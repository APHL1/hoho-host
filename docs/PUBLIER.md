# Publier HoHoHost — pas à pas (pour APHL1)

## 1. Créer le dépôt
1. Sur github.com connecté en **APHL1** : **New repository** → nom `hoho-host`, **Public**, ne coche rien (pas de README, pas de licence : ils sont déjà dans le projet).

## 2. Envoyer les fichiers
- **Option A** : donne accès à Claude, il pousse le code.
- **Option B** (GitHub Desktop) : File → Add local repository → dossier `hoho-host` → « create a repository » → Publish.
- **Option C** (Terminal) :
  ```bash
  cd hoho-host
  git init -b main && git add . && git commit -m "HoHoHost 1.0.0"
  git remote add origin https://github.com/APHL1/hoho-host.git
  git push -u origin main
  ```

## 3. Première version
1. Onglet **Releases** → **Draft a new release** → **Choose a tag** : tape `v1.0.0` → « Create new tag ».
2. Titre `HoHoHost 1.0.0`, colle le contenu de `CHANGELOG.md` → **Publish release**.
3. Onglet **Actions** : le workflow « Build & publish Docker image » tourne (~5 min). Il doit finir en vert ✅.

## 4. Rendre l'image publique (une seule fois)
Profil APHL1 → **Packages** → `hoho-host` → **Package settings** → **Change visibility** → **Public**.
Sans ça, personne (ni ton Unraid) ne peut télécharger l'image.

## 5. Tester sur ton Unraid
Docker → **Add Container** → en bas **Template URL** :
`https://raw.githubusercontent.com/APHL1/hoho-host/main/templates/hoho-host.xml`
→ Apply → ouvre le WebUI → assistant de démarrage.

## 6. Soumettre au store Unraid (Community Applications)
Le dépôt contient déjà ce qu'il faut : `LICENSE`, `ca_profile.xml` à la racine, `templates/hoho-host.xml`.
1. Va sur https://ca.unraid.net/submit (connexion avec ton compte Unraid/forum).
2. Indique l'URL du dépôt `https://github.com/APHL1/hoho-host`, lance **Validate** puis **Scan**, et soumets.
3. Conseillé : créer un fil de support sur le forum Unraid (section *Docker Containers*) et remplacer `<Support>` dans le template + ajouter `<Forum>` dans `ca_profile.xml`.

## 7. Store CasaOS / ZimaOS (facultatif)
Proposer `casaos/docker-compose.yml` en pull request sur le dépôt `IceWhaleTech/CasaOS-AppStore` (dossier `Apps/HoHoHost/` + icône + captures), en suivant leur guide de contribution.

## Mises à jour suivantes
Modifier le code → créer une nouvelle release `v1.0.1`, `v1.1.0`… → l'image `latest` est reconstruite automatiquement. Penser à mettre à jour `version` dans `package.json` et `CHANGELOG.md`.
