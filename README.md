# omp-fulldiff

An [oh-my-pi](https://github.com/can1357/oh-my-pi) extension with two
approval features:

1. **Full-diff edit/write review** — replaces the default approval dialog for
   `edit`/`write` calls with a full, scrollable diff overlay (omp's native
   approval dialog renders tool arguments in a static header, so anything
   beyond the viewport is unreachable).
2. **Per-segment bash approval** — omp's native `allow` patterns never apply
   to compound commands (`grep "hello" | head -n 5` prompts even when both
   sides match `tools.bash.patterns`). The extension splits the command into
   segments (quote-aware) and auto-runs it only when **every** segment is
   covered by an `allow` pattern; everything else prompts.

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

- oh-my-pi (omp) with interactive TUI mode (`ctx.hasUI`).
- omp loads extensions with its own Bun runtime — no separate build step.

## Install

Install straight from GitHub as an omp plugin (the repo's `omp.extensions`
manifest loads the extension automatically):

```bash
omp plugin install https://github.com/nhktmdzhg/omp-fulldiff.git
```

Then edit `~/.omp/agent/config.yml` to set `edit`/`write`/`bash` to `allow`
(the extension replaces the native approval dialogs, so the native ones must
be off):

```yaml
tools:
  approval:
    edit: allow # was: prompt
    write: allow # was: prompt
    bash: allow # was: prompt
```

Restart omp.

To update after a new push (the git install tracks the default branch, so a
re-install pulls the latest commit; `--force` re-resolves without prompting):

```bash
omp plugin install https://github.com/nhktmdzhg/omp-fulldiff.git --force
```

The displayed version (`omp-fulldiff@0.2.0`) comes from `package.json` at the
installed commit — bump `version` in `package.json` before pushing so the
re-install shows the new version. Git tags are not required for this flow
(installs track the default branch, not tags); create tags only if you want
pinned installs (e.g. `github:nhktmdzhg/omp-fulldiff#v0.2.0`).

> Alternative (no plugin): copy both files from `src/` into
> `~/.omp/agent/extensions/` (omp loads `*.ts` files there directly), or clone
> the repo and point `extensions:` at `src/index.ts`.

> Note: `write: allow` also bypasses the native approval for internal URL
> writes (`xd://...`, `memory://...`, ...). The extension still reviews every
> `edit`/`write` call in interactive sessions — internal-URL writes show the
> raw arguments instead of a diff since there is no file to diff.

## Bash approval

omp's native bash approval only lets an `allow` pattern vouch for a command
when it has **no** shell control (`|`, `||`, `&&`, `;`, `&`, ...) — see
`hasBashApprovalShellControl` in omp's `tools/bash.ts`. So
`grep "hello" | head -n 5` prompts even when both `grep *` and `head *` are
`allow` patterns in `tools.bash.patterns`.

With `tools.approval.bash: allow`, this extension becomes the bash gate and
re-evaluates per segment (replicating omp's glob → regex conversion and using
omp's own quote-aware shell tokenizer):

- **Every segment covered** by an `allow` pattern → the command runs without
  prompting (`grep "hello" | head -n 5` with `grep *` + `head *` → runs).
- **Any segment uncovered** (or the command is unparseable — `$(...)`,
  backticks, heredocs, malformed quotes) → the native-style select prompt
  appears (`Allow tool: bash / Command: ...` with Approve/Deny — the same
  dialog component omp's own approval uses). Deny blocks the call.
- **Shell redirects** (`<` / `>` outside quotes) are never auto-allowed. The
  native gate auto-runs any command an `allow` rule can't vouch for under
  `bash: allow`, so delegating would let `cat > out` write files — the
  extension prompts for redirects instead (quote-wrapped `>` such as
  `echo ">"` is not treated as a redirect).
- **`deny` / `prompt` rules and omp's safety-critical patterns** are left to
  the native gate, keeping their original behavior and UI (a deny rule still
  blocks, a prompt rule still prompts with omp's own dialog).

Segmentation uses omp's own tokenizer directly (imported from
`@oh-my-pi/pi-coding-agent/tools/shell-tokenize`: `extractFlatShellCommandSegments`
for allow coverage, `tokenizeShellSegments` for deny/prompt), and glob matching
replicates omp's anchored-regex conversion exactly (`u` flag), so a command
that matches a pattern natively matches it here too. Uncovered simple
commands (e.g. `git commit -m ...` with no matching pattern) still prompt,
just like omp's `prompt` policy did.

Only list commands that are safe to auto-run with **any** arguments: an
`allow` pattern vouches for the whole segment, so avoid tools with write/exec
flags — `sed` (`-i`), `sort` (`-o`), `awk` (`system()`/`print >`), `tee`,
`find` (`-delete`/`-exec`), `fd` (`-x`), `yq` (`-i`), `curl`/`wget` (`-o`),
`dmesg` (`-c`), `env` (runs a command). Pure readers and filters (`stat`,
`du`, `df`, `ps`, `rg`, `jq`, `cut`, `tr`, `diff`, checksums, ...) are safe
in any case.

In headless/RPC sessions an uncovered command is **blocked** (fail-closed,
no interactive UI to ask); fully covered commands still run.

## Usage

Whenever the agent calls `edit` or `write`, an overlay opens with the full
diff. Bash commands with uncovered segments show an Approve/Deny select
dialog. The overlay keys:

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

`src/diff-builder.ts` and `src/bash-approval.ts` are dependency-free so tests
run without the oh-my-pi packages.

## License

MIT
