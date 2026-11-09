import { getNiivueEntry, ohifServices } from './niivueRegistry'
import type {
  OhifExtensionParams,
  OhifToolbarButton,
  OhifToolbarButtonCommand,
  OhifToolbarModuleEntry,
} from './ohif-types'
import { NIIVUE_STANDARD_COMMANDS } from './standardCommands'
import { ANNOTATION_TO_OHIF } from './toolBridge'

export const NIIVUE_UNSUPPORTED_EVALUATOR = 'evaluate.niivue.unsupported'

/** OHIF tools mirrored onto NiiVue (toolBridge.ts). */
export const NIIVUE_SUPPORTED_TOOLS: readonly string[] = [
  ...Object.values(ANNOTATION_TO_OHIF).map((d) => d.toolName),
  'WindowLevel',
  'Pan',
  'Zoom',
  'Angle',
  'CobbAngle',
]
const TOOL_COMMANDS = ['setToolActive', 'setToolActiveToolbar']
// Slide gestures: Length draws a ruler, Zoom zooms, anything else pans.
const SLIDE_SUPPORTED_TOOLS: readonly string[] = ['Length', 'Pan', 'Zoom']
// Volume-only standard commands that no-op on an NVSlide viewport.
const SLIDE_UNSUPPORTED = ['setViewportOrientation', 'setWindowLevelPreset']
// Host commands that act on display sets or app UI, not the viewport's
// renderer, so they work on a NiiVue viewport. openDICOMTagViewer: OHIF
// extensions/default commandsModule reads the grid's displaySetInstanceUIDs.
const HOST_AGNOSTIC_COMMANDS = ['openDICOMTagViewer']

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
  first: OhifToolbarButtonCommand | undefined,
): string | undefined {
  if (!first || !TOOL_COMMANDS.includes(first.commandName)) return undefined
  const name = first.commandOptions?.toolName ?? button?.props.id ?? button?.id
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
      const answered: readonly string[] = entry.slideView
        ? NIIVUE_STANDARD_COMMANDS.filter((c) => !SLIDE_UNSUPPORTED.includes(c))
        : NIIVUE_STANDARD_COMMANDS
      const first = commands[0]
      const toolName = buttonToolName(button, first)
      // setToolActive without a toolGroupId targets the active viewport's
      // Cornerstone tool group, which a NiiVue viewport lacks: the click no-ops.
      const supported =
        toolName !== undefined
          ? (entry.slideView
              ? SLIDE_SUPPORTED_TOOLS
              : NIIVUE_SUPPORTED_TOOLS
            ).includes(toolName) &&
            (first?.commandName !== 'setToolActive' ||
              first.commandOptions?.toolGroupId !== undefined)
          : commands.every(
              ({ commandName, context }) =>
                commandName.startsWith('niivue') ||
                HOST_AGNOSTIC_COMMANDS.includes(commandName) ||
                // An explicit other context bypasses the NIIVUE shadow.
                ((context === undefined || context === 'NIIVUE') &&
                  answered.includes(commandName)),
            )
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
