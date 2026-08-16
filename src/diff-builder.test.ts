import { describe, expect, test } from 'bun:test';
import {
  buildFileDiff,
  buildReplaceHunkDiff,
  isInternalUrl,
  resolveFilePath,
} from './diff-builder';

describe('buildReplaceHunkDiff', () => {
  test('single replace: old 2 lines → new 3 lines, correct hunk and @@ counts', () => {
    const oldText = 'line1\nline2\nold A\nold B\nline5\nline6\n';
    const res = buildReplaceHunkDiff(
      oldText,
      'old A\nold B',
      'new A\nnew B\nnew C',
      false,
    );
    expect(res.ok).toBe(true);
    const lines = res.text.split('\n');
    expect(lines[0]).toBe('@@ -1,6 +1,7 @@');
    expect(lines).toContain('line1');
    expect(lines).toContain('line2');
    expect(lines).toContain('-old A');
    expect(lines).toContain('-old B');
    expect(lines).toContain('+new A');
    expect(lines).toContain('+new B');
    expect(lines).toContain('+new C');
    expect(lines).toContain('line5');
    expect(lines).toContain('line6');
  });

  test('replaceAll with two distant occurrences → one hunk, middle lines as context', () => {
    const oldText = 'x\nA\ny\nz\nA\nw\n';
    const res = buildReplaceHunkDiff(oldText, 'A', 'B', true);
    expect(res.ok).toBe(true);
    const lines = res.text.split('\n');
    expect(lines[0]).toBe('@@ -1,6 +1,6 @@');
    expect(lines.filter((l) => l.startsWith('@@')).length).toBe(1);
    expect(lines.filter((l) => l === '-A').length).toBe(2);
    expect(lines.filter((l) => l === '+B').length).toBe(2);
    expect(lines).toContain('y'); // middle context, no prefix
    expect(lines).toContain('z');
    expect(lines).toContain('x');
    expect(lines).toContain('w');
  });

  test('replaceAll multiple times on the SAME line (mid-line) → one hunk, no duplicated lines', () => {
    const oldText = 'xx A yy A zz';
    const res = buildReplaceHunkDiff(oldText, 'A', 'B', true);
    expect(res.ok).toBe(true);
    const lines = res.text.split('\n');
    expect(lines[0]).toBe('@@ -1,1 +1,1 @@');
    expect(lines.filter((l) => l.startsWith('@@')).length).toBe(1);
    expect(lines.filter((l) => l === '-xx A yy A zz').length).toBe(1);
    expect(lines.filter((l) => l === '+xx B yy B zz').length).toBe(1);
  });

  test('old_string not found → ok=false, warning and raw blocks', () => {
    const res = buildReplaceHunkDiff('a\nb\nc\n', 'zzz', 'yyy', false);
    expect(res.ok).toBe(false);
    expect(res.text).toContain('⚠ exact old_string not found');
    expect(res.text).toContain('-zzz');
    expect(res.text).toContain('+yyy');
  });

  test('empty old_string → ok=false', () => {
    const res = buildReplaceHunkDiff('abc', '', 'x', false);
    expect(res.ok).toBe(false);
  });

  test('replace covering the whole file → hunk spans everything, correct header', () => {
    const oldText = 'a\nb\nc\n';
    const res = buildReplaceHunkDiff(oldText, 'a\nb\nc', 'X\nY', false);
    expect(res.ok).toBe(true);
    const lines = res.text.split('\n');
    expect(lines[0]).toBe('@@ -1,3 +1,2 @@');
    expect(lines).toContain('-a');
    expect(lines).toContain('-b');
    expect(lines).toContain('-c');
    expect(lines).toContain('+X');
    expect(lines).toContain('+Y');
  });
});

describe('buildFileDiff', () => {
  test("new file (oldText undefined) → all lines '+'", () => {
    const diff = buildFileDiff(undefined, 'a\nb\nc', 'new.txt');
    const lines = diff.split('\n');
    expect(lines[0]).toBe('--- a/new.txt');
    expect(lines[1]).toBe('+++ b/new.txt');
    expect(lines[2]).toBe('@@ -0,0 +1,3 @@');
    expect(lines.slice(3).every((l) => l === '' || l.startsWith('+'))).toBe(
      true,
    );
  });

  test('one line changed in a 10-line file → correct 3-line-context hunk', () => {
    const oldLines = Array.from(
      { length: 10 },
      (_, i) => `l${String(i + 1).padStart(2, '0')}`,
    );
    const newLines = oldLines.map((l) => (l === 'l05' ? 'CHANGED' : l));
    const diff = buildFileDiff(
      oldLines.join('\n') + '\n',
      newLines.join('\n') + '\n',
      'f.txt',
    );
    const lines = diff.split('\n');
    expect(lines[2]).toBe('@@ -2,7 +2,7 @@');
    expect(lines).toContain('l02');
    expect(lines).toContain('l03');
    expect(lines).toContain('l04');
    expect(lines).toContain('-l05');
    expect(lines).toContain('+CHANGED');
    expect(lines).toContain('l06');
    expect(lines).toContain('l07');
    expect(lines).toContain('l08');
    expect(lines).not.toContain('l01'); // outside the context window
    expect(lines).not.toContain('l10');
  });

  test("empty old file → all '+'", () => {
    const diff = buildFileDiff('', 'x\ny', 'f.txt');
    const lines = diff.split('\n');
    expect(lines[2]).toBe('@@ -0,0 +1,2 @@');
  });

  test('full deletion → header -N,0 +0,0', () => {
    const diff = buildFileDiff('a\nb\n', '', 'f.txt');
    const lines = diff.split('\n');
    expect(lines[2]).toBe('@@ -1,2 +0,0 @@');
  });
});

describe('path helpers', () => {
  test('isInternalUrl recognizes internal schemes', () => {
    expect(isInternalUrl('xd://ast_edit')).toBe(true);
    expect(isInternalUrl('memory://x')).toBe(true);
    expect(isInternalUrl('src/foo.ts')).toBe(false);
    expect(isInternalUrl('/abs/path.ts')).toBe(false);
  });

  test('resolveFilePath joins cwd for relative paths, keeps absolute paths', () => {
    expect(resolveFilePath('src/a.ts', '/w')).toBe('/w/src/a.ts');
    expect(resolveFilePath('/abs/x', '/w')).toBe('/abs/x');
    expect(resolveFilePath('xd://x', '/w')).toBe('');
  });
});
