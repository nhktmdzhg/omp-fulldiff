/**
 * Bash compound-command approval logic for the full-diff approval extension.
 *
 * omp's native bash approval only lets an `allow` pattern vouch for a command
 * when the command has NO shell control (`|`, `||`, `&&`, `;`, `&`, ...) — see
 * `hasBashApprovalShellControl` in tools/bash.ts. So `grep "hello" | head -n 5`
 * always requires approval even when both sides match `tools.bash.patterns`.
 *
 * This module implements the per-segment rule the extension enforces instead:
 * if EVERY segment of a compound command is covered by some `allow` pattern,
 * the command may run without prompting; anything else falls through to a
 * prompt. `deny`/`prompt` rules keep omp's native semantics (whole command or
 * any segment). All matching replicates omp's own primitives:
 *
 * - glob patterns are converted to anchored regexes exactly like
 *   `bashApprovalPatternToRegExp` (split on `*`, escape regex chars, `^...$`,
 *   `u` flag);
 * - segmentation replicates `extractFlatShellCommandSegments` (quote/escape
 *   aware; conservative — unparseable syntax returns [] so the command cannot
 *   be auto-allowed).
 *
 * Pure module: no `@oh-my-pi/*` imports, so `bun test` runs standalone.
 */

const APPROVAL_VALUES = new Set(['allow', 'deny', 'prompt']);

export type BashPatternApproval = 'allow' | 'deny' | 'prompt';

export interface BashPatternRule {
  match: string;
  approval: BashPatternApproval;
}

/** Normalize a pattern or command the same way omp does: trim + collapse whitespace. */
export function normalizePattern(value: string): string {
  return value.trim().replace(/\s+/gu, ' ');
}

/**
 * Convert a `tools.bash.patterns` glob (`ls *`) into an anchored regex,
 * mirroring `bashApprovalPatternToRegExp` in tools/bash.ts.
 */
