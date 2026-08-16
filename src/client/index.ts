import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { SeismicWorkbench, type WorkbenchInjected } from './SeismicWorkbench.tsx'
import { installStyles } from './styles.ts'
import type {
  DoctorResult,
  MapFileImportRequest,
  MapFileImportResult,
  MapInputDetection,
  MapInputDetectionRequest,
  MapRequest,
  MapResult,
  PickRunRequest,
  PickRunSnapshot,
  PickStartRequest,
  ScanRequest,
  ScanResult,
  WaveformPlotRequest,
  WaveformPlotResult,
  WorkbenchBootstrap,
  WorkbenchSync,
  WorkbenchSyncRequest,
} from '../workbench-contract.ts'

export const inject = ['connection', 'sessions', 'slots', 'workspaces']

async function callWorkbench<T>(
  connection: ConnectionHandle,
  endpoint: string,
  payload: Record<string, unknown>,
): Promise<T> {
  const result = await connection.rpc.call('/seismicx', endpoint, payload)
  if (!result.ok) throw new Error(result.error.message)
  return result.value as T
}

export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as ConnectionHandle
  ctx.effect(() => installStyles(), 'dsh-seismicx: workbench styles')
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'seismicx',
    order: 20,
    label: 'SeismicX',
    inject: sessionId => ({
      bootstrap: () => callWorkbench<WorkbenchBootstrap>(connection, 'bootstrap', { sessionId }),
      sync: (request: Omit<WorkbenchSyncRequest, 'sessionId'>) =>
        callWorkbench<WorkbenchSync>(connection, 'sync', { sessionId, ...request }),
      doctor: () => callWorkbench<DoctorResult>(connection, 'doctor', { sessionId }),
      scan: (request: Omit<ScanRequest, 'sessionId'>) =>
        callWorkbench<ScanResult>(connection, 'scan', { sessionId, ...request }),
      startPick: (request: Omit<PickStartRequest, 'sessionId'>) =>
        callWorkbench<PickRunSnapshot>(connection, 'pick/start', { sessionId, ...request }),
      cancelPick: (request: Omit<PickRunRequest, 'sessionId'>) =>
        callWorkbench<PickRunSnapshot>(connection, 'pick/cancel', { sessionId, ...request }),
      plotWaveforms: (request: Omit<WaveformPlotRequest, 'sessionId'>) =>
        callWorkbench<WaveformPlotResult>(connection, 'waveform/plot', { sessionId, ...request }),
      plotMap: (request: Omit<MapRequest, 'sessionId'>) =>
        callWorkbench<MapResult>(connection, 'map', { sessionId, ...request }),
      detectMapInputs: (request: Omit<MapInputDetectionRequest, 'sessionId'>) =>
        callWorkbench<MapInputDetection>(connection, 'map/detect', { sessionId, ...request }),
      importMapFile: (request: Omit<MapFileImportRequest, 'sessionId'>) =>
        callWorkbench<MapFileImportResult>(connection, 'file/import', { sessionId, ...request }),
      pickDirectory: () => ctx.workspaces.pickDirectory(),
      openPath: path => ctx.workspaces.openPath(path),
      sendToConversation: async (text) => {
        const session = ctx.sessions.binding(sessionId)?.session
        if (session === undefined) throw new Error('当前对话不可用')
        const result = await session.prompt([{ type: 'text', text }], 'queue')
        if (!result.ok) throw new Error(result.error.message)
      },
    } satisfies WorkbenchInjected),
  }, SeismicWorkbench))
}
