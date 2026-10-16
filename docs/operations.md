# Betrieb

Installation als Dienst, Shutdown/Drain, Updates, Backups, Recovery und Fernzugriff. Spec §4, §13, §14, §15, §20, §21.
API-Referenz: [api.md](api.md) · Worker-Vertrag: [worker-protocol.md](worker-protocol.md) · Cron: [cron-semantics.md](cron-semantics.md)

## Verzeichnisse und Rechte

| Pfad (Vorschlag) | Inhalt | Eigentümer / Modus |
|---|---|---|
| `/etc/agent-orchestrator/` (config-dir) | `config.yaml`, `sources.yaml`, `identities.yaml`, `workflows/`, `views/`, `scripts/` | `root:agent-orchestrator`, Verzeichnisse 0750, Dateien 0640, Skripte 0750 |
| `/etc/default/agent-orchestrator` | Secrets als Umgebungsvariablen (GitHub-App-Keys, Webhook-URLs) | `root:agent-orchestrator`, 0640 |
| `/var/lib/agent-orchestrator/` (data-dir) | `orchestrator.sqlite` (+ `-wal`/`-shm`), `orchestrator.lock`, `logs/`, `runs/`, `workspaces/`, `backups/` | `agent-orchestrator`, 0750 |
| Paket, z. B. `/usr/lib/node_modules/agent-orchestrator/` | Code (`dist/`), wird bei Updates ersetzt | `root`, nur lesbar für den Dienst |

- **Schreibrecht auf config-dir = Codeausführung** mit den Rechten des Dienstes (Skripte, Kommandos in YAML, Spec §20.2).
  Deshalb gehört config-dir `root`, der Dienst kann seine eigene Konfiguration nicht ändern.
- **data-dir muss auf einem lokalen Dateisystem liegen (kein NFS/SMB).** Der Instanz-Lock (`orchestrator.lock`) beruht auf
  `fcntl`-Sperren, die auf Netzwerk-Dateisystemen unzuverlässig sind; zwei Instanzen auf demselben data-dir wären möglich.
- Es läuft genau **eine** Instanz pro data-dir (OS-Sperre, wird bei Prozessende immer freigegeben, auch nach SIGKILL).
  Mehrere Instanzen mit getrennten data-dirs koordinieren sich nicht.
- `workspace.base_dir` (Default `<data-dir>/workspaces`) muss für den Dienst schreibbar sein; liegt es außerhalb von
  data-dir, Rechte selbst setzen.

## Installation als systemd-Dienst (Linux)

Voraussetzungen: Linux mit systemd, Node.js ≥ 22.13 (empfohlen 24 LTS) **systemweit** installiert (z. B. `/usr/bin/node`
aus Distribution/NodeSource – nicht aus `nvm` im Home-Verzeichnis, das der Dienstbenutzer nicht lesen kann).

```bash
# 1. Feste Version global installieren (kein npx im Dienst!)
sudo npm install -g agent-orchestrator@0.1.0          # bzw. sudo npm install -g ./agent-orchestrator-0.1.0.tgz

# 2. Konfiguration anlegen (überschreibt nie bestehende Dateien)
sudo agent-orchestrator init --config-dir /etc/agent-orchestrator --data-dir /var/lib/agent-orchestrator
sudoedit /etc/agent-orchestrator/sources.yaml /etc/agent-orchestrator/identities.yaml   # anpassen
sudo agent-orchestrator config validate --config-dir /etc/agent-orchestrator --data-dir /var/lib/agent-orchestrator

# 3. Vorschau: Unit-Datei und geplante Schritte (ändert nichts)
sudo agent-orchestrator service install --dry-run \
  --config-dir /etc/agent-orchestrator --data-dir /var/lib/agent-orchestrator --create-user

# 4. Installieren: Benutzer anlegen, Rechte setzen, Env-Datei-Vorlage, Unit schreiben, daemon-reload, enable
sudo agent-orchestrator service install \
  --config-dir /etc/agent-orchestrator --data-dir /var/lib/agent-orchestrator --create-user

# 5. Secrets eintragen und starten
sudoedit /etc/default/agent-orchestrator
sudo systemctl start agent-orchestrator
agent-orchestrator status --config-dir /etc/agent-orchestrator
journalctl -u agent-orchestrator -f
```

