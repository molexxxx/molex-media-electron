/**
 * @module main/ipc
 * @description Barrel module - composes all IPC handler groups into a
 * single {@link registerIPC} entry point called from the app bootstrap.
 */

import { registerConfigIPC } from './config'
import { registerFilesIPC } from './files'
import { registerProcessingIPC } from './processing'
import { registerEditorIPC } from './editor'
import { registerMediaIPC } from './media'
import { registerSystemIPC } from './system'

/**
 * Register every IPC handler for renderer ↔ main communication.
 * Called once during app initialisation.
 */
export function registerIPC(): void {
  registerConfigIPC()
  registerFilesIPC()
  registerProcessingIPC()
  registerEditorIPC()
  registerMediaIPC()
  registerSystemIPC()
}
