# Țomapant

Jocul clasic cu foaia de hârtie (Țări, Orașe, Munți, Ape, Plante, Animale, Nume, Total), jucat online între 2 și 5 prieteni, fiecare pe telefonul lui. Totul este într-un singur fișier: `tomapant.html`.

## Cum se joacă

1. Deschide `tomapant.html` pe fiecare telefon (sau linkul paginii, dacă este găzduită).
2. Un jucător apasă „Creează o cameră” și le trimite celorlalți codul de 5 caractere.
3. Ceilalți apasă „Intră într-o cameră” și scriu codul.
4. Gazda alege setările și apasă „Începe jocul”.

Conexiunea este directă între telefoane (WebRTC prin PeerJS). Singurele servere folosite sunt serverul public de semnalizare PeerJS și servere STUN publice. Unele rețele mobile blochează conexiunile directe; în acest caz încercați pe Wi-Fi.

## Structura proiectului

- `tomapant.html`: fișierul final, gata de folosit (generat de `npm run build`).
- `src/engine.js`: normalizare, căutare în dicționar, reguli de literă, declinări, punctaj.
- `src/app.js`: transportul (PeerJS sau BroadcastChannel pentru teste), logica gazdei, oglinda oaspetelui, interfața.
- `src/styles.css`, `src/template.html`: aspectul paginii.
- `data/*.txt`: dicționarul, un fișier pe categorie, `Canonic = variantă1 = variantă2` pe linie.
- `data/parts/`: bucățile din care au fost scrise listele (`npm run merge` le combină în `data/*.txt`).
- `scripts/build.js`: verifică datele, le comprimă și asamblează `tomapant.html`.
- `scripts/stats.js`: totaluri și numărători pe literă; iese cu eroare dacă minimele nu sunt atinse.
- `tests/unit.test.js`: teste pentru motor (`npm test`).
- `tests/e2e.js`: un joc complet jucat de Playwright în două file (`?transport=local`), plus o rundă în trei jucători.
- `tests/screenshots.js`: capturi de ecran la 390x844, 360x800 și 1366x768, în modul luminos și întunecat.

## Comenzi

```bash
npm install
npm run merge
npm run stats
npm run build
npm test
npm run e2e
npm run screenshots
```

## Găzduire gratuită pe GitHub Pages

1. Pune `tomapant.html` într-un repository GitHub (de exemplu în rădăcină, redenumit `index.html`).
2. În Settings, Pages, alege ramura și folderul și salvează.
3. După un minut, pagina este disponibilă la `https://<utilizator>.github.io/<repository>/`. Deschide linkul pe ambele telefoane.