Optionen von `service install`: `--user`/`--group` (Default `agent-orchestrator`), `--create-user`, `--name` (Unit-Name),
`--node`/`--entry` (absolute Pfade, Default: das laufende Node und diese Installation), `--env-file <pfad|none>`,
`--drain-timeout` (Default 10m), `--cancel-timeout` (Default 2m), `--unit-dir`, `--now` (sofort starten).
`service install` verweigert `npx`-Cache-Pfade, relative Pfade, TypeScript-Quellen und `root` als Dienstbenutzer.
Ohne `--create-user` muss der Benutzer existieren (Hinweis mit passendem `useradd`-Kommando). Eine bestehende Env-Datei wird
nie überschrieben. `service status` zeigt `systemctl status`; `service uninstall` stoppt (Drain), deaktiviert und entfernt nur
die Unit-Datei – config-dir, data-dir und Benutzer bleiben. Auf macOS lehnen die Kommandos mit Erklärung ab
(`--dry-run` funktioniert überall).

### Generierte Unit (Beispiel)

```ini
[Service]
Type=simple
User=agent-orchestrator
Group=agent-orchestrator
ExecStart=/usr/bin/node /usr/lib/node_modules/agent-orchestrator/dist/cli/main.js start --config-dir /etc/agent-orchestrator --data-dir /var/lib/agent-orchestrator --drain-timeout 10m --cancel-timeout 2m
WorkingDirectory=/var/lib/agent-orchestrator
EnvironmentFile=-/etc/default/agent-orchestrator
Environment=NODE_ENV=production
Restart=on-failure
RestartSec=5s
KillMode=mixed
KillSignal=SIGTERM
TimeoutStopSec=810
UMask=0027
NoNewPrivileges=true
PrivateTmp=true
```

`NoNewPrivileges` verhindert `sudo`/setuid in Workern, `PrivateTmp` gibt dem Dienst ein eigenes `/tmp`. Werden weitere
Härtungen (`ProtectSystem=`, `ReadWritePaths=`) gewünscht, per Drop-in (`systemctl edit agent-orchestrator`) ergänzen –
Agent-Skripte brauchen oft Schreibzugriff auf Caches im Home-Verzeichnis. Änderungen direkt in der Unit-Datei überschreibt
das nächste `service install`.

### Stop-/Restart-Vertrag (Spec §14, §24.4)

| Ereignis | Verhalten | Exit | systemd |
|---|---|---|---|
| `systemctl stop` / `restart` | SIGTERM an den **Hauptprozess** → Drain bis `--drain-timeout`, dann Cancel-All (`on_cancel`) bis `--cancel-timeout`, danach werden Hooks unterbrochen (Recovery setzt sie beim nächsten Start fort) | 0 | gestoppt |
| zweites SIGTERM (`systemctl kill --kill-whom=main --signal=SIGTERM agent-orchestrator`) | sofort Cancel-All | 0 | gestoppt |
| drittes Signal | sofortiger Exit (Recovery räumt beim nächsten Start auf) | 1 | – |
| `agent-orchestrator drain` / UI „Drain“ | keine neuen Runs, aktive laufen zu Ende, dann Ende | 0 | inactive, **kein** Neustart |
| `agent-orchestrator cancel-all` / UI „Cancel All“ | alle Runs abbrechen, `on_cancel`, dann Ende | 0 | inactive, **kein** Neustart |
| Absturz / Exit ≠ 0 | – | ≠ 0 | Neustart nach 5 s → Recovery |
| `TimeoutStopSec` abgelaufen | systemd SIGKILLt die ganze cgroup inkl. Worker | – | gestoppt; nächster Start: Runs `crashed` + `on_crash` |

- **`KillMode=mixed`**: SIGTERM geht nur an den Orchestrator, Worker laufen während des Drains weiter. Mit dem Default
  `control-group` bekämen alle Worker sofort SIGTERM (gleiche cgroup trotz eigener Prozessgruppe) → kein Drain möglich.
- **`TimeoutStopSec`** = Drain-Timeout + Cancel-Timeout + größtes `execute.cancel_grace` der Konfiguration + 60 s Puffer
  (wird bei `service install` aus der Konfiguration berechnet; nach Änderungen an `cancel_grace` neu installieren).
