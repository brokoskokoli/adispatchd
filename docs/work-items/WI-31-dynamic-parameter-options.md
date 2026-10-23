# WI-31 – Parameter manueller Starts: Auswahllisten zur Laufzeit (`options_from`)

**Herkunft:** Wunsch des Maintainers (23. Oktober 2026) · **Abhängig von:** `main` (0.6.0) · **Branch:** `wi-31-dynamic-parameter-options` · **Zielversion:** 0.7.0

## Problem

Workflows haben `parameters` (§3.4.7) mit `string`/`number`/`boolean`/`enum`; das Startformular der UI und
`POST /api/v1/workflows/:id/start` übergeben sie, `{parameters.<name>}` reicht sie an Skript/Hooks weiter. Die
`values` eines `enum` stehen aber fest in der YAML-Datei. Gewünscht: beim manuellen Start z. B. einen **Branch** oder
**Tag** des Repositorys oder einen Wert aus einem **eigenen Skript** auswählen. (Item-Auswahl per Filter ist
ausdrücklich **nicht** Teil dieses WI.)

## Konfiguration

Neuer optionaler Schlüssel `options_from` für Parameter vom Typ `enum` – **statt** `values` (beides zusammen ist ein
Konfigurationsfehler), plus optional `allow_custom`:

```yaml
trigger: { type: manual }
parameters:
  branch:
    type: enum
    options_from: { github: branches, source: project_a }
    default: main
  tag:
    type: enum
    options_from: { github: tags, source: project_a, limit: 50 }
  target:
    type: enum
    options_from:
      command: ./scripts/list-hosts.sh
      args: ['--env', 'prod']
      timeout: 10s
      cache: 5m
    allow_custom: true
execute:
  type: shell
  command: ./scripts/deploy.sh
  args: ['{parameters.branch}', '{parameters.tag}', '{parameters.target}']
```

| Schlüssel | Typ | Pflicht | Default | Regeln |
|---|---|---|---|---|
| `options_from.github` | Enum | eins von `github`/`command` | | `branches`, `tags` |
| `options_from.source` | Source-ID | bei `github`; bei genau einer Trigger-/Workflow-Source optional | die einzige Source des Workflows | muss eine GitHub-Source sein; Lesen mit deren Identity (§6.10) |
| `options_from.limit` | Integer 1–500 | nein | `100` | höchstens so viele Optionen |
| `options_from.command` | String | eins von `github`/`command` | | wie `command` von Shell-Actions/Info-Kacheln (relativ zum Config-Verzeichnis, kein Template) |
| `options_from.args` | Liste String | nein | `[]` | nur Platzhalter `workflow.*`, `timestamp` |
| `options_from.secrets` | wie Shell-Actions | nein | | Tokens/Secrets wie dort (WI-18) |
| `options_from.timeout` | Dauer | nein | `10s` | ≤ `60s` |
| `options_from.cache` | Dauer | nein | `1m` (`github`), `0s` (`command`) | `0s` = nicht cachen |
| `allow_custom` | Boolean | nein | `false` | nur mit `options_from`: auch Werte außerhalb der Liste erlaubt |

- **GitHub:** `branches` alphabetisch, Default-Branch zuerst; `tags` neueste zuerst (Reihenfolge der API). Paginierung
  bis `limit`. Fehler (Rechte, Rate-Limit, nicht erreichbar) → Fehler im Optionen-Ergebnis, kein Absturz.
- **Command:** stdout UTF-8; entweder eine Option pro Zeile (leere Zeilen ignoriert, Trim), oder – wenn die Ausgabe
  mit `[` beginnt – JSON-Liste aus Strings oder `{ "value": "…", "label": "…" }`. Exit ≠ 0, Timeout, ungültiges JSON,
  mehr als 500 Optionen, Werte > 200 Zeichen oder mit Steuerzeichen → Fehler mit kurzer Meldung (stderr gekürzt,
  ohne Secrets). Ausführung wie Info-Kacheln (`dashboard.yaml`, WI-24): eigenes Arbeitsverzeichnis Config-Dir,
  Prozessgruppe, Kill bei Timeout; gleichzeitige Abrufe desselben Parameters werden zusammengelegt.
- **`default`:** muss bei `options_from` nicht in einer statischen Liste stehen (Prüfung erst zur Laufzeit). Fehlt
  der Default in der aktuellen Liste, zeigt das Formular einen Hinweis; beim Start gilt die normale Prüfung.
