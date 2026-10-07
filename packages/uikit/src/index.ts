// @niivue/uikit public entry. UIKit is a collection of controls/widgets that
// integrate into NiiVue's rendering lifecycle. Each widget is a pure geometry
// builder plus an overlay that owns the GPU resources and draws it (see
// docs/ruler-port.md in @niivue/niivue for the design).
//
// The surface is the overlays, the control layer, the spec/style/option types,
// the default styles and the host bridges. The pure widget models (layout,
// build, hit-test and state helpers) stay package-private: they are the
// overlays' implementation, exercised by their own tests, not an API.

// biome-ignore-all lint/performance/noBarrelFile: package entry point
export type { AnnotationGeometryOptions } from './annotationOverlay'
export {
  buildAnnotationGeometry,
  UIKitAnnotationOverlay,
} from './annotationOverlay'
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
  UIKitControlsOptions,
  UIKitHost,
  UIKitInteractive,
  UIKitKeyEvent,
  UIKitRedrawSource,
} from './controls'
export { UIKitControls } from './controls'
export type { CrosshairGeometry, CrosshairSpec } from './crosshair'
export { buildCrosshair } from './crosshair'
export type { CrosshairPlacement } from './crosshairOverlay'
export { UIKitCrosshairOverlay } from './crosshairOverlay'
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
} from './host'
export type { LineData, LineTerminators } from './line'
export { buildLine, buildTerminatedLine, LineTerminator } from './line'
export { UIKitLineOverlay } from './lineOverlay'
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
export type { RectData, RectSpec } from './rect'
export { buildRect } from './rect'
export { UIKitRectOverlay } from './rectOverlay'
export type { RulerGeometry, RulerSpec, Vec2 } from './ruler'
export { buildRuler } from './ruler'
export { UIKitRulerOverlay } from './rulerOverlay'
export type {
  ScrollRange,
  ScrollStripStyle,
  ScrollWindow,
  UIKitBox,
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
export { loadDefaultFont } from './text/defaultFont'
export type {
  RawFontFile,
  UIKitFont,
  UIKitFontMetrics,
  UIKitGlyph,
} from './text/font'
export { parseFont, screenPxRange } from './text/font'
export type { RGBA, TextLayoutOptions } from './text/layout'
export {
  autoOutlineColor,
  layoutText,
  measureWidth,
  readableAngle,
} from './text/layout'
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
export type { TextFieldStyle } from './textField'
export type {
  TextInputLayout,
  TextInputSpec,
  TextInputStyle,
  TextInputVisual,
} from './textInput'
export { DEFAULT_TEXT_INPUT_STYLE } from './textInput'
export type { UIKitTextInputOverlayOptions } from './textInputOverlay'
export { UIKitTextInputOverlay } from './textInputOverlay'
export type { UIKitTextItem } from './textOverlay'
export { UIKitTextOverlay } from './textOverlay'
export type {
  ToggleLayout,
  ToggleSpec,
  ToggleStyle,
  ToggleVisual,
} from './toggle'
export { DEFAULT_TOGGLE_STYLE } from './toggle'
export type { UIKitToggleOverlayOptions } from './toggleOverlay'
export { UIKitToggleOverlay } from './toggleOverlay'
