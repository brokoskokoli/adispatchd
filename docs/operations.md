# Betrieb

Installation als Dienst, Shutdown/Drain, Updates, Backups, Recovery und Fernzugriff. Spec §4, §13, §14, §15, §20, §21.
API-Referenz: [api.md](api.md) · Worker-Vertrag: [worker-protocol.md](worker-protocol.md) · Cron: [cron-semantics.md](cron-semantics.md)

## Verzeichnisse und Rechte

| Pfad (Vorschlag) | Inhalt | Eigentümer / Modus |
|---|---|---|
| `/etc/adispatchd/` (config-dir) | `config.yaml`, `sources.yaml`, `identities.yaml`, `workflows/`, `views/`, `scripts/` | `root:adispatchd`, Verzeichnisse 0750, Dateien 0640, Skripte 0750 |
| `/etc/default/adispatchd` | Secrets als Umgebungsvariablen (GitHub-App-Keys, GitHub-Tokens, Webhook-URLs) | `root:adispatchd`, 0640 |
| `/var/lib/adispatchd/` (data-dir) | `adispatchd.sqlite` (+ `-wal`/`-shm`), `adispatchd.lock`, `logs/`, `runs/`, `workspaces/`, `backups/` | `adispatchd`, 0750 |
| Paket, z. B. `/usr/lib/node_modules/adispatchd/` | Code (`dist/`), wird bei Updates ersetzt | `root`, nur lesbar für den Dienst |

- **Schreibrecht auf config-dir = Codeausführung** mit den Rechten des Dienstes (Skripte, Kommandos in YAML, Spec §20.2).
  Deshalb gehört config-dir `root`, der Dienst kann seine eigene Konfiguration nicht ändern.
- **data-dir muss auf einem lokalen Dateisystem liegen (kein NFS/SMB).** Der Instanz-Lock (`adispatchd.lock`) beruht auf
  `fcntl`-Sperren, die auf Netzwerk-Dateisystemen unzuverlässig sind; zwei Instanzen auf demselben data-dir wären möglich.
- Es läuft genau **eine** Instanz pro data-dir (OS-Sperre, wird bei Prozessende immer freigegeben, auch nach SIGKILL).
  Mehrere Instanzen mit getrennten data-dirs koordinieren sich nicht.
- `workspace.base_dir` (Default `<data-dir>/workspaces`) muss für den Dienst schreibbar sein; liegt es außerhalb von
  data-dir, Rechte selbst setzen.
- **Token-Dateien** (`delivery: file`, seit 0.3.0): `runs/<run-id>/secrets/<NAME>` bzw.
  `runs/<run-id>/actions/<action>/attempt-<n>/secrets/<NAME>`, Verzeichnis 0700, Datei 0600 (Dienstbenutzer). Sie
  existieren nur, solange der Worker bzw. die Action läuft; Reste nach einem Absturz löscht die Recovery beim nächsten
  Start, die Retention bei jedem Lauf. Das Token-Verzeichnis darf nicht im Workspace liegen; verglichen werden die aufgelösten Pfade (Symlinks werden verfolgt). Liegt es darin (z. B. Workspace unter `<data-dir>/runs/` oder ein Symlink dorthin), endet der Run mit `start_error` bzw. die Action scheitert.
  Die Rechte `0700`/`0600` schützen nur vor **anderen Systembenutzern**, nicht vor anderen Runs und Actions **desselben Dienstes**: Alle Worker laufen als derselbe Dienstbenutzer, die Pfade sind vorhersagbar – ein Worker kann die Token-Datei eines parallel laufenden Runs lesen (genauso wie unter Linux dessen Umgebung über `/proc/<pid>/environ` bei `delivery: env`). Wer hoch- und niedrig-privilegierte Workflows trennen muss, betreibt getrennte Instanzen unter getrennten Benutzern oder nutzt Container (WI-19).

## Container-Executor (`execute.type: container`, seit 0.3.0)

- **Rechte:** Der Dienstbenutzer braucht Zugriff auf die Engine. Bei **Docker** heißt das Mitgliedschaft in der Gruppe
  `docker` (bzw. Zugriff auf `/var/run/docker.sock`) – **das entspricht root-Rechten auf dem Host** (wer den Docker-Daemon
  steuert, kann beliebige Host-Pfade mounten). Mit **rootless Podman** (oder rootless Docker) bleibt alles beim
  Dienstbenutzer: `podman` installieren, für den Dienstbenutzer `subuid`/`subgid` einrichten
  (`usermod --add-subuids … --add-subgids … adispatchd`) und `loginctl enable-linger adispatchd`, damit
  `XDG_RUNTIME_DIR` (`/run/user/<uid>`) existiert; `XDG_RUNTIME_DIR` in der Env-Datei setzen.
- **Engine-Umgebung:** Der Engine-Prozess bekommt nur die Minimalumgebung plus `DOCKER_HOST`, `DOCKER_CONTEXT`,
  `DOCKER_CONFIG`, `CONTAINER_HOST`, `XDG_RUNTIME_DIR` u. a. (Liste: [Konfigurationsreferenz](configuration-reference.md)
  §3.4.8) – in `/etc/default/adispatchd` setzen, wenn nötig. Das Binary (`docker`/`podman`) muss im `PATH` des Dienstes
  liegen; beim Start prüft der Daemon `<engine> --version` und warnt im Log, wenn es fehlt (Runs enden dann mit `start_error`).
- **Benutzer im Container:** Default ist `<uid>:<gid>` des Dienstbenutzers, damit Workspace-Dateien dem Dienst gehören
  (Cleanup) und Kontext-/Token-Dateien (`0600`) lesbar sind. Ein anderer `user` braucht passende Rechte auf dem
  Workspace; Kontext- und Token-Dateien sind für ihn auf Linux dann nicht lesbar. Bei Podman setzt der Daemon
  `--userns keep-id` (Podman ≥ 4.3 auch rootful).
- **Rootless Docker:** Die UID des Dienstbenutzers auf dem Host entspricht dort **root im Container** (UID 0 wird auf
  den Dienstbenutzer abgebildet, andere UIDs auf Sub-UIDs). Deshalb `user: '0:0'` setzen – dann gehören Dateien im
  Workspace dem Dienst, und Kontext-/Token-Dateien (`0600`) sind lesbar; der Default (UID des Dienstes) würde im
  Container zu einer Sub-UID ohne Zugriff. Der Daemon erkennt rootless Docker nicht automatisch. Rootless Podman
  braucht das nicht (dort sorgt `--userns keep-id` für dieselbe UID).
- **`network: host`** gibt dem Container den Netzwerk-Namensraum des Hosts – er erreicht damit die API des Daemons auf
  `127.0.0.1` (mit `auth.mode: none` ohne Anmeldung) und kann Runs starten/abbrechen. Nur für vertrauenswürdige Images; sonst `default`
  oder `none`.
- **Images** baut und aktualisiert der Betreiber; `pull: missing` (Default) zieht fehlende Images beim ersten Run,
  `never` verlangt ein lokales Image, `always` zieht jedes Mal.
- **Aufräumen:** Container heißen `adispatch-<run-id>` und tragen die Labels `adispatch.run`, `adispatch.workflow`,
  `adispatch.instance=<hash des data-dir>`. Nach einem Absturz stoppt die Recovery alle Container **dieser Instanz**
  (andere Instanzen und fremde Container bleiben unberührt). Manuell:
  `docker ps -a --filter label=adispatch.instance=<hash>`; den Hash zeigt `workflow dry-run` im Engine-Aufruf.
- **Isolation:** Container trennen Runs voneinander (eigene Mounts, eigene Token-Dateien, `--cap-drop ALL`,
  `no-new-privileges`), aber nur so weit wie die Engine – Netzwerk standardmäßig offen (`network: none` schließt es),
  `network: host` hebt die Trennung zur Daemon-API auf. Mounts, die das data-dir enthalten oder darin liegen (außer im
  Workspace), und Symlinks in `{workspace.path}/<pfad>`-Quellen lehnt der Daemon vor dem Start ab; die Ergebnisdatei
  wird ohne Symlinks gelesen. Variablen, die die Engine-CLI steuern (Proxy, `LD_*`, `GODEBUG` …), gelangen nie in die
  Umgebung des Engine-Prozesses.

## Installation als systemd-Dienst (Linux)

Voraussetzungen: Linux mit systemd, Node.js ≥ 22.13 (empfohlen 24 LTS) **systemweit** installiert (z. B. `/usr/bin/node`
aus Distribution/NodeSource – nicht aus `nvm` im Home-Verzeichnis, das der Dienstbenutzer nicht lesen kann).

