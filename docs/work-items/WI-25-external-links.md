# WI-25 – Externe Tools in der Toolbar (z. B. claude-inspect), optional eingebettet

**Herkunft:** Wunsch des Maintainers (19. Oktober 2026): das Dashboard von [claude-inspect](https://github.com/brokoskokoli/claude_inspect) (npm `claude-inspect`, eigener lokaler Webserver, Default-Port 7717, als Dienst 47717) aus der adispatchd-Oberfläche erreichen, lokal und auf dem Server; abschaltbar · **Abhängig von:** `main`; parallel zu WI-23/WI-24 (alle ändern die UI) · **Branch:** `wi-25-external-links` · **Zielversion:** 0.3.1

## Umfang und Entscheidungen

1. **Konfiguration** (`config.yaml`, optional, Default: keine Einträge → nichts sichtbar):
   ```yaml
   ui:
     external_links:
       - id: claude-inspect
         label: Claude Inspect
         url: http://127.0.0.1:47717/   # so, wie der BROWSER das Tool erreicht (lokal oder über den Reverse Proxy)
         enabled: true                  # optionales Flag, Default true
         embed: true                    # true = Seite innerhalb der adispatchd-UI (iframe), false = Link in neuem Tab
   ```
   Allgemein gehalten (beliebige Tools), claude-inspect ist das dokumentierte Beispiel und steht auskommentiert in der `init`-Vorlage.
   Validierung: `id` Konfigurations-ID, eindeutig; `label` 1–40 Zeichen; `url` absolut, nur `http`/`https`, keine Zugangsdaten in der URL (`user:pass@`) – Query-Parameter erlaubt, aber Warnung, wenn ein Parameter wie `t`/`token` aussieht (Token wäre in Config-API/UI sichtbar); `enabled`/`embed` boolean.

2. **UI:**
   - Toolbar/Navigation: je aktivem Eintrag ein Link mit `label` (Icon „extern“ bei `embed: false`). `embed: false` → `target="_blank" rel="noopener noreferrer"`.
   - `embed: true` → eigene Seite (`#/tools/<id>` o. ä.) mit `iframe` auf die URL, volle Höhe, Kopfzeile mit „In neuem Tab öffnen“. `iframe` mit `sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"` und `referrerpolicy="no-referrer"`. Lädt das Tool nicht (z. B. weil es Framing verbietet oder nicht läuft), bleibt der Link „In neuem Tab öffnen“ sichtbar; ein Hinweistext erklärt typische Ursachen.
   - Labels nur als Text.
3. **Sicherheit / Header:** Die CSP der adispatchd-UI erlaubt `frame-src` genau für die Origins der aktivierten `embed`-Einträge (dynamisch aus der Config, nach Reload aktualisiert); sonst bleibt sie unverändert. Keine Proxy-Funktion – der Browser spricht das Tool direkt an.
4. **API:** Die bestehende Config-/UI-Info (z. B. `GET /api/v1/config` oder ein vorhandener UI-Bootstrap-Endpunkt) liefert die aktiven Links (`id`, `label`, `url`, `embed`). `docs/api.md`.
5. **Doku:**
   - Konfigurationsreferenz (`config.yaml` → `ui.external_links`, Beispiel claude-inspect).
   - `docs/operations.md`: claude-inspect neben adispatchd betreiben – lokal (`npx claude-inspect` bzw. `claude-inspect service install` → Port 47717 ohne Token, nur localhost) und auf dem Server (unter dem Benutzer, dessen `~/.claude` angezeigt werden soll – beim Dienstbetrieb ist das der Dienstbenutzer, unter dem die Agenten laufen; Zugriff von außen nur über den Reverse Proxy mit Authentifizierung, der den `Host`-Header lokal weitergibt, da claude-inspect nur lokale Host-Header annimmt; Hinweis zu Tokens). Kurz und ohne Annahmen, die nicht aus claude-inspects README stammen.
   - README (EN) + README.de, Website-Feature-Liste (EN/DE) kurz, Spec-Nachtrag (§16), `CHANGELOG.md` (0.3.1), `docs/handoff/WI-25.md`.
   - Version nicht selbst erhöhen (WI-23 setzt 0.3.1).

## Acceptance Criteria
- [ ] Tests: Schema/Validierung (URL-Schemata, Zugangsdaten, Token-Warnung, doppelte IDs), CSP `frame-src` nur bei `embed`-Einträgen und nach Reload aktualisiert, API liefert nur aktive Einträge, UI-Rendering (Link vs. eingebettete Seite, Text-Escaping).
- [ ] Manuell: mit laufendem claude-inspect auf `127.0.0.1:47717` einmal in headless Chrome die eingebettete Seite gerendert (Screenshot), sofern verfügbar.
- [ ] `examples/config`, `init` validieren; Doku-Test grün; `npm run check` und `npm run test:pack` grün.
