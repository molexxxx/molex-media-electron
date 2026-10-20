import type { ReactElement, Ref } from 'react'
import type { RunId } from '../../../../../shared/jobs/ids'
import { batchLabel, countOf } from '../../../copy/batch'
import { Button } from '../../../ui/Button'
import { IconButton } from '../../../ui/IconButton'
import { Menu, type MenuEntry, type MenuItem, type MenuLeafItem, type MenuTriggerProps } from '../../../ui/Menu'
import { Tooltip } from '../../../ui/Tooltip'

/** The widths the "Inspector width" items offer, in px. */
export const INSPECTOR_WIDTH_CHOICES = [300, 360, 440, 520] as const

/** The formats "Export report" saves. */
export type ReportFormat = 'csv' | 'json'

/** The words of the after-run actions and the batch overflow menu. */
export const OVERFLOW_COPY =
{
  menu: 'More batch actions',
  shortcuts: 'Keyboard shortcuts',
  inspectorWidth: 'Inspector width',
  output: 'Output',
  workers: 'Workers',
  exportReport: 'Export report',
  exportTooltip: 'Saves a record of this batch: settings, outputs, measurements, and errors',
  csv: 'CSV, one row per job',
  json: 'JSON, full records',
  openFolder: 'Open output folder',
  showOutputs: 'Show outputs'
} as const

/** "Show log for Batch 31". */
export function showLogLabel(runId: RunId): string
{
  return `Show log for ${batchLabel(runId)}`
}

/** "Outputs are in 3 folders". */
export function outputsTooltip(folders: number): string
{
  return `Outputs are in ${countOf(folders, 'folder')}`
}

/** What a finished batch offers: its report and the folders its outputs went to. */
export interface AfterRunActionsProps
{
  /** The folders the batch wrote to: one opens directly, several are listed under "Show outputs". */
  folders: readonly string[]
  onOpenFolder: (folder: string) => void
  onExportReport: (format: ReportFormat) => void
}

function exportItems(onExportReport: (format: ReportFormat) => void): MenuLeafItem[]
{
  return [
    { id: 'export-csv', label: OVERFLOW_COPY.csv, onSelect: () => onExportReport('csv') },
    { id: 'export-json', label: OVERFLOW_COPY.json, onSelect: () => onExportReport('json') }
  ]
}

function folderItems(folders: readonly string[], onOpenFolder: (folder: string) => void): MenuLeafItem[]
{
  return folders.map((folder, index) => ({ id: `folder-${index}`, label: folder, onSelect: () => onOpenFolder(folder) }))
}

/** "Export report" and "Open output folder" (or "Show outputs") as items of the overflow menu. */
function afterRunItems({ folders, onOpenFolder, onExportReport }: AfterRunActionsProps): MenuItem[]
{
  const items: MenuItem[] = [
    { kind: 'submenu', id: 'export-report', label: OVERFLOW_COPY.exportReport, description: OVERFLOW_COPY.exportTooltip, items: exportItems(onExportReport) }
  ]
  if (folders.length === 1)
  {
    items.push({ id: 'open-folder', label: OVERFLOW_COPY.openFolder, description: folders[0], onSelect: () => onOpenFolder(folders[0]) })
  }
  else if (folders.length > 1)
  {
    items.push({ kind: 'submenu', id: 'show-outputs', label: OVERFLOW_COPY.showOutputs, description: outputsTooltip(folders.length), items: folderItems(folders, onOpenFolder) })
  }
  return items
}

interface DescribedMenuButtonProps extends MenuTriggerProps
{
  label: string
  tooltip: string
}

/** A menu's Button trigger whose tooltip is also its description; the menu merges its trigger props into it. */
function DescribedMenuButton({ label, tooltip, ref, ...trigger }: DescribedMenuButtonProps): ReactElement
{
  return (
    <Tooltip content={tooltip}>
      <Button {...trigger} ref={ref as Ref<HTMLButtonElement> | undefined} iconEnd="action.openMenu">{label}</Button>
    </Tooltip>
  )
}

/**
 * Row 1's actions after a run: "Export report" (CSV, one row per job; JSON, full records) and "Open output folder",
 * or a "Show outputs" menu when the outputs sit in several folders next to their sources.
 */