```bash
# 1. Feste Version global installieren (kein npx im Dienst!).
sudo npm install -g adispatchd@0.5.0
#    alternativ aus dem Repository-Checkout: npm install && npm pack && sudo npm install -g ./adispatchd-0.5.0.tgz

# 2. Konfiguration anlegen (überschreibt nie bestehende Dateien)
sudo adispatch init --config-dir /etc/adispatchd --data-dir /var/lib/adispatchd
sudoedit /etc/adispatchd/sources.yaml /etc/adispatchd/identities.yaml   # anpassen
sudo adispatch config validate --config-dir /etc/adispatchd --data-dir /var/lib/adispatchd

# 3. Vorschau: Unit-Datei und geplante Schritte (ändert nichts)
sudo adispatch service install --dry-run \
  --config-dir /etc/adispatchd --data-dir /var/lib/adispatchd --create-user

# 4. Installieren: Benutzer anlegen, Rechte setzen, Env-Datei-Vorlage, Unit schreiben, daemon-reload, enable
sudo adispatch service install \
  --config-dir /etc/adispatchd --data-dir /var/lib/adispatchd --create-user

# 5. Secrets eintragen und starten
sudoedit /etc/default/adispatchd
sudo systemctl start adispatchd
adispatch status --config-dir /etc/adispatchd
journalctl -u adispatchd -f
```

In die Env-Datei gehören alle Variablen, die `identities.yaml` und `config.yaml` nennen: `private_key_env` der
GitHub Apps, `token_env` von `github_token`-Identities (z. B. für user-eigene GitHub Projects) und `url_env`/`headers_env`
der Webhooks. Beispiel:

```bash
# /etc/default/adispatchd (0640, root:adispatchd)
GITHUB_MAINTAINER_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n…\n-----END RSA PRIVATE KEY-----"
GITHUB_PROJECT_TOKEN=ghp_…               # identities.yaml: project_reader: { type: github_token, token_env: GITHUB_PROJECT_TOKEN }
```

Tokens werden beim Start gelesen und in allen Logs redigiert; eine fehlende/leere Variable steht als Fehler im Journal
(„GitHub token identity not usable“), Zugriffe mit dieser Identity scheitern dann. Änderungen an der Env-Datei wirken erst
nach `systemctl restart adispatchd`. Für Projektfelder org-eigener Projekte braucht die lesende GitHub App zusätzlich
die Berechtigung **Organization → Projects: Read** (nach dem Ändern der App-Rechte die Installation bestätigen). Für
user-eigene Projekte empfohlen: klassischer PAT des Owners mit `read:project`, bei privaten Repos zusätzlich `repo`
(der Token liest auch die Issues/PRs); fine-grained Tokens sind dafür nicht verifiziert. Setzt ein Workflow
Projektfelder (`source.update` → `project`, seit 0.3.0), braucht die schreibende Identity **Projects: Read and write**
(App) bzw. den Scope **`project`** statt `read:project` (klassischer PAT).

Optionen von `service install`: `--user`/`--group` (Default `adispatchd`), `--create-user`, `--name` (Unit-Name),
`--node`/`--entry` (absolute Pfade, Default: das laufende Node und diese Installation), `--env-file <pfad|none>`,
`--drain-timeout` (Default 10m), `--cancel-timeout` (Default 2m), `--unit-dir`, `--now` (sofort starten).
`service install` verweigert `npx`-Cache-Pfade, relative Pfade, TypeScript-Quellen und `root` als Dienstbenutzer.
Außerhalb von `--dry-run` bricht `service install` ab, wenn `config.yaml` fehlt oder die Konfiguration ungültig ist
(Schutz vor Tippfehlern, da `chown -R`/`chmod -R` auf config-dir und data-dir laufen). Systemverzeichnisse (`/`, `/etc`,
`/var`, `/var/lib`, `/usr`, `/home`, `/opt`, `/root`, `/tmp`, …), Pfade direkt unter `/`, Home-Verzeichnisse sowie gleiche
oder ineinander verschachtelte config-/data-dirs werden abgelehnt (auch über Symlinks). Ohne `--create-user` muss der Benutzer existieren (Hinweis mit passendem `useradd`-Kommando). Eine bestehende Env-Datei wird
nie überschrieben. `service status` zeigt `systemctl status`; `service uninstall` stoppt (Drain), deaktiviert und entfernt nur
die Unit-Datei – config-dir, data-dir und Benutzer bleiben. Auf macOS lehnen die Kommandos mit Erklärung ab
(`--dry-run` funktioniert überall).

### Generierte Unit (Beispiel)

```ini
[Service]
Type=simple
User=adispatchd
Group=adispatchd
ExecStart=/usr/bin/node /usr/lib/node_modules/adispatchd/dist/cli/main.js start --config-dir /etc/adispatchd --data-dir /var/lib/adispatchd --drain-timeout 10m --cancel-timeout 2m
WorkingDirectory=/var/lib/adispatchd
EnvironmentFile=-/etc/default/adispatchd
Environment=NODE_ENV=production
Restart=on-failure
RestartSec=5s
RestartPreventExitStatus=78
KillMode=mixed
KillSignal=SIGTERM
TimeoutStopSec=810
UMask=0027
NoNewPrivileges=true
PrivateTmp=true
```

`NoNewPrivileges` verhindert `sudo`/setuid in Workern, `PrivateTmp` gibt dem Dienst ein eigenes `/tmp`. Werden weitere
Härtungen (`ProtectSystem=`, `ReadWritePaths=`) gewünscht, per Drop-in (`systemctl edit adispatchd`) ergänzen –
Agent-Skripte brauchen oft Schreibzugriff auf Caches im Home-Verzeichnis. Änderungen direkt in der Unit-Datei überschreibt
das nächste `service install`.

### Stop-/Restart-Vertrag (Spec §14, §24.4)

| Ereignis | Verhalten | Exit | systemd |
|---|---|---|---|
| `systemctl stop` / `restart` | SIGTERM an den **Hauptprozess** → Drain bis `--drain-timeout`, dann Cancel-All (`on_cancel` bzw. `on_error`) bis `--cancel-timeout`, danach werden Hooks unterbrochen (Recovery setzt sie beim nächsten Start fort) | 0 | gestoppt |
| zweites SIGTERM (`systemctl kill --kill-whom=main --signal=SIGTERM adispatchd`) | sofort Cancel-All | 0 | gestoppt |
| drittes Signal | sofortiger Exit (Recovery räumt beim nächsten Start auf) | 1 | – |
| `adispatch drain` / UI „Drain“ | keine neuen Runs, aktive laufen zu Ende, dann Ende | 0 | inactive, **kein** Neustart |
| `adispatch cancel-all` / UI „Cancel All“ | alle Runs abbrechen, `on_cancel` bzw. `on_error`, dann Ende | 0 | inactive, **kein** Neustart |
| Konfigurations-/Startfehler (ungültige YAML, Instanz-Lock belegt, DB-Schema neuer als der Code) | Start abgebrochen | 78 (EX_CONFIG) | **kein** Neustart (`RestartPreventExitStatus=78`) – Fehler beheben, dann `systemctl start` |
| Absturz / Exit ≠ 0 | – | ≠ 0 | Neustart nach 5 s → Recovery |
| `TimeoutStopSec` abgelaufen | systemd SIGKILLt die ganze cgroup inkl. Worker | – | gestoppt; nächster Start: Runs `crashed` + `on_crash` bzw. `on_error` |

- **`KillMode=mixed`**: SIGTERM geht nur an den Orchestrator, Worker laufen während des Drains weiter. Mit dem Default
  `control-group` bekämen alle Worker sofort SIGTERM (gleiche cgroup trotz eigener Prozessgruppe) → kein Drain möglich.
- **`TimeoutStopSec`** = Drain-Timeout + Cancel-Timeout + größtes `execute.cancel_grace` der Konfiguration + 60 s Puffer
  (wird bei `service install` aus der Konfiguration berechnet). Die Grace-Zeit (SIGTERM → SIGKILL der Worker-Gruppe) läuft
  **innerhalb** des Cancel-Timeouts – danach werden Hooks unterbrochen und der Orchestrator beendet sich; der Grace-Term ist
  nur Sicherheitsmarge. `cancel_grace` muss daher **kleiner als `--cancel-timeout`** sein, sonst beendet sich der Orchestrator
  ggf. vor dem SIGKILL (dann räumt erst systemd per cgroup ab) – `service install` und `start` warnen.
- **`Restart=on-failure`**: Ein absichtlicher Shutdown über UI/CLI endet mit Exit 0 und wird **nicht** als Crash neu gestartet.
- **Lange Runs:** Ein Agent-Run dauert oft länger als der Drain-Timeout. `systemctl stop` kann einen vollständigen Drain daher
  nicht garantieren – für geplante Stopps vorher `adispatch drain --wait` ausführen (beliebig lange, ohne Timeout)
  und erst danach `systemctl stop`/Update/Reboot.
- **Absturz unter systemd:** Stirbt der Hauptprozess, beendet systemd (bei `KillMode=mixed`) auch alle Worker der cgroup per
  SIGKILL. Die Recovery findet beim Neustart die Prozessgruppen daher i. d. R. bereits beendet und finalisiert die Runs als
  `crashed` mit `on_crash` bzw. `on_error` (zählt als technischer Fehler, ggf. Retry-Block). Verwaiste, noch lebende Worker (Recovery tötet
  sie nur bei sicher verifizierter Identität) entstehen v. a. außerhalb von systemd (lokaler Start, `KillMode=process`).
