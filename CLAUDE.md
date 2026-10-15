# galleriaDelVento

- **Fonte di verità:** [`docs/SPEC.md`](docs/SPEC.md). Se una scelta la contraddice, vince la SPEC;
  se la SPEC è ambigua, chiedi prima di inventare.
- **Per ripartire:** leggi `STATO.md` (diario locale, non committato): dove siamo, decisioni già
  prese con l'utente (non riaprirle), cosa è stato misurato, insidie. Aggiornalo a fine sessione.
- **Lingue:** codice, identificatori e commenti in inglese; interfaccia, messaggi d'errore per
  l'utente, SPEC e STATO in italiano. Nessuna stringa visibile scritta nei componenti: tutte
  stanno nel dizionario i18n:
  `frontend/src/i18n/it.ts`.

## Comandi

```sh
uv run pytest -q
uv run ruff check . && uv run ruff format --check .
uv run galleriadelvento --no-window       # server senza finestra
cd frontend && npm run build        # scrive in backend/gdv/static/
```

## Architettura di base (dallo scaffold)

Variante: server **fastapi**, finestra **chromium**, interfaccia **react**,
istanza **singola**.

- `runtime.py` possiede l'avvio e la chiusura: il server gira in un thread, il thread principale
  appartiene alla finestra. Tutte le vie d'uscita (finestra chiusa, «Esci», segnali) passano
  dallo stesso evento `stop` e dallo stesso `finally`.
- Il server ascolta solo su `127.0.0.1`; `security.py` rifiuta le pagine estranee (Host/Origin).
- Le route del progetto vanno in `server.py`, in `create_app`, **prima** di `mount_interface`
  (l'interfaccia è un catch-all).
- I file del programma vanno nelle cartelle XDG di `config.py`, mai accanto ai file dell'utente.
