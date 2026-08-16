/**
 * Pure diff builders for the full-diff approval extension.
 *
 * This module must NOT import anything from `@oh-my-pi/*` — it runs standalone
 * so `bun test` works locally without the pi packages installed. All functions
 * return plain (uncolored) unified-ish diff text; ANSI coloring is applied by
 * the view layer in the extension entry file.
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
 * prefixNL[i] = number of '\n' characters in text[0..i). Enables O(1)
 * lineOf(offset): the line index containing offset `c` is prefixNL[c]
 * (a line starts right after the '\n' whose count is prefixNL[c]).
 */
function buildPrefixNL(text: string): Int32Array {
  const arr = new Int32Array(text.length + 1);
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) n++;
    arr[i + 1] = n;
  }
  return arr;
}

/**
 * Split into lines, dropping the phantom "" produced by a trailing "\n"
 * (it is not a real line). "a\nb\n" → ["a", "b"]; "a\n\n" → ["a", ""]
 * (keeps a genuine trailing empty line).
 */
function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Build the text after replacing all occurrences (offsets into the ORIGINAL
 * text); also returns the insertion offset of each replacement inside the
 * final new text.
 */
function buildNewText(
  oldText: string,
  starts: number[],
  oldString: string,
  newString: string,
): { newText: string; newOffsets: number[] } {
  let newText = '';
  const newOffsets: number[] = [];
  let cursor = 0;
  for (const s of starts) {
    const prefix = oldText.slice(cursor, s);
    newOffsets.push(newText.length + prefix.length);
    newText += prefix + newString;
    cursor = s + oldString.length;
  }
  newText += oldText.slice(cursor);
  return { newText, newOffsets };
}

function renderRawBlock(label: string, s: string): string {
  const marker = label === 'old_string' ? '-' : '+';
  const lines = splitLines(s);
  if (lines.length === 0)
    return `${marker}${marker}${marker} ${label} (empty)\n`;
  return `${marker}${marker}${marker} ${label} ---\n${lines.map((l) => `${marker}${l}`).join('\n')}\n`;
}

const CONTEXT = 3;

export interface ReplaceDiffResult {
  ok: boolean;
  text: string;
}

interface Occ {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
}

/**
 * Diff for an edit replace: locate old_string in the file, map it to exact
 * line ranges on both sides using absolute offsets (correct even when several
 * occurrences share a single line), and emit unified-style hunks with 3 lines
 * of context.
 *
 * `ok: false` when old_string has no exact match (the tool may still match via
 * fuzzy matching — the user is warned to verify manually).
 */
