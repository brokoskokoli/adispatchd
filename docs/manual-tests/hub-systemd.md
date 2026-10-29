# Manuelle Tests: Hub unter systemd (Linux, WI-37)

Automatisiert sind die Unit-Generierung für den Hub (Snapshot), `service install --hub --dry-run` und der Lauf gegen einen
In-Memory-Runner (Pfadprüfungen, Reihenfolge der Schritte), `hub init|validate|drain-all --wait`, die Migration einer
Einzelinstanz (Konfiguration, Hub-Start mit unveränderten Verzeichnissen) sowie `npm run test:pack` (installiertes Paket: `hub init`
→ `hub start` → Run in zwei Workspaces über `/w/<id>/` → `hub drain-all --wait` → SIGTERM, danach Migration einer Einzelinstanz in
einen zweiten Hub). Diese Checkliste prüft den **echten Dienstvertrag** auf einem Linux-Host mit systemd (Wegwerf-VM, nicht
Produktion) – Ergänzung zu [systemd.md](systemd.md) (Einzelinstanz), das vorher mindestens einmal durchgeführt sein sollte.

## Vorbereitung

```bash
# VM: Debian/Ubuntu mit systemd, Node 24 systemweit (/usr/bin/node)
npm pack                                        # im Repo → adispatchd-0.10.0.tgz
scp adispatchd-0.10.0.tgz vm:
ssh vm
sudo npm install -g ./adispatchd-0.10.0.tgz

H=/var/lib/adispatchd-hub/hub                    # data-dir des Hubs
sudo adispatch hub init --config-dir /etc/adispatchd-hub --data-dir $H \
  --workspaces-data-dir /var/lib/adispatchd-hub/workspaces --workspace alpha --workspace beta
sudo adispatch hub validate --config-dir /etc/adispatchd-hub --data-dir $H
```

Test-Workflow mit langem, gut erkennbarem Worker in **beiden** Workspaces (Skript wie in [systemd.md](systemd.md), hier je Workspace):

```bash
for ws in alpha beta; do
  c=/etc/adispatchd-hub/workspaces/$ws/config
  sudo tee $c/scripts/long.sh >/dev/null <<'EOF'
#!/bin/sh
trap 'echo "got TERM"; exit 143' TERM
echo "@@ADISPATCH_EVENT {\"type\":\"status\",\"message\":\"sleeping $1s\"}"
sleep "$1" & wait $!
EOF
  sudo chmod 0750 $c/scripts/long.sh
  sudo tee $c/workflows/long.yaml >/dev/null <<'EOF'
id: long
trigger: { type: manual }
parameters: { seconds: { type: number, default: 600 } }
execute: { type: shell, command: scripts/long.sh, args: ['{parameters.seconds}'], cancel_grace: 10s }
on_cancel: [ { type: shell, command: /bin/echo, args: ['on_cancel {run.id}'] } ]
on_crash:  [ { type: shell, command: /bin/echo, args: ['on_crash {run.id}'] } ]
EOF
done
# Start über den Hub (Pass-through /w/<id>/; Hub ohne auth), Argumente: Workspace, Sekunden
start_long() { curl -s -X POST -H 'X-Adispatch-Request: 1' -H 'Content-Type: application/json' \
  -d "{\"parameters\":{\"seconds\":$2}}" http://127.0.0.1:8090/w/$1/api/v1/workflows/long/start | jq -r .run.id; }
run_status() { curl -s http://127.0.0.1:8090/w/$1/api/v1/runs/$2 | jq '{status, finalReason, lifecycleStatus}'; }
hub() { sudo -u adispatchd adispatch hub "$@" --data-dir $H; }
```

## Checkliste