- **Reboot:** wie Absturz – alle Worker sind weg → `crashed` + `on_crash` bzw. `on_error`. Geplante Reboots daher vorher drainen.

Überall gilt: Ist der spezifische Hook (`on_cancel`, `on_crash`, …) im Workflow nicht definiert, läuft `on_error`
(ab 0.3.0; Konfigurationsreferenz §3.4.10).

## Pause, Drain, Cancel-All

```bash
adispatch status    --config-dir /etc/adispatchd     # Zustand, Limits, Auslastung, Blocks
adispatch pause     --config-dir /etc/adispatchd     # keine automatischen Starts (manuelle weiter möglich)
adispatch resume    --config-dir /etc/adispatchd
adispatch drain     --config-dir /etc/adispatchd --wait [--timeout 2h]
adispatch cancel-all --config-dir /etc/adispatchd --reason "maintenance" --wait
adispatch config reload --config-dir /etc/adispatchd # atomar; ungültige YAML behält aktive Konfiguration
adispatch workflow dry-run coder --config-dir /etc/adispatchd   # gegen die laufende Instanz, sonst lokal
```

Die Kommandos sprechen per HTTP mit der laufenden Instanz: `--url http://127.0.0.1:8787` oder – mit `--config-dir` – Host/Port
aus `config.yaml` (Wildcard-Binds `0.0.0.0`/`::` werden über Loopback angesprochen). **Als normaler Benutzer (nicht root)
`--url` verwenden:** das config-dir ist nach `service install` nur für root und die Dienstgruppe lesbar; mit `--config-dir`
meldet das Kommando dann „not readable (permission denied)“ und fällt auf `http://127.0.0.1:8787` zurück. URLs mit
Zugangsdaten (`user:pass@`) werden abgelehnt (Exit 2) – Proxy-Authentifizierung unterstützt die CLI nicht; auf dem Host
selbst die lokale URL nutzen. Sie senden den CSRF-Header
`X-Adispatch-Request: 1`. Mit Anmeldung (`auth.mode` ≠ `none`, seit 0.4.0) senden sie zusätzlich den lokalen
Steuer-Token aus `<data-dir>/control.token` (siehe [Anmeldung](#anmeldung-web-ui-und-api-seit-040)) – dafür als
Dienstbenutzer oder root mit `--data-dir` aufrufen, z. B. `sudo adispatch status --config-dir /etc/adispatchd
--data-dir /var/lib/adispatchd` (ohne `--data-dir` werden `./data` und `/var/lib/adispatchd` probiert). Exit-Codes: 0 ok, 1 API-Fehler (z. B. Reload abgelehnt), 2 Aufruffehler, 3 Instanz nicht
erreichbar, 4 `--wait`-Timeout (der Shutdown läuft im Hintergrund weiter). `workflow dry-run` fällt ohne erreichbare Instanz
auf die lokale Auswertung zurück (`--local` erzwingt sie; mit explizitem `--url` kein Fallback).

## Update (Spec §4, Szenario 12)

Updates ersetzen nur den Code; config-dir, data-dir und Env-Datei bleiben unverändert.

```bash
adispatch drain --config-dir /etc/adispatchd --wait    # aktive Runs sauber beenden (ohne Zeitlimit)
sudo systemctl stop adispatchd                                  # falls noch aktiv (nach Drain bereits beendet)
sudo cp -a /etc/adispatchd /root/adispatchd-config-$(date +%F)   # optional, config-dir sichern
sudo npm install -g adispatchd@<neue-version>          # oder Tarball aus dem Checkout (npm pack)
sudo adispatch config validate --config-dir /etc/adispatchd --data-dir /var/lib/adispatchd
sudo adispatch service install --config-dir /etc/adispatchd --data-dir /var/lib/adispatchd   # nur wenn sich Pfade/Optionen ändern
sudo systemctl start adispatchd
adispatch status --config-dir /etc/adispatchd
journalctl -u adispatchd -n 50      # "database migrated" + Backup-Pfad, "recovery finished"
```

- **DB-Migrationen** sind versioniert und laufen beim Start automatisch. Existiert die DB und stehen Migrationen aus, wird
  **vorher** eine konsistente Kopie geschrieben: `data-dir/backups/adispatchd-<alte-schemaversion>-<zeitstempel>.sqlite`
  (`VACUUM INTO`, auch im WAL-Modus konsistent). Schlägt eine Migration fehl, wird sie zurückgerollt und der Start abgebrochen.
- Eine DB mit **neuerer** Schemaversion als der Code kennt wird abgelehnt (kein stilles Downgrade).
- **0.3.0 hebt das Schema auf v3** (benannte Ergebnisse, gespeicherter Abschluss-Hook). Das ist eine Einbahnstraße:
  0.2.x startet mit einer v3-DB nicht mehr. Zurück auf 0.2.x nur über das vor der Migration geschriebene Backup
  (`backups/adispatchd-2-<zeitstempel>.sqlite`, siehe Rollback).
- **0.4.0 hebt das Schema auf v4** (Tabelle `ui_actions` für das Audit der UI-Aktionen). Ebenfalls eine Einbahnstraße:
  0.3.x startet mit einer v4-DB nicht mehr; zurück nur über das Backup `backups/adispatchd-3-<zeitstempel>.sqlite`.
- **0.6.0 hebt das Schema auf v5** (Retry-Block-Hooks: Trigger `unblock`, `runs.retry_block_hook`,
  `blocks.last_status`/`cleared_run_id`; `runs` und `run_actions` werden dabei neu aufgebaut, Daten bleiben erhalten).
  Einbahnstraße: 0.5.x startet mit einer v5-DB nicht mehr; zurück nur über das Backup
  `backups/adispatchd-4-<zeitstempel>.sqlite`.
- **0.9.0 hebt das Schema auf v6** (Item-Verlauf: Spalte `run_actions.effect_json` mit der strukturierten Wirkung
  jeder Action, Index `blocks_item`, Tabelle `item_history_gaps` für den Aufbewahrungs-Hinweis; kein Neuaufbau,
  bestehende Daten bleiben unverändert). Einbahnstraße: 0.8.x startet mit einer v6-DB nicht mehr; zurück nur über das
  Backup `backups/adispatchd-5-<zeitstempel>.sqlite`.
- **Rollback:** Dienst stoppen, alte Paketversion installieren, `adispatchd.sqlite`, `adispatchd.sqlite-wal` und
  `adispatchd.sqlite-shm` beiseitelegen, das passende Backup als `adispatchd.sqlite` zurückkopieren (Eigentümer
  `adispatchd`), starten. Runs nach dem Backup-Zeitpunkt fehlen dann in der Historie (ihre Logdateien bleiben).
- Alte Dateien unter `backups/` werden nicht automatisch gelöscht.

## Backups

| Was | Wie |
|---|---|
| config-dir | Versionsverwaltung (git) oder Dateikopie; enthält keine Secrets |
| Env-Datei | sicher (verschlüsselt) aufbewahren – enthält Private Keys |
| `adispatchd.sqlite` | im laufenden Betrieb konsistent: `sqlite3 /var/lib/adispatchd/adispatchd.sqlite ".backup '/backup/orch.sqlite'"` (bzw. `VACUUM INTO`); bei gestopptem Dienst auch Dateikopie inkl. `-wal`/`-shm` |
| `logs/`, `runs/` | normale Dateikopie (DB und Logdateien bilden gemeinsam das Run-Journal; `runs/<id>/kept/` enthält die per `execute.keep` gesicherten Dateien); `runs/*/secrets/` und `runs/*/actions/*/*/secrets/` ausschließen (laufende Token-Dateien; nur diese, nicht jedes `secrets/`-Verzeichnis, z. B. in Workspaces) |
| `workspaces/` | meist nicht nötig (Arbeitskopien der Worker) |

**`adispatchd.lock` und `adispatchd.lock.json` nie öffnen, kopieren, archivieren oder wiederherstellen.** Die Instanzsperre
ist eine POSIX-`fcntl`-Sperre auf `adispatchd.lock`; sie gehört dem Orchestrator-Prozess und fällt, sobald *dieser* Prozess
irgendeinen Deskriptor auf die Datei schließt – deshalb öffnet der Orchestrator sie selbst (auch bei Retention/Backups) nie
ein zweites Mal. Externe Werkzeuge, die die Datei als SQLite-DB öffnen (`sqlite3`, Backup-Agenten mit SQLite-Support),
konkurrieren um die Sperre und scheitern bzw. blockieren; eine kopierte Lock-Datei ist wertlos. Beim Sichern ausschließen, z. B.:

Die Token-Ausschlüsse sind am Quellverzeichnis verankert (führendes `/`), damit gleichnamige Verzeichnisse in
Workspaces gesichert werden.

```bash
rsync -a --exclude 'adispatchd.lock*' --exclude 'adispatchd.sqlite*' \
  --exclude '/runs/*/secrets/' --exclude '/runs/*/actions/*/*/secrets/' \
  /var/lib/adispatchd/ /backup/orch-data/
sqlite3 /var/lib/adispatchd/adispatchd.sqlite ".backup '/backup/orch-data/adispatchd.sqlite'"
```

Wiederherstellen nur bei gestopptem Dienst; die Lock-Dateien legt der Orchestrator selbst neu an.

## Recovery nach Absturz

Beim Start erfasst die Recovery alle zuvor aktiven Runs, **bevor** der Scheduler startet (`/ready` erst danach `200`):

- noch lebende, sicher identifizierte Worker-Prozessgruppen (PID + Startzeit/Boot-ID) werden beendet; verschwundene Runs
  werden `crashed` mit `on_crash` bzw. `on_error` (zählt als technischer Fehler); halb abgearbeitete Lifecycle-Ketten
  werden fortgesetzt – ab 0.3.0 genau der beim Übergang nach `finalizing` gespeicherte Abschluss-Hook
  (bereits erfolgreiche Actions laufen nicht erneut; Kommentare werden über Marker abgeglichen).
- Übrig gebliebene Token-Dateien (`delivery: file`) der zuvor aktiven Runs werden zuerst gelöscht – sie würden nicht
  mehr erneuert. Ein noch laufender, nicht beendbarer Worker (`recovery_pending`) verliert damit seine Token-Datei.
- Container (`execute.type: container`) dieser Instanz werden danach am Label `adispatch.instance` gefunden und gestoppt
  (`<engine> stop`, dann `rm -f`) – auch solche ohne aktiven Run; laufende Container werden nie übernommen. Der Run endet
  wie ein Shell-Run nach Neustart (i. d. R. `crashed`, Event `recovery.container_stopped`). Ist die Engine nicht
  erreichbar, bleiben die betroffenen Container-Runs `recovery_pending` → Engine starten, dann „Retry Recovery“.
- **`recovery_pending`**: Prozess nicht sicher identifizierbar oder nicht beendbar → der Run bleibt sichtbar aktiv, hält
  seinen Lock (kein Doppelstart) und erzeugt die Notification `recovery_failed`. Lösung: Prozess prüfen/beenden, dann in der
  UI „Retry Recovery“ bzw. `POST /api/v1/runs/<id>/recovery/retry` (mit `{"assumeGone": true}`, wenn sicher ist, dass der
  Prozess weg ist).
- Retry-Blocks (UI „Blocked“), fehlgeschlagene Lifecycle-Actions (UI „Failed Actions“, Retry/Skip) und
  Benachrichtigungs-Fehlzustellungen bleiben über Neustarts erhalten.

## Fernzugriff, Reverse Proxy (Spec §15, §20.1)

Ohne `auth` (Default `mode: none`) gibt es **keine Anmeldung**. Standard ist `server.host: 127.0.0.1`. Bei einem
Nicht-Loopback-Bind ohne Anmeldung warnt `start` deutlich. Seit 0.4.0 kann adispatchd selbst anmelden
(siehe [Anmeldung](#anmeldung-web-ui-und-api-seit-040)) – dann darf der Proxy die Identität liefern (`trusted_header`)
oder nur TLS terminieren (`password`).

- Mit `auth.mode: none`: Zugriff von außen nur über einen **authentifizierenden** Reverse Proxy (z. B. nginx/Caddy mit
  OIDC über `oauth2-proxy`, Basic-Auth über TLS), VPN oder Tailscale. Der Proxy muss **jede** Anfrage authentifizieren,
  auch `/api/v1/events` (SSE).
- Den öffentlichen Namen des Proxys in `server.allowed_hosts` eintragen (DNS-Rebinding-Schutz: jede Anfrage braucht einen
  erlaubten `Host`, ein gesendeter `Origin` muss exakt passen); der Proxy muss den ursprünglichen `Host` weiterreichen.
- Keine CORS-Header am Proxy hinzufügen; mutierende Requests brauchen `X-Adispatch-Request: 1` (die UI setzt ihn).

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
  auth_basic "Agent Dispatch Daemon";                 # oder auth_request an oauth2-proxy
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

## Anmeldung (Web-UI und API, seit 0.4.0)

`auth` in `config.yaml` (Referenz: [configuration-reference.md](configuration-reference.md) §3.1; Rollen je Endpunkt:
[api.md](api.md#mindestrolle-je-endpunkt)). Rollen: `viewer` (lesen), `operator` (alle schreibenden Aktionen), `admin`.
Änderungen an `auth` wirken mit `adispatch config reload` sofort; Passwort-Hashes sind Umgebungsvariablen (Neustart).

**Tailscale Serve** (empfohlen im Tailnet): Tailscale terminiert TLS und setzt für Tailnet-Benutzer den Header
`Tailscale-User-Login` (Login, z. B. `alice@example.com`). adispatchd bleibt an `127.0.0.1` gebunden:

```bash
tailscale serve --bg http://127.0.0.1:8787
```
```yaml
# config.yaml
server:
  host: 127.0.0.1
  allowed_hosts: [orchestrator.tailnet-name.ts.net]   # MagicDNS-Name
auth:
  mode: trusted_header
  trusted_header:
    header: Tailscale-User-Login       # Default
    trusted_proxies: [127.0.0.1, ::1]  # tailscale serve verbindet sich lokal
    users:
      - { login: alice@example.com, role: admin }
      - { login: bob@example.com, role: viewer }
```
Nicht gelistete Logins erhalten `403`, Anfragen ohne Header (z. B. über Tailscale Funnel) `401`.

> **Wichtig – lokal fälschbar:** Der Header wird jedem geglaubt, der sich von einer Adresse in `trusted_proxies` verbindet.
> Mit Tailscale Serve ist das `127.0.0.1` – also kann **jeder Prozess auf diesem Host, auch jeder Worker und jede
> Shell-Action**, `curl -H 'Tailscale-User-Login: alice@example.com' http://127.0.0.1:8787/…` senden und mit Alices Rolle
> handeln. Tailscale Serve kann kein zusätzliches Geheimnis mitsenden; adispatchd warnt beim Start
> („trusted_header without proxy_secret_env and a trusted loopback proxy“). Diese Konfiguration nur verwenden, wenn alle
> lokalen Prozesse vertrauenswürdig sind (Workers sind ohnehin vertrauenswürdiger Code, Spec §20.2) – sonst einen Proxy
> mit `proxy_secret_env` (unten) oder `password` verwenden. adispatchd nie an eine Nicht-Loopback-Adresse binden (sonst
> Warnung beim Start) und `trusted_proxies` so eng wie möglich halten.

**oauth2-proxy / Authelia / Authentik** vor nginx: der Proxy setzt nach der Anmeldung einen Header mit dem Benutzer –
oauth2-proxy mit `--set-xauthrequest` z. B. `X-Auth-Request-Email`/`X-Auth-Request-User`, im Upstream-Modus mit
`--pass-user-headers` `X-Forwarded-User`/`X-Forwarded-Email`; Authelia `Remote-User`/`Remote-Email`. Diesen Header als
`auth.trusted_header.header` eintragen; nginx muss ihn **immer** selbst setzen (auch leer), damit ein Client ihn nicht
durchreichen kann:

```nginx
location / {
  auth_request /oauth2/auth;
  auth_request_set $user $upstream_http_x_auth_request_email;
  proxy_set_header X-Forwarded-User $user;      # überschreibt einen vom Client gesendeten Wert
  proxy_set_header Host $host;                  # in server.allowed_hosts
  proxy_pass http://127.0.0.1:8787;
  proxy_http_version 1.1;
  proxy_buffering off;                          # SSE
  proxy_read_timeout 1h;
}
```
```yaml
auth:
  mode: trusted_header
  trusted_header:
    header: X-Forwarded-User
    trusted_proxies: [127.0.0.1]
    proxy_secret_env: ADISPATCH_PROXY_SECRET   # nginx sendet es, lokale Prozesse kennen es nicht
    users: [{ login: alice@example.com, role: admin }]
```
Das Geheimnis (z. B. `openssl rand -base64 32`) steht in der Env-Datei von adispatchd und in der nginx-Konfiguration
(`proxy_set_header X-Adispatch-Proxy-Secret "<geheimnis>";`, Datei nur für root lesbar). Ohne `proxy_secret_env` gilt
dieselbe Warnung wie bei Tailscale Serve.

**Passwort-Modus mit HTTPS-Proxy** (ohne externen Identitätsdienst): Benutzer in `config.yaml`, Hashes in der Env-Datei
des Dienstes. Das Passwort niemals ohne TLS über ein Netz senden – vor adispatchd einen TLS-Proxy (nginx/Caddy/Tailscale
Serve) auf demselben Host betreiben, der `X-Forwarded-Proto: https` und `X-Forwarded-For` setzt; das Session-Cookie
erhält dann `Secure`, das Login-Rate-Limit zählt je Client-IP.

```bash
adispatch auth hash-password            # fragt zweimal ohne Echo, gibt scrypt:32768:8:1:… aus
# in /etc/default/adispatchd (0640, root:adispatchd) eintragen, z. B.:
# ADISPATCH_PW_ALICE=scrypt:32768:8:1:…
sudo systemctl restart adispatchd
```
```yaml
auth:
  mode: password
  users:
    - { name: alice, password_hash_env: ADISPATCH_PW_ALICE, role: admin }
  trusted_proxies: [127.0.0.1, ::1]   # der TLS-Proxy auf demselben Host
  session_ttl: 12h
```
```nginx
location / {
  proxy_pass http://127.0.0.1:8787;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header X-Forwarded-For $remote_addr;   # genau eine Adresse; adispatchd nimmt den letzten Eintrag
  proxy_http_version 1.1;
  proxy_buffering off;
  proxy_read_timeout 1h;
}
```
Sessions liegen im Speicher: nach einem Neustart ist jeder abgemeldet. Login-Schutz: 1 s Verzögerung nach Fehlschlag,
höchstens 5 Fehlversuche je (Benutzername, Client-IP), 50 je Benutzername und 20 je Client-IP (IPv6 je /64) in 15 Minuten
(`429`) – ein Angreifer sperrt den echten Benutzer an dessen eigener IP nicht aus; keine Unterscheidung zwischen
unbekanntem Benutzer und falschem Passwort. Bei `password` an einer Nicht-Loopback-Adresse warnt `start` (Klartext-HTTP
ohne TLS-Proxy). Über HTTPS heißt das Cookie `__Host-adispatch_session`. Mit `read_requires_login: false` dürfen alle, die die UI erreichen, lesen.

**CLI und Steuer-Token:** Bei jedem Start schreibt der Daemon einen neuen zufälligen Token nach
`<data-dir>/control.token` (`0600`, atomar ersetzt, mit Port und PID, beim Stop gelöscht). `adispatch status|pause|resume|
drain|cancel-all|config reload|workflow dry-run` lesen ihn (`--data-dir`) und senden ihn nur an Loopback-URLs mit dem Port
aus der Datei; der Daemon akzeptiert ihn nur von Loopback-Verbindungen, behandelt ihn als `operator` und nur auf genau
diesen Routen (sonst `403 control_token_not_allowed`). Ohne lesbaren Token antworten die Befehle mit `401` und einem
Hinweis. **Grenze:** Worker und Shell-Actions laufen als derselbe Dienstbenutzer und **können die Datei lesen** – jedes
Skript kann also pausieren, fortsetzen, die Konfiguration neu laden, einen Drain oder Cancel-All auslösen. Das entspricht
der bestehenden Vertrauensgrenze (Skripte sind vertrauenswürdiger Konfigurationscode, Spec §20.2); Container sehen das
data-dir nicht (außer bei einem entsprechenden Mount).

**Audit:** Jede schreibende Anfrage eines angemeldeten Benutzers steht im Dienstlog (`"msg":"api write"` mit `actor`,
`role`, `via`, `route`, `status`; `journalctl -u adispatchd | grep 'api write'`); Start, Abbruch und Retries von Runs
zusätzlich als Event `audit.user_action` in den Run-Details, entfernte Blocks mit dem Benutzer als `clearedBy`.

| Meldung | Ursache / Lösung |
|---|---|
| `401 authentication_required` in der CLI | Token nicht lesbar: als Dienstbenutzer/root mit `--data-dir` aufrufen, Loopback-URL verwenden |
| `401 invalid_control_token` | Token einer anderen/neu gestarteten Instanz → richtiges `--data-dir` |
| `403 control_token_not_allowed` | Steuer-Token auf einer Route außerhalb der CLI-Befehle (z. B. Run starten) – dafür in der UI anmelden |
| `401 invalid_proxy_secret` | Proxy sendet `X-Adispatch-Proxy-Secret` nicht/falsch oder `proxy_secret_env` fehlt in der Env-Datei |
| Warnung „trusted_header without proxy_secret_env and a trusted loopback proxy …“ | Identität lokal fälschbar (siehe Tailscale Serve oben) |
| `401 untrusted_proxy` | Identitäts-Header kam nicht von `trusted_header.trusted_proxies` (Proxy auf anderem Host? Adresse eintragen) |
| `403 login_not_allowed` | Login fehlt in `auth.trusted_header.users` (Schreibweise wie vom Proxy gesendet, ohne Groß-/Kleinschreibung) |
| Warnung „user cannot log in – password hash variable missing or malformed“ | Env-Variable fehlt oder Hash unvollständig → `adispatch auth hash-password`, Env-Datei, Neustart |
| Login-Seite erscheint nach jedem Neustart | erwartet: Sessions liegen im Speicher |

## UI-Aktionen als Identity (seit 0.4.0)

Administratoren können in der Web-UI (Menü **UI Actions**, Link „Act as identity…“ im Run-Detail und in Views) auf ein
Issue/PR **als eine konfigurierte Identity** antworten, Labels setzen/entfernen und Projektfelder ändern – etwa als
`maintainer`-App statt mit dem eigenen GitHub-Konto.

![Item-Panel: Identity, Kommentar, Labels, Projektfelder, letzte Aktionen](https://raw.githubusercontent.com/brokoskokoli/adispatchd/main/docs/screenshots/item-panel.png)

Einrichtung:

1. Anmeldung einschalten: `auth.mode: password` oder `trusted_header` (siehe oben). Mit `mode: none` bleiben UI-Aktionen
   aus. Über Tailscale funktioniert `auth.mode: password` genauso gut.
2. Benutzer mit Rolle `admin` anlegen.
3. In `identities.yaml` die Identity mit `ui_actions: true` freischalten, `adispatch config reload`.
4. App-Rechte prüfen: **Issues** und **Pull requests** „Read and write“ (Kommentare, Labels), für Projektfelder
   **Organization → Projects** „Read and write“. Fehlende Rechte meldet die UI als `github_forbidden`.

> **Proxy auf demselben Host = lokal fälschbar.** Mit `trusted_header` glaubt adispatchd den Login-Header jeder
> Verbindung von einer Adresse in `trusted_proxies`. Läuft der Proxy auf demselben Rechner, kann **jeder lokale Prozess,
> auch jeder Worker**, sich über dieselbe Adresse verbinden und als Admin eine App-Identity posten lassen – egal ob der
> Proxy dort als `127.0.0.1` oder mit seiner LAN- bzw. Tailscale-IP eingetragen ist. Für UI-Aktionen deshalb entweder
> `auth.mode: password` oder einen Proxy, der `X-Adispatch-Proxy-Secret` mitsendet (`proxy_secret_env`). `config validate`
> lehnt `ui_actions: true` ab, sobald ein `trusted_proxies`-Eintrag Loopback abdeckt und kein `proxy_secret_env` gesetzt
> ist (z. B. Tailscale Serve); eine eigene LAN-/Tailscale-IP erkennt die Prüfung nicht – das ist Ihre Verantwortung.

> **`github_token`-Identities handeln als echte Person.** `ui_actions: true` an einer Token-Identity (z. B. einem
> persönlichen Access-Token) bedeutet: Jeder Admin der UI kommentiert und ändert Labels/Felder **im Namen des
> Token-Besitzers** – für Mitlesende auf GitHub nicht von ihm selbst zu unterscheiden. Nur bewusst und für eigene
> Maschinen-Konten einsetzen; für Bot-Antworten eine GitHub App (`github_app`) verwenden.

Sicherheit und Verhalten:

- Der CLI-Steuer-Token öffnet diese Routen nie (nur echte Anmeldungen). Vor jedem Senden zeigt die UI einen
  Bestätigungsdialog („Send as maintainer (GitHub App)?“), vor dem Anlegen neuer Labels einen eigenen.
- **Kommentare werden nie still verändert:** Sieht ein Text nach einem Secret aus (bekannte Werte des Daemons, GitHub-,
  Anthropic-, AWS-, Slack-Token-Formate, PEM-Private-Keys), warnt die UI und der Server lehnt ab
  (`comment_contains_secret`). Das ist **best effort** – andere Geheimnisse erkennt die Prüfung nicht.
- HTML-Kommentare (`<!-- … -->`) werden als Text gesendet; ein UI-Kommentar kann keine Orchestrator-Marker vortäuschen.
- Kommentare werden **nicht automatisch wiederholt**; derselbe Text am selben Item innerhalb von 60 s wird abgewiesen.
  Bei `github_outcome_unknown` erst auf GitHub nachsehen, ob der Kommentar schon da ist.
- Je Benutzer höchstens 20 Aktionen und 60 Item-Abrufe pro Minute (`429 ui_actions_throttled`).
- Der Link „Open on GitHub“ öffnet das Item in einem neuen Tab – dort liest und schreibt man als man selbst.

**Audit:** Tabelle `ui_actions` in der Datenbank (Schema v4): Zeit, Benutzer, Identity, Item, Art, Ergebnis/Fehler, bei
Kommentaren die URL (nie der Text; Labels/Feldwerte maskiert). Anzeige auf der Seite „UI Actions“ und im Item-Panel, API
`GET /api/v1/ui-actions`, zusätzlich Log-Zeilen `"msg":"ui action"`. Aufbewahrung: `retention.ui_actions` (Default
**365 Tage**, `never` = unbegrenzt), unabhängig vom Ergebnis. Kann ein Eintrag nach einer erfolgreichen Änderung nicht
geschrieben werden (z. B. Platte voll), meldet die UI eine Warnung und der Dienstlog `ui action audit failed`.

| Meldung | Ursache / Lösung |
|---|---|
| `403 ui_actions_disabled` | `auth.mode: none` → Anmeldung einschalten |
| `403 identity_not_allowed` | Identity ohne `ui_actions: true` (Reload vergessen?) |
| `403 control_token_not_allowed` / `user_login_required` | Aufruf mit dem Steuer-Token – nur angemeldete Benutzer |
| `400 comment_contains_secret` | Text enthält etwas, das wie ein Token/Key aussieht – entfernen und neu senden |
| `400 label_not_found` | Label existiert im Repository nicht; in der UI das Anlegen bestätigen (`create: true`) |
| `409 duplicate_comment` | derselbe Kommentar wurde gerade gesendet – auf GitHub prüfen |
| `429 ui_actions_throttled` | zu viele UI-Aktionen/Abrufe pro Minute; `Retry-After` abwarten |
| `502 github_forbidden` | App-Rechte fehlen oder die Unterhaltung ist gesperrt (locked) |
| `429 github_rate_limited` | Rate-Limit der Identity; später erneut senden (`Retry-After`) |
| `502 github_outcome_unknown` | Antwort ging verloren – auf GitHub prüfen, bevor erneut gesendet wird |

## Externe Tools in der UI, z. B. claude-inspect (seit 0.4.0)

`ui.external_links` in `config.yaml` nimmt lokale Werkzeuge in die Navigation auf – als Link in neuem Tab oder
eingebettet (`embed: true`, Details und Validierung: [configuration-reference.md](configuration-reference.md) §3.1).
adispatchd leitet nichts weiter: Der **Browser** öffnet die konfigurierte URL direkt. Sie muss also aus Sicht des Browsers
stimmen. Abschalten: Eintrag entfernen oder `enabled: false`, dann `adispatch config reload`.

- **Wer die URL sieht:** Die URL jedes aktiven Eintrags (auch ein Token darin) sieht jeder, der UI oder API von
  adispatchd erreicht – gleiche Vertrauensgrenze wie adispatchd selbst, also UI nur lokal oder hinter Authentifizierung.
- **Gleicher Hostname und gleiches Schema** für UI und Tool (z. B. beide `127.0.0.1`, auf dem Server dieselbe registrierbare
  Domain und beide HTTPS). Sonst ist der Frame „cross-site“ und `SameSite`-Cookies eines per Token geschützten Tools
  werden im Frame nicht gesendet.

Beispiel [claude-inspect](https://github.com/brokoskokoli/claude_inspect) (Dashboard für Claude-Code-Sitzungen, liest
`~/.claude` des Benutzers, unter dem es läuft; nur lesend). Laut dessen README gilt:

- **Lokal** (Rechner, auf dem Browser und Agenten laufen): `npx claude-inspect` (gibt eine URL mit zufälligem Zugangstoken
  `?t=…` aus) oder dauerhaft `npm install -g claude-inspect` + `claude-inspect service install` – der Dienst läuft
  danach unter Port 47717 **ohne Token** und ist nur von localhost erreichbar. Eintrag mit demselben Hostnamen, unter dem
  die adispatchd-UI geöffnet wird – bei `http://127.0.0.1:8787/`:
  ```yaml
  ui:
    external_links:
      - { id: claude-inspect, label: Claude Inspect, url: "http://127.0.0.1:47717/", embed: true }
  ```
  (öffnet man die UI als `http://localhost:8787/`, entsprechend `http://localhost:47717/`).
- **Auf dem Server:** claude-inspect zeigt das `~/.claude` des Benutzers, unter dem es läuft. Damit es die Sitzungen der
  Agenten zeigt, muss es unter **dem Benutzer laufen, unter dem die Agenten laufen** – beim Dienstbetrieb also unter dem
  Dienstbenutzer von adispatchd (alternativ zeigt `CLAUDE_CONFIG_DIR=/pfad/zu/.claude` auf dessen Verzeichnis, sofern
  lesbar). claude-inspect lauscht nur auf `127.0.0.1` und nimmt nur Anfragen mit lokalem `Host`-Header
  (`localhost`/`127.0.0.1`) an. Von außen deshalb nur über den **authentifizierenden Reverse Proxy** (wie oben), der an
  `127.0.0.1:<port>` weiterleitet und dabei einen lokalen `Host` setzt – z. B. einen eigenen Namen
  `inspect.example.com` mit
  ```nginx
  location / {
    proxy_pass http://127.0.0.1:47717;
    proxy_set_header Host 127.0.0.1:47717;   # claude-inspect akzeptiert nur lokale Host-Header
    proxy_http_version 1.1;
    proxy_buffering off;                     # Live-Updates per SSE
    proxy_read_timeout 1h;
  }
  ```
  und in `config.yaml` `url: https://inspect.example.com/` (UI z. B. unter `https://orchestrator.example.com/`: gleiche
  registrierbare Domain, beide HTTPS). Ob ein Unterpfad (`/inspect/`) funktioniert, hängt vom Tool ab – ein eigener
  (Sub-)Hostname ist die sichere Wahl.
  - claude-inspect lehnt außerdem **POST**-Anfragen ab, deren `Origin` nicht lokal ist; hinter dem Proxy schlägt daher
    z. B. *Analyze with Claude* mit 403 fehl. Wer das braucht, kann im Proxy `proxy_set_header Origin "";` setzen – das
    schaltet diese Prüfung von claude-inspect für alle Anfragen über den Proxy ab; die Absicherung hängt dann allein an der
    Authentifizierung des Proxys (eigene Abwägung).
  - Leitet die Authentifizierung des Proxys auf eine Anmeldeseite eines anderen Hosts um (z. B. OIDC), blockiert die CSP
    der UI diese Umleitung im Frame (`frame-src` erlaubt nur die Origin des Tools). Dann zuerst über „Open in new tab“
    anmelden und die eingebettete Seite danach neu laden.
- **Tokens:** Gehört ein Token in die URL (`?t=…`), steht es in `config.yaml` und ist für jeden sichtbar, der die UI/API
  erreicht (Toolbar, `externalLinks` von `GET /api/v1/config`; adispatchd warnt bei der Validierung). Besser: claude-inspect ohne Token nur lokal betreiben (Dienst) und den Zugriff
  von außen über die Authentifizierung des Proxys schützen. Keine Zugangsdaten in die URL schreiben (`user:pass@` ist
  ein Konfigurationsfehler).
- **Einbetten:** `embed: true` erlaubt die Origin des Tools in der CSP der UI (`frame-src`). Bleibt die eingebettete
  Seite leer, läuft das Tool nicht, ist unter der URL vom Browser aus nicht erreichbar, lehnt die Anfrage ab (Host-Prüfung,
  Token) oder verbietet das Einbetten – dann „Open in new tab“ nutzen oder `embed: false` setzen.

## Hub: mehrere Workspaces auf einem Server (seit 0.10.0)

Ein **Hub** betreibt mehrere unabhängige Projekte (Workspaces) auf einem Server unter **einem gemeinsamen Limit** für
gleichzeitige Runs. Ein Workspace ist eine vollständige, unveränderte Instanz (eigenes config-dir, data-dir, eigene Workflows,
Sources, Identities, Datenbank und eigener Port); der Hub ist ein eigener Prozess, der jede Instanz als Kindprozess startet
(`adispatch start …`), überwacht und neu startet. Die Isolation ist die Prozessgrenze – es gibt keine gemeinsamen Tabellen.
Format von `hub.yaml`: [Konfigurationsreferenz §3.9](configuration-reference.md#39-hubyaml-hub-seit-0100). Eine
Übersichtsseite im Browser gibt es in diesem Stand noch nicht (späteres Work-Item); bedient wird der Hub mit der CLI.

```bash
# Einmalig: hub.yaml und je Workspace ein vollständiges Beispiel-config-dir/data-dir anlegen (überschreibt nie)
adispatch hub init     --config-dir /var/lib/adispatchd-hub/config --data-dir /var/lib/adispatchd-hub/data --workspace coder --workspace docs
adispatch hub validate --config-dir /var/lib/adispatchd-hub/config --data-dir /var/lib/adispatchd-hub/data   # hub.yaml + Konfiguration jedes Workspaces

adispatch hub start    --config-dir /var/lib/adispatchd-hub/config --data-dir /var/lib/adispatchd-hub/data   # Vordergrund, startet alle enabled Workspaces
adispatch hub status   --data-dir /var/lib/adispatchd-hub/data                                    # Zustand je Workspace, Neustarts, Plätze
adispatch hub pause    --data-dir /var/lib/adispatchd-hub/data    # keine neuen automatischen Runs (laufende enden regulär)
adispatch hub resume   --data-dir /var/lib/adispatchd-hub/data
adispatch hub workspace restart coder --data-dir /var/lib/adispatchd-hub/data    # start | stop | restart | drain
adispatch hub drain-all  --data-dir /var/lib/adispatchd-hub/data  # alle Workspaces: Runs zu Ende laufen lassen, dann stoppen
adispatch hub stop-all   --data-dir /var/lib/adispatchd-hub/data  # alle Workspaces: cancel-all, dann stoppen
```

`--data-dir` ist das **eigene** data-dir des Hubs (Instanzsperre `adispatchd.lock`, die Sockets `slots.sock` und `hub.sock`);
es darf sich nicht mit den data-dirs der Workspaces überschneiden. `hub init` legt je Workspace `workspaces/<id>/config` und
`workspaces/<id>/data` unter dem Hub-config-dir an – **auch die veränderlichen Daten** (Datenbank, Logs, Workspaces) liegen
damit im config-dir. Das ist ein Layout zum Ausprobieren; für Produktivsysteme tragen Sie in `hub.yaml` die echten Pfade ein
(Konfiguration unter `/etc/adispatchd/<id>`, Daten unter `/var/lib/adispatchd/<id>`) oder legen das config-dir unter `/var/lib/…` an. Die Steuer-Befehle erreichen den Hub über `<data-dir>/hub.sock`
(oder `--socket`); Exit-Codes: 0 ok, 1 Fehler, 3 Hub nicht erreichbar.

**Zustände eines Workspaces** (`hub status`): `starting` → `running`; `backoff` nach einem Absturz (Neustart nach 1 s, 2 s, 4 s … höchstens 60 s,
der Zähler beginnt nach 60 s stabilem Lauf von vorn); `stopped` (absichtlich beendet, oder Exit 0 – z. B. weil jemand die
Instanz direkt per `adispatch drain --url …` beendet hat; sie wird nicht neu gestartet); `failed` bei Exit-Code 78
(ungültige Konfiguration, Instanzsperre belegt) oder wenn der Prozess nicht startbar ist – kein Neustart, bis
`hub workspace start <id>` oder ein Hub-Neustart. Absturzzähler (`crashes`, `restarts`) und der letzte Exit stehen in der
Statusausgabe. Ein Absturz betrifft nur diesen Workspace; die Geschwister laufen weiter. Die Ausgabe der Kinder erscheint im
Log des Hubs mit dem Präfix `[<id>] ` (die Kinder redigieren ihre Secrets selbst; der Hub schreibt keine Umgebungswerte).

**Gemeinsames Limit.** `hub.max_concurrent` begrenzt automatische Runs (Source, Cron) über alle Workspaces; das
`scheduler.max_concurrent` und die Workflow-Limits der Workspaces gelten zusätzlich. Vor jedem automatischen Start fordert der
Scheduler beim Hub einen **Platz** an (Slot-Protokoll: [worker-protocol.md](worker-protocol.md#slot-protokoll-hub-seit-0100)).
Die Entscheidung `hub_limit` steht in der Planungsdiagnose und im Dry-Run. Manuelle Starts werden nicht begrenzt (wie beim
globalen Limit), belegen aber einen Platz und zählen damit für die automatischen Starts. Es gibt keine Quoten oder
Prioritäten je Workspace: wer zuerst fragt, bekommt den freien Platz.

**Plätze verfallen**, wenn der Kindprozess endet (sofort; auch bei `kill -9`) oder der Workspace kein Lebenszeichen mehr sendet: nach 15 s Stille schließt der Hub die Verbindung (Prüfung im Takt von 5 s), eine
geschlossene Verbindung hält die Plätze noch 15 s – effektiv verfallen sie nach rund 30–35 s. Hinweis: Bleiben nach dem Absturz eines Workspaces Worker-Prozesse zurück, laufen sie bis zur Recovery des
neu gestarteten Workspaces weiter, ohne einen Platz zu belegen – in diesem Zeitfenster kann das Gesamtlimit kurz überschritten
werden.

**Hub-Ausfall.** Stirbt der Hub (Absturz, `kill -9`) **ohne systemd** (oder mit `KillMode=process`), laufen die Workspaces und ihre Runs
unverändert weiter (sie sind eigene Prozessgruppen; ihre Log-Zeilen gehen verloren, weil die Pipe zum Hub bricht). **Unter systemd mit
`KillMode=mixed`** (empfohlen, s. u.) beendet systemd beim Tod des Hauptprozesses die ganze cgroup per SIGKILL: Workspaces und Worker
sind dann ebenfalls weg, und die Recovery der Workspaces finalisiert die Runs beim nächsten Start als `crashed` (wie bei der
Einzelinstanz, „Absturz unter systemd“). Das Folgende gilt für den Fall, dass die Workspaces überleben. Sie starten **keine neuen
automatischen Runs**, bis der Hub wieder erreichbar ist (`hub: NOT REACHABLE` in `adispatch status`); Cron-Termine in dieser Zeit werden als
`skipped_limit` („hub not reachable …“) verbucht und nicht nachgeholt. Nach einem Neustart des
Hubs verbinden sich die verwaisten Workspaces wieder mit dem Slot-Socket und melden ihre laufenden Runs; der Hub zählt sie
sofort wieder. Der Hub kann diese Instanzen aber nicht übernehmen: sein eigener Start des Workspaces scheitert an der
Instanzsperre (Exit 78 → `failed`); antwortet die Instanz noch auf ihrem Port, steht in `hub status` der Hinweis „already running for
this workspace outside the hub“. Beenden Sie die verwaisten Instanzen mit `adispatch drain --wait --url
http://127.0.0.1:<port> --data-dir <workspace-data-dir>` (oder `cancel-all`) und starten Sie sie danach mit
`hub workspace start <id>`.

**Stopp.** SIGTERM/Ctrl-C am Hub: jeder Workspace bekommt genau ein SIGTERM (= Drain bis `--drain-timeout`, dann Cancel-All
bis `--cancel-timeout`, wie bei einer Einzelinstanz); ein zweites Signal am Hub sendet ein zweites SIGTERM (sofort
Cancel-All), ein drittes beendet alle Kinder hart und den Hub (Recovery räumt beim nächsten Start auf). Der Hub endet erst,
wenn alle Kinder beendet sind, und gibt dann Sockets und Instanzsperre frei; ein Kind, das trotz Frist nicht endet, wird
mit SIGKILL beendet. Kindprozesse laufen in einer **eigenen Prozessgruppe**: Ctrl-C im Terminal erreicht nur den Hub, der
die Signale weiterreicht. `hub workspace drain <id>` und `drain-all` rufen `POST /api/v1/shutdown/drain` des Workspaces mit
dessen Steuer-Token auf (ohne Frist), `stop`/`stop-all` das `cancel-all`; ist die API nicht erreichbar, fällt der Hub auf
SIGTERM zurück. Danach bleiben die Workspaces `stopped` (der Hub läuft weiter); `hub workspace start <id>` startet sie wieder.

**systemd.** `adispatch service install` richtet nur eine Einzelinstanz ein. Für einen Hub legen Sie eine Unit nach demselben
Muster an (Abschnitt „Generierte Unit“): `ExecStart=… main.js hub start --config-dir … --data-dir … --drain-timeout 10m
--cancel-timeout 2m`, `KillMode=mixed` (SIGTERM nur an den Hub, der die Kinder selbst beendet – mit dem Default
`control-group` bekämen die Kinder zusätzlich SIGTERM von systemd und würden sofort abbrechen), `RestartPreventExitStatus=78`
und `TimeoutStopSec` ≥ Drain- + Cancel-Timeout + 60 s. Secrets stehen in der `EnvironmentFile` des Hubs; **alle** Workspaces
erben diese Umgebung (jeder Workspace nutzt nur die Variablen, die seine `identities.yaml` nennt). Alle Workspaces laufen unter
dem Benutzer des Hubs; sollen Projekte unter verschiedenen Benutzern laufen, nehmen Sie getrennte Instanzen oder den
Container-Executor (`user`, [Abschnitt „Container-Executor“](#container-executor-executetype-container-seit-030)).

**Sicherheit.** Die Sockets `slots.sock` und `hub.sock` sind nur für den Benutzer des Hubs lesbar/schreibbar (`0600`). Worker
und Actions der Workspaces laufen unter demselben Benutzer und könnten sich daher verbinden (`hub.sock` erlaubt `pause`, `stop-all`
…) – dieselbe Vertrauensgrenze wie bei `control.token` und dem Dienstbenutzer insgesamt (Spec §20.2). Die Umgebungsvariablen
`ADISPATCH_HUB_SOCKET`/`ADISPATCH_HUB_WORKSPACE` erhalten Worker, Actions und Prüfskripte nicht (Minimalumgebung); den
Socket-Pfad kennt ein Worker also nur, wenn er die Dienstumgebung über `/proc` liest.

**Hinweise.** `hub.yaml` wird nur beim Start gelesen (kein Reload); die Konfiguration der Workspaces lädt jede Instanz selbst
(`adispatch config reload --url http://127.0.0.1:<port> --data-dir <workspace-data-dir>`). Der Slot-Socket liegt im
data-dir des Hubs mit Modus `0600`; der Pfad darf höchstens 100 Byte lang sein (Grenze von Unix-Sockets) – bei einem zu
langen Pfad meldet der Hub einen Fehler: ein kürzeres data-dir wählen.

## Observability

- `GET /health` (Prozess lebt), `GET /ready` (DB ok, Recovery fertig, Scheduler läuft, kein Shutdown), `adispatch status`.
- Dienstlog: JSON-Zeilen auf stderr → `journalctl -u adispatchd` (Secrets werden redigiert).
- Run-Logs: `data-dir/logs/<run-id>/{stdout,stderr}.log`, Events/Status in SQLite, live per SSE.
- Aufbewahrung über `retention` in `config.yaml` (Default: erfolgreiche Runs 30 d, fehlgeschlagene 90 d, Block-Runs nie,
  100 MB Log pro Run, Prüfung alle 24 h). Aktive Runs, offene Blocks und unvollständige Aktionsketten werden nie gelöscht.

### Server-Ressourcen im Dashboard (`monitoring`, seit 0.4.0)

- Der Daemon misst CPU, Load, RAM, freien Plattenplatz (data-dir und – falls anderes Dateisystem – `workspace.base_dir`)
  und die Prozessliste (`ps`, einmal je `monitoring.interval`, ohne Shell, Timeout 10 s). Die Werte liegen nur im
  Speicher (`monitoring.retention`, Default 6 h) und **gehen beim Neustart verloren**; es gibt keine DB-Migration.
  API: `GET /api/v1/system/metrics`, live per SSE `system.metrics`.
- **UI (seit 0.5.0):** oben im Dashboard eine kompakte Leiste (CPU gesamt mit Verlauf der letzten 15 min, RAM, am
  stärksten belegter Pfad, Load, größte Prozessgruppen); ein Klick öffnet den Reiter **Resources** (`#/resources`) mit
  den gestapelten Diagrammen, der Zeitraumwahl und der Wertetabelle. Beides ab Rolle `viewer`.
- **Sichtbarkeit:** Die UI zeigt die **Befehlsnamen fremder Prozesse** des Servers (nie Argumente – die können Secrets
  enthalten). Die UI daher nur hinter Authentifizierung/Reverse Proxy freigeben; wer das nicht will, setzt
  `monitoring.enabled: false` (keine Messung, kein `ps`).
- **Zuordnung:** eigene PID → Daemon; Prozessgruppe bzw. Prozessbaum eines Workers → dessen Run; andere Kindprozesse des
  Daemons (Shell-Actions, Conditions) → „adispatchd (hooks/checks)“. Container-Runs: der Engine-CLI-Prozess plus – wenn
  möglich – `<engine> stats --no-stream` (misst selbst nur ein kurzes Fenster von 1–2 s, nicht das ganze Intervall); unter
  Linux sichtbare Container-Prozesse werden nicht doppelt gezählt. Docker Desktop/Podman-Maschine auf macOS: die Container
  laufen in einer VM; der per `stats` gezählte Verbrauch wird vom VM-Prozess (`com.apple.Virtualization…`, `qemu-system*`,
  `vfkit`, `krunkit`) abgezogen.
- **macOS-RAM:** „verfügbar“ = free + inactive + speculative Seiten aus `vm_stat` (vergleichbar mit Linux `MemAvailable`;
  komprimierter Speicher zählt als belegt). Linux: `MemAvailable` aus `/proc/meminfo`. Fehlt beides: `os.freemem()`.
- **Genauigkeit:** CPU je Prozess = Rate der kumulierten CPU-Zeit. Linux liest `/proc/<pid>/stat` (CPU- und Startzeit
  in Clock-Ticks, Name = `comm`, nie `cmdline`), macOS `ps` (10 ms). Prozesse werden über PID und Startzeit
  wiedererkannt (Linux exakt, bei `ps` aus `etime` mit 2,5 s Toleranz); ein Namenswechsel (`exec`, Thread-Name wie Nodes
  `MainThread`) behält die Reihe. Ist `/proc` nicht lesbar, nutzt Linux `ps` (ganze Sekunden) und mittelt über bis zu
  60 s (bei jüngeren Prozessen über die vorhandene Historie). Prozesse, die zwischen zwei Messungen starten und enden, fehlen in der Aufteilung; die
  Differenz zur Gesamtauslastung erscheint als „System / unattributed“.
- **Prozessnamen:** `ps -o ucomm` bzw. unter Linux `comm` aus `/proc/<pid>/stat` (Abrechnungsname des Kernels, nicht
  das umschreibbare `argv[0]`/`process.title`),
  zusätzlich an der ersten Leerstelle abgeschnitten. Restrisiko Linux: `prctl(PR_SET_NAME)` erlaubt einem Prozess, seinen
  Namen (max. 15 Zeichen) selbst zu setzen.
- **Speicher/Payload:** höchstens 5 000 Messpunkte (`retention` ≤ 5 000 Intervalle) mit je höchstens
  `top_processes` (≤ 20) fremden Gruppen, typisch wenige MB. Die API liefert höchstens `points` (Default 600) Punkte –
  bei längeren Zeiträumen Mittelwerte je Zeitfenster.
- Fehler (z. B. `ps` fehlt im Container-Image) werden höchstens alle 10 min geloggt; der Teilwert bleibt leer.

## Fehlerbilder

| Meldung | Ursache / Lösung |
|---|---|
| „Another orchestrator instance is running on this data directory (pid …)“ | Eine andere Instanz nutzt das data-dir. |
| `cannot listen: EADDRINUSE` | Port belegt → `server.port` ändern oder `start --port`. |
| `Configuration … is invalid` | `config validate` zeigt Datei:Zeile: Pfad: Meldung. |
| „Database schema version … is newer than this build supports“ | data-dir stammt von einer neueren Version → passende Version installieren oder Backup einspielen. |
| `ExperimentalWarning: SQLite` | Node 22: `node:sqlite` ist experimentell; Node 24 verwenden. |
| `GITHUB_…_PRIVATE_KEY is not set` | Env-Datei fehlt/unvollständig (`systemctl show adispatchd -p EnvironmentFiles`). |
| `Token for identity "…" missing: environment variable … is not set or empty` | `token_env` einer `github_token`-Identity fehlt in der Env-Datei → eintragen, Neustart. |
| Warnung „GitHub project field unavailable“, Dry-Run `project.* unknown – GitHub project … unavailable` | Projekt nicht gefunden oder kein Zugriff: Nummer/Owner prüfen; Org-Projekt → App-Recht *Projects: Read*; User-Projekt → `github_token`-Identity als `project.identity`. Feld fehlt / falsche Art → `project.fields` an das Projekt anpassen. |
| Action `source.update` `failed`: `option "…" not found (available: …)` / `is ambiguous` | Optionsname bzw. Iterationstitel im Workflow genau wie im Projekt schreiben (oder die Option im Projekt anlegen); danach Action in der UI wiederholen. |
| Action `source.update` `failed` mit `forbidden` „… needs write access to the project“ | Schreibrecht fehlt: App-Recht *Projects: Read and write* (Installation bestätigen) bzw. PAT mit Scope `project`; schreibende Identity ist `project.identity` (wenn gesetzt), sonst die der Action. |

## Bekannte Grenzen

- Die Source-ID ist Teil des Item-Schlüssels (`<source>:<nummer>`): Umbenennen einer Source trennt die Run-Historie und
  Retry-Blocks von den Items.
- Prozesse außerhalb der Worker-Prozessgruppe (eigene Session, selbst gestartete Container) beendet der Orchestrator nicht (siehe
  [worker-protocol.md](worker-protocol.md#abbruch-timeout-prozesse)); Container von `execute.type: container` stoppt er selbst.
- Container-Executor: getestet mit einer Fake-Engine und (optional, `ADISPATCH_CONTAINER_TEST=1`) mit Docker; Podman
  (rootless, `--userns keep-id`) ist manuell zu prüfen.
- Linux-spezifisches Verhalten (systemd, cgroups, Prozessidentität über `/proc`) ist manuell zu prüfen:
  [manual-tests/systemd.md](manual-tests/systemd.md), [manual-tests/process-supervision.md](manual-tests/process-supervision.md);
  GitHub-Annahmen: [manual-tests/github.md](manual-tests/github.md).
