import { describe, expect, test } from 'bun:test';
import {
  classifyBashApproval,
  extractShellSegments,
  globToRegExp,
  normalizePattern,
  parseBashPatternRules,
  patternMatches,
  type BashPatternRule,
} from './bash-approval';

const allow = (match: string): BashPatternRule => ({
  match,
  approval: 'allow',
});
const deny = (match: string): BashPatternRule => ({ match, approval: 'deny' });
const prompt = (match: string): BashPatternRule => ({
  match,
  approval: 'prompt',
});

describe('pattern matching (glob → anchored regex, omp parity)', () => {
  test('normalizePattern trims and collapses whitespace', () => {
    expect(normalizePattern('  ls   -la  ')).toBe('ls -la');
  });

  test('glob * becomes .* inside anchored regex', () => {
    expect(globToRegExp('grep *').source).toBe('^grep .*$');
    expect(globToRegExp('ls *').source).toBe('^ls .*$');
  });

  test('regex specials in the pattern are escaped', () => {
    expect(globToRegExp('a.b *').source).toBe('^a\\.b .*$');
  });

  test('patternMatches is anchored on both ends', () => {
    expect(patternMatches('grep *', 'grep "hello"')).toBe(true);
    expect(patternMatches('ls *', 'ls -la')).toBe(true);
    expect(patternMatches('git diff *', 'git diff "a b"')).toBe(true);
    expect(patternMatches('head *', 'echo head -n 5')).toBe(false);
    expect(patternMatches('grep *', 'x grep hello')).toBe(false);
  });
});

describe('parseBashPatternRules', () => {
  test('parses valid rules, filters invalid entries', () => {
    const rules = parseBashPatternRules([
      { match: 'ls *', approval: 'allow' },
      { match: '  rm   -rf * ', approval: 'deny' },
      { match: 'git commit *', approval: 'PROMPT' },
      { match: 'no-approval' },
      { match: '', approval: 'allow' },
      'not-an-object',
      42,
    ]);
    expect(rules).toEqual([
      { match: 'ls *', approval: 'allow' },
      { match: 'rm -rf *', approval: 'deny' },
      { match: 'git commit *', approval: 'prompt' },
    ]);
  });

  test('non-array input → empty rules', () => {
    expect(parseBashPatternRules(undefined)).toEqual([]);
    expect(parseBashPatternRules({})).toEqual([]);
  });
});

describe('extractShellSegments', () => {
  test('pipe splits segments, preserving quotes', () => {
    expect(extractShellSegments('grep "hello" | head -n 5')).toEqual([
      'grep "hello"',
      'head -n 5',
    ]);
  });

  test('&&, ||, ;, & and newlines are boundaries', () => {
    expect(extractShellSegments('a && b || c; d & e')).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
    ]);
    expect(extractShellSegments('cd /tmp\nls -la')).toEqual([
      'cd /tmp',
      'ls -la',
    ]);
  });

  test('quoted operators are not boundaries', () => {
    expect(extractShellSegments('echo "a|b"')).toEqual(['echo "a|b"']);
    expect(extractShellSegments("echo 'a && b'")).toEqual(["echo 'a && b'"]);
  });

  test('double operator || collapses into one boundary', () => {
    expect(extractShellSegments('grep x || echo y')).toEqual([
      'grep x',
      'echo y',
    ]);
  });

  test('unparseable syntax bails with []', () => {
    expect(extractShellSegments('ls $(echo x)')).toEqual([]);
    expect(extractShellSegments('echo `hi`')).toEqual([]);
    expect(extractShellSegments('cat <<EOF')).toEqual([]);
    expect(extractShellSegments("echo 'unclosed")).toEqual([]);
  });
});

describe('classifyBashApproval', () => {
  test('compound command fully covered by allow → allow', () => {
    const rules = [allow('grep *'), allow('head *')];
    const result = classifyBashApproval('grep "hello" | head -n 5', rules);
    expect(result.kind).toBe('allow');
  });

  test('compound command with an uncovered segment → ask', () => {
    const rules = [allow('grep *')];
    expect(classifyBashApproval('grep x | head -n 5', rules).kind).toBe('ask');
    expect(
      classifyBashApproval('grep x && echo y', [
        allow('grep *'),
        allow('echo *'),
      ]).kind,
    ).toBe('allow');
  });

  test('simple command covered → allow, uncovered → ask', () => {
    expect(classifyBashApproval('ls -la', [allow('ls *')]).kind).toBe('allow');
    expect(classifyBashApproval('git commit -m x', [allow('ls *')]).kind).toBe(
      'ask',
    );
  });

  test('unparseable syntax → ask even if patterns look covering', () => {
    const rules = [allow('ls *'), allow('echo *')];
    expect(classifyBashApproval('ls $(echo x)', rules).kind).toBe('ask');
  });

  test('deny rule fires on whole command or any segment', () => {
    const rules = [allow('cd *'), deny('rm -rf *')];
    expect(classifyBashApproval('cd x && rm -rf /', rules).kind).toBe('deny');
    expect(classifyBashApproval('rm -rf /', rules).kind).toBe('deny');
    expect(
      classifyBashApproval('cd /tmp && ls -la', [allow('cd *'), allow('ls *')])
        .kind,
    ).toBe('allow');
  });

  test('prompt rule → prompt', () => {
    const rules = [allow('ls *'), prompt('git commit *')];
    expect(classifyBashApproval('git commit -m x', rules).kind).toBe('prompt');
    expect(classifyBashApproval('git commit -m x && ls -la', rules).kind).toBe(
      'prompt',
    );
  });

  test('no rules → ask for anything', () => {
    expect(classifyBashApproval('ls -la', []).kind).toBe('ask');
  });
});
