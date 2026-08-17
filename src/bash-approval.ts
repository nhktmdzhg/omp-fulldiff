/**
 * Bash compound-command approval logic for the omp-fulldiff extension.
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
 * any tokenized segment). Pattern matching replicates omp's own primitive:
 *
 * - glob patterns are converted to anchored regexes exactly like
 *   `bashApprovalPatternToRegExp` (split on `*`, escape regex chars, `^...$`,
 *   `u` flag);
 * - segmentation is done by the CALLER with omp's own tokenizer (imported from
 *   `@oh-my-pi/pi-coding-agent/tools/shell-tokenize`): flat segments from
 *   `extractFlatShellCommandSegments` (quotes preserved) drive allow coverage,
 *   quote-stripped `tokenizeShellSegments` output drives deny/prompt — the
 *   same data omp's native matcher (`bashCommandSegments`) uses.
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

/**
 * True when the command contains a `<`/`>` redirect OUTSIDE quotes/escapes.
 * The flat tokenizer does not split on redirects (`cat > out` stays one
 * segment), so `cat *` would otherwise match and auto-run a file-writing
 * command. Mirrors omp's quote-aware scan from `hasBashApprovalShellControl`
 * (tools/bash.ts) restricted to the redirect characters; the native gate
 * rejects commands with these, so the extension delegates instead of
 * auto-allowing.
 */
export function hasRedirectOperator(command: string): boolean {
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === "'") {
      if (ch === "'") quote = undefined;
      continue;
    }
    if (ch === '\\') {
      i++;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === '<' || ch === '>') return true;
  }
  return false;
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

export type BashApprovalKind = 'deny' | 'prompt' | 'allow' | 'ask';

export interface BashApprovalClassification {
  kind: BashApprovalKind;
  /** deny rules that fired (whole command or any tokenized segment). */
  denyRules: BashPatternRule[];
  /** prompt rules that fired (whole command or any tokenized segment). */
  promptRules: BashPatternRule[];
}

function ruleMatchesCommandOrSegment(
  rule: BashPatternRule,
  normalizedCommand: string,
  tokenizedSegments: string[],
): boolean {
  if (patternMatches(rule.match, normalizedCommand)) return true;
  return tokenizedSegments.some((segment) =>
    patternMatches(rule.match, segment),
  );
}

/**
 * Decide what should happen to a bash command given the configured rules:
 * - "deny": a deny rule matched → the native gate rejects the call.
 * - "prompt": a prompt rule matched → the native gate shows the original prompt.
 * - "allow": every segment is covered by an allow rule → run without prompting.
 * - "ask": some segment is uncovered (or the command is unparseable) → prompt.
 *
 * Segments come precomputed from the caller (omp's own tokenizer): `segments`
 * = flat `extractFlatShellCommandSegments` output (original text, quotes
 * preserved) driving allow coverage; `tokenizedSegments` =
 * `tokenizeShellSegments` output joined with a space (quotes stripped) driving
 * deny/prompt — the exact data omp's native matcher uses.
 */
export function classifyBashApproval(
  command: string,
  rules: readonly BashPatternRule[],
  segments: string[],
  tokenizedSegments: string[],
): BashApprovalClassification {
  const normalizedCommand = normalizePattern(command);
  const normalizedSegments = segments
    .map((segment) => normalizePattern(segment))
    .filter((segment) => segment.length > 0);
  const normalizedTokenizedSegments = tokenizedSegments
    .map((segment) => normalizePattern(segment))
    .filter((segment) => segment.length > 0);

  const denyRules = rules.filter(
    (rule) =>
      rule.approval === 'deny' &&
      ruleMatchesCommandOrSegment(
        rule,
        normalizedCommand,
        normalizedTokenizedSegments,
      ),
  );
  if (denyRules.length > 0) {
    return { kind: 'deny', denyRules, promptRules: [] };
  }

  const promptRules = rules.filter(
    (rule) =>
      rule.approval === 'prompt' &&
      ruleMatchesCommandOrSegment(
        rule,
        normalizedCommand,
        normalizedTokenizedSegments,
      ),
  );
  if (promptRules.length > 0) {
    return { kind: 'prompt', denyRules, promptRules };
  }

  const allowRules = rules.filter((rule) => rule.approval === 'allow');
  if (
    normalizedSegments.length > 0 &&
    normalizedSegments.every((segment) =>
      allowRules.some((rule) => patternMatches(rule.match, segment)),
    )
  ) {
    return { kind: 'allow', denyRules, promptRules };
  }

  return { kind: 'ask', denyRules, promptRules };
}
