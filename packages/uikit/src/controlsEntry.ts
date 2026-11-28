// @niivue/uikit/controls: canvas-drawn form controls (buttons, toggles,
// sliders, menus, dialogs, text fields and the tool palette). Use them where
// the interface must live inside the canvas (XR, capture, a host with no DOM);
// they take focus only by pointer, so ordinary app forms are better as DOM
// controls. Route their input with UIKitControls from the root entry.

// biome-ignore-all lint/performance/noBarrelFile: package entry point
export type {
  ButtonLayout,
  ButtonSpec,
  ButtonStyle,
  ButtonVisual,
} from './button'
export { DEFAULT_BUTTON_STYLE } from './button'
export type {
  UIKitButtonHost,
  UIKitButtonOverlayOptions,
} from './buttonOverlay'
export { UIKitButtonOverlay } from './buttonOverlay'
export type {
  ColorChannel,
  ColorControlLayout,
  ColorControlSpec,
  ColorControlStyle,
  ColorControlVisual,
  ColorSwatch,
} from './colorControl'
export { DEFAULT_COLOR_CONTROL_STYLE } from './colorControl'
export type { UIKitColorControlOverlayOptions } from './colorControlOverlay'
export { UIKitColorControlOverlay } from './colorControlOverlay'
export type {
  DialogBoxes,
  DialogButtonRole,
  DialogButtonSize,
  DialogButtonSpec,
  DialogLayout,
  DialogSpec,
  DialogStyle,
} from './dialog'
export { DEFAULT_DIALOG_STYLE } from './dialog'
export type { UIKitDialogOverlayOptions } from './dialogOverlay'
export { UIKitDialogOverlay } from './dialogOverlay'
export type {
  FilePickerLayout,
  FilePickerSpec,
  FilePickerStyle,
  FilePickerVisual,
} from './filePicker'
export {
  DEFAULT_FILE_PICKER_LABEL,
  DEFAULT_FILE_PICKER_PLACEHOLDER,
  DEFAULT_FILE_PICKER_STYLE,
} from './filePicker'
export type { UIKitFilePickerOverlayOptions } from './filePickerOverlay'
export { UIKitFilePickerOverlay } from './filePickerOverlay'
export type {
  BridgeWindow,
  ClipboardBridge,
  ClipboardSource,
  DownloadBridge,
  DownloadDocument,
  DownloadUrlFactory,
  FilePickerBridge,
  FilePickerDocument,
  FilePickerOptions,
} from './host'
export {
  acceptExtensions,
  createBrowserClipboard,
  createBrowserDownload,
  createBrowserFilePicker,
  DOWNLOAD_REVOKE_DELAY_MS,
  FILE_PICKER_CANCEL_GRACE_MS,
} from './host'
export type {
  MenuBounds,
  MenuButtonSpec,
  MenuButtonVisual,
  MenuItemKind,
  MenuItemSpec,
  MenuPopupLayout,
  MenuRowLayout,
  MenuStyle,
} from './menu'
export {
  DEFAULT_MENU_BUTTON_STYLE,
  DEFAULT_MENU_STYLE,
} from './menu'
export type { UIKitMenuOverlayOptions } from './menuOverlay'
export { UIKitMenuOverlay } from './menuOverlay'
export type {
  NumberInputLayout,
  NumberInputSpec,
  NumberInputStyle,
  NumberInputVisual,
} from './numberInput'
export { DEFAULT_NUMBER_INPUT_STYLE } from './numberInput'
export type { UIKitNumberInputOverlayOptions } from './numberInputOverlay'
export { UIKitNumberInputOverlay } from './numberInputOverlay'
export type {
  ScrollRange,
  ScrollStripStyle,
  ScrollWindow,
} from './scroll'
export type {
  SegmentedLayout,
  SegmentedSpec,
  SegmentedStyle,
  SegmentedVisual,
  SegmentLayout,
  SegmentSpec,
} from './segmented'
export { DEFAULT_SEGMENTED_STYLE } from './segmented'
export type { UIKitSegmentedOverlayOptions } from './segmentedOverlay'
export { UIKitSegmentedOverlay } from './segmentedOverlay'
export type { SelectOption, SelectSpec } from './select'
export type { UIKitSelectOverlayOptions } from './selectOverlay'
export { UIKitSelectOverlay } from './selectOverlay'
export type {
  SliderLayout,
  SliderSpec,
  SliderStyle,
  SliderVisual,
} from './slider'
export { DEFAULT_SLIDER_STYLE } from './slider'
export type { UIKitSliderOverlayOptions } from './sliderOverlay'
export { UIKitSliderOverlay } from './sliderOverlay'
export type {
  TextAreaLayout,
  TextAreaSpec,
  TextAreaStyle,
  TextAreaVisual,
  TextRow,
} from './textArea'
export { DEFAULT_TEXT_AREA_STYLE } from './textArea'
export type { UIKitTextAreaOverlayOptions } from './textAreaOverlay'
export { UIKitTextAreaOverlay } from './textAreaOverlay'
export type { TextEditState } from './textEdit'
export type { FieldStyle, TextFieldStyle } from './textField'
export type {
  TextInputLayout,
  TextInputSpec,
  TextInputStyle,
  TextInputVisual,
} from './textInput'
export { DEFAULT_TEXT_INPUT_STYLE } from './textInput'
export type { UIKitTextInputOverlayOptions } from './textInputOverlay'
export { UIKitTextInputOverlay } from './textInputOverlay'
export type {
  ToggleLayout,
  ToggleSpec,
  ToggleStyle,
  ToggleVisual,
} from './toggle'
export { DEFAULT_TOGGLE_STYLE } from './toggle'
export type { UIKitToggleOverlayOptions } from './toggleOverlay'
export { UIKitToggleOverlay } from './toggleOverlay'
export type {
  ToolLook,
  ToolPaletteAction,
  ToolPaletteColor,
  ToolPaletteItem,
  ToolPaletteItemKind,
  ToolPaletteLayout,
  ToolPaletteSpec,
  ToolPaletteStyle,
  ToolPaletteTool,
  ToolPaletteWidth,
} from './toolPalette'
export { DEFAULT_TOOL_PALETTE_STYLE } from './toolPalette'
export type {
  ToolPaletteHandlers,
  ToolPaletteOverlaySpec,
  UIKitToolPaletteOverlayOptions,
} from './toolPaletteOverlay'
export { UIKitToolPaletteOverlay } from './toolPaletteOverlay'