export function AfterRunActions({ folders, onOpenFolder, onExportReport }: AfterRunActionsProps): ReactElement
{
  return (
    <span className="inline-flex shrink-0 items-center gap-2" data-slot="after-run">
      <Menu
        label={OVERFLOW_COPY.exportReport}
        items={exportItems(onExportReport)}
        align="end"
        trigger={<DescribedMenuButton label={OVERFLOW_COPY.exportReport} tooltip={OVERFLOW_COPY.exportTooltip} />}
      />
      {folders.length === 1 && (
        <Tooltip content={folders[0]}>
          <Button onClick={() => onOpenFolder(folders[0])}>{OVERFLOW_COPY.openFolder}</Button>
        </Tooltip>
      )}
      {folders.length > 1 && (
        <Menu
          label={OVERFLOW_COPY.showOutputs}
          items={folderItems(folders, onOpenFolder)}
          align="end"
          trigger={<DescribedMenuButton label={OVERFLOW_COPY.showOutputs} tooltip={outputsTooltip(folders.length)} />}
        />
      )}
    </span>
  )
}

/** Props for {@link BatchOverflowMenu}. */
export interface BatchOverflowMenuProps
{
  /** The batch the header describes; names "Show log for Batch {b}". */
  runId: RunId | null
  /** The inspector's current width, which checks its radio item. */
  inspectorWidth: number
  /** Output and Workers as items, while the view is too narrow for their buttons. */
  narrowControls?: { onOutput: () => void; onWorkers: () => void } | null
  /** The after-run actions as items, while the view is too narrow for them in row 1. */
  afterRun?: AfterRunActionsProps | null
  /** Items the page adds at narrow widths, such as Clear. */
  extraItems?: readonly MenuEntry[]
  onShowLog?: (runId: RunId) => void
  onShowShortcuts?: () => void
  onInspectorWidth?: (width: number) => void
  ref?: Ref<HTMLButtonElement>
}

/**
 * The batch overflow menu, "More batch actions": the batch's log, Keyboard shortcuts, the Inspector width radio
 * items (the single-pointer alternative to the splitter), and at narrow widths Output, Workers, Export report, and
 * the output folders that no longer fit in row 1.
 */
export function BatchOverflowMenu({
  runId,
  inspectorWidth,
  narrowControls = null,
  afterRun = null,
  extraItems = [],
  onShowLog,
  onShowShortcuts,
  onInspectorWidth,
  ref
}: BatchOverflowMenuProps): ReactElement
{
  const entries: MenuEntry[] = []
  if (runId !== null && onShowLog !== undefined)
  {
    entries.push({ id: 'show-log', label: showLogLabel(runId), icon: 'action.showLog', onSelect: () => onShowLog(runId) })
  }
  entries.push({ id: 'shortcuts', label: OVERFLOW_COPY.shortcuts, shortcut: 'Mod+/', onSelect: () => onShowShortcuts?.() })
  entries.push({
    group: OVERFLOW_COPY.inspectorWidth,
    items: INSPECTOR_WIDTH_CHOICES.map((width) => ({
      kind: 'radio' as const,
      id: `inspector-width-${width}`,
      group: 'inspector-width',
      label: `${width} px`,
      checked: inspectorWidth === width,
      onSelect: () => onInspectorWidth?.(width)
    }))
  })
  const narrow: MenuEntry[] = []
  if (narrowControls !== null)
  {
    narrow.push({ id: 'output', label: OVERFLOW_COPY.output, onSelect: narrowControls.onOutput })
    narrow.push({ id: 'workers', label: OVERFLOW_COPY.workers, onSelect: narrowControls.onWorkers })
  }
  if (afterRun !== null)
  {
    narrow.push(...afterRunItems(afterRun))
  }
  narrow.push(...extraItems)
  if (narrow.length > 0)
  {
    entries.push('separator', ...narrow)
  }

  return (
    <span className="inline-flex shrink-0" data-slot="overflow">
      <Menu
        label={OVERFLOW_COPY.menu}
        items={entries}
        align="end"
        trigger={<IconButton ref={ref} label={OVERFLOW_COPY.menu} icon="action.more" />}
      />
    </span>
  )
}
