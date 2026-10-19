# Manuelle Tests: systemd-Dienst (Spec §22.1 „systemd“, §14, §24.4, Szenario 12)

Automatisiert (auf macOS) sind nur die Unit-Generierung (Snapshot), `service install|uninstall --dry-run`, Drain/Cancel-All
über die API, der Exit-Code-Vertrag des CLI-Starts (SIGTERM → Exit 0), Migration mit Backup und das `npm pack`-Update
(`npm run test:pack`). Diese Checkliste prüft den echten Service-Vertrag auf einem **Linux-Host mit systemd** (Wegwerf-VM,
nicht Produktion). Ergebnisse unten protokollieren.

## Vorbereitung

```bash
# VM: Debian/Ubuntu mit systemd, Node 24 systemweit (/usr/bin/node)
npm pack                                        # im Repo → adispatchd-0.4.0.tgz
scp adispatchd-0.4.0.tgz vm:
ssh vm
sudo npm install -g ./adispatchd-0.4.0.tgz
sudo adispatch init --config-dir /etc/adispatchd --data-dir /var/lib/adispatchd
```

Test-Workflow mit langem, gut erkennbarem Worker (manuell gestartet, ohne GitHub):

```bash
sudo tee /etc/adispatchd/scripts/long.sh >/dev/null <<'EOF'
#!/bin/sh
trap 'echo "got TERM"; exit 143' TERM
echo "@@ADISPATCH_EVENT {\"type\":\"status\",\"message\":\"sleeping $1s\"}"
sleep "$1" & wait $!
EOF
sudo chmod 0750 /etc/adispatchd/scripts/long.sh
sudo tee /etc/adispatchd/workflows/long.yaml >/dev/null <<'EOF'
id: long
trigger: { type: manual }
parameters: { seconds: { type: number, default: 600 } }
execute: { type: shell, command: scripts/long.sh, args: ['{parameters.seconds}'], cancel_grace: 10s }
on_cancel: [ { type: shell, command: /bin/echo, args: ['on_cancel {run.id}'] } ]
on_crash:  [ { type: shell, command: /bin/echo, args: ['on_crash {run.id}'] } ]
EOF
start_long() { curl -s -X POST -H 'X-Adispatch-Request: 1' -H 'Content-Type: application/json' \
  -d "{\"parameters\":{\"seconds\":$1}}" http://127.0.0.1:8787/api/v1/workflows/long/start | jq -r .run.id; }
run_status() { curl -s http://127.0.0.1:8787/api/v1/runs/$1 | jq '{status, finalReason, lifecycleStatus}'; }
```

## Checkliste

