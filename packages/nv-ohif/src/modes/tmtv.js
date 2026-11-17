// OHIF's TMTV display on NiiVue panes: its own hanging protocol (4 stages,
// fusion, inverted PT, MIP) and tool groups, over the NiiVue viewer's layout.
import { classes } from '@ohif/core'
import { initToolGroups as tmtvToolGroups } from '@ohif/mode-tmtv'
import { modeInstance, niivue, niivueMode } from './viewer'

// OHIF's ROI threshold and brush tools as plain tool buttons: tmtv's own sit in
// a segmentation toolbox gated on a cornerstone segmentation, which NiiVue panes
// lack (nv-ohif keeps the PT label). Its TMTV panel runs the threshold.
const tool = (id, label, icon, toolName) => ({
  id,
  uiType: 'ohif.toolButton',
  props: {
    icon,
    label,
    commands: {
      commandName: 'setToolActiveToolbar',
      commandOptions: {
        toolName,
        toolGroupIds: ['ctToolGroup', 'ptToolGroup', 'fusionToolGroup'],
      },
    },
    evaluate: [niivue.unsupportedEvaluator, 'evaluate.cornerstoneTool'],
  },
})
export const roiButtons = [
  {
    id: 'NvSegmentationTools',
    uiType: 'ohif.toolButtonList',
    props: { buttonSection: true },
  },
  tool(
    'NvRectangleROIStartEndThreshold',
    'Rectangle ROI Threshold',
    'tool-create-threshold',
    'RectangleROIStartEndThreshold',
  ),
  tool('NvBrush', 'Brush', 'icon-tool-brush', 'CircularBrush'),
  tool('NvEraser', 'Eraser', 'icon-tool-eraser', 'CircularEraser'),
  tool(
    'NvThreshold',
    'Threshold',
    'icon-tool-threshold',
    'ThresholdCircularBrush',
  ),
]
export const roiSection = [
  'NvRectangleROIStartEndThreshold',
  'NvBrush',
  'NvEraser',
  'NvThreshold',
]

// As OHIF's TMTV mode: the PT window is WW 5 / WC 2.5 only when SUV scaling exists.
function onModeEnter(ctx) {
  modeInstance.onModeEnter.call(this, ctx)
  const { toolbarService } = ctx.servicesManager.services
  toolbarService.register(roiButtons, true)
  toolbarService.updateSection('NvSegmentationTools', roiSection)
  toolbarService.updateSection(toolbarService.sections.primary, [
    'NvSegmentationTools',
  ])
  ctx.servicesManager.services.hangingProtocolService.addCustomAttribute(
    'getPTVOIRange',
    'get PT VOI based on corrected or not',
    (displaySets) => {
      const pt = displaySets.find((ds) => ds.Modality === 'PT')
      const imageId = pt?.images?.[0]?.imageId
      if (
        imageId &&
        classes.MetadataProvider.get('scalingModule', imageId)?.suvbw
      )
        return { windowWidth: 5, windowCenter: 2.5 }
    },
  )
}

export default niivueMode({
  id: '@niivue/nv-ohif/modes/tmtv',
  routeName: 'niivue-tmtv',
  displayName: 'NiiVue TMTV (preview)',
  // TMTV opens with the series list closed, as OHIF's (the 3x4 grid needs the width).
  layout: {
    leftPanelClosed: true,
    // As OHIF's TMTV: ROI threshold/TMTV, then the patient/dose editor
    // (nv-ohif reloads PT panes on its invalidation).
    rightPanels: [
      '@niivue/nv-ohif.panelModule.tmtv',
      '@ohif/extension-tmtv.panelModule.petSUV',
    ],
  },
  extensions: { ...modeInstance.extensions, '@ohif/extension-tmtv': '^3.0.0' },
  hangingProtocol: '@ohif/extension-tmtv.hangingProtocolModule.ptCT',
  // ctToolGroup, ptToolGroup, fusionToolGroup, mipToolGroup the protocol names.
  initToolGroups: tmtvToolGroups,
  onModeEnter,
  // As OHIF's TMTV mode: PT and CT together (modeModalities [['PT', 'CT']]).
  isValidMode: ({ modalities, study }) => {
    const list = modalities.split('\\')
    // OHIF's TMTV also excludes SM and two demo studies (the 4D one by MRN).
    const excluded =
      list.includes('SM') ||
      study.mrn === 'M1' ||
      study.studyInstanceUid ===
        '1.3.6.1.4.1.12842.1.1.14.3.20220915.105557.468.2963630849'
    return {
      valid: !excluded && list.includes('PT') && list.includes('CT'),
      description: 'TMTV needs PT and CT',
    }
  },
})
