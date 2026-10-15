# galleriaDelVento — Specifica di implementazione

> **Destinatario:** agente di coding (Claude Code) che implementa il progetto.
> **Lingua del codice/commenti e del README:** inglese. **Lingua della UI e dei messaggi:** italiano.
> Questo documento è la fonte di verità. Se una scelta implementativa lo contraddice, vince
> questo file; se è ambiguo su un dettaglio, chiedi prima di inventare.

---

## 1. Obiettivo

Costruire un programma desktop locale che simula una **galleria del vento bidimensionale a scopo
didattico e di curiosità tecnica**, per un solo utente (lo sviluppatore stesso, con buona
cultura tecnica): le grandezze fisiche sono esposte (Re, Ma, risoluzione, τ), le spiegazioni
stanno in tooltip brevi, non c'è una modalità «lezione».

**Le simulazioni sono sempre 2D.** Un modello 3D si importa per *ricavarne sezioni*: l'utente lo
ruota e lo riposiziona nella camera di prova, **scorre il piano di taglio nella profondità del
modello**, e la galleria simula la sezione corrente, aggiornandosi dal vivo mentre il piano si
sposta.

Il programma deve:

1. **Importare modelli 3D** (STL, OBJ) di oggetti qualsiasi: veicoli, ali e droni, ciclisti e
   persone (scansioni dense, spesso non chiuse), edifici e oggetti generici. Dimensioni tipiche
   da 5 cm a 50 m, da 1.000 a 2.000.000 di triangoli.
2. **Ricavare profili 2D** da quattro fonti, tutte convergenti nello stesso modello dati (§7.1):
   - **sezione** di un modello 3D, con scorrimento in profondità e rotazione del modello dal vivo;
   - **foto di uno schizzo a mano** (contorno su foglio bianco, §8);
   - **file SVG / DXF**;
   - **editor interno** a punti di controllo e spline (anche per ritoccare i profili importati).
3. Simulare il flusso **in tempo reale sulla GPU** (Lattice Boltzmann D2Q9 in shader WebGL2,
   §10): l'utente sposta, ruota, cambia sezione e velocità mentre il flusso evolve.
4. Mostrare: visualizzazione del flusso (fumo, particelle, linee di flusso, campi colorati,
   vortici), **forze e coefficienti** (Cd, Cl, Cm, Cl/Cd, Strouhal), **mappa di pressione sul
   contorno** (Cp), e permettere **serie, confronto tra studi ed esportazione** (PNG, video
   WebM, CSV, VTK, report PDF).

Il valore del programma sta nel far *vedere e capire* il flusso, non nel sostituire una CFD da
progetto. La precisione attesa è quella di §9.5: corretta nei casi di validazione a basso
Reynolds, indicativa oltre.

### Non-obiettivi (v1)

- **Nessuna simulazione 3D**, in nessuna forma: niente solutore 3D, niente voxelizzazione,
  niente forze sull'oggetto 3D intero. Decisione dell'utente.
- **Nessuna CFD ingegneristica**: niente RANS, niente mesh conformi, niente OpenFOAM. I
  coefficienti a Reynolds reali (10⁵–10⁷) sono indicativi (§2.3, §9).
- **Niente flusso comprimibile**: oltre Mach 0,3 il programma avvisa e non estrapola.
- **Niente moto proprio dell'oggetto** (rotazioni, oscillazioni, flap mobili): l'oggetto si
  sposta e ruota solo a mano.
- **Niente formati CAD solidi** (STEP/IGES), niente glTF/PLY/3MF: solo STL e OBJ.
- **Niente generatore NACA nell'interfaccia** (i profili NACA esistono solo nei test, §18).
- Niente WebGPU, nessuna modalità didattica guidata, nessuna lingua oltre l'italiano.
- Nessuna rete, nessun account, nessun cloud (§2.2).

---

## 2. Invarianti assoluti

Questi tre vincoli prevalgono su qualunque altro requisito: se una funzionalità li violasse, la
funzionalità si taglia.

### 2.1 I file dell'utente non si toccano

**Modelli, foto, SVG e DXF dell'utente non vengono mai modificati, spostati, rinominati o
cancellati.**

1. **L'import passa sempre da un upload** (`<input type=file>` o trascinamento sulla finestra):
   il backend riceve i *byte* del file, non il suo percorso. Il file originale non è quindi
   raggiungibile dal backend in scrittura, per costruzione.
2. Il contenuto ricevuto viene **copiato nella libreria dell'app** (§14) e conservato *tale e
   quale* come `originale.<ext>` (con SHA-256 registrato). Riparazioni, scala, orientamento e
   decimazione producono **file derivati** accanto alla copia, mai al posto della copia.
3. **Guardia centrale di scrittura** `safety.assert_writable(path)`, chiamata da *ogni*
   funzione che apre un file in scrittura: consente solo percorsi dentro le cartelle XDG
   dell'app (`config.py`); confronto su `Path.resolve()` (i symlink non la aggirano), controllo
   anche del genitore. Un tentativo bloccato è un **difetto**: log a livello ERROR e risposta
   409.
4. Le esportazioni non scrivono su disco lato server fuori dall'app: arrivano all'utente come
   **download** del browser (`Content-Disposition: attachment`). Il PDF si genera in una
   cartella temporanea dell'app e poi si serve come download (§11.6).
5. Test obbligatorio (test 3): un ciclo completo import → riparazione → sezione → studio →
   export su file in una cartella in sola lettura confronta hash e mtime prima e dopo. Il test
   verifica anche che la guardia rifiuti un percorso fuori dalle cartelle dell'app.

### 2.2 Nessuna rete

Nessuna chiamata di rete in uscita, mai: niente telemetria, controllo aggiornamenti, CDN, font
remoti. Tutte le risorse dell'interfaccia sono nel pacchetto. L'invariante vale per **tre
soggetti**: il backend Python, il JavaScript della pagina e **il processo Chrome stesso**
(finestra `--app`, headless per il PDF, headless dei test).

- **Pagina**: header `Content-Security-Policy` con `default-src 'self'`, `connect-src 'self'`,
  `worker-src 'self' blob:`, `img-src 'self' data: blob:`, `media-src 'self' blob:`.
- **Chrome**: lo scaffold lo lancia solo con `--no-first-run --no-default-browser-check`; il
  traffico di servizio di Chrome (component updater, variations, Safe Browsing, sync, metriche)
  va spento aggiungendo in `window.py` (e riusando la stessa lista in `report.py` e nei test)
  almeno `--disable-background-networking`, `--disable-component-update`, `--disable-sync`,
  `--disable-default-apps`, `--disable-extensions`, `--disable-domain-reliability`,
  `--disable-breakpad`, `--no-pings`, `--metrics-recording-only`,
  `--safebrowsing-disable-auto-update`, e come barriera finale
  `--host-resolver-rules="MAP * ~NOTFOUND , EXCLUDE 127.0.0.1"` (nessun nome si risolve tranne
  il loopback). L'elenco esatto va verificato sulla versione di Chrome installata e motivato
  flag per flag in un commento.
