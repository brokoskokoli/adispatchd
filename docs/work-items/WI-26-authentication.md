# WI-26 – Anmeldung (Login) für Weboberfläche und API

**Herkunft:** Maintainer (19. Oktober 2026): Bevor die UI im Namen von GitHub-Apps schreiben darf (WI-27), braucht sie eine Anmeldung. Heute ist sie nur über Tailscale erreichbar und hat keine eigene Authentifizierung (Spec §20: „Keine Anmeldung in V1“). · **Abhängig von:** `main` · **Branch:** `wi-26-authentication` · **Zielversion:** nächste Release (0.3.1 bzw. 0.4.0)

## Umfang und Entscheidungen

1. **Konfiguration** (`config.yaml`, optional; ohne Abschnitt = Verhalten wie bisher, `mode: none`):
   ```yaml
   auth:
     mode: none | password | trusted_header
     # password: eingebaute Benutzer mit Passwort-Hash
     users:
       - name: alice
         password_hash_env: ADISPATCH_PW_ALICE   # Env-Variable mit scrypt-Hash (nie Klartext in YAML)
         role: admin                              # viewer | operator | admin
     # trusted_header: Identität kommt vom vorgeschalteten Proxy
     trusted_header:
       header: Tailscale-User-Login               # Default; z. B. X-Forwarded-User bei oauth2-proxy
       trusted_proxies: [127.0.0.1, ::1]           # nur Anfragen von diesen Adressen werden akzeptiert
       users:                                      # Zuordnung Login → Rolle; nicht gelistet = abgewiesen
         - { login: alice@example.com, role: admin }
     session_ttl: 12h                              # password-Modus
     read_requires_login: true                     # false: Lesen ohne Login, Schreiben nur mit Login
   ```
2. **Rollen:** `viewer` (nur lesen), `operator` (Runs starten/abbrechen, pause/resume/drain, Retry, Blocks lösen, Overrides, Config-Reload, Info-Refresh – alle bisherigen schreibenden Endpunkte), `admin` (zusätzlich WI-27 „Als Identität handeln“, sofern dort pro Identität erlaubt). Jeder bestehende Endpunkt bekommt eine Mindestrolle; Tabelle in `docs/api.md`.
3. **Modus `password`:** Login-Seite in der UI, `POST /api/v1/auth/login` (Name + Passwort), Vergleich gegen scrypt-Hash (`node:crypto`, konstante Zeit), Session-Cookie `HttpOnly; SameSite=Strict; Path=/` und `Secure`, wenn die Anfrage über HTTPS kam (bzw. `X-Forwarded-Proto: https` von einem vertrauenswürdigen Proxy), Sessions im Speicher (gehen beim Neustart verloren → neu anmelden), `POST /api/v1/auth/logout`, `GET /api/v1/auth/me`. Rate-Limit für Login-Versuche je IP und je Benutzer, Verzögerung bei Fehlschlag, keine Unterscheidung „Benutzer unbekannt“/„Passwort falsch“. CLI `adispatch auth hash-password` (liest das Passwort von stdin/TTY ohne Echo, gibt den Hash aus).
4. **Modus `trusted_header`:** Für Tailscale Serve (setzt `Tailscale-User-Login` für Tailnet-Nutzer), oauth2-proxy, Authelia usw. Der Header zählt nur, wenn die TCP-Gegenstelle in `trusted_proxies` liegt; sonst 401. Ohne Header → 401. Login nicht in `users` → 403. Hinweis in der Doku: adispatchd muss dann an `127.0.0.1` gebunden sein und nur über den Proxy erreichbar.
5. **CLI-Steuerbefehle** (`status`, `pause`, `drain`, …) sprechen die API lokal an: sie müssen weiter funktionieren. Lösung: lokaler Steuer-Token – der Daemon schreibt beim Start einen zufälligen Token in `data-dir/control.token` (0600); die CLI liest ihn und sendet ihn als Header; gilt als Rolle `admin` nur für Verbindungen von localhost. Gilt in allen Modi außer `none`.
6. **Bestehende Schutzmechanismen bleiben:** Host-/Origin-Prüfung, CSRF-Header `X-Adispatch-Request` für schreibende Anfragen, SSE nur mit gültiger Session (bzw. Header). `/health` und `/ready` bleiben ohne Login (für Monitoring), liefern aber keine Details.
7. **UI:** Login-Seite (password), Anzeige des angemeldeten Benutzers und Logout in der Toolbar, Schaltflächen ausblenden/deaktivieren, für die die Rolle fehlt; 401 → Login-Seite, 403 → Hinweis.
8. **Audit:** Jede schreibende Aktion protokolliert den Benutzer (Run-Events/Action-Journal bzw. Daemon-Log mit `actor`); in der UI am jeweiligen Objekt sichtbar, wo heute schon Events gezeigt werden.
9. **Doku:** Konfigurationsreferenz (`auth`), `docs/api.md` (Rollen je Endpunkt, Auth-Endpunkte, Steuer-Token), `docs/operations.md` (Tailscale Serve: `tailscale serve --bg http://127.0.0.1:8787` + `trusted_header`; oauth2-proxy; Passwort-Modus mit HTTPS-Proxy; Hash erzeugen), Spec-Nachtrag §20 (ersetzt „Keine Anmeldung in V1“), README EN/DE, Website, `CHANGELOG.md` (Abschnitt der nächsten Version), `docs/handoff/WI-26.md`.

## Acceptance Criteria
- [ ] Tests: `mode: none` unverändert (alle bisherigen Tests grün); password-Login/Logout/Session-Ablauf/Rate-Limit/konstante Zeit (Logik)/Secure-Flag; trusted_header nur von trusted_proxies, unbekannter Login 403, fehlender Header 401; Rollen je Endpunkt (Tabelle als Test); SSE mit/ohne Session; Steuer-Token nur localhost; CLI-Befehle funktionieren mit aktivem Auth; `auth hash-password`.
- [ ] UI-Tests (Login-Seite, Rollen-abhängige Buttons); Screenshot Login-Seite.
- [ ] Doku-Test grün; `npm run check` und `npm run test:pack` grün.