export function buildReplaceHunkDiff(
  oldText: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): ReplaceDiffResult {
  if (oldString.length === 0) {
    return { ok: false, text: '⚠ old_string is empty — invalid edit' };
  }

  const starts: number[] = [];
  let idx = oldText.indexOf(oldString);
  while (idx !== -1) {
    starts.push(idx);
    if (!replaceAll) break;
    idx = oldText.indexOf(oldString, idx + oldString.length);
  }

  if (starts.length === 0) {
    return {
      ok: false,
      text:
        '⚠ exact old_string not found in file (tool may still match via fuzzy matching — verify manually)\n' +
        renderRawBlock('old_string', oldString) +
        renderRawBlock('new_string', newString),
    };
  }

  const oldLines = splitLines(oldText);
  const { newText, newOffsets } = buildNewText(
    oldText,
    starts,
    oldString,
    newString,
  );
  const newLines = splitLines(newText);
  const nlOld = buildPrefixNL(oldText);
  const nlNew = buildPrefixNL(newText);

  const occs: Occ[] = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    const end = start + oldString.length;
    const oldStart = nlOld[start];
    const oldEnd = nlOld[end - 1] + 1;
    const no = newOffsets[i];
    const newStart = nlNew[no];
    const newEnd =
      newString.length === 0 ? newStart : nlNew[no + newString.length - 1] + 1;
    occs.push({ oldStart, oldEnd, newStart, newEnd });
  }

  // Merge occurrences whose old-line ranges overlap (replaceAll hitting the
  // same line more than once) into a single block — avoids emitting duplicated
  // lines and negative middle-gap counts.
  const eff: Occ[] = [];
  for (const occ of occs) {
    const last = eff[eff.length - 1];
    if (last && occ.oldStart <= last.oldEnd) {
      last.oldEnd = Math.max(last.oldEnd, occ.oldEnd);
      last.newEnd = Math.max(last.newEnd, occ.newEnd);
    } else {
      eff.push({ ...occ });
    }
  }

  // Group occurrences whose context windows overlap into one hunk.
  const groups: Occ[][] = [];
  for (const occ of eff) {
    const lastGroup = groups[groups.length - 1];
    const lastOcc = lastGroup?.[lastGroup.length - 1];
    if (lastOcc && occ.oldStart - lastOcc.oldEnd <= 2 * CONTEXT) {
      lastGroup.push(occ);
    } else {
      groups.push([occ]);
    }
  }

  const chunks: string[] = [];
  for (const group of groups) {
    const first = group[0];
    const last = group[group.length - 1];
    const ctxBefore = oldLines.slice(
      Math.max(0, first.oldStart - CONTEXT),
      first.oldStart,
    );
    const ctxAfter = oldLines.slice(last.oldEnd, last.oldEnd + CONTEXT);
    const removedCount = group.reduce((s, o) => s + (o.oldEnd - o.oldStart), 0);
    const addedCount = group.reduce((s, o) => s + (o.newEnd - o.newStart), 0);
    const middleCount = group.reduce(
      (s, o, i) =>
        i < group.length - 1 ? s + (group[i + 1].oldStart - o.oldEnd) : s,
      0,
    );
    const oldCount =
      ctxBefore.length + removedCount + middleCount + ctxAfter.length;
    const newCount =
      ctxBefore.length + addedCount + middleCount + ctxAfter.length;
    const oldFirstLine = first.oldStart - ctxBefore.length + 1; // 1-based
    const newFirstLine = first.newStart - ctxBefore.length + 1; // 1-based
    const oldStart = oldCount === 0 ? oldFirstLine - 1 : oldFirstLine;
    const newStart = newCount === 0 ? newFirstLine - 1 : newFirstLine;
    chunks.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const l of ctxBefore) chunks.push(l);
    for (let i = 0; i < group.length; i++) {
      const o = group[i];
      for (const l of oldLines.slice(o.oldStart, o.oldEnd))
        chunks.push(`-${l}`);
      for (const l of newLines.slice(o.newStart, o.newEnd))
        chunks.push(`+${l}`);
      if (i < group.length - 1) {
        for (const l of oldLines.slice(o.oldEnd, group[i + 1].oldStart))
          chunks.push(l);
      }
    }
    for (const l of ctxAfter) chunks.push(l);
  }
  return { ok: true, text: chunks.join('\n') + '\n' };
}

/**
 * Whole-file diff (used for write): line-based LCS + standard unified hunks.
 * O(n*m) is bounded — oversized inputs fall back to showing the full new
 * content as '+' lines.
 */
export function buildFileDiff(
  oldText: string | undefined,
  newText: string,
  path: string,
): string {
  const header = `--- a/${path}\n+++ b/${path}\n`;
  const newLines = splitLines(newText);

  if (oldText === undefined) {
    return (
      header +
      `@@ -0,0 +1,${newLines.length} @@\n` +
      newLines.map((l) => `+${l}`).join('\n') +
      '\n'
    );
  }

  const oldLines = splitLines(oldText);
  const n = oldLines.length;
  const m = newLines.length;
  if (n > 20000 || m > 20000 || n * m > 4_000_000) {
    return (
      header +
      `@@ -1,${n} +1,${m} @@\n` +
      newLines.map((l) => `+${l}`).join('\n') +
      '\n'
    );
  }

  return header + lcsUnifiedDiff(oldLines, newLines);
}

