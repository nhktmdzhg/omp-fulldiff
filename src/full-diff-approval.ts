/**
 * omp-fulldiff — oh-my-pi extension: full-diff approval screen for edit/write.
 *
 * Approach: intercept `tool_call` BEFORE the native approval gate, open a
 * custom overlay that shows the FULL diff (j/k scrolling), and let the user
 * approve or deny:
 * - approve: the handler returns nothing → the tool runs with the original input.
 * - deny: the handler returns `{ block: true, reason }` → the tool never runs
 *   and the reason is surfaced to the LLM (verified in ExtensionToolWrapper.execute:
 *   block → throw Error).
 *
 * Requirement: `tools.approval.edit/write: allow` in config — otherwise the
 * native approval dialog also appears (tool_call fires before the approval gate).
 */
import type { Component } from '@oh-my-pi/pi-tui';
import {
  extractPrintableText,
  matchesKey,
  replaceTabs,
  truncateToWidth,
} from '@oh-my-pi/pi-tui';
import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import { buildReviewPayload, type ReviewPayload } from './diff-builder';

/** Number of diff lines shown in the overlay window (terminal height is unknown at render). */
const BODY_ROWS = 24;

/** Serialize reviews: `custom()` is modal, one at a time (the agent may issue several edits in a turn). */
let gate: Promise<unknown> = Promise.resolve();

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

/** Colorize each diff line by its prefix (theme comes from the custom() factory). */
function buildPayloadView(payload: ReviewPayload, theme: unknown): string[] {
  const lines = payload.diff.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const out: string[] = [];
  for (const line of lines) {
    if (line.startsWith('@@')) out.push(fg(theme, 'accent', line, 'accent'));
    else if (line.startsWith('+++') || line.startsWith('---'))
      out.push(fg(theme, 'muted', line, 'dim'));
    else if (line.startsWith('+'))
      out.push(fg(theme, 'success', line, 'accent'));
    else if (line.startsWith('-'))
      out.push(fg(theme, 'danger', line, 'accent'));
    else if (line.startsWith('⚠'))
      out.push(fg(theme, 'danger', line, 'accent'));
    else out.push(line);
  }
  return out;
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
    if (event.toolName !== 'edit' && event.toolName !== 'write') return;
    if (!ctx.hasUI) return; // headless/RPC: same as `allow` policy — no review

    const input = (event.input ?? {}) as Record<string, unknown>;
    const cwd = (
      typeof ctx.cwd === 'string' ? ctx.cwd : process.cwd()
    ) as string;

    const run = gate.then(async (): Promise<boolean> => {
      const payload = await buildReviewPayload(input, cwd, event.toolName);
      let ok: boolean;
      try {
        ok = await ctx.ui.custom<boolean>(
          (tui, theme, keybindings, done) => {
            try {
              return new FullDiffReview(
                payload.title,
                buildPayloadView(payload, theme),
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
        ok = false;
      }
      return ok;
    });
    gate = run.then(
      () => undefined,
      () => undefined,
    );
    const ok = await run;
    if (ok === false) {
      return { block: true, reason: 'Denied by user (full diff review)' };
    }
    // approve: return nothing → tool runs with the original input
  });
}
