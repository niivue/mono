import { describe, expect, it, mock } from 'bun:test'
import { baseView, hostOf } from '../testing/fake-view'
import { bindControls, type PageAction, resolveBinding } from './bindings'
import { controlHandlers, memoryControls } from './controls'
import { settingHandlers } from './settings'
import type {
  MeshUpdate,
  ShownMesh,
  ShownVolume,
  View,
  VolumeUpdate,
} from './view'

/** A view with a setting of each kind a control holds, a view layout and two volumes. */
function settingsView(): View & Record<string, unknown> {
  const volumes: ShownVolume[] = [
    {
      name: 'mni152.nii.gz',
      opacity: 1,
      colormap: 'gray',
      calMin: 10,
      calMax: 80,
      globalMin: 0,
      globalMax: 100,
    },
    { name: 'overlay.nii.gz', opacity: 0.5, colormap: 'warm' },
  ]
  const view = baseView({
    volumes,
    colormaps: ['gray', 'warm', 'cool'],
    sliceType: 4,
    multiplanarType: 0,
    isRadiological: false,
    setVolume: mock((index: number, update: VolumeUpdate) => {
      Object.assign(volumes[index], update)
    }),
  })
  const settings = {
    gamma: 1,
    is3DCrosshairVisible: true,
    crosshairColor: new Float32Array([1, 0, 0, 0.5]),
    primaryDragMode: 1,
    drawPenSize: 1,
    volumePaqdUniforms: [0, 0, 0, 0],
  }
  return Object.assign(view, settings) as unknown as View &
    Record<string, unknown>
}

function setup(actions: Record<string, PageAction> = {}) {
  const view = settingsView()
  const memory = memoryControls()
  const onError = mock((_error: Error) => {})
  const controls = bindControls(memory, { view, actions, onError })
  const host = hostOf(view)
  host.controls = controls
  const { add_control, set_control, remove_control } = controlHandlers(host)
  return {
    view,
    memory,
    controls,
    host,
    onError,
    add_control,
    set_control,
    remove_control,
  }
}

type Reported = { control: Record<string, unknown> }

