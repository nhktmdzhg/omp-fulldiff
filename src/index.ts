/**
 * omp-fulldiff — oh-my-pi extension: full-diff approval screen for edit/write
 * and per-segment bash approval.
 *
 * Edit/write: intercept `tool_call` BEFORE the native approval gate, open a
 * custom overlay that shows the FULL diff (j/k scrolling), and let the user
 * approve or deny. The diff is produced with omp's native Rust edit engine
 * (EditSession preview — in-memory, never writes) so it matches exactly what
 * omp would apply for every EditMode (replace / patch / apply_patch /
 * hashline / sloppy). Requires `tools.approval.edit/write: allow`.
 *
 * Bash: omp's native `allow` patterns never apply to compound commands (shell
 * control like `|`, `||`, `&&`), so `grep "hello" | head -n 5` prompts even
 * when both sides match `tools.bash.patterns`. With `tools.approval.bash:
 * allow`, this extension gates the call instead: if EVERY segment is covered
 * by an `allow` pattern the command runs without prompting; otherwise the
 * native-style select prompt appears. `deny`/`prompt` rules and omp's
 * critical patterns are left to the native gate so they keep their original
 * behavior and UI.
 */
import * as os from 'node:os';
import {
  CRITICAL_BASH_PATTERNS,
  renderDiff,
  settings,
  type ExtensionAPI,
} from '@oh-my-pi/pi-coding-agent';
import {
  EditSession,
  EditStore,
  editDiffString,
  type EditFilePreview,
  type EditPolicy,
} from '@oh-my-pi/pi-natives';
import {
  extractFlatShellCommandSegments,
  tokenizeShellSegments,
} from '@oh-my-pi/pi-coding-agent/tools/shell-tokenize';
import type { Component } from '@oh-my-pi/pi-tui';
import {
  extractPrintableText,
  matchesKey,
  replaceTabs,
  truncateToWidth,
} from '@oh-my-pi/pi-tui';
import {
  classifyBashApproval,
  hasRedirectOperator,
  parseBashPatternRules,
} from './bash-approval';
import { buildRawArgsView, isInternalUrl, resolveFilePath } from './diff-builder';

/** Number of diff lines shown in the overlay window (terminal height is unknown at render). */
const BODY_ROWS = 24;

/** Serialize modal UI (`custom()`/`select()` are one-at-a-time). */
let gate: Promise<unknown> = Promise.resolve();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = gate.then(fn);
  gate = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Truncate a command for the approval prompt, mirroring omp's truncateForPrompt. */
function truncateCommand(command: string, maxChars = 2000): string {
  if (command.length <= maxChars) return command;
  const omitted = command.length - maxChars;
  return `${command.slice(0, maxChars)}[…${omitted}ch elided…]`;
}

interface BashCallContext {
  hasUI: boolean;
  select: (title: string, options: string[]) => Promise<string | undefined>;
}

/**
 * Gate a bash tool call:
 * - deny/prompt rules or omp critical patterns → return undefined (the native
 *   gate rejects or prompts with its original UI);
 * - every segment covered by an allow pattern → return undefined (auto-run);
 * - otherwise → show the native-style select prompt; approve runs, deny blocks.
 * Returns a `tool_call` handler result (undefined = let the tool proceed).
 */
async function gateBashCommand(
  command: string,
  ui: BashCallContext,
): Promise<{ block: true; reason: string } | undefined> {
  const rules = parseBashPatternRules(settings.get('bash.patterns'));
  const segments = extractFlatShellCommandSegments(command).map((s) => s.text);
  const tokenizedSegments = tokenizeShellSegments(command).map((s) =>
    s.join(' '),
  );
  let classification = classifyBashApproval(
    command,
    rules,
    segments,
    tokenizedSegments,
  );

  if (
    hasRedirectOperator(command) &&
    classification.kind !== 'deny' &&
    classification.kind !== 'prompt'
  ) {
    // `<`/`>` redirects can't be auto-allowed. The native gate under
    // `bash: allow` auto-runs any command an allow rule can't vouch for (an
    // allow rule never vouches for shell control), so delegating would let
    // `cat > out` write files. Downgrade to ask so the extension prompts.
    // deny/prompt rules are still delegated to the native gate below.
    classification = { kind: 'ask', denyRules: [], promptRules: [] };
  }

  if (classification.kind === 'deny' || classification.kind === 'prompt') {
    // Native gate handles these with its own message/UI.
    return undefined;
  }
  if (CRITICAL_BASH_PATTERNS.some((pattern) => pattern.test(command))) {
    // Native gate prompts for safety-critical commands — avoid a double prompt.
    return undefined;
  }
  if (classification.kind === 'allow') {
    return undefined; // every segment covered → run without prompting
  }

  // "ask": some segment is not covered by an allow pattern.
  if (!ui.hasUI) {
    return {
      block: true,
      reason: 'Bash command requires approval but no interactive UI available',
    };
  }
  const approved = await enqueue(async () => {
    const choice = await ui.select(
      `Allow tool: bash\nCommand: ${truncateCommand(command)}`,
      ['Approve', 'Deny'],
    );
    return choice === 'Approve';
  });
  if (!approved) {
    return { block: true, reason: 'Denied by user (bash approval)' };
  }
  return undefined;
}

