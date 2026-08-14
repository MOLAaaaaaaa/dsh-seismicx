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
import { applyListModelsTool, applyPickTool, applyPlotMapTool, applyScanTool } from './tools.ts'

export { buildArgv, lastLine, runSeismicx, tailLines } from './cli.ts'
export type { CliRun, SkillPaths } from './cli.ts'
export { applyListModelsTool, applyPickTool, applyPlotMapTool, applyScanTool } from './tools.ts'

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

/** Default budget for a foreground pick. Background runs are unbounded by the job runtime. */
export const DEFAULT_PICK_TIMEOUT_MS = 3_600_000

/** Default budget for map rendering. */
export const DEFAULT_PLOT_TIMEOUT_MS = 600_000

/** Plugin config: where the skill lives, how to run it, and which tools to publish. */
export interface Config {
  /** Absolute path to the seismicx-catalog-skill checkout. */
  skillRoot: string
  /** Python interpreter invoked for every subcommand. */
  python?: string
  /** Working directory the CLI resolves relative output paths against. */
  workdir?: string
  /** Register `seismicx_list_models`. */
  listModels?: boolean
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
  /** Budget (ms) for a foreground pick. */
  pickTimeoutMs?: number
  /** Budget (ms) for map rendering. */
  plotTimeoutMs?: number
}

export const Config: Schema<Config> = Schema.object({
  skillRoot: Schema.string().required(),
  python: Schema.string().default('python3'),
  workdir: Schema.string().default('.'),
  listModels: Schema.boolean().default(true),
  scan: Schema.boolean().default(true),
  pick: Schema.boolean().default(true),
  plotMap: Schema.boolean().default(true),
  allowBackground: Schema.boolean().default(true),
  quickTimeoutMs: Schema.number().default(DEFAULT_QUICK_TIMEOUT_MS),
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
 * `skillRoot` is checked for absoluteness here rather than at first use: the
 * failure is self-contained, so it belongs at load where it names the offending
 * `cordis.yml` row, not inside a tool call the model has to interpret. Existence
 * is deliberately NOT checked — the path may live in a sandbox or remote
 * execution world this process cannot stat, and the subprocess seam is what
 * resolves it.
 *
 * @param ctx - context providing `tools`, `subprocess`, and `jobs`.
 * @param config - validated plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  if (!resolved.skillRoot.trim()) throw new Error('seismicx: skillRoot must not be empty')
  if (!isAbsolute(resolved.skillRoot)) {
    throw new Error(`seismicx: skillRoot must be an absolute path, received ${resolved.skillRoot}`)
  }
  assertPositiveInteger('quickTimeoutMs', resolved.quickTimeoutMs)
  assertPositiveInteger('pickTimeoutMs', resolved.pickTimeoutMs)
  assertPositiveInteger('plotTimeoutMs', resolved.plotTimeoutMs)

  const paths: SkillPaths = {
    skillRoot: resolved.skillRoot.replace(/[/\\]+$/, ''),
    python: resolved.python,
    workdir: resolved.workdir,
  }

  if (resolved.listModels) applyListModelsTool(ctx, paths, resolved.quickTimeoutMs)
  if (resolved.scan) applyScanTool(ctx, paths, resolved.quickTimeoutMs)
  if (resolved.pick) applyPickTool(ctx, paths, resolved.pickTimeoutMs, resolved.allowBackground)
  if (resolved.plotMap) applyPlotMapTool(ctx, paths, resolved.plotTimeoutMs)
}