describe('bindControls: binding a control', () => {
  it('starts a bound control at the value it drives, with its range', () => {
    const { add_control } = setup()
    const got = add_control({
      id: 'g',
      kind: 'slider',
      x: 0,
      y: 0,
      bind: 'gamma',
    }) as Reported
    expect(got.control).toMatchObject({ value: 1, min: 0, bind: 'gamma' })
  })

  it('fills a select with the choices an enum setting has', () => {
    const { add_control } = setup()
    const got = add_control({
      id: 'drag',
      kind: 'select',
      x: 0,
      y: 0,
      bind: 'primaryDragMode',
    }) as Reported
    expect(got.control.value).toBe('contrast')
    const ids = (got.control.options as Array<{ id: string }>).map((o) => o.id)
    expect(ids).toContain('pan')
    expect(ids).toContain('crosshair')
  })

  it('takes an integer setting a whole step at a time', () => {
    const { add_control } = setup()
    const got = add_control({
      id: 'pen',
      kind: 'number',
      x: 0,
      y: 0,
      bind: 'drawPenSize',
    }) as Reported
    expect(got.control).toMatchObject({ value: 1, min: 1, step: 1 })
  })

  it('reads a colour as plain numbers, without alpha when the control has none', () => {
    const { add_control } = setup()
    const got = add_control({
      id: 'c',
      kind: 'color',
      x: 0,
      y: 0,
      bind: 'crosshairColor',
    }) as Reported
    expect(got.control.value).toEqual([1, 0, 0])
  })

  it('sets what it drives when the agent gives a value', () => {
    const { add_control, view } = setup()
    add_control({
      id: 'g',
      kind: 'slider',
      x: 0,
      y: 0,
      bind: 'gamma',
      max: 4,
      value: 2.5,
    })
    expect(view.gamma).toBe(2.5)
  })

  it('declines a kind that cannot hold what the target takes', () => {
    const { add_control, controls } = setup()
    expect(() =>
      add_control({ id: 't', kind: 'toggle', x: 0, y: 0, bind: 'gamma' }),
    ).toThrow('gamma takes a number, which a toggle does not hold')
    expect(() =>
      add_control({ id: 'b', kind: 'button', x: 0, y: 0, bind: 'gamma' }),
    ).toThrow('only be bound to an action')
    expect(controls.list()).toHaveLength(0)
  })

  it('declines options a setting does not take', () => {
    const { add_control } = setup()
    expect(() =>
      add_control({
        id: 'drag',
        kind: 'segmented',
        x: 0,
        y: 0,
        options: ['pan', 'scribble'],
        bind: 'primaryDragMode',
      }),
    ).toThrow('scribble is not among them')
  })

  it('declines what it cannot reach, saying what a bind may name', () => {
    const { add_control } = setup()
    expect(() =>
      add_control({ id: 'x', kind: 'slider', x: 0, y: 0, bind: 'nope' }),
    ).toThrow('volume.<index>.<property>')
    expect(() =>
      add_control({
        id: 'x',
        kind: 'text',
        x: 0,
        y: 0,
        bind: 'volumePaqdUniforms',
      }),
    ).toThrow('which no control holds')
    expect(() =>
      add_control({
        id: 'x',
        kind: 'slider',
        x: 0,
        y: 0,
        bind: 'volume.5.opacity',
      }),
    ).toThrow('There is no volume 5')
    expect(() =>
      add_control({ id: 'x', kind: 'button', x: 0, y: 0, bind: 'action.go' }),
    ).toThrow('offers no actions')
  })

  it('leaves the target as it was when the value given is bad', () => {
    const { add_control, view, controls } = setup()
    expect(() =>
      add_control({
        id: 'drag',
        kind: 'select',
        x: 0,
        y: 0,
        bind: 'primaryDragMode',
        value: 'scribble',
      }),
    ).toThrow()
    expect(view.primaryDragMode).toBe(1)
    expect(controls.list()).toHaveLength(0)
  })
})

describe('bindControls: the view and volumes', () => {
  it('binds the slice type to a segmented row by name', () => {
    const { add_control, memory, view } = setup()
    const got = add_control({
      id: 'slice',
      kind: 'segmented',
      x: 0,
      y: 0,
      bind: 'view.slice',
    }) as Reported
    expect(got.control.value).toBe('render')
    memory.simulate({ id: 'slice', type: 'change', value: 'axial' })
    expect(view.sliceType).toBe(0)
  })

  it('binds a volume property, with its range from the volume', () => {
    const { add_control, memory, view } = setup()
    const got = add_control({
      id: 'max',
      kind: 'slider',
      x: 0,
      y: 0,
      bind: 'volume.0.cal_max',
    }) as Reported
    expect(got.control).toMatchObject({ value: 80, min: 0, max: 100 })
    memory.simulate({ id: 'max', type: 'input', value: 60 })
    expect(view.setVolume).toHaveBeenCalledWith(0, { calMax: 60 })
    expect(view.volumes[0].calMax).toBe(60)
  })

  it('offers the colormaps for a volume colormap', () => {
    const { add_control, memory, view } = setup()
    const got = add_control({
      id: 'cm',
      kind: 'select',
      x: 0,
      y: 0,
      bind: 'volume.1.colormap',
    }) as Reported
    expect(got.control.value).toBe('warm')
    expect(
      (got.control.options as Array<{ id: string }>).map((o) => o.id),
    ).toEqual(['gray', 'warm', 'cool'])
    memory.simulate({ id: 'cm', type: 'change', value: 'cool' })
    expect(view.volumes[1].colormap).toBe('cool')
  })
})

