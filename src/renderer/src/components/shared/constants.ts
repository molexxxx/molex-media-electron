/**
 * @module components/shared/constants
 * @description Shared UI constants used across multiple components.
 *
 * Centralises task-status styling and labels so that Sidebar,
 * ProcessingView, and any future task-list UI stay in sync.
 */

/** Tailwind classes for each processing-task status (compact variant without `bg`). */
export const STATUS_COLORS: Record<string, { text: string; dot: string }> = {
  queued: { text: 'text-surface-400', dot: 'bg-surface-500' },
  analyzing: { text: 'text-blue-300', dot: 'bg-blue-400 animate-pulse' },
  processing: { text: 'text-amber-300', dot: 'bg-amber-400 animate-pulse' },
  finalizing: { text: 'text-cyan-300', dot: 'bg-cyan-400 animate-pulse' },
  complete: { text: 'text-emerald-300', dot: 'bg-emerald-400' },
  error: { text: 'text-red-300', dot: 'bg-red-400' },
  cancelled: { text: 'text-surface-400', dot: 'bg-surface-500' }
}

/** Tailwind classes for each processing-task status (full variant with `bg`). */
export const STATUS_COLORS_FULL: Record<string, { bg: string; text: string; dot: string }> = {
  queued: { bg: 'bg-surface-700/30', text: 'text-surface-400', dot: 'bg-surface-500' },
  analyzing: { bg: 'bg-blue-500/10', text: 'text-blue-300', dot: 'bg-blue-400 animate-pulse' },
  processing: { bg: 'bg-amber-500/10', text: 'text-amber-300', dot: 'bg-amber-400 animate-pulse' },
  finalizing: { bg: 'bg-cyan-500/10', text: 'text-cyan-300', dot: 'bg-cyan-400 animate-pulse' },
  complete: { bg: 'bg-emerald-500/10', text: 'text-emerald-300', dot: 'bg-emerald-400' },
  error: { bg: 'bg-red-500/10', text: 'text-red-300', dot: 'bg-red-400' },
  cancelled: { bg: 'bg-surface-700/30', text: 'text-surface-400', dot: 'bg-surface-500' }
}

/** Human-readable labels for each processing-task status. */
export const STATUS_LABELS: Record<string, string> = {
  queued: 'Queued',
  analyzing: 'Analyzing',
  processing: 'Encoding',
  finalizing: 'Finalizing',
  complete: 'Done',
  error: 'Failed',
  cancelled: 'Cancelled'
}