- **Automatische Workflows** (Source/Cron): erhalten wie bisher nur `default`; `options_from` ohne `default` ist dort ein
  Konfigurationsfehler; der Default wird bei automatischen Runs **nicht** gegen die Liste geprüft (kein Abruf).
- `values` bleibt unverändert gültig; `allow_custom` mit `values` (statisch) ist ebenfalls erlaubt.

## Verhalten beim Start

- `POST /api/v1/workflows/:id/start` prüft serverseitig: Bei `options_from` ohne `allow_custom` muss der Wert in der
  **aktuellen** Optionenliste stehen (Cache darf genutzt werden). Liste nicht abrufbar → HTTP 502
  `parameter_options_unavailable` mit Parametername (kein Start). Mit `allow_custom` keine Listenprüfung.
- Werte gelangen wie bisher als einzelne argv-Einträge/Env-Werte zum Prozess (keine Shell); im Pfadmodus als
  sicheres Pfadsegment (§5).
- Gespeichert am Run wie bisher.

## API und UI

- `GET /api/v1/workflows/:id/parameters/:name/options` → `{ "options": [{ "value", "label" }], "fetchedAt",
  "cached": bool, "allowCustom": bool, "error"?: { "code", "message" } }`; Query `refresh=true` umgeht den Cache.
  Rolle wie das Lesen von Workflows (viewer) – **aber** `command`-Optionen führen ein Skript aus: Abruf nur für Rollen,
  die starten dürfen (operator), damit `viewer` keine Skripte auslösen kann. Rate-Limit/Coalescing gegen Dauerabruf.
- `GET /api/v1/workflows/:id` beschreibt die Parameter inkl. `optionsFrom` (Art, Source, ohne Command-Argumente mit
  Secrets) und `allowCustom`.
- UI-Startformular: lädt die Optionen beim Öffnen, Auswahlfeld mit Suche (bei > 15 Optionen), Knopf „Neu laden“,
  Lade- und Fehlerzustand mit Meldung; mit `allow_custom` Eingabefeld mit Vorschlagsliste (`datalist`). Labels nur als
  Text.
- `adispatch workflow dry-run` bzw. die CLI zum Starten (falls vorhanden) braucht keine Auswahl; ggf. `--param`
  unverändert.

## Doku

`docs/configuration-reference.md` (§3.4.7 inkl. Beispiel, das der Doku-Test validiert; Fehlerbeispiele),
`docs/api.md`, `docs/spec-v0.1.md` (Nachtrag WI-31), `CHANGELOG.md` (Unreleased), `docs/status.md`, README EN/DE und
Website-Feature-Liste kurz, `examples/config` (ein manueller Workflow mit Branch/Tag/Command), `init`-Vorlage
auskommentiert, `docs/handoff/WI-31.md`. Keine lokalen Pfade, keine privaten Projektnamen.

## Acceptance Criteria

- [ ] Schema/Validierung: `options_from` nur bei `enum`, nicht zusammen mit `values`; genau eins von
      `github`/`command`; `source` existiert und ist GitHub; Grenzen (`limit`, `timeout`, `cache`); `allow_custom`
      nur sinnvoll kombiniert; automatischer Workflow ohne `default` → Fehler.
- [ ] GitHub-Optionen gegen Fake-GitHub: Branches (Default zuerst), Tags, Paginierung, `limit`, Fehlerfälle; richtige
      Identity.
- [ ] Command-Optionen: Zeilen- und JSON-Format, Labels, Timeout/Kill, Exit ≠ 0, Größen-/Zeichengrenzen, Cache und
      `refresh`, Coalescing, Secrets nicht in Meldungen/Logs.
- [ ] Start: Wert außerhalb der Liste → 400 mit klarer Meldung; mit `allow_custom` erlaubt; Liste nicht abrufbar → 502;
      Wert kommt korrekt in `args`/`env`/Kontextdatei an (E2E mit Shell-Worker).
- [ ] Rollen: viewer darf `command`-Optionen nicht abrufen (403), operator schon; mit `auth.mode: none` wie bisher.
- [ ] UI: Formular mit dynamischer Liste, Fehlerzustand, Neu laden, `allow_custom` (im Browser einmal geprüft,
      Screenshot nach `docs/screenshots/` nur wenn hilfreich).
- [ ] `examples/config` und `init` validieren; Doku-Test grün; `npm run check` und `npm run test:pack` grün.
