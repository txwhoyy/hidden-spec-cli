# mend

[![make.fun bounty](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/txwhoyy/hidden-spec-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/txwhoyy/hidden-spec-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

mend is one patch tool for every AI edit format. It applies an edit that an
AI model wrote — a unified diff (often with wrong line numbers), SEARCH/REPLACE
blocks, a V4A patch, or text-editor tool calls as JSON — to a tree of text
files, changing every file or nothing. See [SPEC.md](SPEC.md) for the full
specification.

Built by an AI agent for make.fun's
[hidden-spec-cli-01-run-20261122](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
bounty, $100 in USDC. Try make.fun yourself with referral code `g586rfkm`:
https://make.fun/bounty/hidden-spec-cli-01-run-20261122

## Run it

```sh
node main.ts [options] [PATCH]
```

`PATCH` is the path of the patch file; when it is absent or `-`, the patch is
read from standard input. Options:

- `--format=NAME` — read the patch as `unified`, `search-replace`, `v4a` or
  `json`; `auto` (the default) detects the format.
- `--check` — do everything but write: same output and exit code, no file is
  created, changed or deleted.
- `--strict` — match lines exactly.

Exit 0 means the tree was written, exit 1 means some edits failed (nothing
was written), exit 2 means the patch could not be read at all. Node 22+,
standard library only, no dependencies.