interface ReviewPayload {
  title: string;
  diff: string;
  /** Real file path used for context-line syntax highlighting (diff payloads only). */
  filePath?: string;
}

/**
 * Guess the EditMode from the payload shape, matching omp's per-mode schemas.
 * `replace` is the fallback (path + old_string/new_string, or path + content).
 */
function detectEditMode(input: Record<string, unknown>): string {
  const raw = typeof input.input === 'string' ? input.input.trimStart() : '';
  if (raw.startsWith('§')) return 'sloppy';
  if (raw.startsWith('[')) return 'hashline';
  if (raw.startsWith('***')) return 'apply_patch';
  if (Array.isArray(input.edits)) return 'patch';
  return 'replace';
}

/**
 * Preview an `edit` payload with omp's native Rust edit engine — same
 * pipeline omp's streaming preview uses. In-memory only (never writes);
 * returns the numbered unified diff per file. Used for every EditMode, so no
 * per-mode TS parsing is needed (omp 18 removed those helpers).
 */
async function editPreview(
  input: Record<string, unknown>,
  cwd: string,
): Promise<ReviewPayload> {
  const store = new EditStore();
  const policy: EditPolicy = {
    cwd,
    mode: detectEditMode(input),
    // Preview only (no apply), so seen-lines / fuzzy gating are irrelevant —
    // compute the diff regardless.
    allowFuzzy: false,
    fuzzyThreshold: 0,
    enforceSeenLines: false,
    blockAutoGenerated: false,
    planActive: false,
    homeDir: os.homedir(),
    rawInput: false,
  };
  let session: EditSession | null = null;
  let files: EditFilePreview[] = [];
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => resolve(), 150);
    session = new EditSession(store, policy, (_error, batch) => {
      if (!batch.streaming) {
        files = batch.files;
        clearTimeout(timer);
        resolve();
      }
    });
    session.setArgsJson(JSON.stringify(input));
    session.finish();
  });
  session?.close();

  const withDiff = files.filter((f) => f.diff);
  if (withDiff.length > 0) {
    return {
      title: `edit ${withDiff.map((f) => f.path).join(', ')}`,
      diff: withDiff.map((f) => f.diff ?? '').join('\n'),
      filePath: withDiff.length === 1 ? withDiff[0].path : undefined,
    };
  }
  const failed = files.find((f) => f.error);
  return {
    title: 'edit (no preview)',
    diff: buildRawArgsView(
      failed ? `⚠ ${failed.error}` : 'preview unavailable — showing raw arguments',
      input,
    ),
  };
}

/** Preview a `write` payload: diff the existing file against the new content. */
async function writePreview(
  input: Record<string, unknown>,
  cwd: string,
): Promise<ReviewPayload> {
  const path = typeof input.path === 'string' ? input.path : '';
  const title = `write ${path || '(no path)'}`;

  if (isInternalUrl(path)) {
    return {
      title,
      diff: buildRawArgsView(
        'Internal device write — no file diff available',
        input,
      ),
    };
  }
  const content = input.content;
  if (typeof content !== 'string') {
    return {
      title,
      diff: buildRawArgsView('Non-replace edit mode — showing raw arguments', input),
    };
  }

  const absPath = resolveFilePath(path, cwd);
  let oldText = '';
  try {
    oldText = await Bun.file(absPath).text();
  } catch {
    oldText = ''; // new file
  }
  return {
    title,
    diff: editDiffString(oldText, content, path).diff,
    filePath: path,
  };
}

/** Theme-aware coloring that degrades gracefully when a color name is missing. */
function fg(
  theme: unknown,
  color: string,
  text: string,
  fallback: string,
): string {
  const t = theme as { fg?: (c: string, s: string) => string };
  try {
    if (typeof t?.fg === 'function') {
      const out = t.fg(color, text);
      if (typeof out === 'string') return out;
    }
  } catch {
    // fall through
  }
  try {
    return (t?.fg as (c: string, s: string) => string)(fallback, text);
  } catch {
    return text;
  }
}

/** Full-diff review overlay: scrollable diff body + approve/deny keybindings. */
class FullDiffReview implements Component {
  private scroll = 0;

