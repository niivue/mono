import { registerScenes } from './renderHarness'
import { SCENES } from './renderScenes'

// Reference images of the major render paths (scenes in renderScenes.ts); the
// harness and how to update the references are described in renderHarness.ts.
registerScenes(SCENES)
