/** DOM-free helpers of the Artifacts pages (WI-35). */

/** A node of the file tree of an artifact: a directory with children or a file with its size. */
export interface FileTreeNode {
  name: string;
  /** Path relative to the artifact (`/`-separated). */
  path: string;
  /** `null` for directories. */
  size: number | null;
  children: FileTreeNode[];
}

/** Build the tree (directories first, then files, each sorted by name) from the flat file list. */
export function buildFileTree(files: ReadonlyArray<{ path: string; size: number }>): FileTreeNode[] {
  const root: FileTreeNode = { name: '', path: '', size: null, children: [] };
  for (const file of files) {
    const parts = file.path.split('/').filter((p) => p !== '');
    let node = root;
    parts.forEach((name, i) => {
      const path = parts.slice(0, i + 1).join('/');
      const last = i === parts.length - 1;
      let child = node.children.find((c) => c.name === name && (c.size === null) === !last);
      if (!child) {
        child = { name, path, size: last ? file.size : null, children: [] };
        node.children.push(child);
      }
      node = child;
    });
  }
  const sort = (nodes: FileTreeNode[]): void => {
    nodes.sort((a, b) => (a.size === null ? 0 : 1) - (b.size === null ? 0 : 1) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const n of nodes) sort(n.children);
  };
  sort(root.children);
  return root.children;
}

/** API path to download one file of an artifact (every segment URL-encoded). */
export function artifactFileHref(id: string, filePath: string): string {
  return `/api/v1/artifacts/${encodeURIComponent(id)}/files/${filePath.split('/').map(encodeURIComponent).join('/')}`;
}

/** API path to download the whole artifact (a file, or a folder as `.zip`). */
export function artifactDownloadHref(id: string): string {
  return `/api/v1/artifacts/${encodeURIComponent(id)}/download`;
}

/** Route of an artifact page. */
export function artifactHref(id: string): string {
  return `#/artifacts/${encodeURIComponent(id)}`;
}

/** Parse the optional parameter JSON of the start form: an object, or an error text. */
export function parseStartParameters(input: string): { ok: true; value: Record<string, unknown> | undefined } | { ok: false; error: string } {
  const trimmed = input.trim();
  if (trimmed === '') return { ok: true, value: undefined };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false, error: 'Parameters must be a JSON object, e.g. {"mode": "fast"}' };
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, error: 'Parameters are not valid JSON' };
  }
}