describe('bindControls: both ways', () => {
  it('writes what the person does, and redraws', () => {
    const { add_control, memory, view } = setup()
    add_control({
      id: 'cube',
      kind: 'toggle',
      x: 0,
      y: 0,
      bind: 'is3DCrosshairVisible',
    })
    const drawn = (view.drawScene as ReturnType<typeof mock>).mock.calls.length
    memory.simulate({ id: 'cube', type: 'change', value: false })
    expect(view.is3DCrosshairVisible).toBe(false)
    expect(
      (view.drawScene as ReturnType<typeof mock>).mock.calls.length,
    ).toBeGreaterThan(drawn)
  })

  it('keeps a colour control without alpha from dropping the alpha it drives', () => {
    const { add_control, memory, view } = setup()
    add_control({ id: 'c', kind: 'color', x: 0, y: 0, bind: 'crosshairColor' })
    memory.simulate({ id: 'c', type: 'change', value: [0, 1, 0] })
    expect(Array.from(view.crosshairColor as number[])).toEqual([0, 1, 0, 0.5])
  })

  it('writes a slider while it moves but a text field only once committed', () => {
    const { add_control, memory, view } = setup()
    view.placeholderText = 'Drop a scan'
    add_control({ id: 'g', kind: 'slider', x: 0, y: 0, max: 4, bind: 'gamma' })
    memory.simulate({ id: 'g', type: 'input', value: 2 })
    expect(view.gamma).toBe(2)
    add_control({ id: 't', kind: 'text', x: 0, y: 0, bind: 'placeholderText' })
    memory.simulate({ id: 't', type: 'input', value: 'Dro' })
    expect(view.placeholderText).toBe('Drop a scan')
    memory.simulate({ id: 't', type: 'change', value: 'Drop here' })
    expect(view.placeholderText).toBe('Drop here')
  })

  it('shows a change made elsewhere on the control', () => {
    const { add_control, controls, view } = setup()
    add_control({ id: 'g', kind: 'slider', x: 0, y: 0, max: 4, bind: 'gamma' })
    // An agent's set_options, or anything else, changes the setting.
    const { set_options } = settingHandlers(hostOf(view))
    set_options({ options: { gamma: 3 } })
    const g = controls.list().find((c) => c.id === 'g')
    expect(g?.value).toBe(3)
  })

  it('reads the values before each frame of a surface that draws', () => {
    const { add_control, memory, view } = setup()
    add_control({
      id: 'o',
      kind: 'slider',
      x: 0,
      y: 0,
      bind: 'volume.1.opacity',
    })
    ;(view.volumes[1] as { opacity: number }).opacity = 0.25
    memory.frame()
    expect(memory.list()[0].value).toBe(0.25)
  })

  it('does not fight the person: what they set is not read back over itself', () => {
    const { add_control, memory } = setup()
    add_control({ id: 'g', kind: 'slider', x: 0, y: 0, max: 4, bind: 'gamma' })
    const update = mock(memory.update)
    memory.update = update
    memory.simulate({ id: 'g', type: 'change', value: 2 })
    memory.frame()
    expect(update).not.toHaveBeenCalled()
  })

  it("sets what it drives when the agent's set_control gives a value", () => {
    const { add_control, set_control, view } = setup()
    add_control({ id: 'g', kind: 'slider', x: 0, y: 0, max: 4, bind: 'gamma' })
    set_control({ id: 'g', value: 1.5 })
    expect(view.gamma).toBe(1.5)
  })

  it('rebinds and unbinds through set_control', () => {
    const { add_control, set_control, memory, view } = setup()
    add_control({
      id: 'o',
      kind: 'slider',
      x: 0,
      y: 0,
      bind: 'volume.0.opacity',
    })
    const moved = set_control({ id: 'o', bind: 'volume.1.opacity' }) as Reported
    expect(moved.control).toMatchObject({
      bind: 'volume.1.opacity',
      value: 0.5,
    })
    const loose = set_control({ id: 'o', bind: '' }) as Reported
    expect(loose.control.bind).toBeUndefined()
    memory.simulate({ id: 'o', type: 'change', value: 0.1 })
    expect(view.volumes[1].opacity).toBe(0.5)
  })

  it('leaves what a control drives alone when its cell is refused', () => {
    const { add_control, set_control, view } = setup()
    add_control({ id: 'a', kind: 'button', row: 0, col: 0 })
    add_control({ id: 's', kind: 'slider', row: 1, col: 0, bind: 'gamma' })
    expect(() =>
      add_control({
        id: 't',
        kind: 'slider',
        row: 0,
        col: 0,
        bind: 'gamma',
        value: 2,
      }),
    ).toThrow(/holds "a"/)
    expect(() => set_control({ id: 's', row: 0, value: 3 })).toThrow(
      /holds "a"/,
    )
    expect(view.gamma).toBe(1)
  })

  it('stops tracking a control once it is removed', () => {
    const { add_control, remove_control, controls, view } = setup()
    add_control({ id: 'g', kind: 'slider', x: 0, y: 0, max: 4, bind: 'gamma' })
    remove_control({ id: 'g' })
    view.gamma = 2
    expect(controls.list()).toHaveLength(0)
    // The same id comes back unbound, and what it was bound to is not read into it.
    const got = add_control({ id: 'g', kind: 'slider', x: 0, y: 0 }) as Reported
    expect(got.control.value).toBe(0)
  })
})

