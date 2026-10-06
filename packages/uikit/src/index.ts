// @niivue/uikit public entry. UIKit is a collection of controls/widgets that
// integrate into NiiVue's rendering lifecycle. Each widget is a pure geometry
// builder plus an overlay that owns the GPU resources and draws it (see
// docs/ruler-port.md in @niivue/niivue for the design).

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
export {
  advancePress,
  buildButton,
  buttonContains,
  DEFAULT_BUTTON_STYLE,
  layoutButton,
  mixColor,
  resolveButtonStyle,
  scaleButton,
} from './button'
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
export {
  buildColorControl,
  COLOR_CHANNELS,
  colorControlContains,
  colorSwatchAt,
  colorsEqual,
  DEFAULT_COLOR_CONTROL_STYLE,
  layoutColorControl,
  resolveColorControlStyle,
  scaleColorControl,
  selectedSwatch,
  withChannel,
} from './colorControl'
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
export {
  buildDialog,
  DEFAULT_DIALOG_STYLE,
  dialogContains,
  layoutDialog,
  resolveDialogStyle,
  scaleDialog,
  wrapText,
} from './dialog'
export type { UIKitDialogOverlayOptions } from './dialogOverlay'
export { UIKitDialogOverlay } from './dialogOverlay'
export type {
  FilePickerLayout,
  FilePickerSpec,
  FilePickerStyle,
  FilePickerVisual,
} from './filePicker'
export {
  buildFilePicker,
  DEFAULT_FILE_PICKER_LABEL,
  DEFAULT_FILE_PICKER_PLACEHOLDER,
  DEFAULT_FILE_PICKER_STYLE,
  ellipsizeStart,
  filePickerButtonStyle,
  filePickerContains,
  filePickerSummary,
  layoutFilePicker,
  resolveFilePickerStyle,
  scaleFilePicker,
} from './filePicker'
export type { UIKitFilePickerOverlayOptions } from './filePickerOverlay'
export { UIKitFilePickerOverlay } from './filePickerOverlay'
export type {
  DownloadBridge,
  DownloadDocument,
  DownloadUrlFactory,
  FilePickerBridge,
  FilePickerDocument,
  FilePickerOptions,
} from './host'
export {
  acceptExtensions,
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
  activateMenuItem,
  buildMenuButton,
  buildMenuPopup,
  DEFAULT_MENU_BUTTON_STYLE,
  DEFAULT_MENU_STYLE,
  isMenuItemSelectable,
  layoutMenuButton,
  layoutMenuPopup,
  menuButtonSpec,
  menuRevealRow,
  menuRowAt,
  menuRowHeight,
  menuScrollStripAt,
  nextSelectableIndex,
  popupContains,
  resolveMenuStyle,
  scaleMenu,
} from './menu'
export type { UIKitMenuOverlayOptions } from './menuOverlay'
export { UIKitMenuOverlay } from './menuOverlay'
export type {
  NumberInputLayout,
  NumberInputSpec,
  NumberInputStyle,
  NumberInputVisual,
} from './numberInput'
export {
  acceptNumberChar,
  buildNumberInput,
  DEFAULT_NUMBER_INPUT_STYLE,
  formatNumberInput,
  layoutNumberInput,
  numberInputCaretAt,
  numberInputContains,
  numberInputSpinAt,
  numberInputTextWindow,
  parseNumberInput,
  resolveNumberInputStyle,
  scaleNumberInput,
  snapNumberInput,
  stepNumberInput,
} from './numberInput'
export type { UIKitNumberInputOverlayOptions } from './numberInputOverlay'
export { UIKitNumberInputOverlay } from './numberInputOverlay'
export type { RectData, RectSpec } from './rect'
export { buildRect, rectContains } from './rect'
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
export {
  buildScrollArrow,
  canScrollDown,
  canScrollUp,
  revealRow,
  scrollWindow,
  WheelAccumulator,
} from './scroll'
export type {
  SegmentedLayout,
  SegmentedSpec,
  SegmentedStyle,
  SegmentedVisual,
  SegmentLayout,
  SegmentSpec,
} from './segmented'
export {
  buildSegmented,
  DEFAULT_SEGMENTED_STYLE,
  endSegmentValue,
  layoutSegmented,
  resolveSegmentedStyle,
  scaleSegmented,
  segmentAt,
  segmentedContains,
  segmentIndex,
  stepSegmentValue,
} from './segmented'
export type { UIKitSegmentedOverlayOptions } from './segmentedOverlay'
export { UIKitSegmentedOverlay } from './segmentedOverlay'
export type { SelectOption, SelectSpec } from './select'
export {
  endSelectValue,
  SELECT_GROUP,
  selectIndex,
  selectItems,
  selectLabel,
  selectMenuSpec,
  selectOption,
  selectWidth,
  stepSelectValue,
} from './select'
export type { UIKitSelectOverlayOptions } from './selectOverlay'
export { UIKitSelectOverlay } from './selectOverlay'
export type {
  SliderLayout,
  SliderSpec,
  SliderStyle,
  SliderVisual,
} from './slider'
export {
  buildSlider,
  DEFAULT_SLIDER_STYLE,
  effectiveStep,
  formatSliderValue,
  fractionToValue,
  layoutSlider,
  resolveSliderStyle,
  scaleSlider,
  sliderContains,
  sliderThumbX,
  sliderValueAt,
  snapValue,
  stepDecimals,
  stepValue,
  valueToFraction,
} from './slider'
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
  capHeight,
  layoutText,
  measureWidth,
  readableAngle,
} from './text/layout'
export type { TextEditState } from './textEdit'
export {
  advanceBetween,
  caretIndexAt,
  deleteBackward,
  deleteForward,
  editKey,
  glyphAdvances,
  hasSelection,
  insertText,
  selectAll,
  selectionOf,
  setCaret,
  textEditState,
  textWindow,
} from './textEdit'
export type { TextFieldStyle } from './textField'
export {
  buildTextFieldContent,
  textFieldCaretAt,
  textFieldViewport,
  textFieldWindow,
} from './textField'
export type {
  TextInputLayout,
  TextInputSpec,
  TextInputStyle,
  TextInputVisual,
} from './textInput'
export {
  buildTextInput,
  DEFAULT_TEXT_INPUT_STYLE,
  layoutTextInput,
  resolveTextInputStyle,
  scaleTextInput,
  textInputCaretAt,
  textInputContains,
  textInputTextWindow,
} from './textInput'
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
export {
  buildCheckMark,
  buildFocusRing,
  buildToggle,
  DEFAULT_TOGGLE_STYLE,
  layoutToggle,
  resolveToggleStyle,
  scaleToggle,
  toggleContains,
} from './toggle'
export type { UIKitToggleOverlayOptions } from './toggleOverlay'
export { UIKitToggleOverlay } from './toggleOverlay'
