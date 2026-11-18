// D1 segmentation (M8): OHIF's segmentation mode (labelmap toolbox and panel,
// its tool groups, mnGrid protocol) on NiiVue panes. nv-ohif maps the labelmap
// tools onto NiiVue's drawing and answers the panel's segmentation commands.
import { cornerstone, ohif } from '@ohif/mode-basic'
import { modeInstance as segmentation } from '@ohif/mode-segmentation'
import { niivueMode } from './viewer'

export default niivueMode({
  id: '@niivue/nv-ohif/modes/segmentation',
  routeName: 'niivue-segmentation',
  displayName: 'NiiVue Segmentation',
  layout: {
    leftPanels: [ohif.thumbnailList],
    // ponytail: no contour panel; contour tools are an M8 gap (scorecard D1-21).
    rightPanels: [cornerstone.labelMapSegmentationPanel],
    // As OHIF's segmentation layout (basic's starts closed).
    rightPanelClosed: false,
  },
  initToolGroups: segmentation.initToolGroups,
  // Not basic's read-only block: the panel's Add Segmentation / Add Segment show.
  modeCustomizations: { 'panelSegmentation.disableEditing': false },
  hangingProtocol: segmentation.hangingProtocol,
  toolbarButtons: [
    ...segmentation.toolbarButtons,
    { $reference: 'niivue.toolbarButtons' },
  ],
  toolbarSections: [
    ...segmentation.toolbarSections,
    { $reference: 'niivue.toolbarSections' },
    {
      // OHIF's segmentation primary bar (segmentationModeToolbarSections);
      // NiiVue's capture and crosshair replace cornerstone's, as in the viewer mode.
      primary: [
        'WindowLevel',
        'Pan',
        'Zoom',
        'TrackballRotate',
        'NiivueCapture',
        'Layout',
        'NiivueCrosshair',
        'MoreTools',
      ],
    },
  ],
  // As OHIF's segmentation mode: any study with an image modality (nonModeModalities SM, ECG, OT, DOC).
  isValidMode: ({ modalities }) => {
    const list = modalities.split('\\')
    return {
      valid: list.some((m) => !['SM', 'ECG', 'OT', 'DOC'].includes(m)),
      description: 'Segmentation needs an image modality',
    }
  },
})
