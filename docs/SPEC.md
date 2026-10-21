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

**La galleria principale è 2D.** Un modello 3D si importa per *ricavarne sezioni*: l'utente lo
ruota e lo riposiziona nella camera di prova, **scorre il piano di taglio nella profondità del
modello**, e la galleria simula la sezione corrente, aggiornandosi dal vivo mentre il piano si
sposta. In più, a programma 2D finito, una **galleria 3D** a griglia grossolana simula il
modello intero (Fase 7, §24: approvata dall'utente il 2026-10-20).

Dalla Fase 8 (§25, approvata il 2026-10-21) esiste anche una **versione per Windows**: uno zip
che l'utente, insegnante, dà ai suoi studenti e ai PC della scuola. Lo sviluppo resta su Linux
(§3) e la versione Linux non cambia.

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

- **Nessuna simulazione 3D oltre alla galleria 3D di §24**: le sezioni, i profili, gli studi e
  le serie restano 2D. La galleria 3D (Fase 7) è a griglia grossolana e a scopo didattico, non
  una CFD 3D.
- **Nessuna CFD ingegneristica**: niente RANS, niente mesh conformi, niente OpenFOAM. I
  coefficienti a Reynolds reali (10⁵–10⁷) sono indicativi (§2.3, §9).
- **Niente flusso comprimibile**: oltre Mach 0,3 il programma avvisa e non estrapola.
- **Niente moto proprio dell'oggetto** (rotazioni, oscillazioni, flap mobili): l'oggetto si
  sposta e ruota solo a mano.
- **Niente formati CAD solidi** (STEP/IGES), niente glTF/PLY/3MF: solo STL e OBJ.
- **Niente generatore NACA nell'interfaccia** (i profili NACA esistono solo nei test, §18).
- Niente WebGPU per la galleria 2D (WebGPU serve solo alla galleria 3D, §24), nessuna modalità
  didattica guidata, nessuna lingua oltre l'italiano.
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
  Verifica su Chrome 155 (2026-10-15, net-log dietro il proxy del test 4): servono anche
  `--disable-features=AutofillServerCommunication,SafeBrowsingHashPrefixRealTimeLookups,
  NetworkTimeServiceQuerying,PreconnectToSearch,PreconnectToSearchDesktop,OptimizationHints,
  OptimizationHintsFetchingSRP,OptimizationGuideRemoteFetching,
  OptimizationGuideProactivePersonalizedHintsFetching,OptimizationGuideModelExecution` (le
  ultime cinque dal 2026-10-16, decisione dell'utente: una corsa completa del test 4 ha visto un
  tentativo verso `optimizationguide-pa.googleapis.com`). Chrome ignora in silenzio i nomi che
  non conosce: un test verifica che ognuno compaia nel binario installato. E i servizi che
  nessun flag spegne (ListAccounts, idoneità «Modalità AI», aggiornamento di componenti ed
  estensioni) si dirottano su `http://127.0.0.1:9/` con `--gaia-url`, `--google-base-url`,
  `--component-updater=url-source=…`, `--apps-gallery-update-url` (la porta 9 è nell'elenco
  delle porte non sicure di Chrome: la richiesta fallisce prima di aprire un socket). Dalla Fase
  7b anche GCM, il canale push dei servizi di Chrome: la sua registrazione su
  `android.clients.google.com` è comparsa nel test 4 quando la galleria 3D (WebGPU) gira sulla
  GPU vera, anche in una finestra; `--gcm-checkin-url`, `--gcm-registration-url` e
  `--gcm-mcs-endpoint` vanno sulla porta 9 (2026-10-20, da confermare alla revisione della 7b).
  Come per le funzioni, un test verifica che ogni switch di dirottamento compaia nel binario. Resta
  l'«activity reporter» dell'updater, con l'URL scritto nel binario e senza flag: nella finestra
  fallisce sul DNS, e il test 4 accetta quell'unico host (decisione dell'utente).
  `--host-resolver-rules` e `--gaia-url` sono nell'elenco dei flag «non supportati» di Chrome,
  che a ogni avvio apriva una barra in cima alla finestra («Stai utilizzando una segnalazione
  della riga di comando non supportata…»): la lista porta anche `--test-type`, che Chrome
  controlla prima di mostrarla (lo passa anche chromedriver). Non è un flag di rete; sta nella
  stessa lista perché il test 4 lo usi e dimostri che non aggiunge traffico (decisione
  dell'utente, 2026-10-20).
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
- **clipper2-ts** — porting TypeScript di Clipper2 (Boost Software License 1.0, compatibile con
  la GPL): unione booleana e risoluzione delle auto-intersezioni per il riparatore automatico
  delle sezioni dal vivo (§7.2). Scelto rispetto a polygon-clipping perché lavora in aritmetica
  intera (robusto sui casi degeneri delle scansioni) ed è più veloce. Preferito a `clipper2-js`
  (fermo da gennaio 2024) perché mantenuto attivamente, senza dipendenze: decisione dell'utente,
  2026-10-15.
- **uPlot** — serie temporali, polari, curve Cp.
- **zustand** — stato locale delle schermate; TanStack Query resta per i dati del server.
- Solo sviluppo: **vitest**, **playwright-core** con il **Chrome di sistema**
  (`channel: 'chrome'`, nessun browser scaricato); **@webgpu/types** (BSD-3-Clause), i tipi di
  WebGPU per la galleria 3D (approvato dall'utente il 2026-10-20, da aggiungere con la 7b).
- **Nessuna stringa visibile nei componenti**: tutte in `frontend/src/i18n/it.ts`, via
  `t('chiave')`.

### Dipendenze

- Tutte le dipendenze sono a licenza permissiva (MIT, BSD, Apache-2.0, BSL-1.0) e compatibili con la
  GPL-3.0-or-later del progetto (§20).
- Nessuna dipendenza di sistema oltre a quelle dello scaffold (Chrome/Chromium).
- **Ogni dipendenza aggiunta oltre a questo elenco va chiesta prima** (§21), poi motivata nel
  README.

### Decisioni prese (non riaprirle)

1. **Simulazioni 2D, più la galleria 3D di §24.** Il 3D serve a ricavare sezioni; la galleria
   3D (Fase 7, D3Q19 su WebGPU) simula il modello intero a griglia grossolana, senza toccare la
   galleria 2D (decisione dell'utente, 2026-10-20).
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
│   │   ├── planner3d.py       CaseSetup3D → CasePlan3D (§24.3)
│   │   └── coefficients.py    forze reticolari → coefficienti → forze reali
│   ├── lattice.py             costanti D2Q9 + matrice MRT (fonte unica, §10.2)
│   ├── lattice3d.py           costanti D3Q19 + matrice MRT (fonte unica, §24.3)
│   └── studies/
│       ├── store.py           salvataggio/lettura studi
│       ├── export_csv.py, export_vtk.py
│       └── report.py          PDF via Chrome headless
├── frontend/src/
│   ├── pages/    Library, ModelSetup, ProfileEditor, SketchWizard,
│   │             Tunnel, Tunnel3D, Studies, Compare, Report, Settings
│   ├── section/  slicer.worker.ts, slicer.ts (indice + taglio), loops.ts
│   ├── sim2d/    gl.ts, shaders/*.glsl, solver.ts, mask.ts, forces.ts,
│   │             render.ts, smoke.ts, particles.ts, streamlines.ts, probes.ts,
│   │             series.ts, lattice.generated.ts
│   ├── sim3d/    gpu.ts, shaders.ts (WGSL), solver.ts, voxelize.ts,
│   │             lattice3d.generated.ts, voxel.worker.ts, engine.ts, views.ts,
│   │             viewShaders.ts (WGSL della resa), camera.ts, scene.ts (§24)
│   ├── scene3d/  ModelScene, ModelMesh, CutPlane, RotateGizmo
│   ├── charts/   TimeSeries, Polar, CpCurve, DepthCurve (uPlot)
│   ├── lib/      api.ts, types.ts
│   └── i18n/it.ts
├── scripts/gen_lattice_ts.py  genera sim2d/lattice.generated.ts e sim3d/lattice3d.generated.ts
└── tests/
    ├── reference/lbm2d.py     solutore di riferimento in Numba (§10.8)
    ├── reference/lbm3d.py     solutore di riferimento 3D in Numba (§24.4)
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
   veloce (test 9). Se fallisce, ripara con clipper2-ts: unione di tutti gli anelli con
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
- **Senza cambiare strumento** (richiesta dell'utente, 2026-10-20): con «Sposta» si trascina un
  punto; premendo sulla curva (dove compare un «+») se ne tira fuori uno nuovo e lo si trascina,
  in un solo passo di annulla; clic destro o Canc toglie un punto; doppio clic fa lo spigolo.
  Per ogni anello: «Spline | Polilinea», «Infittisci» (un punto a metà di ogni tratto) e
  «Semplifica» (toglie i punti finché la curva si sposta meno della tolleranza, 0,05–1% della
  dimensione; gli spigoli restano).
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

- **JPEG, PNG, WebP** fino a 40 MB; orientamento EXIF rispettato. **HEIC non supportato** in v1
  (decisione dell'utente, 2026-10-16): un file HEIC dà «Le foto HEIC non sono supportate: salvala
  o esportala in JPEG dal telefono».
- Elaborazione su una copia ridotta a **2000 px** sul lato lungo; la foto è copiata in libreria
  (§2.1) e mai modificata.

### 8.2 Passo 1 — Foglio e prospettiva

- Ricerca del foglio: scala di grigi → sfocatura gaussiana → Canny + chiusura morfologica →
  quadrilatero più grande (`approxPolyDP`) con area > 20% dell'immagine.
- I **4 angoli** sono maniglie trascinabili. Se il foglio non si trova, partono dagli angoli
  dell'immagine.
- Raddrizzamento con omografia; rapporto d'aspetto stimato dai quattro angoli con un modello a
  camera stenopeica (pixel quadrati, punto principale al centro della foto; Zhang e He,
  «Whiteboard scanning and image enhancement», 2007), che ricava anche la focale: la media dei
  lati opposti sbaglia del 5–10% con una prospettiva forte. Senza prospettiva (parallelogramma)
  si usano i lati. Se il rapporto è entro il ±5% di √2 si usa quello dell'A4/A3 (decisione
  dell'utente, 2026-10-16).

### 8.3 Passo 2 — Pulizia e binarizzazione

- Appiattimento dell'illuminazione: divisione per lo sfondo stimato con una sfocatura di raggio
  pari al 5% della larghezza (rimuove ombre e gradienti).
- Soglia adattiva (gaussiana, blocco ~3% della larghezza; default: 12% più scuro dei dintorni),
  poi rimozione delle macchie: componenti con area < 0,05% del foglio. Un margine dell'1% lungo
  il bordo del foglio si ripulisce (angoli appena fuori dal foglio lascerebbero una cornice).
- **Chiusura varchi** (slider, default 1% della larghezza): non è una chiusura morfologica, che
  con un disco non salda mai due estremi sottili affacciati (servirebbe un raggio ~d²/4w, l'8%
  del foglio per un varco del 3%). L'inchiostro si dilata di metà del valore, le regioni chiuse
  si cercano sull'inchiostro dilatato e si fanno ricrescere dello stesso raggio fino al tratto
  vero: sul varco il contorno si chiude con una curva dolce. L'anteprima mostra in azzurro fin
  dove arriva la dilatazione (decisione dell'utente, 2026-10-16).

### 8.4 Passo 3 — Contorno

- Il tratto è una linea, non una sagoma piena: si **riempie la regione racchiusa** (flood fill
  dall'esterno; l'interno è ciò che non viene raggiunto) e il contorno cade sulla **linea
  mediana del tratto**: con due trasformate distanza, ogni pixel d'inchiostro va alla regione se
  le è vicino almeno quanto alla carta esterna. Così si segue lo spessore locale (un tratto a
  mano varia da 3 a 6 px), invece di uno spostamento costante di mezzo spessore. Dove i due
  tratti di uno spigolo vivo si fondono (la coda di un profilo), si tiene anche l'inchiostro a
  più di ¾ di mezzo tratto dalla carta esterna. Le sacche chiuse troppo piccole per essere
  regioni contano come tratto.
- Se nessuna regione chiusa supera l'1% del foglio, il tratto è aperto: si evidenziano in rosso
  gli estremi liberi più vicini con la loro distanza e si propongono «Aumenta chiusura varchi»
  o «Chiudi nell'editor».
- Più regioni chiuse (si propongono quelle ≥ 0,25% del foglio, al massimo 20): si selezionano
  con un clic (default la più grande; mai nessuna) e diventano più anelli dello stesso profilo.
- Lisciatura: spline `splprep` con slider «Morbidezza» (scarto tipico concesso alla spline, in %
  del perimetro; default 0,05%, tarato perché il tremolio della mano < 0,5% della lunghezza
  sparisca senza arrotondare il naso), poi ricampionamento a 400 punti con densità che cresce
  con la radice della curvatura. Gli spigoli vivi (regola di «Rendi modificabile», §7.5) tagliano
  il contorno in pezzi lisciati separatamente e restano spigoli.

### 8.5 Passo 4 — Scala e orientamento

- Scala: **lunghezza lungo il vento** (si scrive, es. «corda 1,2 m») oppure **due punti sulla
  foto + distanza reale**.
- Orientamento: freccia del vento ruotabile sul disegno (default da sinistra a destra; angolo in
  gradi antiorari) e «ribalta verticalmente». Il profilo ha il bordo d'attacco a x = 0 e
  l'ingombro centrato su y = 0.
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

- a monte 2·L, a valle 5·L (mai meno di 3·L); **sotto un Re simulato di 1000** a monte 5·L e a
  valle 10·L: a basso Re il corpo disturba il flusso molto lontano e la camera corta falsa i
  numeri (cilindro a Re 20: Cd 2,82 invece di 2,24). Soglia e lunghezze confermate
  dall'utente (2026-10-15);
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
  volte, per assorbire le riflessioni. Nella stessa zona, dopo la collisione, le popolazioni
  fanno una frazione `0,05 · s` (s da 0 a 1 attraverso la spugna) della strada verso
  l'equilibrio del flusso indisturbato (densità 1, velocità d'ingresso della riga, v = 0): uno
  **strato assorbente**. Senza, il primo modo acustico trasversale della camera (pareti a
  scorrimento libero, riflettenti) risuona con il distacco dei vortici — il rapporto delle
  frequenze vale c_s·bloccaggio/(2·St·U_lat) ≈ 1 per i corpi tozzi al 5% — e la densità media,
  che nessun contorno fissa, cresce senza fine quando una parete ha attrito (decisioni
  dell'utente, 2026-10-15).
- **Pareti superiore e inferiore**: scorrimento libero (riflessione speculare), così la camera
  approssima il flusso indisturbato.
- **Pavimento**: `fixed` = rimbalzo no-slip; `moving` = rimbalzo con parete in moto alla
  velocità del vento (nastro trasportatore); `none` = scorrimento libero. Sul pavimento mobile il
  corpo resta ad almeno **3 celle** dal nastro (`floor_gap_m` del piano): a contatto, o a una
  cella, la sacca a cuneo tra corpo e nastro diventa instabile (NACA 0012 su Bozza: subito a
  contatto, dopo 14 s a una cella; stabile a due). Il pavimento fisso si può toccare
  (2026-10-20, da confermare alla revisione). Nella galleria la distanza dal pavimento si scrive
  («Distanza dal pavimento», «Appoggia al pavimento»), oppure si trascina il corpo o la linea
  del pavimento; il corpo non entra mai nel pavimento (richiesta dell'utente, 2026-10-20).
- **Oggetto**: rimbalzo a metà via (*halfway bounce-back*) sulla maschera di celle solide. Le
  condizioni interpolate (Bouzidi) sono un miglioramento possibile solo se la validazione lo
  richiede, da chiedere prima (§22).

### 9.4 Il pianificatore (`physics/planner.py`)

Input `CaseSetup`, output `CasePlan`, via `POST /api/cases/plan`. Passi:

1. `Δx` dalla risoluzione e dal dominio; `L_lat = L_ref / Δx`.
2. Velocità reticolare `U_lat` = 0,08 (Mach reticolare 0,14; limite massimo 0,1).
3. `Re_real = V · L_ref / ν`.
4. `ν_lat` richiesto = `U_lat · L_lat / Re_real`; `τ = 3·ν_lat + 0,5`.
5. Se `τ < τ_min`, si fissa `τ = τ_min` e `Re_sim = U_lat · L_lat / ν_lat(τ_min) < Re_real`:
   **similitudine parziale**. **`τ_min = 0,502`**, e **0,504 con il pavimento fisso** (misurato
   sulla GPU il 2026-10-15, 30.000 passi per caso, Smagorinsky attivo: cilindro e NACA 0012 a 0°,
   8° e 16°, auto su pavimento mobile e quadrato libero restano stabili fino a 0,5005; un
   edificio su pavimento fisso con strato limite in ingresso diverge a 0,502 — sopra il tetto
   |u| arriva a 0,3 reticolare — e regge da 0,504). `U_lat = 0,08` è confermato: sul test 23
   con `U_lat = 0,04` Cd e St restano identici (1,440 e 0,167).
6. `Δt = Δx · U_lat / V` (secondi reali per passo) e **tempo di attraversamento** in passi.
   Definizione unica in tutto il programma: **`T_c = L_ref / V`**, cioè il tempo convettivo
   sulla lunghezza di riferimento; in passi vale `L_lat / U_lat`. Tutto ciò che è espresso in
   «tempi di attraversamento» (rampa, transitorio, finestre di media, tetto delle serie) usa
   questo `T_c`, non la lunghezza della camera. Questa scelta rende realistico il target di
   7 minuti per la serie di 11 incidenze (§17).
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

- **Forze** con il metodo dello **scambio di quantità di moto** sui collegamenti fluido–solido,
  **relative alla pressione indisturbata**: sugli stessi collegamenti si somma anche
  S = Σ 2 w_k c_k (la spinta di un fluido fermo a densità 1) e si sottrae ρ∞ · S. Per un corpo
  circondato dal fluido S è esattamente zero; per un corpo appoggiato al pavimento, la cui faccia
  inferiore non è bagnata, toglie la pressione di fondo sul tetto (un edificio sul pavimento fisso
  aveva Cl = −102 invece di ~2). Difetto trovato e corretto nella Fase 7a (2026-10-20, da
  confermare alla revisione).
- Coefficienti: `C = F_lat / (½ ρ_lat U_lat² · L_lat)`, con `ρ_lat` la **densità indisturbata
  misurata** (media della seconda colonna, ρ∞), non 1: con ingresso a velocità imposta il livello
  medio di densità dipende dalla storia del transitorio, e forze e pressioni lo seguono
  (decisione dell'utente, 2026-10-15). Assi: **Cd** lungo x, **Cl** lungo +y del
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
  mostrato solo se il picco supera di 10 volte il rumore di fondo. Il picco si cerca tra St 0,05
  e 1 (fuori ci sono le onde acustiche dell'avvio), e solo se Cl oscilla davvero (deviazione
  standard > 10⁻³).
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
  **Smagorinsky** (`C_s = 0,1`) applicato al tempo di rilassamento della viscosità. Tempi dei
  momenti non idrodinamici: quelli di Lallemand–Luo, `s_e = 1,64`, `s_ε = 1,54`, `s_q = 1,9`
  (decisione dell'utente; confermati sui test 21–25: legare `s_q` alla viscosità con Λ = 3/16
  cambia il Cd del cilindro a Re 20 dello 0,3%). BGK resta disponibile solo come opzione di
  debug e nel riferimento (§10.8).
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

**Galleria 3D** (§24): Spazio, R, `.`, S, V come nel 2D · 1 velocità sul piano · 2 Cp sul piano ·
3 Cp sulla superficie · 4 fumo · 5 particelle · 6 piano sì/no · PagSu/PagGiù sposta il piano di
una cella (Maiusc: dieci) · trascinamento = gira attorno al modello, tasto destro o
Maiusc+trascinamento = sposta, rotella e `+`/`−` = zoom, `0` o doppio clic = vista iniziale.

**Vista della galleria** (anche con il flusso in corso e durante una serie: lo zoom non tocca la
simulazione): rotella = zoom attorno al cursore (da 1× a 32×), trascinamento del fluido con
«Sposta» o con il tasto centrale = sposta la vista, `+`/`−` zoom, `0` o doppio clic sul fluido =
camera intera. La mini-scena 3D del modello resta navigabile durante una serie (le rotazioni del
gizmo no) e si ingrandisce sopra la galleria (richiesta dell'utente, 2026-10-20).

**Guida** (richiesta dell'utente, 2026-10-20): un pannello laterale che non ferma la galleria,
aperto da «Guida» nell'intestazione o con `?` (sulle scorciatoie). Spiega simboli e grandezze
(con unità), coefficienti con le loro formule, come leggere ogni grafico (storia, Cp con l'asse
rovesciato, sonde, polari, serie in velocità e in profondità, punti vuoti), visualizzazioni e
colori, stati, badge e avvisi, e raccoglie tutte le scorciatoie. Un piccolo «?» accanto a ogni
coefficiente e grafico apre la voce relativa. Non è una modalità lezione: è una legenda.

### 12.3 Requisiti della finestra applicativa

- La navigazione vive tutta dentro l'app: ogni schermata ha un percorso di ritorno visibile.
- Nessuna funzione raggiungibile solo digitando un URL.
- Un errore fatale del frontend non lascia una finestra bianca: messaggio + «Ricarica». Una
  perdita del contesto WebGL (`webglcontextlost`) mostra «La GPU ha interrotto la simulazione»
  con «Riprendi», che ricrea il contesto e riparte dal profilo e dal caso correnti.
- Utilizzabile da **1280×800** in su; i pannelli laterali si richiudono sotto i 1440 px.
- Tooltip brevi (≤ 2 righe) sulle grandezze fisiche: Re, Mach, τ, bloccaggio, Cp, Strouhal,
  similitudine parziale, sezione 2D. Stanno in primo piano, sopra pannelli e canvas, dentro la
  finestra: mai tagliati dal bordo di un pannello laterale (2026-10-20).
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
- **Su Windows**, se è Windows stesso a riservare la porta (Hyper-V e WSL riservano blocchi di
  100 porte a ogni avvio), il programma ne prende una che Windows assegna e la ricorda (§25.8,
  decisione dell'utente del 2026-10-21). Una porta occupata da un altro programma resta un errore.
- **Su Windows** (§25.3): finestra con Chrome o Edge, cercati nei percorsi d'installazione;
  la finestra si apre sempre (salvo `--no-window`); il secondo avvio la porta in primo piano
  con le API di Windows; gli errori di avvio compaiono in una finestra di messaggio.

---

## 14. Dati e persistenza

### 14.1 Cartelle

- Dati: `~/.local/share/galleriadelvento/`
  - `modelli/<sha256[:16]>/originale.stl|obj` (copia intatta), `modello.json` (nome, unità,
    scala, orientamento di base, tipo di studio, riparazioni scelte, referto), `mesh.bin`
    (mesh riparata e trasformata, formato di §7.2), `vista.bin` (decimata, se serve),
    `miniatura.png`;
  - `profili/<uuid>.json` (`Profile2D`) + `<uuid>.png` (miniatura);
  - `foto/<sha256[:16]>.<ext>` (copie delle foto degli schizzi) + `<sha256[:16]>.json` (nome
    originale, formato, SHA-256);
  - `disegni/<sha256[:16]>.svg|dxf` (copia intatta dei disegni importati, al massimo 50 MB) +
    `<sha256[:16]>.json` (nome originale);
  - `studi/<uuid>/studio.json` (`SimulationResult` o serie), `storia.npz`, `campi.npz`
    (float16, compresso), `contorno.npz`, `miniatura.png`, `viste/<velocita|cp|vorticita|fumo>.png`
    (istantanee per il report, §11.2).
- Log: `~/.local/state/galleriadelvento/logs/` (dallo scaffold).
- Temporanei: `~/.cache/galleriadelvento/tmp/`, svuotata all'avvio.
- **Su Windows** (§25.3): le stesse cartelle sotto `%LOCALAPPDATA%\galleriadelvento\`
  (`dati\`, `stato\logs\`, `config\`, `cache\tmp\`; il lock in `stato\`).

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
| `unita_velocita` | `m/s` \| `km/h` | `m/s` |
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
- **Windows** (§25): zip `galleriaDelVento-<versione>-windows-x64.zip` nelle Release del
  repository, costruito e provato dall'azione `.github/workflows/windows.yml` a ogni tag `v*`;
  dentro, l'eseguibile, la cartella `_internal`, `LEGGIMI.txt` e `LICENSE`. Niente installazione.
- Il README spiega come aprire i `.vti`/`.vtp` in ParaView (`apt install paraview`), senza che
  sia una dipendenza.

---

## 17. Prestazioni e budget

Valori da **misurare** sulla macchina di §3 prima di chiudere la fase relativa, e scrivere in
STATO.md.

| Misura | Target | Come si misura |
|---|---|---|
| Avvio fino a finestra pronta | ≤ 3 s | `tests/bench/bench_startup.py` (finestra vera, fino alla libreria disegnata) |
| RAM del backend a riposo | ≤ 200 MB (OpenCV e trimesh importati solo quando servono) | RSS del processo server |
| Galleria Normale (1024×384) | ≥ 300 passi/s **e** ≥ 30 fps | modalità benchmark `?bench=1`: 20 s, media e 5° percentile |
| Galleria Fine (2048×768) | ≥ 80 passi/s, ≥ 20 fps | idem |
| Aggiornamento maschera | ≤ 16 ms | `performance.now()` attorno a `mask.ts` + upload |
| Taglio di una sezione, mesh 1 M triangoli | ≤ 10 ms (indice pronto) | benchmark nel worker, 200 tagli |
| Ricostruzione dell'indice, 1 M triangoli | ≤ 400 ms | idem |
| Scorrimento in profondità, Normale | ≥ 30 fps | benchmark `?bench=depth` |
| Import STL 1 M triangoli | ≤ 5 s fino alla vista | `tests/bench/bench_import.py` |
| Pipeline schizzo (foto 2000 px) | ≤ 400 ms per aggiornamento | `tests/bench/bench_sketch.py` |
| Serie di incidenza (11 punti, Normale) | ≤ 7 min (era 5: misurati 378 s, quasi tutti i punti arrivano al tetto di 20 T_c; decisione dell'utente, 2026-10-16) | `tests/bench/series.bench.mjs`, profilo NACA 0012 |

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
   auto-intersecanti, degeneri). Sui casi non validi, il riparatore automatico TS (clipper2-ts,
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
26. Instabilità forzata (τ = 0,5001 senza sottogriglia, `U_lat` = 0,15: l'MRT regge 0,5001 a
    0,08) → stato «unstable», nessun NaN nei risultati salvati.

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
  27–31, 33; serie di 11 incidenze ≤ 7 min.
- **Fase 6 — Rifinitura**: impostazioni persistenti complete, scorciatoie e `?`, tooltip, tema
  scuro, errori dedicati, perdita del contesto WebGL, misure finali di §17, README.
  *Accettazione*: test 32, 34; tutte le misure di §17 rispettate o discusse.
- **Fase 7 — Galleria 3D** (§24, chiusa il 2026-10-21): 7a solutore e validazione, 7b galleria,
  7c numeri e studi, con una revisione dell'utente alla fine di ciascuna. *Accettazione*: test 35–42 (§24.4) e le misure
  di §24.4.
- **Fase 8 — Versione per Windows** (§25, approvata il 2026-10-21): rami per Windows in
  `gdv/winsupport.py`, eseguibile PyInstaller a cartella, azione di GitHub con test, prova
  dell'eseguibile e Release. *Accettazione*: §25.5, compreso il collaudo dell'utente su un PC
  della scuola.

---

## 20. Licenza

**GPL-3.0-or-later.** Il progetto sarà pubblicato su GitHub e deve restare open source: la GPL
obbliga chi distribuisce versioni modificate a pubblicarne il sorgente. Tutte le dipendenze (MIT,
BSD, Apache-2.0, BSL-1.0 per clipper2-ts) sono compatibili con la GPLv3. Ogni nuova dipendenza va controllata anche per la
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

- **HEIC** (foto da iPhone): servirebbe `pillow-heif` (libheif è LGPL). Escluso dalla v1
  (decisione dell'utente, 2026-10-16), da rivalutare.
- **Condizioni al contorno interpolate (Bouzidi)**: non servono, i test 22–24 passano con il
  rimbalzo a metà via (Fase 3).
- **Turbolenza in ingresso** (intensità regolabile) per edifici e veicoli.
- **Piano di taglio inclinato** rispetto al vento (oggi si ottiene ruotando il modello): da
  valutare se lo scorrimento con rotazioni risulta scomodo.
- **WebGPU**: da rivalutare quando sarà stabile in Chrome su Linux/Intel, per griglie più fini.
- **Più oggetti indipendenti nella camera** (due auto in scia, ciclista dietro un'auto, edifici
  vicini), ognuno con posizione e incidenza proprie e forze separate. In v1 la camera ospita un
  solo `Profile2D` per caso: più corpi si ottengono già con un profilo multi-anello.
- **Simulazione 3D di modelli completi** (richiesta dell'utente, 2026-10-20): è la Fase 7 (§24),
  approvata dall'utente il 2026-10-20 con proposte tecniche, test e ordine dei lavori.
- **Incidenza oltre ±90°** (direzione del vento su 360° per gli edifici in pianta): in v1 resta
  ±90° (decisione dell'utente, 2026-10-15); le altre direzioni si ottengono ruotando il modello.

---

## 23. Primo passo

1. Leggi questo file (e `STATO.md`, se esiste già).
2. Se lo scaffold manca, esegui la Fase 0 (§19) e collaudala; poi implementa la Fase 1,
   partendo da `safety.py` e dal modello della libreria, con i loro test.
3. Le fixture sono tutte sintetiche e generate dai test: non chiedere file all'utente.

---

## 24. Fase 7 — Galleria 3D (approvata il 2026-10-20)

> Stato: **approvata** dall'utente il 2026-10-20 («ti approvo tutte le proposte tecniche, test e
> ordine dei lavori»); §1 e §4 aggiornati. Le scelte fatte durante la 7a sono in §24.6, quelle
> della 7b in §24.7 (confermate il 2026-10-21), le decisioni della revisione della 7b in §24.8,
> le scelte della 7c in §24.9 (confermate il 2026-10-21). La Fase 7 è chiusa.

### 24.1 Obiettivo

Una **galleria 3D in tempo reale** (≥ 30 fps) in cui vedere, a **livello di liceo STEM**,
l'andamento del flusso attorno a un modello 3D intero: semplice, ma non troppo approssimata. Non
sostituisce la galleria 2D, che resta com'è (sezioni, profili, studi, serie). Valgono gli
invarianti di §2 (file dell'utente intatti, nessuna rete, nessun numero senza contesto).

### 24.2 Decisioni dell'utente (2026-10-20)

1. **Fisica**: Lattice Boltzmann **D3Q19** su una griglia grossolana (scia, distacco e vortici
   veri, a Re simulato basso), non flusso potenziale (niente scia: troppo approssimato).
2. **API**: **WebGPU** per la galleria 3D (compute shader e storage buffer); la 2D resta su
   WebGL2. Verificato su Chrome 155 con Iris Xe (adattatore `gen-12lp`, storage buffer fino a
   4 GB, `shader-f16`). Senza WebGPU: «La galleria 3D richiede WebGPU, che questo browser non
   offre» e tutto il resto funziona (come §3 per WebGL2).
3. **Viste**: linee di fumo da un rastrello spostabile; particelle; piano di taglio mobile
   colorato per velocità o Cp; pressione (Cp) sulla superficie del modello.
4. **Interazione dal vivo**: camera libera (orbita, zoom, spostamento) in ogni momento.
   Velocità, fluido e pavimento (nessuno / fisso / mobile) si cambiano e ripartono da zero, come
   nel 2D. **Rotazioni del modello (imbardata, incidenza) prima di avviare**: cambiarle ricomincia
   il flusso.
5. **Numeri**: Cd e Cl del corpo intero (su area frontale) e **forze reali in N**, con i badge di
   contesto (similitudine parziale, griglia grossolana, convergenza; §2.3).
6. **Risoluzione**: preset come nel 2D (Bozza / Normale / Fine), misurati e regolati sull'Iris Xe.
7. **Salvataggi**: istantanea PNG e video WebM; **studi 3D** (elenco Studi, confronto tra studi
   3D); export **VTK** del campo medio 3D (`.vti`); **report PDF**.

### 24.3 Scelte tecniche (approvate)

- **Solutore**: D3Q19, collisione MRT (d'Humières 2002) con Smagorinsky come nel 2D, float32,
  popolazioni come deviazione dal peso, passo fuso stream + collide in schema pull, due buffer
  (ping-pong) in storage buffer. Costanti in `gdv/lattice3d.py`, generate in TypeScript come in
  §10.2. Contorni come §9.3 estesi al 3D: ingresso a velocità imposta con rampa, uscita a
  gradiente nullo con spugna e strato assorbente, pareti laterali e soffitto a scorrimento
  libero, pavimento secondo il tipo, corpo con rimbalzo a metà via sui voxel.
- **Pianificatore 3D** nel backend (`physics/planner3d.py`, decisione 4 di §4): `CaseSetup3D` →
  `CasePlan3D` con griglia, τ, Δx, Δt, Re reale e simulato, bloccaggio d'area. Proposta di
  camera: a monte 1,5 L, a valle 3 L (più corta del 2D, per le celle), bloccaggio d'area ≤ 8%
  (10% per i veicoli). I tre contratti di §5 hanno così una variante 3D, coperta dal test 5.
- **Celle e prestazioni stimate**: Bozza ~0,5 M, Normale ~1,5 M, Fine ~4 M di celle. D3Q19 muove
  152 B per cella e passo: sull'Iris Xe (~70 GB/s) si stimano 180–280 M celle/s, cioè 120–180
  passi/s a Normale, 4–6 passi per fotogramma a 30 fps; il flusso percorre una lunghezza del
  corpo in 3–4 s. Memoria: ~230 MB a Normale, ~600 MB a Fine. **Da misurare** prima di fissare
  i preset (come §17).
- **Voxelizzazione** nel Web Worker dalla mesh piena (`mesh.bin`, §7.2): parità dei raggi lungo
  z per colonna, con i triangoli raggruppati per colonne; per una mesh non chiusa, voto di
  maggioranza su raggi lungo i tre assi. Una cella è solida se il suo centro è dentro.
- **Resa**: un piccolo renderer WebGPU proprio (niente dipendenze nuove): modello (mesh di vista
  §6.6) con Cp in superficie, piano di taglio, filamenti di fumo (striscie di punti emessi dagli
  ugelli e trasportati con RK2 sulla GPU), particelle, pavimento e camera di prova. Le scene
  three.js del 2D restano come sono.
- **Forze**: scambio di quantità di moto sui collegamenti fluido–voxel, ridotto sulla GPU ogni 8
  passi e letto in modo asincrono; area frontale proiettata dai voxel; stesse regole di media,
  convergenza e instabilità di §9.5.
- **Avvisi**: «Similitudine parziale» quasi sempre attivo (un'auto a 30 m/s ha Re ~10⁷, la griglia
  ne simula ~10³), con una spiegazione adatta alla scuola; «Griglia grossolana: i dettagli più
  piccoli di una cella non esistono per il flusso».

### 24.4 Test e accettazione

Numerati di seguito a §18:

35. Costanti D3Q19: `lattice3d.generated.ts` corrisponde a `gdv/lattice3d.py`; matrici
    coerenti (righe ortogonali, M⁻¹M = I), equilibri scritti a mano = momenti di `feq`.
36. Pianificatore 3D: celle del preset, camera (1,5 L a monte, 3 L a valle, bloccaggio d'area),
    similitudine e τ_min, pavimento (quota reale, varco sul nastro, corpo appoggiato), lunghezza
    e area di riferimento cambiano solo i numeri di similitudine e la normalizzazione.
37. Riferimento 3D — condotto quadrato di Poiseuille: errore L2 < 1% a 24 celle di lato contro la
    soluzione in serie, livello di pressione fermo; instabilità forzata rilevata (come test 26).
38. Riferimento 3D — sfera a Re 20 (Cd di riferimento 2,61) e a Re 100 (1,09; Schiller–Naumann),
    con la correzione di bloccaggio, entro il 15% alla risoluzione Normale (`-m slow`).
39. Shader WGSL contro riferimento (playwright, Chrome di sistema, WebGPU su SwiftShader): 500
    passi su 32³, sfera libera, blocco sul pavimento mobile, blocco sul pavimento fisso con strato
    limite: scarto relativo massimo della velocità < 10⁻³ e stesse forze.
40. Voxelizzazione (vitest): sfera, cubo, toro, cubo con un buco (voto di maggioranza);
    rotazioni, ingombro e area frontale del corpo ruotato.
41. E2E (7b–7c): modello → galleria 3D → fumo, particelle, piano, Cp in superficie → studio
    salvato → report; zero errori in console.
42. Test 4 (nessuna rete) con una sessione 3D.

Misure: ≥ 30 fps a Normale con fumo e particelle; voxelizzazione di 1 M triangoli ≤ 2 s.

### 24.5 Ordine dei lavori

7a solutore 3D e validazione senza interfaccia; 7b galleria 3D (resa, fumo, particelle, piano,
Cp, camera, pavimento, preset); 7c numeri, studi 3D, confronto, VTK, PDF. Revisione dell'utente
alla fine di ciascuna.

### 24.6 Scelte fatte nella 7a (2026-10-20; confermate dall'utente alla revisione della 7a)

- **Reticolo e collisione** (`gdv/lattice3d.py`): direzioni in coppie opposte (1–2, 3–4, …);
  base dei momenti di d'Humières et al. (2002), righe ortogonali; equilibri dei momenti = momenti
  dell'equilibrio del secondo ordine (la stessa scelta del 2D: con tempi tutti uguali la
  collisione è BGK); tempi non idrodinamici di d'Humières: s_e 1,19, s_ε 1,4, s_q 1,2, s_π 1,4,
  s_m 1,98; Smagorinsky con C_s 0,1 sul tensore completo delle sollecitazioni fuori equilibrio.
- **Solutore WGSL** (`sim3d/`): un buffer di popolazioni per livello temporale, direzione per
  direzione (`f[k·n + cella]`, 152 byte per cella e passo), corpo come maschera a bit; i prodotti
  per M e M⁻¹ sono scritti per esteso dal generatore sulle sole voci non nulle, nello stesso
  ordine del riferimento Numba (scarto misurato 2·10⁻⁷ sulla velocità). Pareti laterali e
  soffitto a scorrimento libero specchiando le componenti che le attraversano. Misura ogni 8
  passi con una riduzione per workgroup, letta in modo asincrono. Tipi di WebGPU: nella 7a
  dichiarati a mano in `sim3d/webgpu.d.ts` (TypeScript 5.9 non li ha); dalla 7b si usa
  **`@webgpu/types`** (solo sviluppo, BSD-3-Clause), approvato dall'utente il 2026-10-20.
- **Convenzioni del caso**: il modello ruota attorno al centro del suo ingombro, prima il
  beccheggio attorno a y (positivo a cabrare), poi l'imbardata attorno a z (positiva in senso
  antiorario vista dall'alto). L'interfaccia ruota la mesh e manda al pianificatore l'ingombro del
  corpo ruotato e la sua area frontale (geometria, non fisica).
- **Camera 3D**: 1,5 L a monte, 3 L a valle; sezione con lo stesso margine ai lati e sopra (e
  sotto senza pavimento) tale che l'area frontale ne blocchi l'8% (10% per i veicoli), ma almeno
  metà della dimensione più grande del corpo (dal 2026-10-21: della dimensione frontale più
  grande, §24.8). **Nessuna camera lunga a basso Re** (a differenza
  del 2D): sulla sfera a Re 20 e 100, portare il monte da 1,5 a 5 D cambia Cd del 2–3%, mentre il
  bloccaggio da 8% a 2,2% lo cambia del 9–14%; allungare la camera costerebbe 3 volte le celle.
- **Preset misurati sull'Iris Xe** (WebGPU su Vulkan, sfera): Bozza 0,51 M celle 689 passi/s;
  **Normale 1,48 M celle 248 passi/s** (368 M celle/s, 1,5 s per tempo convettivo con D = 30
  celle); Fine 4,0 M celle 92 passi/s. Il solutore è limitato dalla banda di memoria (la
  dimensione del workgroup, 64–256, non cambia nulla). I preset restano 0,5 / 1,5 / 4 M.
- **τ_min 3D = 0,502 con ogni pavimento**: misurato sulla GPU (Normale, 30.000 passi a caso)
  sfera, cubo, auto a scatola sul nastro (a 2 o 3 celle, o appoggiata) ed edificio sul pavimento
  fisso con strato limite reggono fino a 0,5005. Il pavimento fisso non chiede lo 0,504 del 2D.
- **Varco sul pavimento mobile**: 3 celle come nel 2D (a una cella l'auto diverge al passo 1200;
  a due regge).
- **Area di riferimento dei coefficienti** = area frontale dei voxel (quella che il flusso
  vede); l'area rasterizzata fine della mesh serve al pianificatore per dimensionare la camera.
  L'interfaccia, dopo la voxelizzazione, ripianifica con `reference_area_m2` (stessa griglia).
- **Validazione della sfera (test 38)**: con la correzione di bloccaggio per continuità
  (Cd_c = Cd·(1 − A/C)²) la camera del pianificatore a Normale dà 2,86 a Re 20 (+9%) e 1,125 a
  Re 100 (+3%). **Nella galleria 3D e nei risultati si mostra il Cd corretto** per il bloccaggio
  (decisione dell'utente, 2026-10-20), con il bloccaggio tra le condizioni (§2.3).

### 24.7 Scelte fatte nella 7b (2026-10-20; confermate dall'utente alla revisione della 7b, 2026-10-21)

- **Schermata** `/galleria3d/:id` (`pages/Tunnel3D.tsx`), aperta da «Galleria 3D» nella
  preparazione del modello e nel pannello «Modello 3D» della galleria 2D; da lì «Galleria 2D
  (sezioni)» torna al 2D. Stessa disposizione del 2D: condizioni e viste a sinistra, barra in
  alto con Re reale e simulato, Mach, **bloccaggio d'area**, griglia, celle sul corpo, τ, passi/s e
  fps, badge «Similitudine parziale» (tooltip per la scuola, con i due Re) e «Griglia
  grossolana» (sempre, con il lato della cella). I risultati (pannello di destra) arrivano con la
  7c. Velocità, fluido, temperatura, pavimento, ingresso, risoluzione, imbardata e beccheggio
  ripartono da zero; la lunghezza di riferimento no (stesso reticolo, come §9.4). Tipo
  «veicolo»: bloccaggio d'area al 10%, gli altri all'8%; riferimento «corda» = lunghezza lungo x.
- **Rotazioni**: cursori di imbardata (±180°) e beccheggio (±90°) e campi numerici; durante il
  trascinamento il modello ruota a schermo e il flusso è in pausa, al rilascio nuovi voxel, nuovo
  piano, flusso da zero (riparte da solo se l'utente non l'aveva messo in pausa).
- **Ordine di un caso**: geometria nel worker (`voxel.worker.ts`: corpo ruotato, ingombro e area
  frontale) → piano → voxel sulla sua griglia (in cache per rotazione e griglia) → piano con
  `reference_area_m2` = area frontale dei voxel → solutore. Le pipeline del solutore si compilano
  una volta per dispositivo.
- **Campo per la resa**: a ogni fotogramma con passi nuovi le popolazioni diventano una texture
  3D `rgba16float` (ux, uy, uz, δρ; 8 byte per cella) che tutte le viste campionano con il filtro
  trilineare dell'hardware. Nelle celle solide δρ è la media delle vicine fluide sulle facce, così
  la pressione letta alla parete non scende verso zero.
- **Piano di taglio**: trasversale, longitudinale (predefinito, per il centro del corpo) o
  orizzontale; velocità (viridis) o Cp (mappa divergente); le celle del corpo sul piano sono grigie
  (la forma che vede il flusso). Il piano trasversale parte mezza lunghezza dietro il corpo.
- **Cp sulla superficie**: per frammento, letto 0,75 celle fuori dalla superficie lungo la normale
  (normali dei vertici pesate per area, dalla mesh di vista).
- **Fumo**: rastrello di 15 ugelli (2–48) orizzontale o verticale (o a griglia, §24.10), a metà strada tra ingresso e
  corpo, largo 1,2 volte il corpo, spostabile e allargabile dal pannello; un punto per ugello a
  ogni fotogramma con flusso, 384 punti per filamento, trasporto RK2 con il numero di passi del
  fotogramma, nastri di 2 px che sfumano con l'età. Un punto che finirebbe nel corpo **scivola
  sulle sue facce** (asse per asse) invece di sparire: senza, il fumo che arriva sul muso si
  fermava lì.
- **Particelle**: 50.000 (non 100.000 come nel 2D: in un volume coprivano tutto e il riempimento
  dimezzava i passi/s), nate a caso nel fluido, vita 120–360 fotogrammi, trattini lunghi 2,5 celle
  alla velocità del vento e al più 18 px a schermo, colorati per velocità.
- **Scale dei colori** come nel 2D: 2°–98° percentile, simmetrica per Cp; letta ogni 400 ms da
  ~6000 celle del piano e ~4000 punti appena fuori dalla superficie. **Durante la rampa
  d'avvio** la scala è fissa (velocità 0–1,3 V, Cp ±1): automatica inseguiva velocità mille volte
  più piccole del vento. «Blocca scala» le ferma tutte.
- **Passi per fotogramma**: si cerca un fotogramma di ~27 ms di GPU (≥ 30 fps con margine), con al
  più due fotogrammi in attesa sulla GPU (che così non resta mai ferma); misura ogni 8 passi come
  nel 2D. Con `passi_per_frame` fisso vale quello.
- **Telecamera** orbitale, z in alto, vista iniziale isometrica sul corpo con la scia; pulsanti
  Isometrica/Frontale/Laterale/Dall'alto; la vista non tocca la simulazione.
- **Istantanea** (S) a risoluzione doppia, con legende e condizioni (Re, griglia, passo,
  similitudine parziale, griglia grossolana); **video** (V) WebM come nel 2D.
- **Dispositivo perso**: «La GPU ha interrotto la simulazione» e «Riprendi» (nuovo dispositivo,
  stesso caso). Senza WebGPU: il messaggio di §24.2 #2.
- **Test**: test 41 (parte 7b) in `frontend/tests/e2e/phase7.e2e.mjs`, test 42 nel test 4 con
  una sessione 3D, vitest `tunnel3d.test.ts` (telecamera, modello disegnato = voxel, rastrello,
  punti di campionamento, scale, client del worker). L'e2e e il test 4 usano WebGPU sulla GPU
  vera (Vulkan), come i benchmark: in Chrome headless un canvas WebGPU su SwiftShader perde
  l'istanza al primo fotogramma (solo il calcolo funziona, per questo il test 39 resta lì).
- **Misure** (2026-10-20, Iris Xe, alimentatore, profilo «performance», corpo di Ahmed sul nastro,
  piano + Cp in superficie + fumo + particelle, finestra 1440×900): Bozza 0,50 M celle 603 passi/s,
  37 fps; **Normale 1,50 M celle 184 passi/s, 37,6 fps** (P5 37); Fine 3,98 M celle 67 passi/s,
  34,5 fps. Target di §24.4 (≥ 30 fps a Normale con fumo e particelle) rispettato.

### 24.8 Revisione della 7b (2026-10-21): la forma del corpo nel calcolo

Alla revisione l'utente ha confermato tutte le scelte di §24.7 e ha notato che un modello vero
(un'auto da 22 cm) perde troppo della sua forma. Non era solo la resa: il modello è disegnato
dalla mesh di vista, liscio, ma il flusso vede un corpo a gradini di celle (a Normale 3,4 mm,
l'auto 65 × 19 × 17 celle; le parti più sottili di una cella sparivano). Decisioni dell'utente:

1. **Camera più stretta per i corpi slanciati**: il margine minimo attorno al corpo è metà della
   sua dimensione frontale più grande (larghezza o altezza), non della lunghezza. Prima, per un
   corpo lungo e basso, il margine dalla lunghezza dominava (l'auto: bloccaggio 4,6% invece del
   10% ammesso, metà delle celle lontane dal corpo). Sfera e cubo non cambiano.
2. **Pareti interpolate** (Bouzidi, Firdaouss e Lallemand 2001, interpolazione lineare) al posto
   del rimbalzo a metà via sul corpo: per ogni collegamento tra una cella fluida e la superficie
   si conosce la distanza vera della parete, q ∈ (0, 1] in frazioni del collegamento, e la
   popolazione riflessa la usa: q < ½: f_k̄(x) = 2q f*_k(x) + (1 − 2q) f*_k(x + c_k̄); q ≥ ½:
   f_k̄(x) = f*_k(x)/(2q) + (1 − 1/(2q)) f*_k̄(x). Sono combinazioni convesse (nessuna
   amplificazione). Dove x + c_k̄ non è fluido si torna al rimbalzo a metà via; dove una cella
   solida non ha intersezione sul collegamento (voxel deciso a maggioranza) vale q = ½.
   - Le q si calcolano nel worker della geometria intersecando i collegamenti con i triangoli
     della mesh piena; si conservano a 8 bit (q = b/255, b = 0: nessuna parete), 18 per cella
     di confine, più un indice per cella.
   - **Parti sottili**: un collegamento tra due celle fluide che attraversa la superficie è una
     parete per entrambe (con la sua q da ciascun lato): un alettone più sottile di una cella
     esiste per il flusso anche se nessun centro di cella cade dentro.
   - **Forze**: scambio di quantità di moto con la popolazione riflessa vera,
     F = Σ c_k (f*_k(x) + f_k̄(x, t+1)), più la correzione per ρ∞ di §9.5 sugli stessi
     collegamenti.
   - Il pavimento e le pareti della camera restano come in §24.3; la galleria 2D resta col
     rimbalzo a metà via (§22).
3. **«Mostra i voxel»**: un interruttore della galleria 3D disegna il corpo come lo vede il
   flusso (le facce esterne delle celle solide) al posto della mesh, per far vedere a scuola cosa
   vuol dire «griglia grossolana».
4. I preset restano Bozza / Normale / Fine.

### 24.9 Scelte fatte nella 7c (2026-10-21; confermate dall'utente alla revisione della 7c, 2026-10-21)

- **Contratto**: `SimulationResult3D` è la variante 3D del terzo contratto (§5): `dimension:
  "3d"`, `CaseSetup3D`, `CasePlan3D`, `Coefficients3D` (Cd, Cl, Cs corretti, Cd misurato, fattore
  di correzione, regime, variazione, passi mediati, ρ∞), `Forces3D` (resistenza, portanza,
  laterale in N), storia, campi 3D. Un risultato 2D scrive `dimension: "2d"`; i file scritti
  prima, senza il campo, si leggono come 2D. `StudyPoint.result` è l'uno o l'altro. Coperti dal
  test 5.
- **Numeri** (pannello a destra della galleria 3D): Cd lungo x, Cl verso l'alto (+z), **Cs
  laterale** (+y), sull'area di riferimento (frontale delle celle), normalizzati con ρ∞, medie e
  convergenza come §9.5 (il distacco si cerca su Cl o su Cs, quello che oscilla di più). **La
  correzione di bloccaggio (1 − A/C)² vale per tutti i coefficienti e per le forze** (è una
  correzione della velocità di riferimento): forze «all'aria libera», ½ ρ V² · A_rif · C. Il
  fattore lo calcola il pianificatore (`blockage_correction` in `CasePlan3D`); il Cd misurato
  nella camera sta nel suggerimento e nello studio. **Niente Cm né Strouhal in 3D**: un momento
  del corpo intero e una frequenza adimensionata con la lunghezza lungo x direbbero poco a scuola.
- **Campo medio**: (δρ, u_x, u_y, u_z) sommati sulla GPU nello stesso passaggio della misura,
  una misura su quattro (un campione ogni 32 passi: sommare 24 MB a ogni misura faceva
  inceppare i fotogrammi; misurato il 2026-10-21), dopo il transitorio e di nuovo dopo un cambio
  della lunghezza di riferimento,
  16 byte per cella (24 MB a Normale). Salvato come `u`, `v`, `w` su V e `cp`, float16, forma
  (nz, ny, nx), più le celle solide; niente vorticità (ParaView la ricava).
- **Studio 3D**: sempre singolo (la galleria 3D non fa serie). Tre immagini a risoluzione doppia,
  con legenda e condizioni: «vista» (com'era al salvataggio), «piano» (piano longitudinale per il
  centro del corpo, velocità, vista laterale), «superficie» (Cp sul modello, isometrica); la
  miniatura viene dal piano. Mentre si salvano, la galleria mostra per un attimo le due viste
  fisse. Uscire con numeri 3D non salvati chiede conferma come nel 2D (§13).
- **Pagina dello studio, report, export**: condizioni con rotazioni, area di riferimento e
  bloccaggio con il fattore; coefficienti e forze in N; avvisi (provvisorio, similitudine
  parziale, griglia grossolana, bloccaggio); immagini; storia di Cd, Cl, Cs. Export: storia CSV
  (`passo;tempo_s;Cd;Cl;Cs`, condizioni in testa), campi 3D in VTK `.vti` (velocità vettore,
  Cp, pressione in Pa, solido), JSON (senza contorno), PDF. Niente contorno, DXF/SVG né
  `fields.bin` per un risultato 3D.
- **Confronto**: gli studi 3D si confrontano tra loro (Cd, Cl, Cs; diversi se Re simulato o area
  di riferimento differiscono oltre il 2%); uno studio 2D accanto a uno 3D è sempre «non
  confrontabile». Le immagini 3D si affiancano, ognuna con la sua scala (sono immagini salvate,
  non campi).
- **Test**: test 41 completo (`phase7.e2e.mjs`: numeri e forze, «Mostra i voxel», studio salvato
  con tre immagini e campo 3D, pagina dello studio, VTK e CSV, report e PDF, confronto); pytest
  `test_studies3d.py` (salvataggio e rilettura, caso instabile, VTK 3D riletto, CSV, JSON,
  confronto, niente serie, studio 2D senza `dimension`); vitest del caricamento 3D e del distacco
  laterale.
- **Passi per fotogramma frazionari** (2026-10-21, dopo la revisione): ogni fotogramma fa passi
  interi ma la frazione si porta al successivo, così la media è quella che la GPU regge (4,3 a
  Normale) invece di arrotondarla (4). Le celle con pareti hanno anche una maschera a bit, letta
  prima dell'indice.
- **Misure** (2026-10-21, Iris Xe, alimentatore, «performance», corpo di Ahmed sul nastro, tutte
  le viste, 1440×900): Bozza 591 passi/s, 37,9 fps (P5 37); **Normale 161 passi/s, 37,9 fps
  (P5 37)**; Fine 62 passi/s, 38,2 fps (P5 37). Il calo rispetto ai 184 passi/s della 7b non
  viene dal codice: il codice della 7b con la camera nuova fa 155–160. La camera più stretta
  (§24.8) mette le stesse 50.000 particelle in un volume più piccolo attorno al corpo e la resa
  costa di più. Il solutore da solo è invariato (226–243 contro 231–245 passi/s a Normale).

### 24.10 Griglia di fumi (richiesta dell'utente, 2026-10-21)

L'utente vuole poter usare **una griglia di ugelli, non solo una fila**. Scelte fatte, provvisorie
fino alla sua prova:

- Nel pannello del fumo, «Ugelli» ha una terza voce, **«a griglia»**: ugelli sul piano trasversale
  (x costante), `nozzles` per fila lungo y su «Larghezza» e `rows` file lungo z su «Altezza»,
  centrata sulla «Quota». Per una griglia «Numero di ugelli» diventa «Ugelli per fila», e c'è
  «File»; entrambi 2–16, quindi al massimo 256 filamenti (la fila resta 2–48). Si parte da 8 × 6,
  larga e alta 1,2 volte il corpo, a metà strada tra ingresso e corpo come la fila. Nella scena un
  filo per fila e i due montanti laterali.
- Il buffer dei filamenti passa da 48 a 256 ugelli (16 B × 384 punti × 256 = 1,5 MB). Ogni
  filamento è come prima: un punto per fotogramma, 384 punti, nastri che sfumano con l'età.
- **Misure** (2026-10-21, Iris Xe, alimentatore, «performance», benchmark con tutte le viste,
  `GDV_BENCH_SMOKE=griglia` per una griglia 16 × 16): Normale 158 passi/s contro 166 della fila
  (−5%), Fine 59 contro 60, 38 fps in entrambi i casi. Cali isolati del P5 (fino a 3–17 fps) si
  sono visti in qualche corsa sia con la fila sia con la griglia: disturbo della macchina, non
  della griglia.
- Test: vitest della griglia (posizioni riga per riga, limiti del pannello) e l'e2e della Fase 7
  che passa dalla griglia.

---

## 25. Fase 8 — Versione per Windows (approvata il 2026-10-21)

> Stato: **approvata** dall'utente il 2026-10-21 («approvo tutto»), compresi PyInstaller come
> dipendenza di build e la proposta di §25.4. Confermati anche l'eseguibile a cartella e
> nessun intervento sulla scelta della GPU (§25.2, punti 4 e 5).

### 25.1 Obiettivo

Uno **zip per Windows 10/11 (x64)** da dare agli studenti e ai PC della scuola, da usare anche
per progetti personali. Si estrae dove si vuole e si avvia `galleriaDelVento.exe`, senza
installazione e senza permessi di amministratore. Il programma è lo stesso: stesse schermate,
stessa fisica, stessi invarianti di §2. **La versione per Linux resta com'è**: nessun cambio di
comportamento, di struttura, di `install.sh` o dei test esistenti.

L'utente ha solo PC Linux: lo zip lo costruisce e lo prova GitHub, su una macchina Windows.

### 25.2 Decisioni dell'utente (2026-10-21)

1. **Un solo codice** per i due sistemi, con tutto ciò che è specifico di Windows confinato in
   un modulo e in `packaging/windows/`. Niente rami o copie separate.
2. **Dati nel profilo dell'utente Windows** (non accanto all'eseguibile, niente modalità
   portatile). Se un PC della scuola azzera il profilo al logout, i dati si perdono: è un limite
   accettato.
3. **Build con GitHub Actions** e zip pubblicato nelle **Release** del repository pubblico, da
   cui gli studenti lo scaricano.
4. **Eseguibile a cartella**, non a file unico: una volta avviato va alla stessa velocità, ma il
   file unico estrae 300–400 MB a ogni avvio (10–30 s su un disco lento) e viene segnalato più
   spesso dagli antivirus.
5. **GPU: nessun intervento** (decisione poi cambiata dall'utente il 2026-10-21, dopo la prova su
   un portatile con NVIDIA: §25.8). Il frontend chiede già la GPU più potente
   (`powerPreference: 'high-performance'` in WebGL2 e WebGPU); sui portatili con due GPU la
   scelta resta al browser e a Windows. Niente nome della GPU nell'interfaccia.

### 25.3 Scelte tecniche (proposte)

- **`backend/gdv/winsupport.py`**: l'unico modulo con codice per Windows, solo libreria
  standard (`ctypes`, niente `pywin32`). I moduli esistenti lo usano con una sola riga di
  smistamento (`if sys.platform == "win32"`) nei quattro punti in cui Linux e Windows
  differiscono (i primi quattro previsti dalla bozza, gli altri trovati rileggendo il codice):
  1. *Segnali* (`runtime.py`): su Windows non esiste `SIGHUP`; si usano `SIGINT`, `SIGTERM` e
     `SIGBREAK`.
  2. *Processo vivo* (`single_instance.py`): su Windows `os.kill(pid, 0)` non controlla, manda
     un Ctrl+C (lo `0` è `CTRL_C_EVENT`). Al suo posto `OpenProcess` + `GetExitCodeProcess`.
  3. *Cartelle* (`config.py`): tutto sotto `%LOCALAPPDATA%\galleriadelvento\` (`dati\`,
     `stato\logs\`, `config\`, `cache\tmp\`, lock in `stato\`). Local e non Roaming: i modelli
     arrivano a 500 MB e un profilo roaming li copierebbe a ogni accesso. Le variabili `GDV_*` e
     `XDG_*`, se impostate, valgono anche su Windows (i test le usano per isolarsi).
  4. *Browser* (`window.py`): Chrome se c'è, altrimenti **Microsoft Edge**, che è presente su
     ogni Windows 10/11, accetta `--app` e `--user-data-dir` e ha WebGL2 e WebGPU. Si cercano i
     percorsi d'installazione (`Program Files`, `Program Files (x86)`, `%LOCALAPPDATA%`), che
     su Windows non sono nel PATH. Gli stessi percorsi servono al PDF (§11.6).
     *Primo piano*: al secondo avvio la finestra esistente viene portata davanti con
     `EnumWindows` + `SetForegroundWindow` sul processo della finestra (al posto di
     `wmctrl`/`xdotool`). Se Windows lo impedisce, la finestra lampeggia nella barra.
     Il messaggio «Installa Chromium (sudo snap install chromium)» diventa «Installa Microsoft
     Edge o Google Chrome».
  5. *Finestra sì o no* (`runtime.py`): su Linux la finestra si apre se c'è `DISPLAY` o
     `WAYLAND_DISPLAY`, che su Windows non esistono; lì si apre sempre, salvo `--no-window`.
  6. *Porta libera* (`single_instance.py`): su Windows `SO_REUSEADDR` permette di agganciarsi
     a una porta già in ascolto, quindi la prova direbbe sempre «libera»; lì si usa
     `SO_EXCLUSIVEADDRUSE`.
  7. *Errori senza console*: con `--noconsole` non c'è un terminale su cui stampare. L'avvio
     dell'eseguibile (`packaging/windows/launcher.py`, fuori dal pacchetto `gdv`) raccoglie
     quello che il programma scrive su stderr e, se esce con un errore (porta occupata, server
     che non parte, eccezione), lo mostra in una finestra di messaggio di Windows con il
     percorso del log.
  8. *Tipi dei file dell'interfaccia* (`server.py`): Python li legge dal registro di Windows,
     dove `.js` risulta spesso `text/plain`, e Chrome rifiuta uno script modulo servito come
     testo (finestra bianca). Su Windows i tipi dell'interfaccia (`.js`, `.css`, `.html`,
     `.json`, `.svg`, `.png`, `.wasm`) vengono fissati sopra il registro.
- **Eseguibile**: **PyInstaller** in modalità cartella (`--onedir`, non file unico: parte più in
  fretta e viene scambiato meno spesso per un virus), senza console (`--noconsole`: messaggi e
  traceback vanno nel log di `stato\logs\`), icona `.ico` generata da `packaging/make_icons.py`
  con la stessa geometria, `backend/gdv/static/` incluso. File in `packaging/windows/`:
  `galleriadelvento.spec`, `LEGGIMI.txt` per gli studenti (come avviarlo, l'avviso di
  SmartScreen, dove stanno i dati, requisiti di GPU).
- **Dipendenza nuova**: PyInstaller (GPL-2.0-or-later con eccezione per il bootloader:
  compatibile, non impone niente al programma), solo in un gruppo `windows-build`
  installato dall'azione, **non** nel gruppo `dev`: su Linux non si installa.
- **Azione `.github/workflows/windows.yml`** su `windows-latest`, avviata da un tag `v*`
  (e a mano): build del frontend, `uv sync`, test, PyInstaller, prova dell'eseguibile, zip
  `galleriaDelVento-<versione>-windows-x64.zip` con il suo SHA-256 allegati alla Release. Il tag
  deve coincidere con `version` di `pyproject.toml`. Ogni push di tag resta su richiesta
  esplicita (§21.4).
- **Nessun cambio all'interfaccia**: il frontend compilato è lo stesso.

### 25.4 Invariante §2.2 (domanda bloccante)

Edge è un **soggetto nuovo** per l'invariante «nessuna rete»: ha servizi Microsoft propri
(SmartScreen, telemetria, funzioni «Edge») che la lista di §2.2, verificata su Chrome 155, non
conosce. Proposta:

- stessa lista di flag; la barriera finale `--host-resolver-rules` vale anche per Edge (nessun
  nome si risolve tranne il loopback), quindi un servizio che chiama a casa per nome fallisce
  prima di aprire un socket;
- **test 4 rifatto nell'azione con Edge** (proxy di registrazione su loopback, come su Linux);
  gli host Microsoft che compaiono vanno spenti con un flag o dirottati sulla porta 9 come per
  Chrome, e quelli che restano si discutono con l'utente prima del rilascio;
- se Chrome è installato si preferisce Chrome, già verificato.

### 25.5 Test e accettazione

- **Su Linux**: tutta la suite attuale resta verde e invariata.
- **Test nuovi** (girano su entrambi i sistemi, con i rami Windows simulati su Linux): cartelle
  Windows da `%LOCALAPPDATA%` e precedenza di `GDV_*`/`XDG_*`; ricerca di Edge e Chrome nei
  percorsi di Windows; processo vivo; segnali registrati senza `SIGHUP`.
- **Nell'azione su Windows**: pytest senza `browser`, `gpu` e `slow`. I test solo Linux
  (`install.sh`, Flatpak, `WM_CLASS`) vengono saltati con il motivo scritto. Poi il test 4 con
  Edge e la **prova dell'eseguibile**: avvio con `--no-window`, `GET /api/health`, controllo
  Host/Origin, secondo avvio che riconosce il primo, chiusura con `POST /api/app/quit`,
  lockfile rimosso.
- **Collaudo dell'utente su un PC della scuola** (GitHub non ha GPU né schermo): avvio dallo
  zip, finestra Edge senza barre, chiudere la finestra chiude il programma (va verificato che
  l'«avvio rapido» o le app in background di Edge non tengano vivo il processo), galleria 2D,
  galleria 3D, import di un STL, studio e PDF. Le misure di §17 e §24.4 valgono per l'Iris Xe e
  sui PC della scuola si annotano soltanto.

### 25.6 Ordine dei lavori

1. `winsupport.py` e i quattro smistamenti, con i loro test; suite Linux verde.
2. `packaging/windows/` e l'azione; prima corsa avviata a mano (senza tag), zip scaricato dagli
   artefatti.
3. Test 4 con Edge nell'azione e decisioni sugli host che compaiono (§25.4).
4. Collaudo dell'utente su un PC della scuola, poi il primo tag e la prima Release.
5. Dopo l'approvazione: §1, §3, §13, §14.1 e §16 aggiornati per dire che esiste una versione
   Windows; README con una sezione per Windows.

### 25.7 Rischi noti

- **SmartScreen**: lo zip non è firmato, quindi al primo avvio Windows mostra «Windows ha
  protetto il PC» → «Altre informazioni» → «Esegui comunque». Sui PC gestiti dalla scuola può
  servire l'autorizzazione del tecnico. Firmare costa (un certificato a pagamento) ed è fuori
  da questa fase.
- **Antivirus**: gli eseguibili di PyInstaller ogni tanto vengono segnalati per errore; la
  modalità a cartella riduce il problema.
- **GPU dei PC della scuola**: il 2D richiede WebGL2 con `EXT_color_buffer_float`, il 3D WebGPU;
  se mancano, i messaggi di §3 e §24.2 restano validi.
- **Dimensioni**: circa 300–400 MB estratti (scipy, opencv, numpy).

### 25.8 Scelte fatte nella Fase 8 (2026-10-21)

- **Test 4 su Windows senza playwright** (`tests/test_offline_windows.py`): playwright aggiunge
  switch suoi (fra cui alcuni anti-rete) che nasconderebbero proprio il traffico di Edge. Il
  browser parte con l'argv della finestra vera, più `--proxy-server` verso il proxy di
  registrazione di `test_offline.py`, aperto per 90 s sulla galleria di un NACA 0012. Gira su
  Edge e su Chrome (il runner li ha entrambi) e stampa nel log dell'azione gli host estranei,
  che §25.4 fa decidere all'utente. Un secondo test cerca ogni nome di funzione e di switch di
  §2.2 in `msedge.dll` / `chrome.dll`, come su Linux nel binario di Chrome.
- **Test saltati su Windows**, con il motivo: i due test della finestra con il finto browser
  (è uno script `sh`) e quello di SIGTERM (su Windows è `TerminateProcess`). `test_install.py`
  si salta già da solo.
- **Prova dell'eseguibile** (`packaging/windows/smoke.py`, solo libreria standard): avvio senza
  finestra con `%LOCALAPPDATA%` in una cartella temporanea, interfaccia e tipo degli script,
  pagina estranea rifiutata, import di un STL (trimesh, scipy), di un SVG (svgelements), di una
  foto PNG (OpenCV), export DXF (ezdxf), secondo avvio, «Esci», lock rimosso. Provata anche
  sulla stessa ricetta costruita su Linux (2026-10-21: 370 MB, tutto verde).
- **PyInstaller 6.22.3**, senza UPX (falsi allarmi degli antivirus). Icona
  `packaging/icons/galleriadelvento.ico` (16–256 px, ogni misura disegnata a parte) generata da
  `make_icons.py`.
- **Azione**: Node 24, `npm ci` e build dell'interfaccia, `uv sync --group windows-build`,
  controllo che tag, `pyproject.toml` e `gdv.__version__` coincidano, pytest senza `slow` e
  `gpu`, PyInstaller, prova, zip con SHA-256 tra gli artefatti; con un tag, Release con `gh`.
- **Note di rilascio** in `docs/release-notes/<versione>.md`, in italiano per studenti e
  insegnanti: la prima riga è il titolo della Release, il resto la descrizione. Con un tag
  l'azione si ferma se il file manca (richiesta dell'utente, 2026-10-21: «descrizione e nome
  significativo»). Un paragrafo per riga: GitHub mostra ogni a capo della
  descrizione di una Release.
- **Rete di Edge, decisione dell'utente (2026-10-21, §25.4: «accettarli così»).** Nell'azione,
  Chrome 155 su Windows non fa nessuna richiesta estranea. Edge 154 ne tenta cinque, verso
  servizi suoi che nessun flag della lista spegne (dal net-log):
  `edge.microsoft.com/abusiveadblocking/api/v1/blocklist` (siti con pubblicità abusive),
  `edge.microsoft.com/serviceexperimentation/v3/` (esperimenti, come le «variations» di Chrome),
  `edge-consumer-static.azureedge.net/mouse-gesture/config.json` (gesti del mouse),
  `www.bing.com/api/shopping/v1/user/shoppingsettings` e
  `www.bing.com/bloomfilterfiles/ExpandedDomainsFilterGlobal.json` (Shopping). Sono **residui
  accettati**, come l'«activity reporter» di Chrome: nella finestra vera falliscono sul DNS
  (`--host-resolver-rules`). Lo verifica a ogni build `test_4_the_dns_barrier_holds_in_the_real_window`:
  la finestra con l'argv vero, senza proxy, per 90 s, e nessuna connessione TCP non loopback dei
  processi del browser (nessuna, né con Edge né con Chrome, nella corsa del 2026-10-21). Il test
  dietro il proxy li accetta per host e per URL: un servizio nuovo, anche sugli stessi host, lo
  fa fallire. Edge non conosce `PreconnectToSearchDesktop` (dichiarato nel test dei nomi).
- **Porta riservata da Windows** (2026-10-21, collaudo dell'utente su un PC Windows): l'avvio
  falliva con «la porta 8853 è occupata da un altro programma», ma nessuno la usava. Windows
  riservava le porte 8761–8860 (`netsh interface ipv4 show excludedportrange protocol=tcp`:
  blocchi di 100 di Hyper-V/WSL da 1036 in su, scelti a ogni avvio), e il bind falliva con
  `WSAEACCES` (10013). Decisione dell'utente («porta libera, ricordata»): su Windows, se la porta
  non è stata scelta con `--port` o `GDV_PORT`, il programma prova la porta ricordata, poi la
  8853, poi una porta assegnata da Windows (porta 0: Windows non assegna mai una porta che
  riserva), e scrive quella presa in `stato\porta`. La porta ricordata occupata da un altro
  programma fa passare alla successiva; la 8853 occupata da un altro programma, o una porta scelta
  dall'utente, resta un errore, ora con il messaggio giusto («riservata da Windows» oppure
  «occupata da un altro programma»). Cambiando porta si perdono solo le preferenze
  dell'interfaccia in `localStorage` (l'origine cambia); il lock registra la porta vera, quindi
  il secondo avvio trova sempre il primo. Su Linux non cambia niente. Gli errori di avvio vanno
  anche nel registro (prima erano solo stampati: il registro non esisteva), anche su Linux.
  Nell'azione la riservazione non si può simulare: un'esclusione aggiunta con `netsh int ipv4
  add excludedportrange` (amministrata) toglie la porta solo all'assegnazione automatica, e il
  bind esplicito riesce lo stesso (misurato il 2026-10-21); quelle di Hyper-V non si creano su un
  runner. La logica è coperta dai test con l'errore di Windows simulato, la prova vera è il PC
  dell'utente.
- **GPU dedicata sui portatili** (2026-10-21, prova dell'utente su un portatile con grafica
  integrata e NVIDIA: la galleria usava l'integrata). Windows assegna a ogni programma una GPU e
  ai browser dà quella a basso consumo; `powerPreference` della pagina non lo cambia. Decisione
  dell'utente («flag + preferenza»): su Windows la finestra riceve
  `--force-high-performance-gpu` e `--use-webgpu-power-preference=default-high-performance`
  (il test dei nomi ne stampa la presenza nel browser, senza farne una condizione), e, mentre
  il programma è aperto, l'eseguibile del browser ha in
  `HKCU\Software\Microsoft\DirectX\UserGpuPreferences` il valore `GpuPreference=2;` (quello
  che scrive Impostazioni → Schermo → Grafica, senza permessi di amministratore). Per tutta la
  sessione e non solo all'avvio, perché il browser può riavviare il suo processo grafico. Alla
  chiusura (`WindowHost.close`) il valore torna com'era; una scelta fatta a mano dall'utente
  (un `GpuPreference=` già presente, o cambiato durante la sessione) non viene toccata. Cosa è
  stato cambiato sta in `stato\gpu-preferenza.json`, così un programma chiuso a forza rimette a
  posto al prossimo avvio. Effetto collaterale dichiarato nel LEGGIMI: un Edge usato per
  navigare mentre il programma è aperto usa anch'esso la GPU dedicata.
