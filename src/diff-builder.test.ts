import { describe, expect, test } from 'bun:test';
import {
  buildNewText,
  buildNotFoundWarning,
  buildRawArgsView,
  findOldStringOccurrences,
  isInternalUrl,
  resolveFilePath,
} from './diff-builder';

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

describe('findOldStringOccurrences', () => {
  test('single occurrence without replaceAll', () => {
    expect(findOldStringOccurrences('a\nA\ny\nz\nA\nw\n', 'A', false)).toEqual([
      2,
    ]);
  });

  test('replaceAll finds every occurrence', () => {
    expect(findOldStringOccurrences('a\nA\ny\nz\nA\nw\n', 'A', true)).toEqual([
      2, 8,
    ]);
  });

  test('no exact match → empty array', () => {
    expect(findOldStringOccurrences('a\nb\nc\n', 'zzz', false)).toEqual([]);
  });

  test('empty old_string → empty array', () => {
    expect(findOldStringOccurrences('abc', '', false)).toEqual([]);
  });
});

describe('buildNewText', () => {
  test('single replacement', () => {
    const starts = findOldStringOccurrences('xx A yy', 'A', false);
    expect(buildNewText('xx A yy', starts, 'A', 'B')).toBe('xx B yy');
  });

  test('replaceAll on the same line', () => {
    const starts = findOldStringOccurrences('xx A yy A zz', 'A', true);
    expect(buildNewText('xx A yy A zz', starts, 'A', 'B')).toBe('xx B yy B zz');
  });

  test('multiline replacement', () => {
    const starts = findOldStringOccurrences('a\nold\nb\n', 'old', false);
    expect(buildNewText('a\nold\nb\n', starts, 'old', 'new1\nnew2')).toBe(
      'a\nnew1\nnew2\nb\n',
    );
  });
});

describe('buildNotFoundWarning', () => {
  test('contains warning and raw old/new blocks', () => {
    const warning = buildNotFoundWarning('zzz', 'yyy');
    expect(warning).toContain('⚠ exact old_string not found');
    expect(warning).toContain('-zzz');
    expect(warning).toContain('+yyy');
  });

  test('multiline blocks are rendered line by line', () => {
    const warning = buildNotFoundWarning('a\nb', 'c');
    expect(warning).toContain('-a');
    expect(warning).toContain('-b');
    expect(warning).toContain('+c');
  });
});

describe('buildRawArgsView', () => {
  test('label plus pretty-printed JSON', () => {
    const view = buildRawArgsView(
      'Internal device write — no file diff available',
      {
        path: 'xd://ast_edit',
        content: 'x',
      },
    );
    expect(view).toContain('Internal device write');
    expect(view).toContain('"path": "xd://ast_edit"');
    expect(view).toContain('"content": "x"');
  });
});