describe('bindControls: actions', () => {
  it('runs an action when a button is pressed, not while a value moves', () => {
    const run = mock(() => {})
    const { add_control, memory } = setup({
      reset: { description: 'Puts the view back.', run },
    })
    add_control({ id: 'r', kind: 'button', x: 0, y: 0, bind: 'action.reset' })
    memory.simulate({ id: 'r', type: 'press' })
    expect(run).toHaveBeenCalledWith({ id: 'r', type: 'press' })
    add_control({ id: 's', kind: 'slider', x: 0, y: 0, bind: 'action.reset' })
    memory.simulate({ id: 's', type: 'input', value: 0.5 })
    expect(run).toHaveBeenCalledTimes(1)
    memory.simulate({ id: 's', type: 'change', value: 0.5 })
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('reports an action that fails, by its control', async () => {
    const { add_control, memory, onError } = setup({
      boom: {
        description: 'Fails.',
        run: async () => {
          throw new Error('no')
        },
      },
    })
    add_control({ id: 'b', kind: 'button', x: 0, y: 0, bind: 'action.boom' })
    memory.simulate({ id: 'b', type: 'press' })
    await Promise.resolve()
    await Promise.resolve()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0].message).toBe('no')
  })

  it('lists the forms and the actions in capabilities', () => {
    const { host } = setup({
      reset: { description: 'Puts the view back.', run: () => {} },
    })
    const caps = settingHandlers(host).capabilities({}) as {
      controlBindings: {
        forms: Array<{ form: string }>
        actions: Array<{ name: string; description: string }>
      }
    }
    expect(caps.controlBindings.forms.map((f) => f.form)).toContain(
      'volume.<index>.<property>',
    )
    expect(caps.controlBindings.actions).toEqual([
      { name: 'reset', description: 'Puts the view back.' },
    ])
  })
})

/** A view with a surface, a tract and a connectome. */
function meshView() {
  const meshes: ShownMesh[] = [
    { name: 'lh.pial', kind: 'mesh', opacity: 1, shaderType: 'phong' },
    {
      name: 'yeh2022.trx',
      kind: 'tract',
      opacity: 1,
      tractOptions: {
        fiberRadius: 0.5,
        colorBy: 'fixed',
        fixedColor: [255, 0, 0, 128],
      },
      trx: {
        groups: { CST: [], AF: [] },
        dps: { z_score: [] },
        dpsMeta: { z_score: { globalMin: 0, globalMax: 5 } },
      },
    },
    {
      name: 'net.jcon',
      kind: 'connectome',
      connectomeOptions: { nodeScale: 3 },
    },
  ]
  const options =
    (key: 'tractOptions' | 'connectomeOptions') =>
    (index: number, update: Record<string, unknown>) => {
      meshes[index][key] = { ...meshes[index][key], ...update }
      return Promise.resolve()
    }
  const view = baseView({
    meshes,
    meshShaders: ['phong', 'matte', 'flat'],
    colormaps: ['gray', 'warm'],
    setMesh: mock((index: number, update: MeshUpdate) => {
      Object.assign(meshes[index], update)
      return Promise.resolve()
    }),
    setTractOptions: mock(options('tractOptions')),
    setConnectomeOptions: mock(options('connectomeOptions')),
  })
  const memory = memoryControls()
  const onError = mock((_error: Error) => {})
  const controls = bindControls(memory, { view, onError })
  const host = hostOf(view)
  host.controls = controls
  const { add_control, list_controls } = controlHandlers(host)
  return { view, meshes, memory, onError, add_control, list_controls }
}