- **`Restart=on-failure`**: Ein absichtlicher Shutdown über UI/CLI endet mit Exit 0 und wird **nicht** als Crash neu gestartet.
- **Lange Runs:** Ein Agent-Run dauert oft länger als der Drain-Timeout. `systemctl stop` kann einen vollständigen Drain daher
  nicht garantieren – für geplante Stopps vorher `agent-orchestrator drain --wait` ausführen (beliebig lange, ohne Timeout)
  und erst danach `systemctl stop`/Update/Reboot.
- **Absturz unter systemd:** Stirbt der Hauptprozess, beendet systemd (bei `KillMode=mixed`) auch alle Worker der cgroup per
  SIGKILL. Die Recovery findet beim Neustart die Prozessgruppen daher i. d. R. bereits beendet und finalisiert die Runs als
  `crashed` mit `on_crash` (zählt als technischer Fehler, ggf. Retry-Block). Verwaiste, noch lebende Worker (Recovery tötet
  sie nur bei sicher verifizierter Identität) entstehen v. a. außerhalb von systemd (lokaler Start, `KillMode=process`).
- **Reboot:** wie Absturz – alle Worker sind weg → `crashed` + `on_crash`. Geplante Reboots daher vorher drainen.

## Pause, Drain, Cancel-All

```bash
agent-orchestrator status    --config-dir /etc/agent-orchestrator     # Zustand, Limits, Auslastung, Blocks
agent-orchestrator pause     --config-dir /etc/agent-orchestrator     # keine automatischen Starts (manuelle weiter möglich)
agent-orchestrator resume    --config-dir /etc/agent-orchestrator
agent-orchestrator drain     --config-dir /etc/agent-orchestrator --wait [--timeout 2h]
agent-orchestrator cancel-all --config-dir /etc/agent-orchestrator --reason "maintenance" --wait
agent-orchestrator config reload --config-dir /etc/agent-orchestrator # atomar; ungültige YAML behält aktive Konfiguration
agent-orchestrator workflow dry-run coder --config-dir /etc/agent-orchestrator   # gegen die laufende Instanz, sonst lokal
```

Die Kommandos sprechen per HTTP mit der laufenden Instanz: `--url http://127.0.0.1:8787` oder – mit `--config-dir` – Host/Port
aus `config.yaml` (Wildcard-Binds `0.0.0.0`/`::` werden über Loopback angesprochen). Sie senden den CSRF-Header
`X-Orchestrator-Request: 1`. Exit-Codes: 0 ok, 1 API-Fehler (z. B. Reload abgelehnt), 2 Aufruffehler, 3 Instanz nicht
erreichbar, 4 `--wait`-Timeout (der Shutdown läuft im Hintergrund weiter). `workflow dry-run` fällt ohne erreichbare Instanz
auf die lokale Auswertung zurück (`--local` erzwingt sie; mit explizitem `--url` kein Fallback).

## Update (Spec §4, Szenario 12)

Updates ersetzen nur den Code; config-dir, data-dir und Env-Datei bleiben unverändert.

```bash
agent-orchestrator drain --config-dir /etc/agent-orchestrator --wait    # aktive Runs sauber beenden (ohne Zeitlimit)
sudo systemctl stop agent-orchestrator                                  # falls noch aktiv (nach Drain bereits beendet)
sudo cp -a /etc/agent-orchestrator /root/agent-orchestrator-config-$(date +%F)   # optional, config-dir sichern
sudo npm install -g agent-orchestrator@<neue-version>
sudo agent-orchestrator config validate --config-dir /etc/agent-orchestrator --data-dir /var/lib/agent-orchestrator
sudo agent-orchestrator service install --config-dir /etc/agent-orchestrator --data-dir /var/lib/agent-orchestrator   # nur wenn sich Pfade/Optionen ändern
sudo systemctl start agent-orchestrator
agent-orchestrator status --config-dir /etc/agent-orchestrator
journalctl -u agent-orchestrator -n 50      # "database migrated" + Backup-Pfad, "recovery finished"
```

