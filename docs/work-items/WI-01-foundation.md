# WI-01 – Fundament: Projekt, Core-Typen, Hilfsfunktionen

**Spec:** §3, §4, §9, §20 · **Abhängig von:** – · **Branch:** `wi-01-foundation`

## Ziel
Lauffähiges TypeScript-Projekt mit allen geplanten Dependencies, Verzeichnisstruktur und den **gemeinsamen Interfaces**, gegen die alle späteren Work-Items parallel entwickeln. Dieses WI legt die Verträge fest – Sorgfalt vor Umfang.

## Umfang
1. `package.json` (ESM, `bin: agent-orchestrator`, Scripts `build`, `check`, `test`, `typecheck`), `tsconfig.json` (strict, NodeNext, outDir `dist`), `vitest.config.ts`, `.gitignore`, `.nvmrc`. Dependencies vorinstallieren: `yaml`, `zod`, `fastify`, `@fastify/static`, `croner`, `commander`; dev: `typescript`, `vitest`, `@types/node`, `tsx`.
2. Verzeichnisse mit `index.ts`-Stubs: `src/{core,config,persistence,filters,executors,sources,identities,lifecycle,runs,scheduler,views,notifications,api,ui,cli,service}`.
3. `src/core/` – gemeinsame Verträge (nur Typen + kleine reine Funktionen):
   - `clock.ts`: `Clock { now(): Date }`, `systemClock`, `FakeClock` für Tests.
   - `logger.ts`: minimales strukturiertes Logger-Interface + Console-Implementierung mit Secret-Redaction-Hook.
   - `duration.ts`: `parseDuration('30s'|'45m'|'6h'|'30d'|'100ms') → ms`, `parseSize('100MB') → bytes`; Fehler bei ungültig.
   - `template.ts`: Platzhalter-Interpolation `{run.id}`, `{workflow.id}`, `{workspace.base_dir}`, `{source.id}`, `{source.repository}`, `{item.number}`, `{timestamp}`, `{result.message}` usw. **nur feste Whitelist** (§20.5); unbekannter Platzhalter = Fehler; Modus `path` (jeder interpolierte Wert wird als einzelnes Pfadsegment sicher gemacht: kein `/`, kein `..`, keine NUL) und Modus `text`. Funktion zum Extrahieren/Validieren der verwendeten Platzhalter (für Config-Validierung).
   - `paths.ts`: `resolveWithin(base, rel)` mit Path-Traversal-Schutz, Normalisierung.
   - `ids.ts`: Run-IDs (stabil, eindeutig, sortierbar, pfadsicher, z. B. `run-<zeit>-<random>`), `sourceItemKey(sourceId, itemId)` global eindeutig (§17).
   - `types.ts` – Domänentypen:
     - `TechnicalStatus` (§8.1 inkl. `recovery_pending`), `BusinessResult = 'success'|'failure'|null`, `TriggerType = 'source'|'schedule'|'manual'`, `HookName`.
     - `TriValue = true|false|'unknown'` (§6).
     - `SourceItem { sourceId, itemId, key, url, type: string, fields: Record<string, unknown> }`.
     - `FieldDefinition { name, type: 'string'|'number'|'boolean'|'date'|'string[]', link?, operators: FilterOperator[] }`.
     - `FilterNode` (AST: `all|any|not|{field,operator,value}`), `FilterOperator`.
     - `SourceAdapter` Interface: `type`, `fieldDefinitions()`, `listCandidates(pushdownFilter?) → SourceItem[]`, `getItem(itemId)`, `parseItemRef(urlOrId)`, `resolveField(item, field) → Promise<{value, known}>` für teure Felder (Dependencies), `applyUpdate(item, update, identity)`, `postComment(item, body, marker, identity)`, `findCommentByMarker(item, marker, identity)`.
     - `CredentialProvider` / `IdentityRef`: `getToken(identityId) → Promise<{token, expiresAt}>`.
     - `Executor`-Interface: `start(spec: ExecutionSpec) → RunningProcess` mit `onOutput`, `onEvent`, `wait() → ExecutionOutcome`, `cancel(graceMs)`, `pid`, `startIdentity`.
     - `ExecutionOutcome` (Exit-Code, Signal, spawnError, timedOut, cancelled, resultFile-Status) und `WorkerResult` (Schema §9.2).
     - `ActionStatus = pending|running|succeeded|failed|skipped`.
4. `src/cli/main.ts` mit `commander`: Kommandos als Stubs (`init`, `start`, `config validate`, `config reload`, `workflow dry-run`, `service install|status|uninstall`), globale Optionen `--config-dir`, `--data-dir`.
5. Ein Beispiel-Unit-Test je Hilfsmodul; `npm run check` grün.
6. `README.md` (kurz: Zweck, Dev-Setup, Gate).

## Acceptance Criteria
- [ ] `npm install && npm run check` grün; `npx tsx src/cli/main.ts --help` zeigt alle Kommandos.
- [ ] Alle in Umfang 3 genannten Typen/Interfaces existieren, sind dokumentiert (TSDoc, kurz) und aus `src/core/index.ts` exportiert.
- [ ] Template-Engine lehnt unbekannte Platzhalter ab; Pfadmodus verhindert Traversal (Tests mit `..`, `/`, absoluten Pfaden, NUL).
- [ ] `resolveWithin` verhindert Ausbruch aus dem Basisverzeichnis (Tests).
- [ ] Duration-/Size-Parser getestet inkl. Fehlerfälle.
- [ ] Handoff `docs/handoff/WI-01.md` mit Überblick über die Verträge.