/** LCS suffix DP (full table for backtracking) + unified hunks with context 3. */
function lcsUnifiedDiff(a: string[], b: string[]): string {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const dp = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const idx = i * width + j;
      dp[idx] =
        a[i] === b[j]
          ? dp[(i + 1) * width + j + 1] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }

  type Op = { type: 'same' | 'del' | 'add'; line: string };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const idx = i * width + j;
    if (a[i] === b[j]) {
      ops.push({ type: 'same', line: a[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      ops.push({ type: 'del', line: a[i] });
      i++;
    } else {
      ops.push({ type: 'add', line: b[j] });
      j++;
    }
  }
  while (i < n) {
    ops.push({ type: 'del', line: a[i] });
    i++;
  }
  while (j < m) {
    ops.push({ type: 'add', line: b[j] });
    j++;
  }

  // Contiguous runs of non-"same" ops = changed regions.
  const changes: Array<{ start: number; end: number }> = [];
  let inChange = false;
  let cstart = 0;
  for (let k = 0; k < ops.length; k++) {
    if (ops[k].type !== 'same') {
      if (!inChange) {
        inChange = true;
        cstart = k;
      }
    } else if (inChange) {
      changes.push({ start: cstart, end: k });
      inChange = false;
    }
  }
  if (inChange) changes.push({ start: cstart, end: ops.length });

  // Extend with 3 lines of context; merge hunks that touch.
  const hunks: Array<{ start: number; end: number }> = [];
  for (const c of changes) {
    const start = Math.max(0, c.start - CONTEXT);
    const end = Math.min(ops.length, c.end + CONTEXT);
    const last = hunks[hunks.length - 1];
    if (last && start <= last.end) {
      last.end = end;
    } else {
      hunks.push({ start, end });
    }
  }

  const chunks: string[] = [];
  let k = 0;
  let oldLine = 1;
  let newLine = 1;
  for (const h of hunks) {
    while (k < h.start) {
      const op = ops[k];
      if (op.type === 'same') {
        oldLine++;
        newLine++;
      } else if (op.type === 'del') {
        oldLine++;
      } else {
        newLine++;
      }
      k++;
    }
    let oldCount = 0;
    let newCount = 0;
    for (let x = h.start; x < h.end; x++) {
      const op = ops[x];
      if (op.type === 'same') {
        oldCount++;
        newCount++;
      } else if (op.type === 'del') {
        oldCount++;
      } else {
        newCount++;
      }
    }
    const oldStart = oldCount === 0 ? oldLine - 1 : oldLine;
    const newStart = newCount === 0 ? newLine - 1 : newLine;
    chunks.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (let x = h.start; x < h.end; x++) {
      const op = ops[x];
      if (op.type === 'same') chunks.push(op.line);
      else if (op.type === 'del') chunks.push(`-${op.line}`);
      else chunks.push(`+${op.line}`);
    }
    for (let x = h.start; x < h.end; x++) {
      const op = ops[x];
      if (op.type === 'same') {
        oldLine++;
        newLine++;
      } else if (op.type === 'del') {
        oldLine++;
      } else {
        newLine++;
      }
    }
    k = h.end;
  }
  return chunks.join('\n') + '\n';
}

export interface ReviewPayload {
  title: string;
  diff: string;
  warning?: string;
}

/**
 * Build the review content from a tool-call input.
 * - edit replace: path + old_string/new_string → hunk diff; no match → warning.
 * - write: path + content → whole-file diff (new file → all '+').
 * - internal URL (xd://, memory://, ...): no file diff → show raw arguments.
 * - other edit modes / missing fields: show raw arguments as JSON.
 */
export async function buildReviewPayload(
  input: Record<string, unknown>,
  cwd: string,
  toolName: string,
): Promise<ReviewPayload> {
  const path = typeof input.path === 'string' ? input.path : '';
  const title = `${toolName} ${path || '(no path)'}`;

  if (!path) {
    const diff =
      '⚠ missing path — raw arguments:\n' +
      JSON.stringify(input, null, 2) +
      '\n';
    return { title, diff, warning: diff };
  }
  if (isInternalUrl(path)) {
    const diff =
      'Internal device write — no file diff available:\n' +
      JSON.stringify(input, null, 2) +
      '\n';
    return { title, diff };
  }

  const absPath = resolveFilePath(path, cwd);
  let oldText: string | undefined;
  try {
    oldText = await Bun.file(absPath).text();
  } catch {
    oldText = undefined;
  }

  const oldString = input.old_string;
  const newString = input.new_string;
  if (typeof oldString === 'string' && typeof newString === 'string') {
    const replaceAll = input.replace_all === true;
    const res = buildReplaceHunkDiff(
      oldText ?? '',
      oldString,
      newString,
      replaceAll,
    );
    return {
      title,
      diff: res.text,
      ...(res.ok ? {} : { warning: res.text }),
    };
  }

  const content = input.content;
  if (typeof content === 'string') {
    return { title, diff: buildFileDiff(oldText, content, path) };
  }

  const diff =
    'Non-replace edit mode — showing raw arguments:\n' +
    JSON.stringify(input, null, 2) +
    '\n';
  return { title, diff };
}
