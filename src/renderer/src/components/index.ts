/**
 * @module components
 * @description Barrel export for all UI components, organized by domain.
 *
 * ```
 * components/
 * ├-- layout/      TitleBar, Sidebar
 * ├-- player/      MediaPlayer
 * ├-- editor/      MediaEditor
 * ├-- batch/       FileQueue, ProcessingView
 * ├-- dashboard/   Dashboard
 * ├-- settings/    Settings
 * ├-- logs/        LogViewer
 * ├-- setup/       SetupWizard
 * └-- shared/      Status constants
 * ```
 */

export { TitleBar, Sidebar } from './layout'
export { MediaPlayer } from './player'
export { MediaEditor } from './editor'
export { FileQueue, ProcessingView } from './batch'
export { Dashboard } from './dashboard'
export { Settings } from './settings'
export { LogViewer } from './logs'
export { SetupWizard } from './setup'
export { STATUS_COLORS, STATUS_COLORS_FULL, STATUS_LABELS } from './shared'