| # | Schritt | Erwartung | Ergebnis |
|---|---|---|---|
| H1 | `sudo adispatch service install --hub --dry-run --config-dir /etc/adispatchd-hub --data-dir $H --create-user` | Unit `adispatchd-hub.service` mit `/usr/bin/node …/dist/cli/main.js hub start …`, kein `npx`, `KillMode=mixed`, `Restart=on-failure`, `RestartPreventExitStatus=78`, `TimeoutStopSec=810`; geplante Schritte nennen Hub-data-dir und beide Workspace-data-dirs sowie **ein** config-dir; nichts geändert (`id adispatchd` unbekannt, keine Unit-Datei) | |
| H2 | wie H1 ohne `--dry-run` | Benutzer angelegt; `/var/lib/adispatchd-hub/hub` und `…/workspaces/{alpha,beta}` 0750 `adispatchd`; `/etc/adispatchd-hub` `root:adispatchd` 0750/0640 (inkl. `workspaces/*/config`); `/etc/default/adispatchd-hub` 0640 (Vorlage); Unit enabled; `systemd-analyze verify /etc/systemd/system/adispatchd-hub.service` ohne Fehler | |
| H3 | Layout von `hub init` **ohne** `--workspaces-data-dir` (zweites Config-Dir unter `/etc/x-hub` anlegen) mit `service install --hub --dry-run` | Exit 2 „…must be separate, non-nested directories … use --workspaces-data-dir“; nichts ausgegeben/geändert | |
| H4 | `sudo systemctl start adispatchd-hub; hub status` | beide Workspaces `running`, `connected`; `ps -o user= -C node` → überall `adispatchd`; `journalctl -u adispatchd-hub` zeigt Zeilen mit `[alpha] `/`[beta] `; der Dienst kann `/etc/adispatchd-hub` nicht beschreiben (`sudo -u adispatchd touch /etc/adispatchd-hub/hub.yaml` → Permission denied) | |
| H5 | Browser/curl `http://127.0.0.1:8090/` und `/w/alpha/` | Übersicht mit zwei Kacheln; Workspace-UI unter `/w/alpha/` mit „← Hub“; direkter Zugriff `curl http://127.0.0.1:8091/api/v1/status` → `401` | |
| H6 | **Gemeinsames Limit:** `hub.max_concurrent: 2` in `hub.yaml`, Hub neu starten; je Workspace 2 manuelle `long`-Runs, dazu automatische Quellen/Cron, falls vorhanden | Plätze 2/2 in `hub status`; weitere automatische Starts mit Entscheidung `hub_limit`; manuelle Starts nicht begrenzt | |
| H7 | **Drain per CLI:** `id=$(start_long alpha 20)`, `hub drain-all --wait` | Run läuft zu Ende (`completed`), Befehl endet mit Exit 0 („all workspaces ended“), `hub status` → beide `stopped`; der Hub läuft weiter (`systemctl is-active adispatchd-hub` → active); `systemctl stop adispatchd-hub` endet sofort mit Exit 0, **kein** Neustart (`NRestarts=0`) | |
| H8 | **`systemctl stop` während Runs in beiden Workspaces:** starten, `a=$(start_long alpha 30); b=$(start_long beta 30)`, `sudo systemctl stop adispatchd-hub` | `stop` blockiert, bis beide Runs fertig sind (Drain; **kein** „got TERM“ in den Run-Logs), beide `completed`, Hub Exit 0 | |
| H9 | **Drain-Timeout → Cancel-All:** Unit mit `--drain-timeout 20s --cancel-timeout 30s` neu installieren, beide Workspaces `start_long … 600`, `systemctl stop` | nach ~20 s Cancel in **beiden** Workspaces: „got TERM“, Runs `cancelled`, `on_cancel` gelaufen; Dienst gestoppt deutlich vor `TimeoutStopSec` | |
| H10 | **Zweites SIGTERM:** Runs starten, `sudo systemctl stop adispatchd-hub &`, dann `sudo systemctl kill --kill-whom=main --signal=SIGTERM adispatchd-hub` | sofortiges Cancel-All in allen Workspaces, Hub Exit 0 | |
| H11 | **Stop-All per CLI:** Runs starten, `hub stop-all --wait` | Runs `cancelled`, `on_cancel`, Workspaces `stopped`, Exit 0; Hub läuft weiter; `hub workspace start alpha` startet den Workspace wieder | |
| H12 | **Absturz eines Workspaces:** `start_long beta 600`, `sudo kill -9 <pid von beta aus hub status>` | nur `beta` geht auf `backoff` und startet nach ~1 s neu (`restarts: 1`); `alpha` unverändert (gleiche PID, Runs laufen); Recovery in `beta`: Run `crashed` + `on_crash`; Plätze von `beta` waren sofort frei | |
| H13 | **Absturz des Hubs:** `start_long alpha 600`, `sudo systemctl kill --kill-whom=main --signal=SIGKILL adispatchd-hub` | systemd beendet die cgroup inkl. aller Worker (`pgrep -f long.sh` leer), Neustart nach ~5 s (`NRestarts=1`), Workspaces starten, Run in `alpha` `crashed` + `on_crash`; `/w/alpha/ready` erst nach Recovery `200` | |
| H14 | **Hub-Ausfall ohne cgroup-Kill:** Drop-in `sudo systemctl edit adispatchd-hub` mit `[Service]`, `KillMode=process`, `Restart=no`; Dienst neu starten; `start_long alpha 600`; Hauptprozess des Hubs mit SIGKILL beenden (`sudo systemctl kill --kill-whom=main --signal=SIGKILL adispatchd-hub`) | `alpha` und der Worker laufen weiter; `sudo -u adispatchd adispatch status --url http://127.0.0.1:8091 --data-dir /var/lib/adispatchd-hub/workspaces/alpha` zeigt `hub: NOT REACHABLE`; neue automatische Runs starten nicht; nach `systemctl start adispatchd-hub` meldet `hub status` für `alpha` „already running for this workspace outside the hub“ (operations.md „Hub-Ausfall“); aufräumen mit `adispatch drain --wait --url … --data-dir …`, Drop-in entfernen | |
| H15 | **Konfigurationsfehler:** Syntaxfehler in `/etc/adispatchd-hub/hub.yaml`, `systemctl restart adispatchd-hub` | Exit 78 (`status=78`), **kein** Neustart-Loop; Fehlerbeschreibung im Journal | |
| H16 | **Ungültige Konfiguration eines Workspaces:** Syntaxfehler in `workspaces/beta/config/config.yaml`, `systemctl restart` | `beta` Zustand `failed` (Exit 78 des Kindes), `alpha` läuft; Hub bleibt aktiv; nach Korrektur `hub workspace start beta` | |
| H17 | **Zweiter Hub / zweite Kopie:** bei laufendem Dienst `sudo -u adispatchd adispatch hub start --config-dir /etc/adispatchd-hub --data-dir $H` | sofortiger Abbruch mit Exit 78 (Instanzsperre des Hub-data-dirs belegt) | |
| H18 | **Update-Ablauf** (operations.md „Betrieb: … Update“): `hub drain-all --wait`, `systemctl stop`, Tarball der nächsten Version installieren, `hub validate`, `systemctl start` | beide Workspaces starten mit der neuen Version; `journalctl`: Migration mit Backup-Pfad je Workspace, falls das Schema steigt; Historie beider Workspaces vollständig | |
| H19 | **Boot-Recovery:** `start_long alpha 600`, `sudo reboot` | Hub startet automatisch (enabled); Run `crashed` + `on_crash`; keine fremden Prozesse signalisiert | |
| H20 | **Migration einer Einzelinstanz:** Einzelinstanz nach [systemd.md](systemd.md) S2 einrichten (Port 8787), ein paar Runs erzeugen; danach operations.md „Eine bestehende Einzelinstanz in einen Hub aufnehmen (Migration)“ durchführen | Historie der Runs unter `/w/main/`; `config.yaml`/DB unverändert (`sha256sum` der Konfiguration vorher/nachher gleich); bei noch laufender alter Instanz scheitert der Workspace mit Exit 78 (`failed`) ohne Datenschaden; Rückweg (`systemctl enable --now adispatchd`) funktioniert | |
| H21 | **Reverse Proxy** (z. B. nginx wie in operations.md auf `/adispatch/`): `https://host/adispatch/` und `…/w/alpha/` | Übersicht und Workspace-UI laden, SSE-Live-Updates laufen (Kachel aktualisiert sich ohne Reload), `allowed_hosts` ohne Eintrag → `421` | |
| H22 | `sudo adispatch service uninstall --hub` | Hub gedraint und deaktiviert, Unit-Datei weg; config-dir, data-dirs, Env-Datei und Benutzer bleiben | |

## Protokoll

| Datum | Host / Distribution / systemd / Node | Version | Schritte | Beobachtung |
|---|---|---|---|---|
| | | | | |