describe('bindControls: meshes', () => {
  it("offers a tract's colour modes and scalars, direction standing for ''", () => {
    const { add_control, memory, meshes } = meshView()
    const got = add_control({
      id: 'c',
      kind: 'select',
      bind: 'mesh.1.tract.colorBy',
    }) as Reported
    expect(
      (got.control.options as Array<{ id: string }>).map((o) => o.id),
    ).toEqual(['direction', 'global', 'fixed', 'dps:z_score'])
    expect(got.control.value).toBe('fixed')
    memory.simulate({ id: 'c', type: 'change', value: 'direction' })
    expect(meshes[1].tractOptions?.colorBy).toBe('')
    memory.simulate({ id: 'c', type: 'change', value: 'dps:z_score' })
    expect(meshes[1].tractOptions?.colorBy).toBe('dps:z_score')
  })

  it('shows one group of a tract alone, or all of them', () => {
    const { add_control, memory, meshes, list_controls } = meshView()
    const got = add_control({
      id: 'g',
      kind: 'select',
      bind: 'mesh.1.tract.group',
    }) as Reported
    expect(
      (got.control.options as Array<{ id: string }>).map((o) => o.id),
    ).toEqual(['all', 'CST', 'AF'])
    memory.simulate({ id: 'g', type: 'change', value: 'AF' })
    expect(meshes[1].tractOptions?.groupColors).toEqual({
      AF: [230, 25, 75, 255],
    })
    memory.simulate({ id: 'g', type: 'change', value: 'all' })
    expect(meshes[1].tractOptions?.groupColors).toBeNull()
    // A change made elsewhere shows on the select.
    meshes[1].tractOptions = {
      ...meshes[1].tractOptions,
      groupColors: { CST: [0, 0, 0, 255] },
    }
    const listed = list_controls({}) as {
      controls: Array<{ id: string; value: unknown }>
    }
    expect(listed.controls.find((c) => c.id === 'g')?.value).toBe('CST')
  })

  it('stops driving a mesh that another has replaced at its index', () => {
    const { add_control, memory, meshes, view, onError } = meshView()
    add_control({ id: 'g', kind: 'select', bind: 'mesh.1.tract.group' })
    meshes[1] = { name: 'net.jcon', kind: 'connectome' }
    memory.simulate({ id: 'g', type: 'change', value: 'AF' })
    expect(view.setTractOptions).not.toHaveBeenCalled()
    expect(onError.mock.calls[0][0].message).toContain('Bind it again')
  })

  it('keeps the last value of a mesh property once its mesh is replaced', () => {
    const { add_control, meshes, list_controls } = meshView()
    meshes[0].visible = false
    add_control({ id: 'v', kind: 'toggle', bind: 'mesh.0.visible' })
    meshes[0] = { ...meshes[0], visible: false }
    const listed = list_controls({}) as {
      controls: Array<{ id: string; value: unknown }>
    }
    expect(listed.controls.find((c) => c.id === 'v')?.value).toBe(false)
  })

  it('stops driving a mesh loaded again at its index from the same source', () => {
    const { add_control, memory, meshes, view, onError, list_controls } =
      meshView()
    add_control({ id: 'r', kind: 'slider', bind: 'mesh.1.tract.fiberRadius' })
    meshes[1] = {
      ...meshes[1],
      tractOptions: { ...meshes[1].tractOptions, fiberRadius: 2 },
    }
    // The new mesh's value does not show on the control bound to the old one.
    const listed = list_controls({}) as {
      controls: Array<{ id: string; value: unknown }>
    }
    expect(listed.controls.find((c) => c.id === 'r')?.value).toBe(0.5)
    memory.simulate({ id: 'r', type: 'change', value: 1 })
    expect(view.setTractOptions).not.toHaveBeenCalled()
    expect(onError.mock.calls[0][0].message).toContain('Bind it again')
  })

  it('hears a write that NiiVue fails later', async () => {
    const { add_control, memory, view, onError } = meshView()
    // The bind holds the setter it was made with, so it fails from the start.
    view.setTractOptions = mock(() => Promise.reject(new Error('boom')))
    add_control({ id: 'r', kind: 'slider', bind: 'mesh.1.tract.fiberRadius' })
    memory.simulate({ id: 'r', type: 'change', value: 1 })
    await Promise.resolve()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0].message).toBe('boom')
  })

  it('reads no named groups as all of them shown', () => {
    const { add_control, meshes, list_controls } = meshView()
    add_control({ id: 'g', kind: 'select', bind: 'mesh.1.tract.group' })
    meshes[1].tractOptions = { ...meshes[1].tractOptions, groupColors: {} }
    const listed = list_controls({}) as {
      controls: Array<{ id: string; value: unknown }>
    }
    expect(listed.controls.find((c) => c.id === 'g')?.value).toBe('all')
  })

  it('declines a group select on a tract with no groups', () => {
    const { add_control, meshes } = meshView()
    meshes[1].trx = null
    expect(() =>
      add_control({ id: 'g', kind: 'select', bind: 'mesh.1.tract.group' }),
    ).toThrow('has no groups')
  })

  it('drives a tract option from a slider as it moves', () => {
    const { add_control, memory, view } = meshView()
    const got = add_control({
      id: 'r',
      kind: 'slider',
      x: 0,
      y: 0,
      max: 2,
      step: 0.1,
      bind: 'mesh.1.tract.fiberRadius',
    }) as Reported
    expect(got.control).toMatchObject({ value: 0.5, min: 0, max: 2 })
    memory.simulate({ id: 'r', type: 'input', value: 1.2 })
    expect(view.setTractOptions).toHaveBeenLastCalledWith(1, {
      fiberRadius: 1.2,
    })
  })

  it("takes a tract slider's range from NiiVue's examples when given none", () => {
    const { add_control } = meshView()
    const got = add_control({
      id: 'r',
      kind: 'slider',
      bind: 'mesh.1.tract.fiberRadius',
    }) as Reported
    expect(got.control).toMatchObject({ min: 0, max: 3, step: 0.1, value: 0.5 })
  })

  it('shows a mesh with visible unset as shown', () => {
    const { add_control, memory, meshes } = meshView()
    const got = add_control({
      id: 'v',
      kind: 'toggle',
      bind: 'mesh.0.visible',
    }) as Reported
    expect(got.control.value).toBe(true)
    memory.simulate({ id: 'v', type: 'change', value: false })
    expect(meshes[0].visible).toBe(false)
  })

  it('offers the mesh shaders and writes a mesh property', () => {
    const { add_control, memory, meshes } = meshView()
    const got = add_control({
      id: 's',
      kind: 'select',
      x: 0,
      y: 0,
      bind: 'mesh.0.shader',
    }) as Reported
    expect(got.control.value).toBe('phong')
    expect(
      (got.control.options as Array<{ id: string }>).map((o) => o.id),
    ).toEqual(['phong', 'matte', 'flat'])
    memory.simulate({ id: 's', type: 'change', value: 'matte' })
    expect(meshes[0].shaderType).toBe('matte')
  })

  it('holds a tract colour 0 to 1 and keeps the alpha it drives', () => {
    const { add_control, memory, meshes } = meshView()
    const got = add_control({
      id: 'c',
      kind: 'color',
      x: 0,
      y: 0,
      bind: 'mesh.1.tract.fixedColor',
    }) as Reported
    expect(got.control.value).toEqual([1, 0, 0])
    memory.simulate({ id: 'c', type: 'change', value: [0, 1, 0] })
    expect(meshes[1].tractOptions?.fixedColor).toEqual([0, 255, 0, 128])
  })

  it('shows a tract option changed elsewhere', () => {
    const { add_control, list_controls, meshes } = meshView()
    add_control({
      id: 'n',
      kind: 'number',
      x: 0,
      y: 0,
      bind: 'mesh.2.connectome.nodeScale',
    })
    meshes[2].connectomeOptions = { nodeScale: 5 }
    const { controls } = list_controls({}) as {
      controls: Array<{ value: unknown }>
    }
    expect(controls[0].value).toBe(5)
  })

  it('declines a mesh it cannot reach, saying what a mesh bind may name', () => {
    const { add_control } = meshView()
    const bind = (b: string) => () =>
      add_control({ id: 'x', kind: 'slider', x: 0, y: 0, bind: b })
    expect(bind('mesh.4.opacity')).toThrow('There is no mesh 4: 3 are loaded.')
    expect(bind('mesh.0.tract.fiberRadius')).toThrow(
      'lh.pial is a mesh, not a tract.',
    )
    expect(bind('mesh.1.tract.groupColors')).toThrow('not a mesh binding')
    expect(bind('mesh.1.width')).toThrow('fiberRadius')
    expect(bind('mesh.1.opacity.x')).toThrow('not a mesh binding')
  })
})

