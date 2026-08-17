/**
 * Pure helpers for the full-diff approval extension.
 *
 * This module must NOT import anything from `@oh-my-pi/*` — it runs standalone
 * so `bun test` works locally without the pi packages installed. Actual diff
 * generation and rendering are delegated to omp's own `generateDiffString`
 * and `renderDiff` (see index.ts) so the overlay looks identical
 * to omp's native edit/write diff display.
 */

/** Internal URL schemes handled by omp (no real file on disk to diff). */
export const INTERNAL_URL_RE =
  /^(?:xd|memory|local|artifact|skill|rule|agent|history|issue|pr|omp|ssh):\/\//;

export function isInternalUrl(path: string): boolean {
  return INTERNAL_URL_RE.test(path);
}

export function resolveFilePath(rawPath: string, cwd: string): string {
  if (isInternalUrl(rawPath)) return '';
  return rawPath.startsWith('/') ? rawPath : `${cwd}/${rawPath}`;
}

/**
 * Find char offsets of every occurrence of `oldString` in `oldText`.
 * Stops after the first hit unless `replaceAll` is set (mirrors the edit
 * tool's replace semantics). Returns [] when there is no exact match.
 */
export function findOldStringOccurrences(
  oldText: string,
  oldString: string,
  replaceAll: boolean,
): number[] {
  if (oldString.length === 0) return [];
  const starts: number[] = [];
  let idx = oldText.indexOf(oldString);
  while (idx !== -1) {
    starts.push(idx);
    if (!replaceAll) break;
    idx = oldText.indexOf(oldString, idx + oldString.length);
  }
  return starts;
}

/**
 * Build the file content after replacing every occurrence at the given
 * char offsets (offsets into the ORIGINAL text).
 */
export function buildNewText(
  oldText: string,
  starts: number[],
  oldString: string,
  newString: string,
): string {
  let out = '';
  let cursor = 0;
  for (const s of starts) {
    out += oldText.slice(cursor, s) + newString;
    cursor = s + oldString.length;
  }
  out += oldText.slice(cursor);
  return out;
}

/** Split into lines, dropping the phantom "" produced by a trailing "\n". */
function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function renderRawBlock(label: string, s: string): string {
  const marker = label === 'old_string' ? '-' : '+';
  const lines = splitLines(s);
  if (lines.length === 0)
    return `${marker}${marker}${marker} ${label} (empty)\n`;
  return `${marker}${marker}${marker} ${label} ---\n${lines.map((l) => `${marker}${l}`).join('\n')}\n`;
}

/**
 * Warning shown when the exact old_string cannot be found (the tool may still
 * match via fuzzy matching), including the raw old/new blocks for manual
 * comparison.
 */
export function buildNotFoundWarning(
  oldString: string,
  newString: string,
): string {
  return (
    '⚠ exact old_string not found in file (tool may still match via fuzzy matching — verify manually)\n' +
    renderRawBlock('old_string', oldString) +
    renderRawBlock('new_string', newString)
  );
}

/**
 * Fallback view for inputs that have no diff (missing path, internal URLs,
 * non-replace edit modes): a label plus the raw tool arguments as JSON.
 */
export function buildRawArgsView(
  label: string,
  input: Record<string, unknown>,
): string {
  return `${label}:\n${JSON.stringify(input, null, 2)}\n`;
}
