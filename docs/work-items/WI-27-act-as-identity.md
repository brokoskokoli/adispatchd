# WI-27 – In der UI als GitHub-App-Identität handeln (Kommentar, Labels, Projektfelder)

**Herkunft:** Maintainer (19. Oktober 2026): aus der Oberfläche heraus unter einer konfigurierten Identity (z. B. `maintainer`) auf ein Issue/PR antworten, Labels setzen/entfernen und Projektfelder ändern – ohne als eigene Person aufzutreten. · **Abhängig von:** WI-26 (Anmeldung, Rollen, Audit) · **Branch:** `wi-27-act-as-identity` · **Zielversion:** wie WI-26

## Umfang und Entscheidungen

1. **Freischaltung je Identity** (`identities.yaml`, Default aus):
   ```yaml
   identities:
     maintainer:
       type: github_app
       …
       ui_actions: true          # darf in der UI für Kommentare/Labels/Projektfelder genutzt werden
   ```
   Zusätzlich nötig: `auth.mode` ≠ `none` und Benutzerrolle `admin` (WI-26). Mit `auth.mode: none` sind UI-Aktionen deaktiviert (Hinweis in UI und `config validate`-Warnung, wenn `ui_actions: true` ohne Auth).
2. **API** (schreibend, CSRF wie üblich, Rolle admin):
   - `POST /api/v1/items/:source/:item/comment` `{ identity, body }` – Kommentar als die App (Markdown, max. 65 536 Zeichen, Redaction von Secrets im Text bevor gesendet; kein Marker nötig).
   - `POST /api/v1/items/:source/:item/labels` `{ identity, add: [], remove: [] }` – nutzt den bestehenden `applyUpdate`-Pfad (erst lesen, dann schreiben).
   - `POST /api/v1/items/:source/:item/project` `{ identity, fields: { Status: "Review" } }` – nutzt WI-16 (Validierung gegen `project.fields` der Source, Optionen/Iterationen wie bei `source.update`).
   - `GET /api/v1/items/:source/:item` – Item-Details für das Panel (Titel, URL, Labels, Projektfelder, Liste der freigeschalteten Identities, verfügbare Labels des Repos optional, Optionen der Single-Select-Felder aus den Projektmetadaten).
   - Item-Referenzen werden wie beim manuellen Start validiert (Source muss existieren, Item gehört zur Source).
3. **Audit:** Jede Aktion wird dauerhaft protokolliert (neue Tabelle oder bestehendes Journal; DB-Migration als nächste freie Version): Zeit, angemeldeter Benutzer, Identity, Item, Art, Ergebnis/Fehler, bei Kommentaren die Kommentar-URL (nicht der volle Text). Anzeige: eigene UI-Seite „UI-Aktionen“ bzw. Abschnitt im Item-Panel; API `GET /api/v1/ui-actions`. Retention wie Runs.
4. **UI:** Item-Panel (erreichbar aus Run-Detail, View-Zeilen und einer Suche/Eingabe `owner/repo#nr` oder URL): Kopf mit Titel und Link „Auf GitHub öffnen“ (neuer Tab, dort liest man als man selbst), Auswahl der Identity, Tabs/Abschnitte „Kommentar“ (Textfeld mit Vorschau als reiner Text oder einfaches Markdown-Rendering ohne HTML), „Labels“ (aktuelle Labels als Chips, entfernen/hinzufügen), „Projektfelder“ (deklarierte Felder mit aktuellen Werten, Auswahl bei Single-Select/Iteration, Eingabe bei Text/Zahl/Datum, Leeren). Bestätigungsdialog vor dem Senden („Als maintainer[bot] senden?“). Ergebnis/Fehler sichtbar, danach Item neu laden.
5. **Rate-Limits/Fehler:** GitHub-Fehler verständlich anzeigen (Rechte fehlen, Item gesperrt, Rate-Limit); keine automatischen Retries für Kommentare (Doppelpost vermeiden), Labels/Projektfelder idempotent.
6. **Doku:** Konfigurationsreferenz (`ui_actions`), `docs/api.md`, Spec-Nachtrag (§16, §20), `docs/operations.md` (Voraussetzung Auth, App-Rechte: Issues/PRs write, Projects write), README EN/DE, Website, CHANGELOG, `docs/handoff/WI-27.md`.

## Acceptance Criteria
- [ ] Tests mit Fake-GitHub: Kommentar/Labels/Projektfelder als Identity; nicht freigeschaltete Identity 403; ohne Auth deaktiviert; Rolle operator/viewer 403; CSRF; Item gehört nicht zur Source; Audit-Einträge inkl. Fehlern; keine Retries bei Kommentaren; Redaction im Kommentartext.
- [ ] UI-Tests und ein Screenshot des Item-Panels.
- [ ] Doku-Test grün; `npm run check` und `npm run test:pack` grün.
