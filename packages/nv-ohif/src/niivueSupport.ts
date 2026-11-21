import { CONTOUR_TOOL_NAMES } from './contourSeg'
import { getNiivueEntry, ohifServices } from './niivueRegistry'
import type {
  OhifExtensionParams,
  OhifToolbarButton,
  OhifToolbarButtonCommand,
  OhifToolbarEvaluation,
  OhifToolbarModuleEntry,
} from './ohif-types'
import { holdsPet } from './petQuant'
import { SEG_TOOLS } from './segEdit'
import {
  NIIVUE_ROTATE_FLIP_COMMANDS,
  NIIVUE_STANDARD_COMMANDS,
  noTiles2D,
} from './standardCommands'
import {
  ANNOTATION_TO_OHIF,
  OHIF_BRUSHES,
  OHIF_TO_SLIDE_TOOL,
} from './toolBridge'

export const NIIVUE_UNSUPPORTED_EVALUATOR = 'evaluate.niivue.unsupported'

/** OHIF tools mirrored onto NiiVue (toolBridge.ts). */
export const NIIVUE_SUPPORTED_TOOLS: readonly string[] = [
  ...Object.values(ANNOTATION_TO_OHIF).map((d) => d.toolName),
  'WindowLevel',
  'WindowLevelRegion',
  'StackScroll',
  'Pan',
  'Zoom',
  'Magnify',
  'AdvancedMagnify',
  ...Object.keys(SEG_TOOLS),
  ...CONTOUR_TOOL_NAMES,
]
// TMTV / 4D ROI tools: only on a pane holding a PT (petQuant.ts).
const PET_TOOLS: readonly string[] = [
  'RectangleROIStartEndThreshold',
  ...Object.keys(OHIF_BRUSHES),
]
const TOOL_COMMANDS = [
  'setToolActive',
  'setToolActiveToolbar',
  'toggleActiveDisabledToolbar',
]
// Slide gestures: Length draws a ruler, Zoom zooms, anything else pans.
const SLIDE_SUPPORTED_TOOLS: readonly string[] = [
  'Pan',
  'Zoom',
  // OHIF measurement tools the slide view draws (toolBridge OHIF_TO_SLIDE_TOOL).
  ...Object.keys(OHIF_TO_SLIDE_TOOL),
]
// Volume-only standard commands that no-op on an NVSlide viewport.
const SLIDE_UNSUPPORTED = [
  'setViewportOrientation',
  'setWindowLevelPreset',
  'setViewportColormap',
  ...NIIVUE_ROTATE_FLIP_COMMANDS,
]
// Host commands that act on display sets or app UI, not the viewport's
// renderer, so they work on a NiiVue viewport. openDICOMTagViewer: OHIF
// extensions/default commandsModule reads the grid's displaySetInstanceUIDs.
// Segmentation tool options set OHIF's segmentation state or tool group
// configuration, which segEdit.ts reads (brush size, threshold range); the
// NIIVUE context answers the rest (segCommands.ts).
const HOST_AGNOSTIC_COMMANDS = [
  'openDICOMTagViewer',
  'activateSelectedSegmentationOfType',
  'setThresholdRange',
  'setViewportForToolConfiguration',
  'setBrushSize',
  'interpolateLabelmap',
  // Service state only (cineService, every tool group's SegmentLabel mode);
  // the pane reads it (sliceCine.tsx, segmentLabel.tsx).
  'toggleCine',
  'toggleSegmentLabel',
  // UI state: which contour utility's options are open (contourOps.ts runs them).
  'toggleActiveSegmentationUtility',
  // Shadowed in the NIIVUE context (standardCommands.ts, segCommands.ts).
  'toggleEnabledDisabledToolbar',
  'toggleSynchronizer',
  'runSegmentBidirectional',
]

const NIIVUE_SEGMENTATION_EVALUATOR = 'evaluate.niivue.segmentation'

type SegmentationServiceLike = {
  getSegmentationRepresentations?: (viewportId: string) => unknown[]
  getActiveSegmentation?: (
    viewportId: string,
  ) => { segments?: Record<string, unknown> } | undefined
}
type ToolbarServiceLike = {
  _evaluateFunction?: Record<string, (args: Record<string, unknown>) => unknown>
}

/**
 * OHIF's `evaluate.cornerstone.segmentation` for NiiVue panes (which belong to
 * no cornerstone tool group): enabled once the pane lists a segmentation with
 * a segment, active when the primary tool is one of `toolNames`. Other panes
 * get cornerstone's verdict.
 */
export function niivueSegmentationEvaluator(
  servicesManager: OhifExtensionParams['servicesManager'],
): OhifToolbarModuleEntry {
  return {
    name: NIIVUE_SEGMENTATION_EVALUATOR,
    evaluate: (args) => {
      const services = ohifServices(servicesManager)
      const entry = getNiivueEntry(args.viewportId)
      if (!entry)
        return (
          services?.toolbarService as ToolbarServiceLike | undefined
        )?._evaluateFunction?.['evaluate.cornerstone.segmentation']?.(args) as
          | OhifToolbarEvaluation
          | undefined
      const seg = services?.segmentationService as
        | SegmentationServiceLike
        | undefined
      const viewportId = args.viewportId as string
      if (!seg?.getSegmentationRepresentations?.(viewportId)?.length)
        return { disabled: true, disabledText: 'No segmentations available' }
      const active = seg.getActiveSegmentation?.(viewportId)
      if (!Object.keys(active?.segments ?? {}).length)
        return {
          disabled: true,
          disabledText: 'Add segment to enable this tool',
        }
      const toolNames = args.toolNames as string[] | undefined
      if (!toolNames) return { disabled: false }
      const tools = services?.toolGroupService as
        | {
            getActivePrimaryMouseButtonTool?: (id: string) => string | undefined
          }
        | undefined
      const tool = tools?.getActivePrimaryMouseButtonTool?.(
        entry.toolGroupId ?? 'default',
      )
      return { disabled: false, isActive: !!tool && toolNames.includes(tool) }
    },
  }
}