| # | Schritt | Erwartung | Ergebnis |
|---|---|---|---|
| S1 | `sudo adispatch service install --dry-run --config-dir /etc/adispatchd --data-dir /var/lib/adispatchd --create-user` | Unit mit `/usr/bin/node …/dist/cli/main.js start …`, kein `npx`, `User=adispatchd`, `KillMode=mixed`, `Restart=on-failure`, `TimeoutStopSec=810`; nichts geändert (`id adispatch` → unbekannt, keine Unit-Datei) | |
| S2 | wie S1 ohne `--dry-run` | Benutzer angelegt (`/usr/sbin/nologin`), `/var/lib/adispatchd` 0750 `adispatchd`, `/etc/adispatchd` `root:adispatchd` 0750/0640, `/etc/default/adispatchd` 0640 (Vorlage), Unit enabled; `systemd-analyze verify /etc/systemd/system/adispatchd.service` ohne Fehler | |
| S3 | `sudo systemctl start adispatchd; adispatch status --config-dir /etc/adispatchd` | `ready: yes`; `ps -o user= -C node` → `adispatchd`; Dienst kann `/etc/adispatchd` nicht beschreiben (`sudo -u adispatchd touch /etc/adispatchd/x` → Permission denied) | |
| S4 | **Drain per CLI:** `id=$(start_long 20)`, `adispatch drain --config-dir /etc/adispatchd --wait` | Run läuft zu Ende (`completed`), danach Exit 0; `systemctl status` → `inactive (dead)`, **kein** Neustart (`journalctl` zeigt keinen Restart, `NRestarts=0` in `systemctl show -p NRestarts`) | |
| S5 | **systemctl stop während eines Runs:** Dienst starten, `id=$(start_long 30)`, `sudo systemctl stop adispatchd` | `stop` blockiert bis der Run fertig ist (Drain; Worker bekam **kein** SIGTERM: kein „got TERM“ im Run-Log), Run `completed`, Exit 0 | |
| S6 | **Drain-Timeout → Cancel-All:** Unit mit `--drain-timeout 20s --cancel-timeout 30s` neu installieren, `start_long 600`, `systemctl stop` | nach ~20 s Cancel: Worker-Log „got TERM“, Run `cancelled`, `on_cancel` gelaufen, Dienst gestoppt deutlich vor `TimeoutStopSec` | |
| S7 | **Zweites SIGTERM:** `start_long 600`, `sudo systemctl stop adispatchd &`, dann `sudo systemctl kill --kill-whom=main --signal=SIGTERM adispatchd` | sofortiges Cancel-All, Run `cancelled`, Exit 0 | |
| S8 | **Cancel-All per CLI:** `start_long 600`, `adispatch cancel-all --config-dir /etc/adispatchd --wait` | Run `cancelled`, `on_cancel`, Exit 0, kein Neustart | |
| S9 | **App-Absturz:** `start_long 600`, `sudo systemctl kill --kill-whom=main --signal=SIGKILL adispatchd` | systemd tötet die cgroup inkl. Worker (`pgrep -f long.sh` leer), Neustart nach ~5 s (`NRestarts=1`), Recovery: Run `crashed` + `on_crash`, technischer Zähler +1; `/ready` erst nach Recovery | |
| S10 | **Absturz mit Exit ≠ 0** (z. B. `kill -SEGV <pid>` oder DB-Datei vorübergehend unlesbar machen) | Neustart (`Restart=on-failure`) | |
| S11 | **Grace länger als Cancel-Timeout:** Unit mit `--drain-timeout 5s --cancel-timeout 5s`, Worker ignoriert TERM (`trap '' TERM`), `cancel_grace: 300s` **ohne** Neuinstallation, `systemctl stop` | `start` warnt beim Start („not smaller than the cancel timeout“); Hauptprozess endet nach ~5 s Drain + 5 s Cancel + bis 10 s Hook-Abbruch (≈ 20–25 s) mit **Exit 0**, ohne dass der Worker SIGKILL bekam; systemd (`KillMode=mixed`) SIGKILLt danach sofort die restliche cgroup inkl. Worker (nicht erst nach `TimeoutStopSec`); nächster Start: Run `crashed` + `on_crash` (kein hängender Lock) | |
| S11b | **Konfigurationsfehler:** YAML-Syntaxfehler in `config.yaml`, `systemctl restart` | Exit 78, `systemctl status` zeigt `status=78`, **kein** Neustart-Loop (`NRestarts` bleibt) | |
| S12 | **Boot-Recovery:** `start_long 600`, `sudo reboot` | Dienst startet nach Boot automatisch; Run `crashed` + `on_crash`; Boot-ID-Wechsel → keine fremden Prozesse signalisiert | |
| S13 | **Update-Migration (Szenario 12):** mit Version N Runs erzeugen, `drain --wait`, Version N+1 (mit neuer Migration) als Tarball `npm install -g ./adispatchd-<N+1>.tgz`, `systemctl start` | `journalctl`: „database backup written before migration“ + Pfad, „database migrated“; `backups/orchestrator-<N>-*.sqlite` vorhanden; alte Runs, Logs, Blocks, config-dir und Env-Datei unverändert; neuer Run funktioniert | |
| S14 | **Rollback:** Dienst stoppen, Version N installieren, Backup als `adispatchd.sqlite` zurück (inkl. `-wal`/`-shm` entfernen), starten | startet mit Version N; DB mit neuerer Version ohne Rückspielen → Start abgelehnt („newer than this build supports“) | |
| S15 | **Zweite Instanz:** bei laufendem Dienst `sudo -u adispatchd adispatch start --config-dir /etc/adispatchd --data-dir /var/lib/adispatchd --port 8788` | sofortiger Abbruch „Another orchestrator instance is running on this data directory“ | |
| S16 | `sudo adispatch service uninstall` | Dienst gedraint und deaktiviert, Unit-Datei weg; config-dir, data-dir, Env-Datei, Benutzer bleiben | |

## Protokoll

| Datum | Host / Distribution / systemd / Node | Version | Schritte | Beobachtung |
|---|---|---|---|---|
| | | | | |
