/**
 * Component `artifacts` – public API (WI-35): collecting the files and folders
 * a workflow declares in `execute.artifacts`, serving them (listing, files,
 * `.zip`), staging them as read-only input of a run and deleting them.
 * Other components import from this module only.
 */
export { ArtifactService, type ArtifactServiceOptions, type ArtifactZip, type CollectInput, type CollectionReport, type CollectWarning } from './service.js';
export { ArtifactError } from './errors.js';
export { inspectArtifactPath, ARTIFACT_MAX_ENTRIES, ARTIFACT_MAX_FILES, type CollectFailure, type CollectSkip, type InspectResult } from './collect.js';
export { artifactPathSegments, ARTIFACT_LIST_LIMIT, type ArtifactFile, type OpenedArtifactFile } from './files.js';
export { makeTreeWritable } from './input.js';
export { ZIP_MAX_BYTES, ZIP_MAX_ENTRIES } from './zip.js';
