# WI-19 – Container-Executor

**Herkunft:** Wunschliste aus dem ersten Praxiseinsatz (19. Oktober 2026), Feature F4 · **Abhängig von:** WI-17 (`on_result` für `container` freischalten), WI-18 (Secrets als Datei) · **Branch:** `wi-19-container-executor` · **Zielversion:** 0.3.0 · Gemeinsame Anforderungen siehe WI-17.

**Problem:** Wer Worker in Wegwerf-Containern laufen lässt, schreibt heute ein Wrapper-Skript (Engine-Aufruf, Mounts, Limits, Namen, Stoppen bei Abbruch/Timeout – der Container gehört nicht zur Prozessgruppe des Runs).

**Konfiguration:**
```yaml
execute:
  type: container
  engine: docker                 # docker | podman; Default aus config.yaml (container.engine, Default docker)
  image: localhost/worker:current
  command: [claude, -p, …]       # Templates erlaubt wie bei shell-args
  workdir: /work/repo            # Default: Ziel des Workspace-Mounts
  mounts:
    - { source: '{workspace.path}', target: /work, mode: rw }
    - { source: agents/, target: /home/worker/.claude/agents, mode: ro }   # relativ zum config-dir
  env: { … }                     # wie shell
  secrets: { … }                 # wie shell inkl. delivery: file (WI-18); Secret-Dateien read-only gemountet
  resources: { memory: 8g, cpus: 3, pids: 4096 }
  user: '1000:1000'              # podman: zusätzlich --userns keep-id
  network: default               # default | none | <Name>
  pull: missing                  # never | missing | always (Default missing)
  timeout: { … }                 # wie shell
  cancel_grace: 30s              # wie shell
```
**Verhalten:**
- Containername `adispatch-<run-id>`, Labels `adispatch.run=<run-id>`, `adispatch.workflow=<id>`, `adispatch.instance=<data-dir-hash>` (damit mehrere Instanzen sich nicht gegenseitig aufräumen).
- Immer `--rm --init --cap-drop all --security-opt no-new-privileges`; Env nur explizit (`-e NAME` mit Wert aus der Prozess-Env des Engine-Aufrufs, nicht auf der Kommandozeile, damit Secrets nicht in `ps` erscheinen; Secrets als `env` ebenso).
- Workspace: ist kein Mount mit `source: '{workspace.path}'` angegeben, wird der Workspace automatisch nach `/work` gemountet (rw).
- Kontext- und Ergebnisdatei: eigener Mount `/adispatch` – Kontextdatei read-only (`/adispatch/context.json`), ein leeres Ausgabeverzeichnis des Runs rw (`/adispatch/out/`, Ergebnisdatei `/adispatch/out/result.json`), Secret-Dateien read-only unter `/adispatch/secrets/`. Die `ADISPATCH_*`-Pfade im Container zeigen auf diese Container-Pfade. (Abweichung von „im Workspace-Mount“: so kann der Container weder die Daemon-Logs im Run-Verzeichnis noch andere Dateien außerhalb seines Ausgabeverzeichnisses verändern.)
- stdout/stderr und Events (`@@ADISPATCH_EVENT`) wie beim Shell-Executor (Engine im Vordergrund, `--rm`, Ausgabe des Engine-Prozesses).
- Cancel und Timeout: `<engine> stop -t <cancel_grace> <name>`; danach Engine-Prozess wie beim Shell-Executor behandeln. Endstatus-Klassifikation wie Shell (Exit-Code des Containers).
- Recovery nach Daemon-Neustart: Container dieser Instanz am Label finden. Runs, die beim Neustart als aktiv galten, werden wie Shell-Runs nach Neustart behandelt (bestehende Recovery-Semantik, i. d. R. `crashed`), ihre Container werden gestoppt; Container ohne aktiven Run werden gestoppt. Kein „Übernehmen“ laufender Container (gleiches Verhalten wie beim Shell-Executor; dokumentieren).
- `config.yaml`: neuer Abschnitt `container: { engine: docker }`.

**Validierung:** `image` Pflicht; Mount-Quellen existieren (relativ zum config-dir aufgelöst; Templates nur `{workspace.path}`); `target` absolut, normalisiert, nicht `/`, nicht unter `/adispatch`, keine doppelten Targets; `mode` ∈ {ro, rw}; `resources`-Formate; `on_result` (WI-17) für `container` erlaubt; Engine-Binary wird beim Start geprüft (Warnung/`start_error`, nicht beim Offline-Validate).

**Akzeptanz:** Run mit Fake-Engine (Skript im PATH, das Argumente protokolliert und `run`/`stop`/`ps` simuliert) erzeugt den erwarteten Aufruf; Cancel stoppt den Container; Ergebnisdatei wird gelesen; nach Neustart hängt kein verwaister Container. Zusätzlich ein optionaler echter Docker-Test hinter `ADISPATCH_CONTAINER_TEST=1` (kleines Image wie `busybox`/`alpine`, schreibt Ergebnisdatei).

## Acceptance Criteria
- [ ] Tests wie oben; `workflow dry-run` zeigt den aufgelösten Engine-Aufruf (Secrets maskiert).
- [ ] Doku (Referenz `execute.type: container`, `config.yaml` `container`, Worker-Protokoll Container-Pfade, Spec-Nachtrag, README, operations.md Hinweise zu Docker/Podman-Rechten, CHANGELOG 0.3.0); Doku-Test grün.
- [ ] `npm run check` und `npm run test:pack` grün.