export function globToRegExp(pattern: string): RegExp {
  const escaped = normalizePattern(pattern)
    .split('*')
    .map((part) => part.replace(/[\\^$+?.()|[\]{}]/gu, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`, 'u');
}

const compiledCache = new Map<string, RegExp>();

/** Anchored-glob match of a normalized text. */
export function patternMatches(pattern: string, text: string): boolean {
  let regex = compiledCache.get(pattern);
  if (!regex) {
    regex = globToRegExp(pattern);
    compiledCache.set(pattern, regex);
  }
  return regex.test(text);
}

/** Parse `settings.get("bash.patterns")` into rules, mirroring getBashApprovalPatternRules. */
export function parseBashPatternRules(value: unknown): BashPatternRule[] {
  if (!Array.isArray(value)) return [];
  const rules: BashPatternRule[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.match !== 'string') continue;
    const match = normalizePattern(record.match);
    if (match.length === 0) continue;
    const approval =
      typeof record.approval === 'string'
        ? record.approval.trim().toLowerCase()
        : '';
    if (!APPROVAL_VALUES.has(approval)) continue;
    rules.push({ match, approval: approval as BashPatternApproval });
  }
  return rules;
}

/**
 * Split a bash command into independent segments, preserving each segment's
 * original text (quotes/escapes intact). Replicates omp's
 * `extractFlatShellCommandSegments`: boundaries are `|`, `||`, `|&`, `&&`, `;`,
 * `&` and newlines outside quotes; `\n`-continuations are preserved; comments
 * are dropped. Returns [] for syntax the conservative scanner cannot handle
 * (heredocs, command substitution, backticks, grouping, malformed quotes) so
 * callers treat the command as unverifiable and never auto-allow it.
 */
export function extractShellSegments(command: string): string[] {
  const segments: string[] = [];
  let segmentStart = 0;
  let inSingle = false;
  let inDouble = false;
  let atWordStart = true;

  const pushSegment = (end: number): boolean => {
    const segment = command.slice(segmentStart, end).trim();
    if (segment.length === 0) return false;
    segments.push(segment);
    return true;
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '\\') {
        if (i + 1 >= command.length) return [];
        i++;
        continue;
      }
      if (ch === '"') {
        inDouble = false;
        continue;
      }
      if (ch === '`' || (ch === '$' && command[i + 1] === '(')) return [];
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      atWordStart = false;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      atWordStart = false;
      continue;
    }
    if (ch === '\\') {
      if (i + 1 >= command.length) return [];
      i++;
      atWordStart = false;
      continue;
    }
    if (
      ch === '`' ||
      ch === '(' ||
      ch === ')' ||
      (ch === '$' && command[i + 1] === '(') ||
      (ch === '$' && command[i + 1] === '{') ||
      (ch === '<' && command[i + 1] === '<') ||
      ((ch === '{' || ch === '}') &&
        atWordStart &&
        (command[i + 1] === undefined || /[ \t\n;]/.test(command[i + 1])))
    ) {
      return [];
    }
    if (ch === '#' && atWordStart) {
      pushSegment(i);
      const newline = command.indexOf('\n', i + 1);
      if (newline === -1) return segments;
      i = newline;
      segmentStart = newline + 1;
      atWordStart = true;
      continue;
    }
    const isRedirectionOperatorCharacter =
      ch === '|'
        ? command[i - 1] === '>'
        : ch === '&'
          ? command[i - 1] === '>' ||
            command[i - 1] === '<' ||
            command[i + 1] === '>'
          : false;
    if (
      (ch === '\n' || ch === ';' || ch === '|' || ch === '&') &&
      !isRedirectionOperatorCharacter
    ) {
      pushSegment(i);
      const doubled = (ch === '|' || ch === '&') && command[i + 1] === ch;
      const pipeStderr = ch === '|' && command[i + 1] === '&';
      if (doubled || pipeStderr) i++;
      segmentStart = i + 1;
      atWordStart = true;
      continue;
    }
    atWordStart = ch === ' ' || ch === '\t';
  }

  if (inSingle || inDouble) return [];
  pushSegment(command.length);
  return segments;
}

export type BashApprovalKind = 'deny' | 'prompt' | 'allow' | 'ask';

export interface BashApprovalClassification {
  kind: BashApprovalKind;
  /** deny rules that fired (whole command or any segment). */
  denyRules: BashPatternRule[];
  /** prompt rules that fired (whole command or any segment). */
  promptRules: BashPatternRule[];
  /** Segments the command was split into ([] when unparseable). */
  segments: string[];
}

function ruleMatchesCommandOrSegment(
  rule: BashPatternRule,
  normalizedCommand: string,
  segments: string[],
): boolean {
  if (patternMatches(rule.match, normalizedCommand)) return true;
  return segments.some((segment) => patternMatches(rule.match, segment));
}

/**
 * Decide what should happen to a bash command given the configured rules:
 * - "deny": a deny rule matched → the native gate rejects the call.
 * - "prompt": a prompt rule matched → the native gate shows the original prompt.
 * - "allow": every segment is covered by an allow rule → run without prompting.
 * - "ask": some segment is uncovered (or the command is unparseable) → prompt.
 */
export function classifyBashApproval(
  command: string,
  rules: readonly BashPatternRule[],
): BashApprovalClassification {
  const normalizedCommand = normalizePattern(command);
  const segments = extractShellSegments(command)
    .map((segment) => normalizePattern(segment))
    .filter((segment) => segment.length > 0);

  const denyRules = rules.filter(
    (rule) =>
      rule.approval === 'deny' &&
      ruleMatchesCommandOrSegment(rule, normalizedCommand, segments),
  );
  if (denyRules.length > 0) {
    return { kind: 'deny', denyRules, promptRules: [], segments };
  }

  const promptRules = rules.filter(
    (rule) =>
      rule.approval === 'prompt' &&
      ruleMatchesCommandOrSegment(rule, normalizedCommand, segments),
  );
  if (promptRules.length > 0) {
    return { kind: 'prompt', denyRules, promptRules, segments };
  }

  const allowRules = rules.filter((rule) => rule.approval === 'allow');
  if (
    segments.length > 0 &&
    segments.every((segment) =>
      allowRules.some((rule) => patternMatches(rule.match, segment)),
    )
  ) {
    return { kind: 'allow', denyRules, promptRules, segments };
  }

  return { kind: 'ask', denyRules, promptRules, segments };
}