/**
 * Prepend {@link NIIVUE_UNSUPPORTED_EVALUATOR} to a button's evaluators. OHIF
 * reads `hideWhenDisabled` from a single object evaluator but not from an
 * array, so it is hoisted to the button props.
 */
export function withNiivueSupport(
  button: OhifToolbarButton,
): OhifToolbarButton {
  const { evaluate } = button.props
  const list =
    evaluate === undefined
      ? []
      : Array.isArray(evaluate)
        ? evaluate
        : [evaluate]
  const hide =
    !Array.isArray(evaluate) &&
    typeof evaluate === 'object' &&
    evaluate.hideWhenDisabled === true
  return {
    ...button,
    props: {
      ...button.props,
      ...(hide ? { hideWhenDisabled: true } : {}),
      evaluate:
        list[0] === NIIVUE_UNSUPPORTED_EVALUATOR
          ? list
          : [NIIVUE_UNSUPPORTED_EVALUATOR, ...list],
    },
  }
}

function buttonCommands(
  button: OhifToolbarButton | undefined,
): OhifToolbarButtonCommand[] {
  const raw = button?.props?.commands
  const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw]
  return list.map((c) => (typeof c === 'string' ? { commandName: c } : c))
}

// The tool a tool-activation button selects, resolved like OHIF's
// ToolbarService.getToolNameForButton; undefined for a command button.
function buttonToolName(
  button: OhifToolbarButton | undefined,
  command: OhifToolbarButtonCommand | undefined,
): string | undefined {
  if (!command || !TOOL_COMMANDS.includes(command.commandName)) return undefined
  const name =
    command.commandOptions?.toolName ?? button?.props.id ?? button?.id
  return typeof name === 'string' ? name : undefined
}

/** The {@link NIIVUE_UNSUPPORTED_EVALUATOR} toolbar module entry. */
export function niivueSupportEvaluator(
  servicesManager: OhifExtensionParams['servicesManager'],
): OhifToolbarModuleEntry {
  return {
    // Leaves non-NiiVue viewports to the button's other evaluators; on a
    // NiiVue viewport disables what NiiVue cannot do.
    name: NIIVUE_UNSUPPORTED_EVALUATOR,
    evaluate: ({ viewportId, button }) => {
      const entry = getNiivueEntry(viewportId)
      if (!entry) return undefined
      const commands = buttonCommands(button)
      // Section lists, menus and the layout selector carry no commands.
      if (commands.length === 0) return undefined
      const unanswered: readonly string[] = entry.slideView
        ? SLIDE_UNSUPPORTED
        : noTiles2D(entry)
          ? NIIVUE_ROTATE_FLIP_COMMANDS
          : []
      const answered: readonly string[] = NIIVUE_STANDARD_COMMANDS.filter(
        (c) => !unanswered.includes(c),
      )
      const supportedTools = entry.slideView
        ? SLIDE_SUPPORTED_TOOLS
        : NIIVUE_SUPPORTED_TOOLS
      // OHIF runs every command of a button, so each must work on NiiVue.
      const runs = (c: OhifToolbarButtonCommand): boolean => {
        if (HOST_AGNOSTIC_COMMANDS.includes(c.commandName)) return true
        // An explicit other context bypasses the NIIVUE shadow, whatever the
        // command or tool.
        if (c.context !== undefined && c.context !== 'NIIVUE') return false
        const toolName = buttonToolName(button, c)
        // setToolActive without a toolGroupId targets the active viewport's
        // Cornerstone tool group, which a NiiVue viewport lacks: the click
        // no-ops.
        if (toolName !== undefined)
          return (
            (supportedTools.includes(toolName) ||
              (PET_TOOLS.includes(toolName) &&
                !entry.slideView &&
                holdsPet(entry, servicesManager))) &&
            (c.commandName !== 'setToolActive' ||
              c.commandOptions?.toolGroupId !== undefined)
          )
        return (
          c.commandName.startsWith('niivue') || answered.includes(c.commandName)
        )
      }
      const supported = commands.every(runs)
      const toolName = buttonToolName(button, commands[0])
      if (!supported) {
        return {
          disabled: true,
          disabledText: 'Not available on NiiVue viewports',
        }
      }
      if (toolName === undefined) return undefined
      const tools = ohifServices(servicesManager)?.toolGroupService as
        | {
            getActivePrimaryMouseButtonTool?: (
              toolGroupId: string,
            ) => string | undefined
          }
        | undefined
      return {
        disabled: false,
        isActive:
          tools?.getActivePrimaryMouseButtonTool?.(
            entry.toolGroupId ?? 'default',
          ) === toolName,
      }
    },
  }
}