describe('bindControls: dialogs', () => {
  it('opens a hidden dialog from a button bound to it', () => {
    const { add_control, memory } = setup()
    add_control({
      id: 'about',
      kind: 'dialog',
      label: 'About',
      x: 0,
      y: 0,
      open: false,
    })
    const open = () => memory.list().find((c) => c.id === 'about')?.open
    expect(open()).toBe(false)
    add_control({ id: 'b', kind: 'button', x: 0, y: 0, bind: 'dialog.about' })
    memory.simulate({ id: 'b', type: 'press' })
    expect(open()).toBe(true)
    memory.simulate({ id: 'about', type: 'press', item: 'ok' })
    expect(open()).toBe(false)
    memory.simulate({ id: 'b', type: 'press' })
    expect(open()).toBe(true)
  })

  it('declines a dialog that is not there, and reports one removed since', () => {
    const { add_control, remove_control, memory, onError } = setup()
    expect(() =>
      add_control({ id: 'b', kind: 'button', x: 0, y: 0, bind: 'dialog.nope' }),
    ).toThrow('There is no dialog "nope". Add it first, with open: false')
    add_control({ id: 't', kind: 'toggle', x: 0, y: 0 })
    expect(() =>
      add_control({ id: 'b', kind: 'button', x: 0, y: 0, bind: 'dialog.t' }),
    ).toThrow('"t" is a toggle, not a dialog.')
    add_control({ id: 'd', kind: 'dialog', x: 0, y: 0, open: false })
    add_control({ id: 'b', kind: 'button', x: 0, y: 0, bind: 'dialog.d' })
    remove_control({ id: 'd' })
    memory.simulate({ id: 'b', type: 'press' })
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0].message).toContain('no dialog "d"')
  })
})

describe('resolveBinding', () => {
  it('names the actions the page has when one is not there', () => {
    expect(() =>
      resolveBinding('action.go', settingsView(), {
        reset: { description: '', run: () => {} },
      }),
    ).toThrow('It has: reset')
  })

  it('declines a view part NiiVue lacks', () => {
    const view = baseView()
    expect(() => resolveBinding('view.slice', view)).toThrow('no sliceType')
  })
})