- **DB-Migrationen** sind versioniert und laufen beim Start automatisch. Existiert die DB und stehen Migrationen aus, wird
  **vorher** eine konsistente Kopie geschrieben: `data-dir/backups/orchestrator-<alte-version>-<zeitstempel>.sqlite`
  (`VACUUM INTO`, auch im WAL-Modus konsistent). Schlägt eine Migration fehl, wird sie zurückgerollt und der Start abgebrochen.
- Eine DB mit **neuerer** Schemaversion als der Code kennt wird abgelehnt (kein stilles Downgrade).
- **Rollback:** Dienst stoppen, alte Paketversion installieren, `orchestrator.sqlite`, `orchestrator.sqlite-wal` und
  `orchestrator.sqlite-shm` beiseitelegen, das passende Backup als `orchestrator.sqlite` zurückkopieren (Eigentümer
  `agent-orchestrator`), starten. Runs nach dem Backup-Zeitpunkt fehlen dann in der Historie (ihre Logdateien bleiben).
- Alte Dateien unter `backups/` werden nicht automatisch gelöscht.

## Backups

| Was | Wie |
|---|---|
| config-dir | Versionsverwaltung (git) oder Dateikopie; enthält keine Secrets |
| Env-Datei | sicher (verschlüsselt) aufbewahren – enthält Private Keys |
| `orchestrator.sqlite` | im laufenden Betrieb konsistent: `sqlite3 /var/lib/agent-orchestrator/orchestrator.sqlite ".backup '/backup/orch.sqlite'"` (bzw. `VACUUM INTO`); bei gestopptem Dienst auch Dateikopie inkl. `-wal`/`-shm` |
| `logs/`, `runs/` | normale Dateikopie (DB und Logdateien bilden gemeinsam das Run-Journal) |
| `workspaces/` | meist nicht nötig (Arbeitskopien der Worker) |

**`orchestrator.lock` und `orchestrator.lock.json` nie öffnen, kopieren, archivieren oder wiederherstellen.** Die Instanzsperre
ist eine POSIX-`fcntl`-Sperre auf `orchestrator.lock`; sie gehört dem Orchestrator-Prozess und fällt, sobald *dieser* Prozess
irgendeinen Deskriptor auf die Datei schließt – deshalb öffnet der Orchestrator sie selbst (auch bei Retention/Backups) nie
ein zweites Mal. Externe Werkzeuge, die die Datei als SQLite-DB öffnen (`sqlite3`, Backup-Agenten mit SQLite-Support),
konkurrieren um die Sperre und scheitern bzw. blockieren; eine kopierte Lock-Datei ist wertlos. Beim Sichern ausschließen, z. B.:

```bash
rsync -a --exclude 'orchestrator.lock*' --exclude 'orchestrator.sqlite*' /var/lib/agent-orchestrator/ /backup/orch-data/
sqlite3 /var/lib/agent-orchestrator/orchestrator.sqlite ".backup '/backup/orch-data/orchestrator.sqlite'"
```

Wiederherstellen nur bei gestopptem Dienst; die Lock-Dateien legt der Orchestrator selbst neu an.

## Recovery nach Absturz

Beim Start erfasst die Recovery alle zuvor aktiven Runs, **bevor** der Scheduler startet (`/ready` erst danach `200`):

- noch lebende, sicher identifizierte Worker-Prozessgruppen (PID + Startzeit/Boot-ID) werden beendet; verschwundene Runs
  werden `crashed` mit `on_crash` (zählt als technischer Fehler); halb abgearbeitete Lifecycle-Ketten werden fortgesetzt
  (bereits erfolgreiche Actions laufen nicht erneut; Kommentare werden über Marker abgeglichen).
- **`recovery_pending`**: Prozess nicht sicher identifizierbar oder nicht beendbar → der Run bleibt sichtbar aktiv, hält
  seinen Lock (kein Doppelstart) und erzeugt die Notification `recovery_failed`. Lösung: Prozess prüfen/beenden, dann in der
  UI „Retry Recovery“ bzw. `POST /api/v1/runs/<id>/recovery/retry` (mit `{"assumeGone": true}`, wenn sicher ist, dass der
  Prozess weg ist).
- Retry-Blocks (UI „Blocked“), fehlgeschlagene Lifecycle-Actions (UI „Failed Actions“, Retry/Skip) und
  Benachrichtigungs-Fehlzustellungen bleiben über Neustarts erhalten.

