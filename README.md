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
- For `edit` (replace mode) it reads the current file, applies the replacement
  in memory, and diffs old vs new content with omp's own `generateDiffString`.
  For `write` it diffs the existing file against the new content the same way.
- The diff is rendered with omp's native `renderDiff` (same `toolDiffAdded` /
  `toolDiffRemoved` colors, line-number gutter, and intra-line word-level
  highlighting of changed tokens), shown in a custom overlay via
  `ctx.ui.custom(...)` — so the review looks identical to omp's built-in
  edit/write diff display, but with the full content reachable via scrolling.
- **Approve** (`y`/Enter): the handler returns nothing, the tool runs with its
  original input.
- **Deny** (`n`/Esc): the handler returns `{ block: true, reason }` — the tool
  never executes and the reason is surfaced to the LLM (fail-closed).

## Requirements

- oh-my-pi (omp) with interactive TUI mode (`ctx.hasUI`). In headless/RPC
  sessions the extension skips review, matching the `allow` policy semantics.
- omp loads extensions with its own Bun runtime — no separate build step.

## Install

Install straight from GitHub as an omp plugin (the repo's `omp.extensions`
manifest loads the extension automatically):

```bash
omp plugin install https://github.com/nhktmdzhg/omp-fulldiff.git
```

Then edit `~/.omp/agent/config.yml` to set `edit`/`write` to `allow` (the
extension replaces the native approval dialog, so the native one must be off):

```yaml
tools:
  approval:
    edit: allow # was: prompt
    write: allow # was: prompt
```

Restart omp.

To update after a new push (the git install tracks the default branch, so a
re-install pulls the latest commit; `--force` re-resolves without prompting):

```bash
omp plugin install https://github.com/nhktmdzhg/omp-fulldiff.git --force
```

The displayed version (`omp-fulldiff@0.1.0`) comes from `package.json` at the
installed commit — bump `version` in `package.json` before pushing so the
re-install shows the new version. Git tags are not required for this flow
(installs track the default branch, not tags); create tags only if you want
pinned installs (e.g. `github:nhktmdzhg/omp-fulldiff#v0.1.0`).

> Alternative (no plugin): copy both files from `src/` into
> `~/.omp/agent/extensions/` (omp loads `*.ts` files there directly), or clone
> the repo and point `extensions:` at `src/full-diff-approval.ts`.

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
