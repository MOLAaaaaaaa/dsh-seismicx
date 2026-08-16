/**
 * `dsh-seismicx` — model-facing tools over the SeismicX earthquake-catalog skill.
 *
 * This plugin owns schemas, argument validation, timeouts, and presentation; the
 * bundled Python CLI owns the seismology. It registers nothing else: the skill's
 * `SKILL.md` remains the portable workflow document that also runs on Claude
 * Code, Codex, and OpenCode, and this plugin is the DSH-only enhancement layer
 * over it.
 *
 * @module @cangyeone/dsh-seismicx
 */

import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-tools'
import type { SkillPaths } from './cli.ts'
import { applyDoctorTool, applyListModelsTool, applyPickTool, applyPlotMapTool, applyScanTool } from './tools.ts'

export { buildArgv, lastLine, runSeismicx, tailLines } from './cli.ts'
export type { CliRun, SkillPaths } from './cli.ts'
export { applyDoctorTool, applyListModelsTool, applyPickTool, applyPlotMapTool, applyScanTool } from './tools.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'seismicx'

/**
 * Services required before `apply` runs. `jobs` is required rather than
 * optional because `seismicx_pick` advertises background execution in its
 * schema: a composition without the jobs runtime would publish an argument the
 * tool could not honor.
 */
export const inject = ['tools', 'subprocess', 'jobs']

/** Default budget for the cheap metadata subcommands. */
export const DEFAULT_QUICK_TIMEOUT_MS = 120_000

/**
 * Default budget for the environment check.
 *
 * Larger than the metadata budget because `doctor` starts one interpreter per
 * probe, and a probe that fails by hanging — an import blocked on a stalled
 * network mount, say — has to be waited out rather than assumed fast.
 */
export const DEFAULT_DOCTOR_TIMEOUT_MS = 300_000

/** Default budget for a foreground pick. Background runs are unbounded by the job runtime. */
export const DEFAULT_PICK_TIMEOUT_MS = 3_600_000

/** Default budget for map rendering. */
export const DEFAULT_PLOT_TIMEOUT_MS = 600_000

/** Plugin config: where the skill lives, how to run it, and which tools to publish. */
export interface Config {
  /**
   * Absolute path to the seismicx-catalog-skill checkout. Omitting it leaves
   * the plugin inert rather than failing the boot: an installed-but-not-yet-
   * pointed-at plugin is unconfigured, not misconfigured, and must not stop the
   * harness from starting.
   */
  skillRoot?: string
  /** Python interpreter invoked for every subcommand. */
  python?: string
  /** Working directory the CLI resolves relative output paths against. */
  workdir?: string
  /**
   * Extra environment variables for every CLI run.
   *
   * Left to the operator on purpose: see `SkillPaths.env`.
   */
  env?: Record<string, string>
  /** Register `seismicx_list_models`. */
  listModels?: boolean
  /** Register `seismicx_doctor`. */
  doctor?: boolean
  /** Register `seismicx_scan`. */
  scan?: boolean
  /** Register `seismicx_pick`. */
  pick?: boolean
  /** Register `seismicx_plot_map`. */
  plotMap?: boolean
  /** Allow `seismicx_pick` to publish background jobs. */
  allowBackground?: boolean
  /** Budget (ms) for the metadata subcommands. */
  quickTimeoutMs?: number
  /** Budget (ms) for the environment check. */
  doctorTimeoutMs?: number
  /** Budget (ms) for a foreground pick. */
  pickTimeoutMs?: number
  /** Budget (ms) for map rendering. */
  plotTimeoutMs?: number
}

/**
 * Interpreter to invoke when config names none.
 *
 * `python3` is right on Linux and macOS but wrong on Windows, where it is not
 * normally installed and the name resolves to the Microsoft Store's stub — a
 * shim that exits without running anything, so every tool fails identically and
 * for a reason the output never states.
 */
const DEFAULT_PYTHON = process.platform === 'win32' ? 'python' : 'python3'

export const Config: Schema<Config> = Schema.object({
  skillRoot: Schema.string().default(''),
  python: Schema.string().default(DEFAULT_PYTHON),
  workdir: Schema.string().default('.'),
  env: Schema.dict(Schema.string()).default({}),
  listModels: Schema.boolean().default(true),
  doctor: Schema.boolean().default(true),
  scan: Schema.boolean().default(true),
  pick: Schema.boolean().default(true),
  plotMap: Schema.boolean().default(true),
  allowBackground: Schema.boolean().default(true),
  quickTimeoutMs: Schema.number().default(DEFAULT_QUICK_TIMEOUT_MS),
  doctorTimeoutMs: Schema.number().default(DEFAULT_DOCTOR_TIMEOUT_MS),
  pickTimeoutMs: Schema.number().default(DEFAULT_PICK_TIMEOUT_MS),
  plotTimeoutMs: Schema.number().default(DEFAULT_PLOT_TIMEOUT_MS),
})

/** Complete config after Schemastery applies every field default. */
type ResolvedConfig = Required<Config>

/** A configured budget must be a positive integer number of milliseconds. */
function assertPositiveInteger(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`seismicx: ${field} must be a positive integer`)
  }
}

/**
 * Register the enabled tools.
 *
 * Unconfigured and misconfigured are treated differently. An absent `skillRoot`
 * means the plugin is installed but not yet pointed at a checkout: it logs one
 * line naming what to set and registers nothing, so a fresh install cannot stop
 * the harness from booting. A `skillRoot` that IS set but relative is genuine
 * misconfiguration and fails loud at load, where the error names the offending
 * row instead of surfacing inside a tool call the model has to interpret.
 *
 * Existence is deliberately NOT checked — the path may live in a sandbox or
 * remote execution world this process cannot stat, and the subprocess seam is
 * what resolves it.
 *
 * @param ctx - context providing `tools`, `subprocess`, and `jobs`.
 * @param config - validated plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  if (!resolved.skillRoot.trim()) {
    ctx.logger.warn('seismicx: no skillRoot configured, registering no tools — set it on the `seismicx` row in your profile cordis.patch.yml (or export SEISMICX_SKILL_ROOT) to enable them')
    return
  }
  if (!isAbsolute(resolved.skillRoot)) {
    throw new Error(`seismicx: skillRoot must be an absolute path, received ${resolved.skillRoot}`)
  }
  assertPositiveInteger('quickTimeoutMs', resolved.quickTimeoutMs)
  assertPositiveInteger('doctorTimeoutMs', resolved.doctorTimeoutMs)
  assertPositiveInteger('pickTimeoutMs', resolved.pickTimeoutMs)
  assertPositiveInteger('plotTimeoutMs', resolved.plotTimeoutMs)

  const paths: SkillPaths = {
    skillRoot: resolved.skillRoot.replace(/[/\\]+$/, ''),
    python: resolved.python,
    workdir: resolved.workdir,
    env: resolved.env,
  }

  if (resolved.doctor) applyDoctorTool(ctx, paths, resolved.doctorTimeoutMs)
  if (resolved.listModels) applyListModelsTool(ctx, paths, resolved.quickTimeoutMs)
  if (resolved.scan) applyScanTool(ctx, paths, resolved.quickTimeoutMs)
  if (resolved.pick) applyPickTool(ctx, paths, resolved.pickTimeoutMs, resolved.allowBackground)
  if (resolved.plotMap) applyPlotMapTool(ctx, paths, resolved.plotTimeoutMs)
}
