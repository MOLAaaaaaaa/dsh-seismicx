# dsh-seismicx

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that exposes the
[SeismicX earthquake-catalog skill](https://github.com/cangyeone/seismicx-catalog-skill) as typed,
model-facing tools.

The skill's `SKILL.md` stays the portable workflow document — it runs unchanged on Claude Code,
Codex, and OpenCode. This plugin is the DSH-only enhancement layer over it, and it exists for
three things a skill cannot do:

| | As a skill | As this plugin |
|---|---|---|
| Arguments | A bash string; a bad `--real-R` tuple fails minutes in | Validated at the call boundary, before the process starts |
| Results | stdout prose the model re-parses for paths | A typed JSON value with `picks_path`, `map_path`, `exit_code` |
| Hour-long picks | A blocking bash call that floods the context window | A background job with an id, `job_status`, and `job_kill` |

## Install

Requires a working `seismicx-catalog-skill` checkout and its Python environment.

```bash
dsh plugin --profile <name> add dsh-seismicx
```

Then point the plugin at the skill in the profile's `cordis.patch.yml`:

```yaml
- id: seismicx
  config:
    skillRoot: /absolute/path/to/seismicx-catalog-skill
    python: /path/to/.venv/bin/python
    workdir: /path/to/your/project
```

The shipped `cordis.patch.yml` reads `SEISMICX_SKILL_ROOT` and `SEISMICX_PYTHON` from the
environment instead, if you would rather not write the path into a file.

Verify the wiring without touching any data:

```bash
dsh --profile <name> --dump-config   # the seismicx row should appear
```

then ask the agent to call `seismicx_list_models`.

## Config

| Field | Default | Description |
|---|---|---|
| `skillRoot` | — (required) | Absolute path to the skill checkout |
| `python` | `python3` | Interpreter used for every subcommand |
| `workdir` | `.` | Directory relative output paths resolve against |
| `listModels` / `scan` / `pick` / `plotMap` | `true` | Register the corresponding tool |
| `allowBackground` | `true` | Let `seismicx_pick` publish background jobs |
| `quickTimeoutMs` | `120000` | Budget for metadata subcommands |
| `pickTimeoutMs` | `3600000` | Budget for a **foreground** pick |
| `plotTimeoutMs` | `600000` | Budget for map rendering |

`skillRoot` must be absolute; a relative or empty value fails at load, naming the offending row.
Existence is deliberately not checked — the path may live in a sandbox or remote execution world
this process cannot stat, and `ctx.subprocess` is what resolves it.

## Tools

| Tool | Shape | Notes |
|---|---|---|
| `seismicx_list_models` | foreground, concurrency-safe | Call it first to verify `skillRoot`/`python` |
| `seismicx_scan` | foreground, concurrency-safe | Waveform inventory; confirms the archive is readable |
| `seismicx_pick` | foreground **or background** | Set `run_in_background` for continuous data |
| `seismicx_plot_map` | foreground, concurrency-safe | Returns `map_path`; carries `presentationMeta` for a UI card |

`seismicx_pick` exposes no filtering argument, on purpose: the skill's standing rule is that
continuous waveforms reach the PNSN picker unfiltered.

A background pick is owned by the calling agent, so agent disposal cancels and awaits it. A call
with no agent behind it (a direct service invocation rather than a model turn) is refused rather
than leaking a multi-hour unowned run.

## Design notes

**Everything goes through `ctx.subprocess`, never `node:child_process`.** The seam is what carries
the deployment's sandbox and remote-execution choices, so a composition that points `subprocess` at
a remote runner moves these tools with it, unchanged.

**`argv` is an array and is never shell-interpreted.** A station code or path containing shell
metacharacters cannot escape into a command line.

**A non-zero exit is a domain outcome, not a throw.** It is represented in the canonical value
(`exit_code`, `stderr_tail`) so callers can branch on it. Only spawn-level failures reject.

## Not done yet

- **The remaining nine subcommands.** `polarity`, `associate`, `locate`, `magnitude-ml`,
  `mechanism`, `analyze`, `build-tools`, `init-config`, and the end-to-end `catalog` follow the
  same shape as `seismicx_scan`; adding one is mechanical.
- **Structured returns are shallow.** Tools report the paths they were given plus exit facts, not
  row counts or residual statistics, because the CLI prints prose. The clean fix belongs upstream:
  a `--json` summary flag on the Python subcommands, which this plugin would then surface as typed
  fields instead of `stdout_tail`.
- **No browser half.** `seismicx_plot_map` already persists `presentationMeta.mapPath`, which is
  what a `tool.call.toolview` entry keyed `seismicx_plot_map` needs to render the map inline in the
  conversation instead of leaving a path to open. A GMT/PyGMT renderer and a `shell.overlay`
  control panel (region, projection, depth slice, beachballs) are the intended next step.
- **No capability seams.** The picker, associator, locator, and mechanism engines are still CLI
  flags rather than swappable `ctx.*` providers. Seam-ifying them is what would let a freshly
  fine-tuned checkpoint become a plugin row instead of a code change.

## License

GPL-3.0-only — see [LICENSE](LICENSE).

This plugin is distributed under GPL-3.0 because the skill it wraps is GPL-3.0. DeepSeek Harness
itself is MIT and is **not** covered by this license; MIT is one-way compatible with GPL, so a GPL
plugin may run on an MIT harness, but this plugin's code cannot be relicensed into the harness
repository.

The bundled model checkpoints in the skill carry their own separate terms; see the `.LICENSE` files
beside them in `assets/models/`.