## Fernzugriff, Reverse Proxy (Spec §15, §20.1)

V1 hat **keine Anmeldung**. Standard ist `server.host: 127.0.0.1`. Bei einem Nicht-Loopback-Bind warnt `start` deutlich.

- Zugriff von außen nur über einen **authentifizierenden** Reverse Proxy (z. B. nginx/Caddy mit OIDC über `oauth2-proxy`,
  Basic-Auth über TLS), VPN oder Tailscale. Der Proxy muss **jede** Anfrage authentifizieren, auch `/api/v1/events` (SSE).
- Den öffentlichen Namen des Proxys in `server.allowed_hosts` eintragen (DNS-Rebinding-Schutz: jede Anfrage braucht einen
  erlaubten `Host`, ein gesendeter `Origin` muss exakt passen); der Proxy muss den ursprünglichen `Host` weiterreichen.
- Keine CORS-Header am Proxy hinzufügen; mutierende Requests brauchen `X-Orchestrator-Request: 1` (die UI setzt ihn).

```yaml
# config.yaml
server:
  host: 127.0.0.1
  port: 8787
  allowed_hosts: [orchestrator.example.com]
```

```nginx
server {
  listen 443 ssl;
  server_name orchestrator.example.com;
  # ssl_certificate …;
  auth_basic "agent-orchestrator";                 # oder auth_request an oauth2-proxy
  auth_basic_user_file /etc/nginx/orchestrator.htpasswd;
  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;                   # muss in server.allowed_hosts stehen
    proxy_http_version 1.1;
    proxy_buffering off;                           # SSE (/api/v1/events)
    proxy_read_timeout 1h;
  }
}
```

Tailscale: `tailscale serve --bg http://127.0.0.1:8787` und den MagicDNS-Namen in `allowed_hosts` eintragen.

## Observability

- `GET /health` (Prozess lebt), `GET /ready` (DB ok, Recovery fertig, Scheduler läuft, kein Shutdown), `agent-orchestrator status`.
- Dienstlog: JSON-Zeilen auf stderr → `journalctl -u agent-orchestrator` (Secrets werden redigiert).
- Run-Logs: `data-dir/logs/<run-id>/{stdout,stderr}.log`, Events/Status in SQLite, live per SSE.
- Aufbewahrung über `retention` in `config.yaml` (Default: erfolgreiche Runs 30 d, fehlgeschlagene 90 d, Block-Runs nie,
  100 MB Log pro Run, Prüfung alle 24 h). Aktive Runs, offene Blocks und unvollständige Aktionsketten werden nie gelöscht.

## Fehlerbilder

| Meldung | Ursache / Lösung |
|---|---|
| „Another orchestrator instance is running on this data directory (pid …)“ | Eine andere Instanz nutzt das data-dir. |
| `cannot listen: EADDRINUSE` | Port belegt → `server.port` ändern oder `start --port`. |
| `Configuration … is invalid` | `config validate` zeigt Datei:Zeile: Pfad: Meldung. |
| „Database schema version … is newer than this build supports“ | data-dir stammt von einer neueren Version → passende Version installieren oder Backup einspielen. |
| `ExperimentalWarning: SQLite` | Node 22: `node:sqlite` ist experimentell; Node 24 verwenden. |
| `GITHUB_…_PRIVATE_KEY is not set` | Env-Datei fehlt/unvollständig (`systemctl show agent-orchestrator -p EnvironmentFiles`). |

## Bekannte Grenzen

- Die Source-ID ist Teil des Item-Schlüssels (`<source>:<nummer>`): Umbenennen einer Source trennt die Run-Historie und
  Retry-Blocks von den Items.
- Prozesse außerhalb der Worker-Prozessgruppe (eigene Session, Container) beendet der Orchestrator nicht (siehe
  [worker-protocol.md](worker-protocol.md#abbruch-timeout-prozesse)).
- Linux-spezifisches Verhalten (systemd, cgroups, Prozessidentität über `/proc`) ist manuell zu prüfen:
  [manual-tests/systemd.md](manual-tests/systemd.md), [manual-tests/process-supervision.md](manual-tests/process-supervision.md);
  GitHub-Annahmen: [manual-tests/github.md](manual-tests/github.md).
