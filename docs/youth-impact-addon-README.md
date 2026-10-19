# Youth Impact — site web (refonte)

Site statique : HTML + CSS + un peu de JavaScript. **Aucune étape de build, aucune dépendance.**

## Lancer / déployer
- En local : `python3 -m http.server 8000` puis http://localhost:8000
- Vercel / Netlify / GitHub Pages : déposer le dossier tel quel (pas de commande de build).

## Structure
- `index.html` — tout le contenu (sections dans l'ordre du site d'origine)
- `css/styles.css` — jetons de marque en haut du fichier (:root), puis composants
- `js/main.js` — menu mobile, section active, fiche événement, formulaire
- `assets/fonts` — Funnel Display, Funnel Sans, Unbounded (licence OFL incluse)
- `assets/logos` — les logos officiels du kit (non modifiés)
- `assets/patterns` — Msamer, Arches, Faisceau (fichiers du kit)
- `assets/img` — photos en duotone Nuit (voir ci-dessous)

## À compléter
1. `assets/youth-impact-media-kit.pdf` : le lien « Consulter le media kit » le cherche (le fichier n'était pas dans l'archive du site d'origine).
2. Photos : le dossier `11_Photos` du kit était vide ; les photos utilisées viennent du guide de marque (camps / AG de l'association). Vérifier l'accord écrit (parents si mineur), puis remplacer par les photos de votre choix (mêmes noms de fichiers, format portrait 3:5 ou 4:5).
3. Données des clubs : dates, lieux, tarifs, responsables, Instagram… (toujours « à confirmer / à renseigner », comme sur le site d'origine). Les textes de chaque fiche sont dans les attributs `data-*` de chaque `<article class="ticket">`.
4. `<meta name="robots" content="noindex, nofollow">` est conservé du site d'origine : à retirer au lancement.
5. Adresse de contact et envoi du formulaire : le formulaire valide les champs mais n'envoie rien (comportement d'origine).