  constructor(
    private header: string,
    private body: string[],
    private keybindings: { matches: (data: string, action: string) => boolean },
    private done: (ok: boolean) => void,
    private theme: unknown,
  ) {}

  handleInput(data: string): void {
    if (this.keybindings.matches(data, 'app.interrupt')) {
      this.done(false);
      return;
    }
    if (matchesKey(data, 'escape')) {
      this.done(false);
      return;
    }
    const printable = extractPrintableText(data);
    if (printable === 'n') {
      this.done(false);
      return;
    }
    if (
      printable === 'y' ||
      matchesKey(data, 'enter') ||
      matchesKey(data, 'return') ||
      data === '\n'
    ) {
      this.done(true);
      return;
    }
    const maxScroll = Math.max(0, this.body.length - BODY_ROWS);
    if (matchesKey(data, 'j') || matchesKey(data, 'down')) {
      if (this.scroll < maxScroll) this.scroll++;
      return;
    }
    if (matchesKey(data, 'k') || matchesKey(data, 'up')) {
      if (this.scroll > 0) this.scroll--;
      return;
    }
    if (matchesKey(data, 'pagedown')) {
      this.scroll = Math.min(this.scroll + BODY_ROWS, maxScroll);
      return;
    }
    if (matchesKey(data, 'pageup')) {
      this.scroll = Math.max(0, this.scroll - BODY_ROWS);
      return;
    }
    if (matchesKey(data, 'home') || printable === 'g') {
      this.scroll = 0;
      return;
    }
    if (matchesKey(data, 'end') || printable === 'G') {
      this.scroll = maxScroll;
    }
  }

  render(width: number): readonly string[] {
    const w = Math.max(1, width);
    const maxScroll = Math.max(0, this.body.length - BODY_ROWS);
    if (this.scroll > maxScroll) this.scroll = maxScroll;
    const start = this.scroll;
    const end = Math.min(this.body.length, start + BODY_ROWS);
    const lines: string[] = [
      fg(
        this.theme,
        'accent',
        truncateToWidth(replaceTabs(this.header), w),
        'accent',
      ),
      fg(
        this.theme,
        'dim',
        truncateToWidth(
          replaceTabs(
            'j/k ↑↓ scroll · pgup/pgdn · g/G top/bottom · y/Enter approve · n/Esc deny',
          ),
          w,
        ),
        'dim',
      ),
    ];
    for (let i = start; i < end; i++) {
      lines.push(truncateToWidth(replaceTabs(this.body[i]), w));
    }
    if (end < this.body.length) {
      lines.push(
        fg(
          this.theme,
          'dim',
          truncateToWidth(
            replaceTabs(`… ${this.body.length - end} more lines (j to scroll)`),
            w,
          ),
          'dim',
        ),
      );
    }
    return lines;
  }

  invalidate(): void {
    // Nothing to do: render returns a fresh array whenever scroll changes.
  }
}

export default function extension(pi: ExtensionAPI): void {
  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName === 'bash') {
      const input = (event.input ?? {}) as Record<string, unknown>;
      const command = typeof input.command === 'string' ? input.command : '';
      if (command.length === 0) return; // let the native tool report the error
      return gateBashCommand(command, {
        hasUI: ctx.hasUI,
        select: (title, options) => ctx.ui.select(title, options),
      });
    }

    if (event.toolName !== 'edit' && event.toolName !== 'write') return;
    if (!ctx.hasUI) return; // headless/RPC: same as `allow` policy — no review

    const input = (event.input ?? {}) as Record<string, unknown>;
    const cwd = (
      typeof ctx.cwd === 'string' ? ctx.cwd : process.cwd()
    ) as string;

    const ok = await enqueue(async (): Promise<boolean> => {
      const payload =
        event.toolName === 'edit'
          ? await editPreview(input, cwd)
          : await writePreview(input, cwd);
      try {
        return await ctx.ui.custom<boolean>(
          (tui, theme, keybindings, done) => {
            try {
              // omp's native diff renderer: colors, gutter, intra-line highlight.
              const colored = renderDiff(payload.diff, {
                filePath: payload.filePath,
              });
              return new FullDiffReview(
                payload.title,
                colored.split('\n'),
                keybindings,
                done,
                theme,
              );
            } catch {
              done(false);
              return { render: () => [], invalidate: () => {} };
            }
          },
          { overlay: true },
        );
      } catch {
        // UI failed to open (non-interactive mode); already guarded by hasUI.
        return false;
      }
    });
    if (ok === false) {
      return { block: true, reason: 'Denied by user (full diff review)' };
    }
    // approve: return nothing → tool runs with the original input
  });
}