- **Test 4**: l'avvio e una sessione 2D completa devono registrare zero tentativi non-loopback,
  sia dal backend (socket intercettati) sia da Chrome (lanciato con la stessa lista di flag più
  `--proxy-server` verso un proxy di registrazione su loopback e `--proxy-bypass-list=<-loopback>`;
  qualunque richiesta che arriva al proxy e non è per l'app è un fallimento). Il test verifica
  anche che l'argv di Chrome contenga i flag obbligatori.

### 2.3 Nessun numero senza il suo contesto

Ogni coefficiente o forza mostrato, salvato o esportato porta con sé **le condizioni in cui è
stato calcolato**: Re reale, **Re simulato**, grandezza di riferimento, risoluzione, stato di
convergenza e, per le sezioni di un modello 3D, **posizione e orientamento del piano di taglio**.
In particolare:

- Quando Re simulato ≠ Re reale, l'interfaccia mostra sempre il badge **«Similitudine
  parziale»** (§9.4) accanto ai numeri, e CSV e report riportano le stesse colonne.
- Le forze sono sempre **per metro di profondità (N/m)** ed etichettate così.
- Per un profilo ricavato da un modello 3D, il badge **«Sezione 2D»** ricorda in un tooltip che la
  sezione si comporta come un oggetto infinitamente esteso nella profondità: niente vortici
  d'estremità, niente flusso che aggira i fianchi. I suoi coefficienti non sono quelli
  dell'oggetto 3D intero.
- Un numero di un caso **non convergente** o **instabile** non si presenta come risultato: è
  marcato «provvisorio» o «non valido».

---

## 3. Vincoli di ambiente (macchina target, verificata il 2026-10-14)

| Voce | Valore |
|---|---|
| OS | Ubuntu 26.04.1 LTS (kernel 7.0.0-38-generic) |
| Sessione grafica | wayland / ubuntu:GNOME |
| CPU | 13th Gen Intel(R) Core(TM) i5-13500H — 16 thread logici |
| RAM | 14.8 GB totali, ~7.1 GB disponibili ora |
| GPU | Intel Corporation Raptor Lake-P [Iris Xe Graphics] (rev 04) — OpenGL 4.6, Mesa 26.0.8 |
| Spazio libero in $HOME | 47G |
| Python di sistema | Python 3.14.4 |
| Python gestiti da uv | cpython-3.12.13, cpython-3.14.4, cpython-3.14.5 |
| uv | uv 0.11.18 |
| Node / npm | v24.21.0 / 11.19.0 |
| Browser | google-chrome, google-chrome-stable, firefox |
| GTK + WebKit per pywebview | sì (Gtk 3 + WebKit2GTK 4.1) |
| Strumenti presenti | desktop-file-validate gtk-update-icon-cache pandoc git |
| Software CFD | nessuno (niente OpenFOAM, ParaView, gmsh) |

**Conseguenze vincolanti:**

- **GPU integrata Intel, niente CUDA**: la simulazione gira in WebGL2 nella finestra Chromium
  (Iris Xe: ~70 GB/s di banda condivisa, stima 150–300 MLUPS in D2Q9).
- **WebGL2 con `EXT_color_buffer_float` è obbligatorio** (texture RGBA32F come render target).
  All'apertura della galleria il frontend lo verifica; se manca mostra «La GPU o il driver non
  supportano il rendering in virgola mobile: la galleria non è disponibile», e libreria, editor,
  sezioni e schizzi continuano a funzionare.
- **C'è Google Chrome**: il percorso normale è la finestra dedicata `--app`; lo stesso Chrome
  in modalità headless genera i PDF (§11.6) ed esegue i test GPU (§18).
- **RAM**: una mesh da 2 M di triangoli occupa ~70 MB nel Web Worker delle sezioni; nessun
  altro carico rilevante.
- **Python 3.12** per l'ambiente del progetto (Numba, usato solo nei test, non supporta 3.14).

---

## 4. Stack tecnologico (vincolante)

Variante dello scaffold: **completa** — server FastAPI, finestra Chromium, interfaccia React,
istanza singola. Motivi: grafica WebGL pesante (Chromium è molto più veloce di WebKitGTK su
canvas e WebGL, e WebKitGTK non garantisce `EXT_color_buffer_float`); una scena Three.js per
orientare e tagliare il modello; 8–9 schermate interattive con stato complesso; upload di file
grandi (fino a 500 MB) con validazione.

### Backend

- **Python 3.12**, ambiente con **`uv`** (`pyproject.toml`, niente `requirements.txt`).
- **FastAPI + uvicorn** (dallo scaffold), **python-multipart** per gli upload.
- **numpy**, **scipy** (spline `splprep`/`splev`, filtri).
- **trimesh** — lettura STL/OBJ, analisi e riparazione della mesh; **fast-simplification** —
  decimazione della mesh di vista.
- **shapely** — operazioni sui poligoni 2D: validità, area, semplificazione, offset.
- **opencv-python-headless** — pipeline dello schizzo fotografato (§8).
- **svgelements** — SVG con trasformazioni e unità; **ezdxf** — DXF.
- Solo sviluppo: **pytest**, **ruff**, **numba** (solutore di riferimento dei test, §10.8).

### Frontend

- **React + TypeScript + Vite + Tailwind + TanStack Query** (dallo scaffold).
- **three** + **@react-three/fiber** + **@react-three/drei** — scena 3D del modello e del piano
  di taglio.
- **WebGL2 diretto** (senza librerie) per il solutore e la sua visualizzazione (§10).
- **Web Worker** per il taglio delle sezioni (§7.2).
- **clipper2-js** — porting TypeScript di Clipper2 (Boost Software License 1.0, compatibile con
  la GPL): unione booleana e risoluzione delle auto-intersezioni per il riparatore automatico
  delle sezioni dal vivo (§7.2). Scelto rispetto a polygon-clipping perché lavora in aritmetica
  intera (robusto sui casi degeneri delle scansioni) ed è più veloce. Prima di installarlo,
  verificare nome esatto del pacchetto npm, manutenzione e licenza; se non convince, chiedere.
- **uPlot** — serie temporali, polari, curve Cp.
- **zustand** — stato locale delle schermate; TanStack Query resta per i dati del server.
- Solo sviluppo: **vitest**, **playwright-core** con il **Chrome di sistema**
  (`channel: 'chrome'`, nessun browser scaricato).
- **Nessuna stringa visibile nei componenti**: tutte in `frontend/src/i18n/it.ts`, via
  `t('chiave')`.

### Dipendenze

- Tutte le dipendenze sono a licenza permissiva (MIT, BSD, Apache-2.0, BSL-1.0) e compatibili con la
  GPL-3.0-or-later del progetto (§20).
- Nessuna dipendenza di sistema oltre a quelle dello scaffold (Chrome/Chromium).
- **Ogni dipendenza aggiunta oltre a questo elenco va chiesta prima** (§21), poi motivata nel
  README.

### Decisioni prese (non riaprirle)

1. **Simulazioni sempre 2D.** Il 3D serve solo a ricavare sezioni; non esiste un solutore 3D.
2. **Lattice Boltzmann D2Q9 su GPU nel frontend**: si implementa bene con shader su griglie
   cartesiane, non richiede mesh conformi (si rasterizza qualunque contorno) e gestisce bene i
   flussi instazionari (scie, vortici di von Kármán). La risposta al mouse deve stare in un
   frame.
3. **Il taglio delle sezioni avviene nel frontend**, in un Web Worker sulla mesh piena: è
   l'unico modo per scorrere la profondità a 60 Hz con il flusso che segue.
4. **Un solo pianificatore fisico nel backend** (§9): il frontend non calcola mai τ, Δx, Δt o Re
   simulato da solo.
5. **Import solo via upload** (§2.1): niente dialoghi file nativi, niente percorsi.
6. **Studi salvati come file**, non in un database: niente SQLite, niente coda di job.
7. **Uso personale**: interfaccia da strumento, tooltip brevi, niente modalità lezione.
8. **Licenza GPL-3.0-or-later**: il progetto andrà su GitHub e deve restare open source.

---

## 5. Architettura

```
galleriaDelVento/
├── backend/gdv/
│   ├── __main__.py, runtime.py, config.py, controls.py, security.py,
│   │   server.py, window.py, single_instance.py      ← dallo scaffold
│   ├── safety.py              guardia di scrittura (§2.1)
│   ├── settings.py            impostazioni persistenti (§14.3)
│   ├── api/                   router FastAPI, uno per area; registrati in server.py
│   │   ├── routes_models.py   import/elenco/dettaglio/riparazione, mesh binaria
│   │   ├── routes_profiles.py profili 2D: CRUD, validazione, SVG/DXF
│   │   ├── routes_sketch.py   pipeline foto dello schizzo
│   │   ├── routes_cases.py    pianificatore: CaseSetup → CasePlan
│   │   ├── routes_studies.py  studi, serie, confronto, esportazioni
│   │   └── routes_settings.py
│   ├── library/               libreria di modelli, profili, foto (file su disco, §14)
│   ├── geometry/
│   │   ├── mesh_import.py     STL/OBJ → mesh, unità, referto
│   │   ├── mesh_repair.py     riparazioni non distruttive
│   │   ├── mesh_binary.py     mesh → formato binario per il frontend (§7.2)
│   │   ├── profile.py         Profile2D (contratto) + validazione
│   │   ├── raster2d.py        Profile2D → maschera (riferimento, §10.3)
│   │   ├── spline.py          spline chiuse, adattamento ai punti
│   │   ├── svg_import.py, dxf_import.py
│   │   └── sketch/            paper.py, binarize.py, contour.py, pipeline.py (§8)
│   ├── physics/
│   │   ├── fluids.py          proprietà di aria e acqua in funzione di T
│   │   ├── planner.py         CaseSetup → CasePlan (§9)
│   │   └── coefficients.py    forze reticolari → coefficienti → forze reali
│   ├── lattice.py             costanti D2Q9 + matrice MRT (fonte unica, §10.2)
│   └── studies/
│       ├── store.py           salvataggio/lettura studi
│       ├── export_csv.py, export_vtk.py
│       └── report.py          PDF via Chrome headless
├── frontend/src/
│   ├── pages/    Library, ModelSetup, ProfileEditor, SketchWizard,
│   │             Tunnel, Studies, Compare, Report, Settings
│   ├── section/  slicer.worker.ts, slicer.ts (indice + taglio), loops.ts
│   ├── sim2d/    gl.ts, shaders/*.glsl, solver.ts, mask.ts, forces.ts,
│   │             render.ts, smoke.ts, particles.ts, streamlines.ts, probes.ts,
│   │             series.ts, lattice.generated.ts
│   ├── scene3d/  ModelScene, ModelMesh, CutPlane, RotateGizmo
│   ├── charts/   TimeSeries, Polar, CpCurve, DepthCurve (uPlot)
│   ├── lib/      api.ts, types.ts
│   └── i18n/it.ts
├── scripts/gen_lattice_ts.py  genera sim2d/lattice.generated.ts da gdv/lattice.py
└── tests/
    ├── reference/lbm2d.py     solutore di riferimento in Numba (§10.8)
    └── … (pytest) + frontend/tests/ (vitest, playwright)
```

### Principio architetturale non negoziabile

**Tre contratti, e solo tre, attraversano i sottosistemi:**

1. **`Profile2D`** (§7.1) — prodotto da *tutte* le fonti (sezione, foto, SVG, DXF, editor),
   consumato da solutore, editor ed export. Nessuna fonte ha un percorso privilegiato verso il
   solutore: anche la sezione dal vivo produce un `Profile2D` (in memoria) a ogni taglio.
2. **`CaseSetup` → `CasePlan`** (§9) — il `CaseSetup` è fisico (m/s, metri, °C, scelto
   dall'utente); il `CasePlan` è reticolare (τ, Δx, Δt, U_lat, griglia, contorni) ed è prodotto
   **solo** da `physics/planner.py`. Il solutore consuma solo un `CasePlan`.
3. **`SimulationResult`** (§11.1) — coefficienti, serie temporali, campi, condizioni (§2.3).
   Studi, serie, confronto ed export lavorano solo su questo.

Sono modelli Pydantic nel backend, con i tipi TypeScript in `frontend/src/lib/types.ts`; il
test 5 confronta i nomi e i tipi dei campi.

---

## 6. Modelli 3D: import, riparazione, orientamento

### 6.1 Import

- Formati: **STL** (binario e ASCII) e **OBJ** (gruppi e oggetti multipli: si uniscono in una
  sola mesh; i materiali `.mtl` si ignorano). Un file illeggibile dà «Il file non sembra un
  STL/OBJ valido» con il dettaglio tecnico in «Dettagli».
- Upload fino a **500 MB** e **2.000.000 di triangoli**. Oltre, rifiuto con il numero reale
  («3,4 milioni di triangoli: il limite è 2 milioni; decima il modello in Blender»).
- La copia in libreria è **identificata dallo SHA-256**: reimportare lo stesso file propone di
  aprire quello già presente invece di duplicarlo.

### 6.2 Unità e scala

STL e OBJ non hanno unità. Dopo l'import un dialogo chiede le unità del file, con una proposta
pre-selezionata in base all'estensione massima `E` del bounding box:

| `E` nei numeri del file | Proposta |
|---|---|
| > 200 | millimetri |
| 20–200 | centimetri |
| ≤ 20 | metri |

Opzioni: mm, cm, m, pollici, oppure **«Lunghezza reale»**: l'utente scrive la lunghezza vera di
un asse (es. «lunghezza dell'auto 4,35 m») e la scala si ricava da lì. Il dialogo mostra le
dimensioni risultanti in metri prima di confermare. La scala si può cambiare in seguito.

### 6.3 Controlli e riparazione

All'import si calcola e si mostra un **referto della mesh**: triangoli, vertici, chiusura
(watertight), spigoli non-manifold, facce degeneri, vertici duplicati, normali incoerenti,
componenti connesse, buchi (numero e perimetro del più grande).

Riparazioni proposte, ognuna con un interruttore e attive di default salvo dove indicato:
unione dei vertici duplicati, rimozione delle facce degeneri, orientamento coerente delle
normali, chiusura dei buchi con perimetro < 5% della diagonale del bounding box, rimozione delle
componenti con meno dello 0,1% dei triangoli (**disattivata di default**: potrebbero essere
specchietti o antenne).

**Chiusura dei buchi scritta a mano** (`mesh_repair.py`): `trimesh.repair.fill_holes` chiude
solo buchi di 3–4 spigoli, quindi non basta. Si estraggono gli anelli di bordo (spigoli usati
da una sola faccia), si proietta ciascuno sul suo piano medio (PCA) e lo si triangola con
ear-clipping, con le normali coerenti alle facce adiacenti. Se la proiezione si
auto-interseca, il buco resta aperto e il referto lo dice. Nessuna dipendenza nuova.

**Una mesh non chiusa non blocca nulla**: le sezioni gestiscono i varchi (§7.2). Il referto
segnala però che i tagli potrebbero risultare aperti in alcuni punti.

### 6.4 Sistema di riferimento della galleria

- **x** = direzione del vento (verso valle), **y** = profondità (laterale), **z** = verticale
  verso l'alto. Unità: metri.
- Il modello ha un **orientamento di base**, fissato nella preparazione: pulsanti ±90° sui tre
  assi, «L'asse alto del file è Y» (modelli da Blender), «Appoggia al pavimento» (minimo z a 0,
  con luce a terra impostabile). È salvato in `modello.json`.
- Sopra l'orientamento di base, nella galleria agiscono **tre rotazioni del caso**, che non
  modificano il modello (§7.2): rotazione attorno alla normale del piano di taglio
  (= **incidenza** del profilo), e le due rotazioni attorno agli altri assi (che cambiano la
  forma della sezione).

### 6.5 Tipo di studio (preimpostazioni)

Alla preparazione l'utente sceglie un tipo, che imposta solo i *default* (tutti modificabili):

| Tipo | Piano di taglio | Pavimento | Ingresso | Velocità | Lunghezza di riferimento | Bloccaggio max (§9.2) |
|---|---|---|---|---|---|---|
| Veicolo | verticale (x–z), a metà larghezza | mobile (= V) | uniforme | 30 m/s | lunghezza lungo x | 8% |
| Ala / drone | verticale (x–z), al 40% dell'apertura | nessuno | uniforme | 15 m/s | corda | 5% |
| Persona / ciclista | verticale (x–z), a metà | mobile | uniforme | 12 m/s | altezza frontale | 8% |
| Edificio — pianta | orizzontale (x–y), a 1/3 dell'altezza | nessuno | uniforme | 10 m/s | larghezza frontale | 8% |
| Edificio — prospetto | verticale (x–z), a metà larghezza | fisso | strato limite | 10 m/s (a 10 m di quota) | altezza | 8% |
| Generico | verticale (x–z), a metà | nessuno | uniforme | 10 m/s | altezza frontale | 5% |

Motivo dei due valori di bloccaggio: con il 5% su corpi tozzi o allungati gran parte delle
celle finisce in aria libera; l'8% dà circa il 25% di celle in più sul corpo, e per questi tipi
i coefficienti sono comunque indicativi. Ali e generico restano al 5% perché i casi di
validazione (test 22–24) sono di quel tipo.

### 6.6 Vista

La scena 3D mostra il modello con le normali lisciate, la camera di prova (scatola trasparente
con pavimento quadrettato in metri e freccia del vento) e il piano di taglio. Sopra i 500.000
triangoli si usa una **mesh di vista decimata** (il taglio usa sempre la mesh piena).
Navigazione orbitale; viste rapide frontale/laterale/dall'alto/isometrica.

---

## 7. Profili 2D

### 7.1 Il contratto `Profile2D`

```python
class Loop(BaseModel):
    points: list[tuple[float, float]]  # metres, closed (last != first), ≥ 3 points
    # orientation normalised on save: outer boundaries CCW, holes CW

class Profile2D(BaseModel):
    id: str                       # uuid4
    name: str
    loops: list[Loop]             # one or more solid bodies, possibly with holes
    source: ProfileSource         # kind: section3d | photo | svg | dxf | editor
                                  # + the parameters needed to reproduce it
    spline: SplineData | None     # control points, if editable as a spline
    created_at: datetime
    schema_version: int = 1
```

- Coordinate in **metri** nel piano del flusso: **x** lungo il vento a incidenza zero, **y**
  verso l'alto del piano.
- **Più corpi** sono permessi (un'ala a più elementi, le ruote in una sezione d'auto). I buchi
  interni chiusi restano solidi ai fini del flusso, e corpi che si sovrappongono si uniscono
  (regola della maschera in §10.3). I buchi restano nel `Profile2D` (per l'editor e l'export
  DXF/SVG) ma il solutore li ignora.
- Validazione (`profile.validate`): ogni anello semplice (niente auto-intersezioni, con
  shapely), area > 0, punti consecutivi a distanza > 10⁻⁶ m; al massimo 50 anelli e 20.000
  punti in totale. Anelli non validi si riparano con `shapely.make_valid` solo dopo conferma,
  mostrando il prima e il dopo. Il frontend ha una validazione equivalente e più veloce per le
  sezioni dal vivo (test 9).
- Per `section3d`, `source` contiene: id del modello, orientamento di base, le tre rotazioni
  del caso, tipo di piano e profondità. Riaprire il profilo ripristina il taglio esatto.

### 7.2 Sezione di un modello 3D, dal vivo

Questa è la funzione centrale del flusso 3D → 2D.

**Piano di taglio.** Il piano contiene sempre la direzione del vento ed è di due tipi:
**verticale** (x–z, normale lungo y: profilo laterale di un'auto, sezione di un'ala a una
stazione dell'apertura, sagoma di un ciclista) oppure **orizzontale** (x–y, normale lungo z:
pianta di un edificio). Ogni altra giacitura si ottiene **ruotando il modello**, non il piano.

**Controlli nella galleria** (pannello «Modello 3D», visibile quando il profilo viene da un
modello):

- **Profondità**: slider in metri e in % dell'estensione del modello lungo la normale, rotella
  del mouse sopra lo slider, tasti PagSu/PagGiù (passo 1%, Shift 0,1%). **Il flusso continua**
  mentre la sezione cambia: la maschera si aggiorna a ogni nuovo taglio (§10.3).
- **Rotazioni**: incidenza (attorno alla normale del piano: frecce ±0,5°, Shift ±5°, o
  trascinando il profilo nella galleria) e le altre due rotazioni (slider ±180° e gizmo nella
  mini-scena 3D). L'incidenza ruota solo il profilo già tagliato; le altre due cambiano la
  sezione.
- **Posizione** del profilo nella camera (trascinamento nella galleria) e quota rispetto al
  pavimento.
- Una **mini-scena 3D** (richiudibile, nell'angolo) mostra il modello, il piano e la traccia
  della sezione, sincronizzati con i controlli.
- «**Salva sezione come profilo**» crea un `Profile2D` persistente (per l'editor, il confronto,
  le serie).

**Taglio nel Web Worker** (`section/slicer.worker.ts`):

1. All'apertura il frontend scarica la **mesh piena** in formato binario
   (`GET /api/models/{id}/mesh.bin`: header JSON di lunghezza fissa + vertici float32 + indici
   uint32, già scalati e con l'orientamento di base applicato) e la passa al worker come
   `Transferable`.
2. **Indice**: per la direzione normale corrente, il worker calcola per ogni triangolo il
   minimo e il massimo della coordinata lungo la normale e ordina i triangoli per minimo
   (con il massimo cumulativo per scartare in fretta). Si ricostruisce solo quando cambia una
   delle due rotazioni che alterano la sezione, al rilascio del controllo; durante il
   trascinamento di quelle rotazioni si taglia su un sotto-campione della mesh (≤ 200.000
   triangoli) e si ritaglia sulla mesh piena al rilascio.
3. **Taglio**: solo i triangoli che attraversano il piano → segmenti → anelli chiusi per
   concatenazione degli estremi (hash spaziale, tolleranza 10⁻⁶ × diagonale).
4. **Varchi** (mesh non chiusa): estremi liberi a distanza < 1% della dimensione della sezione
   si uniscono; i segmenti che restano aperti si scartano e si evidenziano in rosso nella vista,
   con l'avviso «La sezione ha aperture: parte del contorno è stata ignorata».
5. Semplificazione Douglas–Peucker a **metà cella** della griglia corrente (i dettagli più
   piccoli non sono visibili al solutore), poi conversione nelle coordinate del piano e
   costruzione del `Profile2D` in memoria.
6. **Riparatore automatico** (sempre attivo sulle sezioni dal vivo): con le scansioni un
   taglio può dare anelli auto-intersecanti o sovrapposti. Il worker esegue la validazione
   veloce (test 9). Se fallisce, ripara con clipper2-js: unione di tutti gli anelli con
   regola di riempimento NonZero, poi scarto delle schegge con area < 4 celle. La sezione
   riparata entra subito nel flusso, e accanto ai numeri compare il badge **«Contorno riparato
   automaticamente»**. Una sezione dal vivo non blocca mai il flusso per invalidità.
   La conferma con il prima e il dopo di §7.1 resta, ma **solo al salvataggio** («Salva
   sezione come profilo», «Salva studio»): il dialogo mostra il taglio grezzo e quello
   riparato. «Salva» registra la versione riparata (validata di nuovo da `profile.validate` nel
   backend), «Annulla» non salva nulla.
7. Ogni taglio è etichettato con un numero di sequenza; il thread principale scarta i risultati
   superati, così lo scorrimento veloce non accoda lavoro.

**Casi limite**: piano che non taglia il modello → la galleria resta vuota con la scritta «Il
piano non taglia il modello a questa profondità» e il flusso continua indisturbato; sezione
fatta di centinaia di frammenti minuscoli (es. capelli di una scansione) → si scartano gli
anelli con area < 4 celle, dicendo quanti.

**Nessun calcolo 3D**: il backend non taglia mai la mesh durante l'uso. La correttezza del
worker si verifica con vitest su casi analitici (test 8).

### 7.3 Import SVG

- `svgelements` con trasformazioni applicate. Si leggono `path`, `polygon`, `polyline`,
  `rect`, `circle`, `ellipse`; i tratti aperti si chiudono se il varco è < 0,5% della
  dimensione del disegno, altrimenti si scartano con un avviso che dice quanti.
- Curve appiattite con tolleranza 0,05% della dimensione del disegno.
- Scala: se il file ha unità fisiche (`width="120mm"`) si propongono quelle; altrimenti si
  chiede la lunghezza reale come per lo schizzo (§8.5). L'asse y dell'SVG va verso il basso: si
  ribalta.

### 7.4 Import DXF

- `ezdxf`: `LWPOLYLINE`, `POLYLINE`, `LINE`, `ARC`, `CIRCLE`, `ELLIPSE`, `SPLINE` dal model
  space; le entità sciolte si concatenano per estremi coincidenti (tolleranza 10⁻⁶ ×
  dimensione). Unità da `$INSUNITS` se presente, altrimenti si chiede.
- Blocchi (`INSERT`) esplosi; layer spenti, testi e quote ignorati.

### 7.5 Editor

- Ogni anello è una **spline chiusa** (Catmull–Rom centripeta, campionata adattivamente:
  errore di corda ≤ 0,02% della dimensione) oppure una **polilinea** (spigoli vivi); ogni punto
  di controllo può essere marcato «spigolo».
- Azioni: aggiungi/sposta/elimina punto, nuovo anello, elimina anello, **modalità simmetrica**
  rispetto alla linea di corda (modifichi la metà superiore, l'inferiore segue), scala con
  valore numerico, ruota, griglia con aggancio opzionale, righello.
- **«Rendi modificabile»**: un profilo importato (sezione, foto, SVG, DXF) diventa spline
  adattando N punti di controllo ai minimi quadrati (N scelto dall'utente, default 24 per
  anello; errore massimo mostrato in mm).
- **Annulla/Ripeti** almeno 100 passi (Ctrl+Z / Ctrl+Shift+Z), anche in modalità simmetrica.
- Il profilo modificato si salva come **nuovo** profilo di default («Salva come…»);
  sovrascrivere richiede «Salva» esplicito. Il profilo di origine è registrato in `source`.
- Accanto al disegno: corda, spessore massimo e sua posizione, area, perimetro, aggiornati a
  ogni modifica.
- «Apri in galleria» porta il profilo nella galleria con l'ultimo caso usato.

---

## 8. Foto di uno schizzo → profilo

Scenario: l'utente disegna a penna o matita il **contorno** di una forma su un foglio bianco, lo
fotografa con il telefono e lo importa. Procedura guidata in 4 passi, con anteprima sovrapposta
alla foto e ogni parametro regolabile.

### 8.1 Ingresso

- **JPEG, PNG, WebP** fino a 40 MB; orientamento EXIF rispettato. (HEIC: vedi §22.)
- Elaborazione su una copia ridotta a **2000 px** sul lato lungo; la foto è copiata in libreria
  (§2.1) e mai modificata.

### 8.2 Passo 1 — Foglio e prospettiva

- Ricerca del foglio: scala di grigi → sfocatura gaussiana → Canny + chiusura morfologica →
  quadrilatero più grande (`approxPolyDP`) con area > 20% dell'immagine.
- I **4 angoli** sono maniglie trascinabili. Se il foglio non si trova, partono dagli angoli
  dell'immagine.
- Raddrizzamento con omografia; rapporto d'aspetto: se è entro il ±5% di √2 si usa quello
  dell'A4/A3, altrimenti quello stimato dai lati.

### 8.3 Passo 2 — Pulizia e binarizzazione

- Appiattimento dell'illuminazione: divisione per lo sfondo stimato con una sfocatura di raggio
  pari al 5% della larghezza (rimuove ombre e gradienti).
- Soglia adattiva (gaussiana, blocco ~3% della larghezza), poi chiusura morfologica che salda i
  varchi del tratto fino allo slider «Chiusura varchi» (default 1% della larghezza).
- Rimozione delle macchie: componenti con area < 0,05% del foglio.

### 8.4 Passo 3 — Contorno

- Il tratto è una linea, non una sagoma piena: si **riempie la regione racchiusa** (flood fill
  dall'esterno; l'interno è ciò che non viene raggiunto), si prende il bordo della regione e lo
  si sposta verso l'esterno di **mezzo spessore del tratto** (stimato con la trasformata
  distanza), così il profilo cade sulla linea mediana del tratto.
- Se nessuna regione chiusa supera l'1% del foglio, il tratto è aperto: si evidenziano in rosso
  gli estremi liberi più vicini con la loro distanza e si propongono «Aumenta chiusura varchi»
  o «Chiudi nell'editor».
- Più regioni chiuse: si selezionano con un clic (default la più grande) e diventano più anelli
  dello stesso profilo.
- Lisciatura: spline periodica `splprep` con slider «Morbidezza» (default tarato perché il
  tremolio della mano < 0,5% della lunghezza sparisca), poi ricampionamento a 400 punti con
  densità proporzionale alla curvatura.

### 8.5 Passo 4 — Scala e orientamento

- Scala: **lunghezza lungo il vento** (si scrive, es. «corda 1,2 m») oppure **due punti sulla
  foto + distanza reale**.
- Orientamento: freccia del vento ruotabile sul disegno (default da sinistra a destra) e
  «ribalta verticalmente».
- Risultato: `Profile2D` con `source = photo` (SHA-256 della foto, angoli, tutti i parametri):
  riaprire la procedura dal profilo ripristina lo stato dei 4 passi.

### 8.6 Reattività

Ogni modifica di uno slider o di una maniglia aggiorna l'anteprima in ≤ 400 ms (§17); le
richieste superate si annullano.

---

## 9. Fisica e similitudine

### 9.1 `CaseSetup` (fisico, scelto dall'utente)

| Campo | Unità | Default / campo ammesso |
|---|---|---|
| `profile` | — | `Profile2D` (salvato o sezione dal vivo) + posizione nella camera |
| `fluid` | — | `aria` (default) \| `acqua` |
| `temperature_c` | °C | 20; aria −20…50, acqua 5…40 |
| `speed` | m/s | dal tipo di studio; 0,1…120 (l'UI accetta anche km/h) |
| `angle_deg` | ° | 0; incidenza −90…90 |
| `ground` | — | `none` \| `fixed` \| `moving` |
| `inlet_profile` | — | dal tipo di studio (§6.5); `uniform` \| `boundary_layer` (legge di potenza, esponente 0,16, quota di riferimento 10 m, dove la velocità vale `speed`; solo con pavimento) |
| `domain` | m | dimensioni della camera (§9.2) |
| `resolution` | — | preset (§10.5) |
| `reference_length` | m | §9.6 |

**Proprietà del fluido** (`physics/fluids.py`): aria come gas ideale a 101.325 Pa con viscosità
di Sutherland (20 °C → ρ = 1,204 kg/m³, ν = 1,516·10⁻⁵ m²/s); acqua da tabella interpolata
(20 °C → ρ = 998,2 kg/m³, ν = 1,004·10⁻⁶ m²/s). Test 19.

### 9.2 Dominio predefinito (camera di prova)

Con `L` = estensione del profilo lungo x e `H` = altezza frontale:

- a monte 2·L, a valle 5·L (mai meno di 3·L);
- altezza della camera tale che il **bloccaggio** (H / altezza camera) sia ≤ al valore del
  tipo di studio (§6.5: 5% o 8%), con un minimo di 3·H sopra e sotto l'oggetto (senza
  pavimento) o sopra (con pavimento);
- con il pavimento l'oggetto resta alla quota reale; senza, sta al centro.

**Camera e interazione dal vivo.** La camera non deve ricostruirsi a ogni gesto (vorrebbe dire
nuova griglia e flusso da zero), ma nemmeno dimensionarsi su una sfera d'ingombro 3D, che
dimezzerebbe la risoluzione sui corpi allungati. Regola:

- La camera si dimensiona sull'**ingombro della sezione nel piano alla rotazione e incidenza
  correnti, preso sul massimo lungo tutta la profondità** (per un modello 3D: estensione del
  modello lungo x e lungo l'asse verticale del piano, per tutte le profondità).
- **Profondità** e **posizione**: non ripianificano mai.
- **Incidenza** e le **due rotazioni fuori piano**: durante il trascinamento la camera resta
  fissa (la parte di oggetto che esce dal dominio si ritaglia, con un contorno rosso). Al
  rilascio si ripianifica **solo se** l'oggetto esce dalla camera o il bloccaggio supera il
  **10%**: in quel caso nuovo piano, nuova griglia e flusso da zero, con il messaggio «Camera
  ridimensionata per la nuova rotazione». Negli altri casi il flusso continua.
- L'utente può allargare o restringere la camera a mano (nuovo piano). Sopra il **10% di
  bloccaggio** compare l'avviso «Le pareti accelerano il flusso: i coefficienti risultano
  gonfiati».

### 9.3 Condizioni al contorno

- **Ingresso**: velocità imposta (equilibrio con la velocità di ingresso e la densità estrapolata
  dall'interno), uniforme o con profilo di strato limite. **Rampa di avvio** sinusoidale da 0 a
  U su `max(1000, 0,5 · T_c)` passi, per non generare onde di pressione.
- **Uscita**: gradiente nullo (copia delle popolazioni entranti dall'ultima colonna interna) più
  una **zona spugna** sull'ultimo 8% del dominio, dove la viscosità sale linearmente fino a 10
  volte, per assorbire le riflessioni.
- **Pareti superiore e inferiore**: scorrimento libero (riflessione speculare), così la camera
  approssima il flusso indisturbato.
- **Pavimento**: `fixed` = rimbalzo no-slip; `moving` = rimbalzo con parete in moto alla
  velocità del vento (nastro trasportatore); `none` = scorrimento libero.
- **Oggetto**: rimbalzo a metà via (*halfway bounce-back*) sulla maschera di celle solide. Le
  condizioni interpolate (Bouzidi) sono un miglioramento possibile solo se la validazione lo
  richiede, da chiedere prima (§22).

### 9.4 Il pianificatore (`physics/planner.py`)

Input `CaseSetup`, output `CasePlan`, via `POST /api/cases/plan`. Passi:

1. `Δx` dalla risoluzione e dal dominio; `L_lat = L_ref / Δx`.
2. Velocità reticolare `U_lat` = 0,08 (Mach reticolare 0,14; limite massimo 0,1).
3. `Re_real = V · L_ref / ν`.
4. `ν_lat` richiesto = `U_lat · L_lat / Re_real`; `τ = 3·ν_lat + 0,5`.
5. Se `τ < τ_min` (punto di partenza: **0,502**, con modello di sottogriglia attivo), si fissa
   `τ = τ_min` e `Re_sim = U_lat · L_lat / ν_lat(τ_min) < Re_real`: **similitudine parziale**. Il
   valore definitivo di `τ_min` si fissa in Fase 3 misurando la stabilità sui casi dei test
   21–25, e va scritto in questo paragrafo.
6. `Δt = Δx · U_lat / V` (secondi reali per passo) e **tempo di attraversamento** in passi.
   Definizione unica in tutto il programma: **`T_c = L_ref / V`**, cioè il tempo convettivo
   sulla lunghezza di riferimento; in passi vale `L_lat / U_lat`. Tutto ciò che è espresso in
   «tempi di attraversamento» (rampa, transitorio, finestre di media, tetto delle serie) usa
   questo `T_c`, non la lunghezza della camera. Questa scelta rende realistico il target di
   5 minuti per la serie di 11 incidenze (§17).
7. Restituisce anche: griglia, contorni, passi per la convergenza attesa, e i testi già pronti
   per l'interfaccia (es. «Re reale 4,1·10⁶ — Re simulato 2,3·10⁴»).

Cambiare sezione (profondità), incidenza o posizione **non** richiede un nuovo piano, salvo il
caso di ridimensionamento della camera al rilascio (§9.2). Lo richiedono velocità, fluido,
temperatura, risoluzione e dimensioni della camera: nuova griglia o nuovo τ, flusso da zero.

**La lunghezza di riferimento non entra in τ.** Poiché `ν_lat = U_lat · L_lat / Re_real =
U_lat · ν / (V · Δx)`, τ dipende solo da fluido, temperatura, velocità e Δx. Un cambio di
`L_ref` produce quindi un nuovo `CasePlan` con **stessa griglia, stesso τ, stessi Δx e Δt**:
cambiano solo Re reale, Re simulato, `T_c` e la normalizzazione dei coefficienti. Il solutore
**non riparte**; si azzerano solo le medie. Il test 18 lo verifica.

**Badge «Similitudine parziale»**: compare quando `Re_sim < 0,95 · Re_real`. Il tooltip spiega in
due righe che scia e distacco sono quelli di un oggetto più piccolo o più lento, e che i
coefficienti valgono come indicazione e confronto tra forme, non come valori assoluti.

**Mach reale** `V / c`: > 0,3 → avviso persistente «Oltre Mach 0,3 la comprimibilità conta: il
modello non ne tiene conto».

### 9.5 Coefficienti e forze

- **Forze** con il metodo dello **scambio di quantità di moto** sui collegamenti fluido–solido.
- Coefficienti: `C = F_lat / (½ ρ_lat U_lat² · L_lat)`. Assi: **Cd** lungo x, **Cl** lungo +y del
  piano, **Cm** (beccheggio) attorno al punto di riferimento (default 25% della corda per le ali,
  centro del bounding box altrimenti), positivo a cabrare.
- **Forze reali**: `F' = ½ ρ V² · L_ref · C`, in **N/m di profondità**.
- **Cp** = `(p − p∞) / (½ ρ U²)` con `p − p∞ = (ρ_lat − ρ∞,lat)/3` in unità reticolari.
- **Media e convergenza**: dopo il transitorio (fine della rampa di avvio + 3 `T_c`, §9.4),
  media su finestre di 1 `T_c`; un caso è **convergente** quando la media di Cd varia < 0,5% tra
  due finestre consecutive (stazionario) o tra due gruppi di 5 periodi di distacco (periodico).
  Fino ad allora i numeri sono «provvisori». Ogni cambio di sezione, incidenza o posizione
  azzera le medie.
- **Strouhal**: FFT di Cl sulla finestra convergente, `St = f · L_ref / V` (in unità simulate);
  mostrato solo se il picco supera di 10 volte il rumore di fondo.
- **Instabilità**: un NaN o una densità fuori da [0,7; 1,3] in qualunque cella (controllo sulla
  piramide di riduzione, §10.4) ferma il calcolo con «La simulazione è diventata instabile» e il
  pulsante «Riprova con Re simulato più basso» (dimezza `Re_sim`). Mai continuare su un campo
  instabile.

### 9.6 Lunghezza di riferimento

Default dal tipo di studio (§6.5): corda (estensione lungo x a incidenza zero), altezza frontale
(estensione lungo y del piano) o larghezza frontale. Durante lo scorrimento in profondità si può
scegliere tra **«della sezione corrente»** (cambia a ogni taglio: i coefficienti descrivono la
forma locale) e **«fissa»** (un valore unico, es. la corda alla radice: i coefficienti si
confrontano tra sezioni). Default: fissa, pari al valore della prima sezione. Il valore usato è
sempre mostrato accanto ai coefficienti (§2.3).

In modalità «della sezione corrente», durante lo scorrimento resta valido il piano in corso.
Al **rilascio** (fine trascinamento dello slider, oppure 300 ms senza tasti PagSu/PagGiù o
rotella) si chiede un nuovo piano con la `L_ref` della sezione corrente. Come detto in §9.4, il
nuovo piano non cambia griglia né τ: il flusso continua, mentre Re, `T_c` e coefficienti si
aggiornano e le medie ripartono.

---

## 10. Solutore 2D su GPU

### 10.1 Schema

- Reticolo **D2Q9**, collisione **MRT** (Lallemand–Luo) con modello di sottogriglia
  **Smagorinsky** (`C_s = 0,1`) applicato al tempo di rilassamento della viscosità. BGK resta
  disponibile solo come opzione di debug e nel riferimento (§10.8).
- **float32** con popolazioni memorizzate come deviazione dal peso a riposo (`f_i − w_i`), per
  ridurre l'errore di arrotondamento.
- Un solo passaggio fuso **stream + collide in schema pull**: ogni frammento legge le 9
  popolazioni dai vicini e scrive le nuove in **3 texture RGBA32F** (12 canali, 9 usati) con
  *multiple render targets*; ping-pong tra due insiemi di texture.
- Più passi per frame (default automatico: tanti quanti stanno in 12 ms di GPU, misurati), poi un
  passaggio di visualizzazione.

### 10.2 Costanti condivise

Velocità del reticolo, pesi, matrice MRT e tempi di rilassamento non idrodinamici sono definiti
**una sola volta** in `gdv/lattice.py`. `scripts/gen_lattice_ts.py` genera
`frontend/src/sim2d/lattice.generated.ts`; il test 20 fallisce se il file generato non
corrisponde.

### 10.3 Maschera dell'oggetto

- Il `Profile2D`, trasformato con posizione e incidenza, si rasterizza in una texture R8: **una
  cella è solida se il suo centro sta dentro almeno un anello esterno** (unione dei corpi,
  buchi riempiti). Gli anelli-buco si ignorano: in 2D un buco chiuso non è raggiungibile dal
  flusso e, lasciato fluido, aggiungerebbe solo rumore alle forze. I corpi sovrapposti (es. una
  ruota che compenetra la carrozzeria) restano solidi anche nella parte comune. Per decidere
  se un anello è esterno o buco: orientamento normalizzato (§7.1) per i profili salvati,
  annidamento (numero di anelli che lo contengono, pari = esterno) per le sezioni dal vivo.
- Due implementazioni identiche: `geometry/raster2d.py` (riferimento) e `sim2d/mask.ts`. Il
  test 10 le confronta cella per cella su 20 profili e trasformazioni salvati come JSON.
- **Aggiornamento dal vivo** (nuova sezione, incidenza, posizione): maschera ricalcolata e
  caricata in ≤ 16 ms (§17). Le celle che passano da solido a fluido si inizializzano
  all'equilibrio con la velocità media dei vicini fluidi; quelle che diventano solide si
  azzerano. Durante uno scorrimento continuo la maschera si aggiorna al massimo una volta per
  frame, con l'ultimo taglio disponibile.

### 10.4 Forze sulla GPU

Lo scambio di quantità di moto si calcola in uno shader per cella e si riduce con una piramide
di riduzione (somme parziali su texture sempre più piccole) fino a 1×1; nella stessa piramide si
calcolano minimo e massimo della densità e il conteggio dei NaN (§9.5). Lettura con
`readPixels` **ogni 8 passi**, asincrona (`fenceSync` + PBO) per non bloccare la GPU.

### 10.5 Risoluzioni

| Preset | Griglia | Uso |
|---|---|---|
| Bozza | 512 × 192 | interazione rapida, scorrimento in profondità |
| Normale (default) | 1024 × 384 | uso tipico |
| Fine | 2048 × 768 | immagini e misure più pulite |

Il rapporto d'aspetto segue il dominio (§9.2); il numero di celle del preset resta quello della
tabella. Cambiare preset riparte da zero.

### 10.6 Visualizzazioni (tasti 1–6)

1. **Modulo della velocità** (mappa sequenziale, default *viridis*).
2. **Pressione / Cp** (mappa divergente centrata su 0).
3. **Vorticità** (mappa divergente; rosso antiorario, blu orario).
4. **Fumo**: scalare passivo immesso da un rastrello di 15 ugelli a monte (numero e posizione
   regolabili), avvezione semi-lagrangiana sulla GPU con leggera diffusione.
5. **Particelle**: fino a 100.000 traccianti avvezionati sulla GPU (RK2), con scia che sfuma.
6. **Linee di flusso**: calcolate in un Web Worker (RK4) dal campo di velocità letto ogni mezzo
   secondo, da 30 punti a monte o da un rastrello disegnato dall'utente.

Si sovrappongono: un campo di sfondo (1–3) + fumo o particelle + linee di flusso. Scala dei
colori automatica con «Blocca scala», e legenda con unità reali.

### 10.7 Strumenti della galleria

- **Avvia/Pausa** (Spazio), **Ricomincia** (R), passo singolo (`.`), velocità di simulazione.
- **Sonde**: clic sul fluido per piazzare fino a 6 sonde con la serie temporale di velocità e
  Cp; trascinabili ed eliminabili.
- **Risultati dal vivo**: Cd, Cl, Cm, Cl/Cd, St con media e deviazione standard, stato
  «provvisorio/convergente», forze reali in N/m, grafico delle serie temporali (uPlot, finestra
  scorrevole di 20.000 passi).
- **Cp sul contorno**: curva Cp(x/c) di dorso e ventre (o lungo il perimetro per i corpi tozzi),
  media nel tempo; contorno del profilo colorato per Cp nella vista.
- **Istantanea** (S): PNG della vista a risoluzione doppia, con legenda e condizioni (§2.3).
- **Registra** (V): video WebM VP9 con `MediaRecorder` dal canvas, 30 fps, fino a 2 minuti, con
  la sovrimpressione delle condizioni. Si può registrare anche uno scorrimento in profondità.

### 10.8 Solutore di riferimento (CPU, solo test)

`tests/reference/lbm2d.py` implementa **lo stesso algoritmo** (stesse costanti da
`gdv/lattice.py`, stessa maschera da `raster2d.py`, stessi contorni, float32) in Numba. Serve
a:

- validare la fisica senza GPU (test 21–24);
- verificare lo shader: il test 25 (playwright + Chrome di sistema) esegue 500 passi su
  256×96 nello shader e nel riferimento e confronta i campi: errore relativo massimo sulla
  velocità < 10⁻³.

---

## 11. Risultati, studi, serie, confronto, esportazione

### 11.1 `SimulationResult`

```python
class SimulationResult(BaseModel):
    case: CaseSetup                     # includes the profile and, for 3D sections, the cut
    plan: CasePlan                      # Re_real, Re_sim, lattice parameters
    status: Literal["converged", "provisional", "unstable"]
    coefficients: Coefficients          # mean and std of Cd, Cl, Cm; Cl/Cd; St
    forces_real: Forces                 # N/m, labelled
    history: TimeSeriesRef              # per-step coefficients (file reference)
    fields: list[FieldRef]              # averaged u, v, p, vorticity (float16, file references)
    contour_cp: ContourCpRef            # Cp along the contour
    created_at: datetime
    app_version: str
    schema_version: int = 1
```

### 11.2 Studi

- Uno **studio** = un `SimulationResult` salvato con nome, note e miniatura. «Salva studio»
  nella galleria invia coefficienti, storia, Cp, i campi medi letti dalla GPU e **3–4 PNG
  istantanei** catturati dal canvas in quel momento: velocità, Cp, vorticità e, se attivo, fumo.
  Vengono resi offscreen alla risoluzione della griglia, con legenda e condizioni. Servono al
  report (§11.6) e al dettaglio dello studio. A differenza dei campi medi, nei flussi periodici
  mostrano anche la scia istantanea.
- Se il profilo dello studio è una **sezione dal vivo** non ancora salvata, «Salva studio» la
  salva automaticamente anche come `Profile2D` in libreria. Il nome è
  «<modello> — sezione <verticale|orizzontale> <profondità in %>», e lo studio punta a quel
  profilo. Se la sezione è stata riparata, vale prima la conferma di §7.2.
- Elenco con filtro per profilo/modello e data; miniatura; stato.
- Eliminare uno studio chiede conferma e dice quanto spazio libera.

### 11.3 Serie (sweep)

Una serie esegue in sequenza sulla GPU più casi che differiscono per un solo parametro, ognuno
fino a convergenza o a un tetto di 20 `T_c` (§9.4), oltre alla rampa. I punti non convergenti si
disegnano vuoti; un punto instabile non ferma la serie.

- **Incidenza** (da, a, passo; default −4…16° passo 2°) → **polari** Cl–α, Cd–α, Cm–α, Cl–Cd,
  Cl/Cd–α.
- **Velocità** → coefficienti in funzione di Re.
- **Profondità** (solo per i modelli 3D; da, a, numero di sezioni; default 11 sezioni dal 5% al
  95%) → curve Cd, Cl, Cm **in funzione della posizione del taglio**, con la miniatura di ogni
  sezione. Il grafico ricorda (§2.3) che sono coefficienti di sezioni 2D indipendenti, non una
  distribuzione 3D.

Una serie è uno studio con più punti; si può fermare a metà tenendo i punti finiti. La serie in
corso blocca i controlli della galleria e mostra il progresso (punto *n* di *N*, tempo stimato);
chiudere la finestra durante una serie chiede conferma (§13).

### 11.4 Confronto

- Fino a **4 studi** affiancati con la stessa scala di colori e lo stesso riquadro.
- Tabella dei coefficienti con differenze in % rispetto al primo studio e le condizioni di
  ciascuno: se Re simulato o lunghezza di riferimento differiscono, la riga lo segnala («i
  coefficienti non sono direttamente confrontabili»).
- Curve Cp, polari e curve in profondità sovrapposte.

### 11.5 Esportazioni

| Formato | Contenuto |
|---|---|
| PNG | vista corrente a risoluzione doppia, con legenda e condizioni |
| WebM | registrazione della vista (§10.7) |
| CSV | storia dei coefficienti; Cp sul contorno; punti delle serie. Separatore `;` e virgola decimale di default (impostazioni) |
| VTK | campi medi come `.vti` (ImageData XML, binario raw appeso), contorno con Cp come `.vtp`; apribili in ParaView. Scritti a mano (`studies/export_vtk.py`), senza dipendenze |
| DXF / SVG | il profilo (anche una sezione), per riusarlo in CAD o Inkscape |
| JSON | lo studio completo (senza campi) per riaprirlo o confrontarlo |
| PDF | report (§11.6) |

Ogni CSV ha in testa le righe di commento con le condizioni (§2.3).

### 11.6 Report PDF

- È una pagina dell'app (`/report/:id`, React) con: titolo, data, profilo (e per le sezioni: la
  miniatura del modello con il piano), condizioni, tabella dei coefficienti, grafici, i PNG
  istantanei salvati con lo studio (`viste/`, §11.2; il report non usa WebGL, perché Chrome
  headless non garantisce WebGL2 con float), avvisi (similitudine parziale, sezione 2D, bloccaggio,
  convergenza).
- `studies/report.py` lancia il Chrome trovato dallo scaffold in headless con `--print-to-pdf`
  su quella pagina (token monouso nell'URL, valido 60 s), in una cartella temporanea dell'app,
  poi lo serve come download e lo cancella.
- Senza Chrome/Chromium: il pulsante dice «Serve Chrome o Chromium per il PDF» e propone di
  aprire il report e usare «Stampa».

---

## 12. Interfaccia

### 12.1 Schermate

1. **Libreria** (home): schede Modelli 3D, Profili 2D, Studi, con miniature, ricerca e
   ordinamento; area di trascinamento «Trascina qui STL, OBJ, SVG, DXF o una foto», che
   riconosce il tipo dal contenuto e apre il flusso giusto; «Importa», «Nuovo profilo».
2. **Preparazione modello 3D**: scena 3D (§6.6); referto e riparazioni, unità e scala,
   orientamento di base, tipo di studio; azione «Apri in galleria».
3. **Editor del profilo**: §7.5.
4. **Foto dello schizzo**: procedura in 4 passi (§8) con «Indietro/Avanti» sempre visibili.
5. **Galleria**: canvas a tutta area; a sinistra le condizioni (fluido, T, velocità, incidenza,
   pavimento, risoluzione, camera, lunghezza di riferimento) e la visualizzazione; con un
   modello 3D, il pannello «Modello 3D» (profondità, rotazioni, mini-scena, §7.2); a destra i
   risultati dal vivo e i grafici (richiudibile); barra in alto con Re reale/simulato, Mach,
   bloccaggio, passi/s e fps, badge di §2.3.
6. **Studi**: elenco, dettaglio, serie, esportazioni.
7. **Confronto**: §11.4.
8. **Report**: anteprima di §11.6.
9. **Impostazioni**: §14.3, più lo spazio occupato dalla libreria.

### 12.2 Scorciatoie

Spazio avvia/pausa · R ricomincia · `.` passo singolo · 1–6 visualizzazione · frecce ±0,5° di
incidenza (Shift ±5°) · PagSu/PagGiù profondità ±1% (Shift ±0,1%) · S istantanea · V registra ·
Ctrl+Z / Ctrl+Shift+Z nell'editor · Esc chiude dialoghi e pannelli. Elenco visibile con `?`.

### 12.3 Requisiti della finestra applicativa

- La navigazione vive tutta dentro l'app: ogni schermata ha un percorso di ritorno visibile.
- Nessuna funzione raggiungibile solo digitando un URL.
- Un errore fatale del frontend non lascia una finestra bianca: messaggio + «Ricarica». Una
  perdita del contesto WebGL (`webglcontextlost`) mostra «La GPU ha interrotto la simulazione»
  con «Riprendi», che ricrea il contesto e riparte dal profilo e dal caso correnti.
- Utilizzabile da **1280×800** in su; i pannelli laterali si richiudono sotto i 1440 px.
- Tooltip brevi (≤ 2 righe) sulle grandezze fisiche: Re, Mach, τ, bloccaggio, Cp, Strouhal,
  similitudine parziale, sezione 2D.
- Tema chiaro e scuro (segue il sistema); le mappe dei colori sono le stesse nei due temi.

### 12.4 Reattività

- Galleria Normale: **≥ 30 fps** e **≥ 300 passi/s** sull'Iris Xe (§17).
- Scorrimento in profondità: nuova sezione nel flusso **entro lo stesso frame o il successivo**
  (taglio ≤ 10 ms + maschera ≤ 16 ms), fps ≥ 30 durante lo scorrimento.
- Cambio di incidenza o trascinamento: il flusso riprende nello stesso frame.
- Schizzo: anteprima entro 400 ms da ogni modifica.

---

## 13. Server locale e finestra (garantiti dallo scaffold)

- Server solo su `127.0.0.1` (porta fissa **8853**), nessuna opzione per esporlo; richieste da
  pagine estranee rifiutate (controllo Host/Origin).
- Istanza singola: il secondo avvio mostra la finestra esistente ed esce con 0; lockfile stantio
  rimosso; porta occupata da altri → errore con l'indicazione di `--port`, mai un'altra porta
  scelta in silenzio.
- Finestra Chromium `--app` con profilo dedicato e identità propria nella dock, lanciata con i
  flag anti-rete di §2.2; senza Chromium,
  scheda del browser + avviso (la galleria funziona solo se il browser ha WebGL2 con
  `EXT_color_buffer_float`).
- Chiudere la finestra chiude il programma; «Esci» nell'interfaccia fa lo stesso.
- **Chiusura con una serie in corso o studi non salvati**: il frontend intercetta la chiusura
  (`beforeunload`) e mostra «C'è una serie in corso (punto 4 di 11): uscire la interrompe. I punti
  finiti restano salvati.» I punti completati di una serie si salvano man mano, quindi un crash
  non perde nulla di finito.
- Upload: limite di 500 MB applicato dal server prima di leggere tutto il corpo.

---

## 14. Dati e persistenza

### 14.1 Cartelle

- Dati: `~/.local/share/galleriadelvento/`
  - `modelli/<sha256[:16]>/originale.stl|obj` (copia intatta), `modello.json` (nome, unità,
    scala, orientamento di base, tipo di studio, riparazioni scelte, referto), `mesh.bin`
    (mesh riparata e trasformata, formato di §7.2), `vista.bin` (decimata, se serve),
    `miniatura.png`;
  - `profili/<uuid>.json` (`Profile2D`) + `<uuid>.png` (miniatura);
  - `foto/<sha256[:16]>.<ext>` (copie delle foto degli schizzi);
  - `studi/<uuid>/studio.json` (`SimulationResult` o serie), `storia.npz`, `campi.npz`
    (float16, compresso), `contorno.npz`, `miniatura.png`, `viste/<velocita|cp|vorticita|fumo>.png`
    (istantanee per il report, §11.2).
- Log: `~/.local/state/galleriadelvento/logs/` (dallo scaffold).
- Temporanei: `~/.cache/galleriadelvento/tmp/`, svuotata all'avvio.

### 14.2 Formati e versioni

Ogni JSON ha `schema_version`. Un file di versione più vecchia si migra in memoria (e si riscrive
solo al primo salvataggio); di versione più nuova → «Creato da una versione più recente di
galleriaDelVento», nessuna scrittura. Scritture atomiche: `.tmp` nella stessa cartella e
`os.replace`. `mesh.bin` e `vista.bin` sono derivati: se mancano o sono di un altro formato si
rigenerano da `originale.*` e `modello.json`.

### 14.3 Impostazioni persistenti

`~/.config/galleriadelvento/config.json`, scritto in `.tmp` e rinominato; chiavi sconosciute
ignorate, valori fuori campo riportati al default con un warning nel log. API
`GET /api/settings`, `PUT /api/settings/{chiave}` con un validatore per chiave (tabella
`_WRITABLE`).

| Chiave | Valori | Default |
|---|---|---|
| `unita_velocita` | `m/s` \| `km/h` | `km/h` |
| `fluido_predefinito` | `aria` \| `acqua` | `aria` |
| `temperatura_predefinita_c` | numero nel campo del fluido | 20 |
| `risoluzione` | `bozza` \| `normale` \| `fine` | `normale` |
| `mappa_sequenziale` | `viridis` \| `inferno` \| `cividis` | `viridis` |
| `mappa_divergente` | `coolwarm` \| `RdBu` | `coolwarm` |
| `csv_separatore` | `;` \| `,` | `;` |
| `passi_per_frame` | `auto` \| 1–200 | `auto` |
| `riferimento_in_profondita` | `fissa` \| `sezione` | `fissa` |

Preferenze solo di interfaccia (pannelli richiusi, ultima visualizzazione) in `localStorage`.

---

## 15. Errori e diagnostica

- Messaggi all'utente in italiano comprensibile, mai un traceback in un dialogo; dettagli
  tecnici dietro un «Dettagli» richiudibile e copiabile.
- Errori con messaggio dedicato: file non leggibile, mesh vuota, troppi triangoli, piano che non
  taglia il modello, sezione con aperture, schizzo senza contorno chiuso, profilo non valido,
  WebGL2 assente, contesto WebGL perso, instabilità numerica.
- Log: ogni import, riparazione, caso pianificato (CaseSetup + CasePlan), serie (durata, esiti),
  errore. Il frontend manda al log del server gli errori JS e le perdite di contesto WebGL
  (`POST /api/log`, solo loopback).
- **Nessuna chiamata di rete** (§2.2).

---

## 16. Distribuzione e installazione

`install.sh` (dallo scaffold): idempotente, senza sudo; se manca qualcosa stampa il comando
esatto e si ferma. Installa comando, icone, voce di menu
(`Categories=Education;Science;Physics;`). `uninstall.sh` non tocca la libreria (modelli,
profili, studi) senza un «sì» esplicito.

- La build del frontend (Vite) va nel pacchetto Python; Node serve solo per sviluppare.
- Il README spiega come aprire i `.vti`/`.vtp` in ParaView (`apt install paraview`), senza che
  sia una dipendenza.

---

## 17. Prestazioni e budget

Valori da **misurare** sulla macchina di §3 prima di chiudere la fase relativa, e scrivere in
STATO.md.

| Misura | Target | Come si misura |
|---|---|---|
| Avvio fino a finestra pronta | ≤ 3 s | `tests/bench/bench_startup.py` |
| RAM del backend a riposo | ≤ 200 MB (OpenCV e trimesh importati solo quando servono) | RSS del processo server |
| Galleria Normale (1024×384) | ≥ 300 passi/s **e** ≥ 30 fps | modalità benchmark `?bench=1`: 20 s, media e 5° percentile |
| Galleria Fine (2048×768) | ≥ 80 passi/s, ≥ 20 fps | idem |
| Aggiornamento maschera | ≤ 16 ms | `performance.now()` attorno a `mask.ts` + upload |
| Taglio di una sezione, mesh 1 M triangoli | ≤ 10 ms (indice pronto) | benchmark nel worker, 200 tagli |
| Ricostruzione dell'indice, 1 M triangoli | ≤ 400 ms | idem |
| Scorrimento in profondità, Normale | ≥ 30 fps | benchmark `?bench=depth` |
| Import STL 1 M triangoli | ≤ 5 s fino alla vista | `tests/bench/bench_import.py` |
| Pipeline schizzo (foto 2000 px) | ≤ 400 ms per aggiornamento | `tests/bench/bench_sketch.py` |
| Serie di incidenza (11 punti, Normale) | ≤ 5 min | log della serie, profilo NACA 0012 |

Se un target non si raggiunge, prima di cambiarlo si misura dove va il tempo e si chiede.

---

## 18. Test richiesti

Numerati: i commenti e STATO.md li citano («test 7»). Tutte le fixture sono **sintetiche e
generate dai test** (nessun file personale): sfera, cilindro, cubo, toro, ala rastremata
estrusa da NACA 0012/2412 (formula analitica), «Ahmed body» semplificato con lunotto a 25°,
sagoma umana grossolana, schizzo fotografato simulato.

**Invarianti e contratti**

1. Scaffold: API di base, Host/Origin, istanza singola, finestra, installazione, avvio e
   chiusura (test già presenti).
2. `safety.assert_writable` rifiuta percorsi fuori dalle cartelle dell'app, symlink compresi.
3. Non distruttività: ciclo completo su file in una cartella in sola lettura, hash e mtime
   invariati (§2.1).
4. Nessuna rete: avvio + sessione nella galleria con socket non-loopback del backend
   intercettati e Chrome dietro un proxy di registrazione su loopback (§2.2) → zero tentativi;
   l'argv di Chrome contiene i flag anti-rete obbligatori.
5. I campi di `Profile2D`, `CaseSetup`, `CasePlan`, `SimulationResult` coincidono tra Pydantic e
   `types.ts`.

**Geometria**

6. Import STL binario, STL ASCII e OBJ multi-oggetto dello stesso cubo → stessa mesh; proposta di
   unità corretta per estensioni 0,5 / 50 / 500.
7. Riparazione: un cubo con un buco piccolo diventa chiuso; `originale.*` resta identico byte
   per byte; `mesh.bin` riletto coincide con la mesh riparata.
8. Taglio nel worker (vitest): sfera di raggio 1 a profondità 0,5 → un anello con area
   π·0,75 ± 0,5%; toro → due anelli; ala rastremata a 3 profondità → corde attese entro lo
   0,5%; cubo con un buco → anello chiuso dal varco < 1%; piano fuori dal modello → risultato
   vuoto; risultati con numero di sequenza superato scartati.
9. Validazione di `Profile2D`: stessi esiti tra `profile.py` e la versione TS su 30 casi (validi,
   auto-intersecanti, degeneri). Sui casi non validi, il riparatore automatico TS (clipper2-js,
   §7.2) e `shapely.make_valid` + unione danno la stessa area entro lo 0,5%, e il risultato TS
   supera `profile.validate`.
10. Rasterizzazione: `raster2d.py` e `mask.ts` coincidono cella per cella su 20 casi, tra cui
    un profilo con un buco (le celle del buco sono solide) e due corpi sovrapposti (la parte
    comune è solida).
11. Import SVG (rettangolo con trasformazione, cerchio, path con curve) e DXF (LWPOLYLINE, ARC
    concatenati, SPLINE) → aree e perimetri attesi entro lo 0,5%; export DXF/SVG e reimport →
    stesso profilo.
12. Editor (vitest): modalità simmetrica, annulla/ripeti per 100 passi, «Rendi modificabile» su un
    NACA 0012 con 24 punti → errore massimo ≤ 0,3% della corda.

**Schizzo**

13. Schizzo simulato: NACA 0012 disegnato con tratto irregolare di 3–6 px su carta non bianca,
    ombra a gradiente, omografia casuale, rumore JPEG → dopo la scala alla corda nota, distanza
    di Hausdorff ≤ 1,5% della corda e errore d'area ≤ 3%, su 10 semi casuali.
14. Tratto aperto (varco del 3%) → errore «contorno non chiuso» con la posizione del varco; con
    «Chiusura varchi» al 4% → profilo valido.
15. Due forme chiuse sullo stesso foglio → due regioni selezionabili.
16. Foglio non trovato (bianco su bianco) → maniglie agli angoli dell'immagine, nessun errore.

**Fisica**

17. Pianificatore: Re reale 100 → nessuna similitudine parziale; Re reale 10⁷ → `τ = τ_min` e
    badge attivo; `U_lat ≤ 0,1` sempre; `Δt` coerente con V e Δx.
18. Pianificatore: cambiare solo sezione, incidenza o posizione non cambia il `CasePlan`;
    cambiare solo `L_ref` lascia invariati griglia, τ, Δx e Δt e cambia Re reale, Re simulato e
    `T_c` in proporzione; con bloccaggio ≤ 10% e oggetto dentro la camera, una rotazione non
    ridimensiona la camera, mentre oltre il 10% sì.
19. Proprietà dei fluidi a 0, 20, 40 °C entro lo 0,5% dei valori di riferimento.
20. `lattice.generated.ts` corrisponde a `gdv/lattice.py`.
21. Riferimento — canale di Poiseuille: profilo parabolico con errore L2 < 1% a 64 celle di
    larghezza.
22. Riferimento — cilindro a Re 20 (D = 40 celle, bloccaggio ≤ 5%): Cd in [1,95; 2,25], flusso
    stazionario, lunghezza di ricircolo L/D in [0,8; 1,1].
23. Riferimento — cilindro a Re 100: Cd medio in [1,25; 1,45], St in [0,155; 0,175].
24. Riferimento — NACA 0012 a Re simulato 10⁴: Cl(−5°) = −Cl(+5°) entro il 3%; Cl(5°) in
    [0,25; 0,65]; Cd(0°) > 0.
25. Shader contro riferimento (playwright, Chrome di sistema): 500 passi su 256×96, errore
    relativo massimo < 10⁻³; ripetuto con pavimento mobile e con un cambio di maschera a metà.
    Marcato `gpu`; si salta solo se Chrome manca, e lo dice.
26. Instabilità forzata (τ = 0,5001 senza sottogriglia) → stato «unstable», nessun NaN nei
    risultati salvati.

**Risultati ed export**

27. Studio salvato e riletto → `SimulationResult` identico; file di versione futura → rifiuto
    senza scrittura.
28. Serie in profondità sull'ala rastremata (5 sezioni): corde delle sezioni crescenti verso la
    radice; con riferimento «fisso» i Cl dei punti sono confrontabili e salvati con la loro
    profondità.
29. VTK: `.vti` e `.vtp` riletti con un parser XML di test (dimensioni, numero di punti, valori
    campione); CSV con le righe di condizioni in testa.
30. Confronto di due studi con Re simulato diverso → avviso «non direttamente confrontabili».
31. Report PDF generato con Chrome headless (file > 0 byte, numero di pagine atteso); senza
    Chrome → messaggio dedicato (Chrome simulato assente).
32. Impostazioni: valori fuori campo → default + warning; chiavi sconosciute ignorate.

**Interfaccia (playwright, Chrome di sistema)**

33. Percorso completo: importa l'ala rastremata → apri in galleria → 300 passi → scorri la
    profondità di 5 posizioni con il flusso attivo → salva studio → riapri lo studio dall'elenco;
    nessun errore in console.
34. Perdita del contesto WebGL simulata (`WEBGL_lose_context`) → messaggio e «Riprendi»
    funzionante.

---

## 19. Fasi di sviluppo

Ogni fase si chiude solo con i suoi test verdi e, dove previsto, le misure di §17 scritte in
STATO.md.

- **Fase 0 — Scaffold** (da fare): generato con la skill `nuova-app-linux`, preset `completa`,
  `--app-id galleriadelvento --nome "galleriaDelVento" --pkg gdv --env GDV --porta 8853
  --licenza GPL-3.0-or-later --generic-name "Galleria del vento"
  --categorie "Education;Science;Physics;"`. Server, finestra, istanza singola, installazione,
  test di base verdi (test 1); poi si scrive `STATO.md`. Lo scaffold esegue `git init` e il
  primo commit; README in inglese.
- **Fase 1 — Modelli 3D**: import STL/OBJ via upload, libreria su file, unità e scala, referto e
  riparazioni, orientamento di base e tipo di studio, `mesh.bin`, scena 3D, schermata Libreria,
  guardia di scrittura. *Accettazione*: test 2, 3 (parte import), 6, 7; import di 1 M triangoli
  ≤ 5 s.
- **Fase 2 — Profili 2D**: contratto `Profile2D` e validazione, taglio nel Web Worker con
  profondità e rotazioni (ancora senza flusso: anteprima 2D accanto alla scena), import SVG/DXF,
  editor a spline con «Rendi modificabile», export DXF/SVG. *Accettazione*: test 5 (parte
  profili), 8, 9, 11, 12; taglio ≤ 10 ms e indice ≤ 400 ms misurati.
- **Fase 3 — Galleria su GPU**: proprietà dei fluidi, pianificatore, solutore di riferimento,
  shader MRT+Smagorinsky, maschera dal vivo, contorni, forze, visualizzazioni 1–6, sonde, Cp sul
  contorno, istantanee e video, badge e avvisi, pannello «Modello 3D» con scorrimento in
  profondità dal vivo. *Accettazione*: test 4, 10, 17–26; ≥ 300 passi/s e ≥ 30 fps misurati,
  anche durante lo scorrimento; `τ_min` definitivo scritto in §9.4.
- **Fase 4 — Foto dello schizzo**: pipeline OpenCV e procedura in 4 passi. *Accettazione*:
  test 13–16; ≤ 400 ms per aggiornamento.
- **Fase 5 — Studi, serie, confronto, export**: salvataggio studi, serie di incidenza,
  velocità e profondità, confronto, CSV/VTK/JSON/PDF. *Accettazione*: test 3 (completo),
  27–31, 33; serie di 11 incidenze ≤ 5 min.
- **Fase 6 — Rifinitura**: impostazioni persistenti complete, scorciatoie e `?`, tooltip, tema
  scuro, errori dedicati, perdita del contesto WebGL, misure finali di §17, README.
  *Accettazione*: test 32, 34; tutte le misure di §17 rispettate o discusse.

---

## 20. Licenza

**GPL-3.0-or-later.** Il progetto sarà pubblicato su GitHub e deve restare open source: la GPL
obbliga chi distribuisce versioni modificate a pubblicarne il sorgente. Tutte le dipendenze (MIT,
BSD, Apache-2.0, BSL-1.0 per clipper2-js) sono compatibili con la GPLv3. Ogni nuova dipendenza va controllata anche per la
licenza prima di aggiungerla.

---

## 21. Regole di lavoro per l'agente

1. **Test insieme al codice**: ogni funzione nuova arriva con il suo test nella stessa
   modifica; la correzione di un difetto arriva con il test che lo riproduce.
2. **Chiedi prima di inventare**, distinguendo due livelli:
   - **Domande bloccanti, da fare subito**: dipendenze nuove (e la loro licenza), scelte
     fisiche o numeriche non scritte qui (schemi di collisione, contorni, parametri di
     stabilità), qualunque cosa tocchi gli invarianti di §2.
   - **Dubbi minori** (default visibili non scritti qui, soglie di validazione, dettagli di
     interfaccia): si sceglie un valore provvisorio, ragionevole e facile da cambiare, e lo si
     registra in `STATO.md` sotto «Da decidere con l'utente» con il motivo. Si rivedono a fine
     fase.
3. **Autonomia per fase**: dentro una fase si lavora in autonomia. **A ogni fase chiusa ci si
   ferma** per la revisione dell'utente, presentando test verdi, misure di §17 e dubbi minori
   raccolti. Non si inizia la fase successiva senza il suo via.
4. **Git**: un commit per fase chiusa (o per blocco logico coerente dentro una fase), con
   messaggio in inglese. **Mai `git push`** né creazione di repository remoti senza richiesta
   esplicita. `STATO.md` resta fuori dal repository (`.gitignore`, come da scaffold).

---

## 22. Punti aperti

- **HEIC** (foto da iPhone): servirebbe `pillow-heif` (libheif è LGPL). Da decidere in Fase 4.
- **Condizioni al contorno interpolate (Bouzidi)** per ridurre l'effetto «a gradini» sui
  contorni curvi: solo se i test 22–24 non passano con il rimbalzo a metà via.
- **`U_lat` = 0,08**: da confermare in Fase 3 confrontando stabilità ed errore di
  comprimibilità sul test 23.
- **Turbolenza in ingresso** (intensità regolabile) per edifici e veicoli.
- **Piano di taglio inclinato** rispetto al vento (oggi si ottiene ruotando il modello): da
  valutare se lo scorrimento con rotazioni risulta scomodo.
- **WebGPU**: da rivalutare quando sarà stabile in Chrome su Linux/Intel, per griglie più fini.
- **Più oggetti indipendenti nella camera** (due auto in scia, ciclista dietro un'auto, edifici
  vicini), ognuno con posizione e incidenza proprie e forze separate. In v1 la camera ospita un
  solo `Profile2D` per caso: più corpi si ottengono già con un profilo multi-anello.
- **Incidenza oltre ±90°** (direzione del vento su 360° per gli edifici in pianta): in v1 resta
  ±90° (decisione dell'utente, 2026-10-15); le altre direzioni si ottengono ruotando il modello.

---

## 23. Primo passo

1. Leggi questo file (e `STATO.md`, se esiste già).
2. Se lo scaffold manca, esegui la Fase 0 (§19) e collaudala; poi implementa la Fase 1,
   partendo da `safety.py` e dal modello della libreria, con i loro test.
3. Le fixture sono tutte sintetiche e generate dai test: non chiedere file all'utente.
