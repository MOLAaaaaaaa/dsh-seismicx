/** Arguments shared by the model-facing tools and the browser workbench. */

/** Waveform scan inputs. */
export interface ScanOperationInput {
  readonly waveformDir: string
  readonly outputPath: string
  readonly errorsPath?: string
}

/** Phase-picking inputs. */
export interface PickOperationInput {
  readonly waveformDir: string
  readonly outputPath: string
  readonly errorsPath?: string
  readonly model?: string
  readonly phases?: string
}

/** Event-map inputs. */
export interface PlotMapOperationInput {
  readonly eventsPath: string
  readonly outputPath: string
  readonly stationsPath?: string
  readonly title?: string
}

/**
 * Build scan subcommand arguments.
 * @param input - validated scan paths.
 * @returns ordered CLI arguments.
 */
export function scanArguments(input: ScanOperationInput): string[] {
  const argv = ['-w', input.waveformDir, '-o', input.outputPath]
  if (input.errorsPath) argv.push('--errors', input.errorsPath)
  return argv
}

/**
 * Build PNSN picker subcommand arguments.
 * @param input - validated picker paths and options.
 * @returns ordered CLI arguments.
 */
export function pickArguments(input: PickOperationInput): string[] {
  const argv = ['-w', input.waveformDir, '-o', input.outputPath, '--picker', 'torchscript-pnsn']
  if (input.errorsPath) argv.push('--errors', input.errorsPath)
  if (input.model) argv.push('--model', input.model)
  if (input.phases) argv.push('--phases', input.phases)
  return argv
}

/**
 * Build map-rendering subcommand arguments.
 * @param input - validated catalog, station, and output paths.
 * @returns ordered CLI arguments.
 */
export function plotMapArguments(input: PlotMapOperationInput): string[] {
  const argv = ['-e', input.eventsPath, '-o', input.outputPath]
  if (input.stationsPath) argv.push('-s', input.stationsPath)
  if (input.title) argv.push('--title', input.title)
  return argv
}
