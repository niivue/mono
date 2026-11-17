// The NiiVue viewer (NVSlide for SM) under the microscopy demo's route.
import { niivueMode } from './viewer'

export default niivueMode({
  id: '@niivue/nv-ohif/modes/microscopy',
  routeName: 'niivue-microscopy',
  displayName: 'NiiVue Microscopy (preview)',
  // As OHIF's microscopy mode: SM only.
  isValidMode: ({ modalities }) => ({
    valid: modalities.split('\\').includes('SM'),
    description: 'Microscopy needs the SM modality',
  }),
})
