# Manueller Spike: Prozess-Supervision unter Linux (Spec §13, §24.3)

Ziel: vor der Produktionsfreigabe klären, ob Prozessgruppen + Startidentität (`linux:<boot-id>:<starttime>` aus
`/proc/<pid>/stat`) für Cancel und Crash-Recovery genügen oder ob systemd-Scopes/cgroups bzw. ein Wrapper nötig sind.
Automatisierte Tests laufen nur auf macOS bzw. mit simuliertem procfs (WI-05/WI-08). Durchführung auf einer Linux-VM,
einmal **ohne** systemd (Vordergrund-`start`) und einmal **unter** systemd (`service install`, siehe [systemd.md](systemd.md)).

## Vorbereitung

```bash
agent-orchestrator init --config-dir ~/spike/config --data-dir ~/spike/data
cd ~/spike/config
cat > scripts/tree.sh <<'EOF'
#!/bin/sh
# Prozessbaum: Vordergrundkind, Hintergrundkind, Enkel mit eigener Session, Zombie-Kandidat
sleep 600 &
sh -c 'sleep 600' &
setsid sh -c 'echo $$ > /tmp/spike-setsid.pid; sleep 600' &
echo "@@ORCH_EVENT {\"type\":\"status\",\"message\":\"tree started\"}"
sleep 600
EOF
chmod 0750 scripts/tree.sh
cat > workflows/tree.yaml <<'EOF'
id: tree
trigger: { type: manual }
execute: { type: shell, command: scripts/tree.sh, cancel_grace: 5s }
EOF
agent-orchestrator start --config-dir ~/spike/config --data-dir ~/spike/data &   # ohne systemd
start_tree() { curl -s -X POST -H 'X-Orchestrator-Request: 1' http://127.0.0.1:8787/api/v1/workflows/tree/start | jq -r .run.id; }
show() { ps -eo pid,pgid,sid,stat,lstart,cmd --forest | grep -E 'tree.sh|sleep 600' | grep -v grep; }
```

## Checkliste

| # | Szenario | Erwartung | Ergebnis |
|---|---|---|---|
| P1 | `id=$(start_tree); show` | Worker ist Leader einer eigenen Prozessgruppe/Session (PGID = PID = SID); `sleep`-Kinder in derselben Gruppe; setsid-Enkel in eigener Session | |
| P2 | `curl -s http://127.0.0.1:8787/api/v1/runs/$id \| jq .pid`; `cat /proc/<pid>/stat \| awk '{print $22}'`; `cat /proc/sys/kernel/random/boot_id` | in der DB (`runs.process_start_identity`) steht `linux:<boot-id>:<starttime>` passend zu `/proc` | |
| P3 | **Cancel:** `curl -X POST -H 'X-Orchestrator-Request: 1' …/runs/$id/cancel`; nach 6 s `show` | ganze Gruppe weg (TERM, nach 5 s KILL); Run `cancelled`; **setsid-Enkel lebt weiter** (bekannte Grenze, Skript-Verantwortung) → `kill $(cat /tmp/spike-setsid.pid)` | |
| P4 | **Timeout:** `timeout: { max_duration: 10s }` ergänzen, Reload, Start | nach 10 s TERM→KILL an die Gruppe, Run `timed_out` | |
| P5 | **Orchestrator-Absturz ohne systemd:** Run starten, `kill -9 <orchestrator-pid>`, `show` | Worker-Gruppe lebt weiter (verwaist, PPID 1/Subreaper) | |
| P6 | Orchestrator neu starten | Recovery verifiziert die Identität, beendet die Gruppe (TERM→KILL), Run `crashed` + `on_crash`; `/ready` erst danach `200` | |
| P7 | **PID-Wiederverwendung simulieren:** P5 wiederholen, Worker-Gruppe manuell beenden, in der DB `process_start_identity` auf einen falschen `starttime` setzen (`sqlite3 data/orchestrator.sqlite "UPDATE runs SET process_start_identity=json_set(process_start_identity,'$.token','linux:<boot-id>:1') WHERE id='$id'"`), dabei einen fremden Prozess mit derselben PID nicht nötig – Neustart | kein Signal an fremde Prozesse; Run `crashed` (Gruppe weg) bzw. `recovery_pending` (Gruppe mit alter PGID existiert) + Notification `recovery_failed` | |
| P8 | **`recovery_pending` auflösen:** UI „Retry Recovery“ bzw. `POST /api/v1/runs/$id/recovery/retry` (`{"assumeGone":true}`) | Run finalisiert (`crashed`), Lock frei | |
| P9 | **Zombies:** Worker, dessen Kind nicht gereapt wird (z. B. Container ohne Init, `docker run` ohne `--init`) | Cancel meldet kein falsches `kill_failed` (Zombies zählen nicht); Empfehlung `--init`/tini bestätigt | |
| P10 | **Container:** Worker startet `docker run --rm alpine sleep 600` (ohne `-d`) | Cancel beendet den `docker`-CLI-Prozess; Container läuft u. U. weiter → Skript braucht `trap 'docker stop …' TERM` bzw. `--init`; dokumentieren | |
| P11 | **Unter systemd** (`KillMode=mixed`): P5 mit `systemctl kill --kill-whom=main --signal=SIGKILL` | systemd SIGKILLt die ganze cgroup inkl. Worker **und** setsid-Enkel; Recovery findet die Gruppe weg → `crashed` | |
| P12 | Unter systemd: `systemd-cgls -u agent-orchestrator.service` während eines Runs | alle Worker (auch setsid/nohup) in der Dienst-cgroup; Docker-Container **nicht** (gehören zu dockerd) | |
| P13 | Unter systemd: `systemctl stop` während P1 | nur der Hauptprozess bekommt SIGTERM (Worker laufen bis Drain-Timeout weiter); danach Cancel der Gruppe | |

## Auswertung / Entscheidung

Festhalten, ob für V1 ausreichend:

- Prozessgruppe + Startidentität für Cancel/Timeout/Recovery (P1–P8),
- systemd-cgroup als Sicherheitsnetz für Abstürze (P11–P13),
- oder ob Worker zusätzlich in eigene transiente Scopes (`systemd-run --scope --unit=orch-run-<id>`) bzw. einen Wrapper
  gehören, um auch setsid-/nohup-Prozesse bei Cancel (nicht nur beim Dienst-Stop) zuverlässig zu erfassen.

## Protokoll

| Datum | Host / Kernel / systemd / Node | Version | Schritte | Beobachtung / Entscheidung |
|---|---|---|---|---|
| | | | | |
