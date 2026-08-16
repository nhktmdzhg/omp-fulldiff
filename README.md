# omp-fulldiff

An [oh-my-pi](https://github.com/can1357/oh-my-pi) extension that replaces the
default tool-approval dialog for `edit`/`write` calls with a **full, scrollable
diff** review overlay.

The native approval dialog renders the tool arguments inside a static,
non-scrollable header — anything beyond the viewport is unreachable. This
extension intercepts `edit`/`write` before the native approval gate and shows
the complete diff (with j/k scrolling), letting you review exactly what the
agent will change, then approve or deny for real.

## How it works

- The extension listens on the `tool_call` event, which omp fires **before**
  the approval gate (`ExtensionToolWrapper.execute`).
- For `edit` (replace mode) it builds a hunk diff from `path` +
  `old_string`/`new_string` by reading the current file. For `write` it builds
  a whole-file LCS diff against the existing content.
- The diff is rendered in a custom overlay via `ctx.ui.custom(...)`,
  replacing the native approve/deny dialog (requires `edit`/`write` to be set
  to `allow` in config).
- **Approve** (`y`/Enter): the handler returns nothing, the tool runs with its
  original input.
- **Deny** (`n`/Esc): the handler returns `{ block: true, reason }` — the tool
  never executes and the reason is surfaced to the LLM (fail-closed).

## Requirements

- oh-my-pi (omp) with interactive TUI mode (`ctx.hasUI`). In headless/RPC
  sessions the extension skips review, matching the `allow` policy semantics.
- omp loads extensions with its own Bun runtime — no separate build step.

## Install

1. Clone this repo (or copy `src/` somewhere).

2. Edit `~/.omp/agent/config.yml`:

   ```yaml
   tools:
     approval:
       edit: allow # was: prompt
       write: allow # was: prompt
   extensions:
     - /path/to/omp-fulldiff/src/full-diff-approval.ts
   ```

   Alternatively, copy both files from `src/` into `~/.omp/agent/extensions/`
   (omp loads `*.ts` files there directly).

3. Restart omp.

> Note: `write: allow` also bypasses the native approval for internal URL
> writes (`xd://...`, `memory://...`, ...). The extension still reviews every
> `edit`/`write` call in interactive sessions — internal-URL writes show the
> raw arguments instead of a diff since there is no file to diff.

## Usage

Whenever the agent calls `edit` or `write`, an overlay opens with the full
diff:

| Key             | Action         |
| --------------- | -------------- |
| `j` / `↓`       | scroll down    |
| `k` / `↑`       | scroll up      |
| `pgup` / `pgdn` | page up / down |
| `g` / `G`       | top / bottom   |
| `y` / `Enter`   | approve        |
| `n` / `Esc`     | deny           |

Non-replace edit modes (hashline / apply_patch / patch) and missing files
fall back to showing the raw arguments as JSON — the review flow still works,
just without a computed diff.

## Development

```bash
bun test
```

The diff builder (`src/diff-builder.ts`) is dependency-free so tests run
without the oh-my-pi packages.

## License

MIT
