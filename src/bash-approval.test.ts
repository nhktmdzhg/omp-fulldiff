import { describe, expect, test } from 'bun:test';
import {
  classifyBashApproval,
  globToRegExp,
  hasRedirectOperator,
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

describe('hasRedirectOperator (redirect = shell control, native parity)', () => {
  test('detects < and > outside quotes', () => {
    expect(hasRedirectOperator('cat > /tmp/x')).toBe(true);
    expect(hasRedirectOperator('cat >> log')).toBe(true);
    expect(hasRedirectOperator('grep x < in.txt')).toBe(true);
    expect(hasRedirectOperator('echo a 2>err')).toBe(true);
    expect(hasRedirectOperator('cmd &> out')).toBe(true);
  });

  test('ignores redirect chars inside quotes and escapes', () => {
    expect(hasRedirectOperator('echo ">"')).toBe(false);
    expect(hasRedirectOperator("echo 'a < b'")).toBe(false);
    expect(hasRedirectOperator('echo \\> x')).toBe(false);
  });

  test('compound without redirect → false', () => {
    expect(hasRedirectOperator('grep x | head -n 5')).toBe(false);
    expect(hasRedirectOperator('ls && echo hi')).toBe(false);
  });
});

describe('classifyBashApproval', () => {
  test('compound command fully covered by allow → allow', () => {
    const rules = [allow('grep *'), allow('head *')];
    const result = classifyBashApproval(
      'grep "hello" | head -n 5',
      rules,
      ['grep "hello"', 'head -n 5'], // flat: extractFlatShellCommandSegments
      ['grep hello', 'head -n 5'], // tokenized: tokenizeShellSegments
    );
    expect(result.kind).toBe('allow');
  });

  test('compound command with an uncovered segment → ask', () => {
    const rules = [allow('grep *')];
    expect(
      classifyBashApproval(
        'grep x | head -n 5',
        rules,
        ['grep x', 'head -n 5'],
        ['grep x', 'head -n 5'],
      ).kind,
    ).toBe('ask');
    expect(
      classifyBashApproval(
        'grep x && echo y',
        [allow('grep *'), allow('echo *')],
        ['grep x', 'echo y'],
        ['grep x', 'echo y'],
      ).kind,
    ).toBe('allow');
  });

  test('simple command covered → allow, uncovered → ask', () => {
    expect(
      classifyBashApproval('ls -la', [allow('ls *')], ['ls -la'], ['ls -la'])
        .kind,
    ).toBe('allow');
    expect(
      classifyBashApproval(
        'git commit -m x',
        [allow('ls *')],
        ['git commit -m x'],
        ['git commit -m x'],
      ).kind,
    ).toBe('ask');
  });

  test('unparseable syntax (empty segments) → ask even if patterns look covering', () => {
    const rules = [allow('ls *'), allow('echo *')];
    // omp's tokenizer returns [] for $(...)/backticks/heredocs — caller passes
    // that through; no segments means no allow coverage.
    expect(classifyBashApproval('ls $(echo x)', rules, [], []).kind).toBe(
      'ask',
    );
  });

  test('deny rule fires on whole command or any segment', () => {
    const rules = [allow('cd *'), deny('rm -rf *')];
    expect(
      classifyBashApproval(
        'cd x && rm -rf /',
        rules,
        ['cd x', 'rm -rf /'],
        ['cd x', 'rm -rf /'],
      ).kind,
    ).toBe('deny');
    expect(
      classifyBashApproval('rm -rf /', rules, ['rm -rf /'], ['rm -rf /']).kind,
    ).toBe('deny');
    expect(
      classifyBashApproval(
        'cd /tmp && ls -la',
        [allow('cd *'), allow('ls *')],
        ['cd /tmp', 'ls -la'],
        ['cd /tmp', 'ls -la'],
      ).kind,
    ).toBe('allow');
  });

  test('deny matches quote-stripped tokenized segments (native parity)', () => {
    const rules = [allow('cd *'), deny('rm -rf *')];
    // Flat `rm "-rf" /` does not match `rm -rf *` (quotes preserved); the
    // tokenized `rm -rf /` does — same data omp's native matcher uses.
    expect(
      classifyBashApproval(
        'cd x && rm "-rf" /',
        rules,
        ['cd x', 'rm "-rf" /'],
        ['cd x', 'rm -rf /'],
      ).kind,
    ).toBe('deny');
  });

  test('prompt rule → prompt', () => {
    const rules = [allow('ls *'), prompt('git commit *')];
    expect(
      classifyBashApproval(
        'git commit -m x',
        rules,
        ['git commit -m x'],
        ['git commit -m x'],
      ).kind,
    ).toBe('prompt');
    expect(
      classifyBashApproval(
        'git commit -m x && ls -la',
        rules,
        ['git commit -m x', 'ls -la'],
        ['git commit -m x', 'ls -la'],
      ).kind,
    ).toBe('prompt');
  });

  test('no rules → ask for anything', () => {
    expect(
      classifyBashApproval('ls -la', [], ['ls -la'], ['ls -la']).kind,
    ).toBe('ask');
  });
});
