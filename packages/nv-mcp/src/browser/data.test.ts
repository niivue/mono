import { describe, expect, it, mock } from 'bun:test'
import { baseView, hostOf } from '../testing/fake-view'
import { dataHandlers, dataPalette } from './data'

const CATALOG = [
  {
    id: 'mni',
    label: 'MNI152',
    tool: 'load_volume' as const,
    args: { url: '/volumes/mni152.nii.gz', mni: true },
  },
  {
    id: 'motor',
    description: 'A motor map',
    tool: 'add_overlay' as const,
    args: { url: '/volumes/spmMotor.nii.gz', colormap: 'warm' },
  },
]

function setup() {
  const host = hostOf(baseView())
  host.data = dataPalette(CATALOG)
  const loaders = {
    load_volume: mock((params: Record<string, unknown>) => ({
      name: params.url,
    })),
    add_overlay: mock((params: Record<string, unknown>) => ({
      name: params.url,
    })),
  }
  host.data.connect(loaders)
  const { list_data, add_data, remove_data, load_data } = dataHandlers(host)
  return { host, loaders, list_data, add_data, remove_data, load_data }
}

describe('the data palette', () => {
  it('lists the page entries, labelled, with who put them there', () => {
    const { list_data } = setup()
    expect(list_data({})).toEqual({
      data: [
        { ...CATALOG[0], source: 'page' },
        { ...CATALOG[1], label: 'motor', source: 'page' },
      ],
    })
  })

  it('loads an entry through the loading tool it names, with its arguments', async () => {
    const { load_data, loaders } = setup()
    const got = await load_data({ id: 'motor' })
    expect(loaders.add_overlay).toHaveBeenCalledWith({
      url: '/volumes/spmMotor.nii.gz',
      colormap: 'warm',
    })
    expect(got).toEqual({
      loaded: 'motor',
      result: { name: '/volumes/spmMotor.nii.gz' },
    })
  })

  it('adds an entry from another, its arguments laid over, without a tab', async () => {
    const { add_data, load_data, loaders } = setup()
    const got = add_data({
      id: 'motor_hot',
      label: 'Motor (hot)',
      from: 'motor',
      args: { colormap: 'hot', tab: 'x' },
    })
    expect(got).toEqual({
      data: {
        id: 'motor_hot',
        label: 'Motor (hot)',
        description: 'A motor map',
        tool: 'add_overlay',
        args: { url: '/volumes/spmMotor.nii.gz', colormap: 'hot' },
        source: 'agent',
      },
    })
    await load_data({ id: 'motor_hot' })
    expect(loaders.add_overlay.mock.calls[0][0]).toEqual({
      url: '/volumes/spmMotor.nii.gz',
      colormap: 'hot',
    })
  })

  it('declines what is not a load, a taken id and an entry not there', () => {
    const { add_data, load_data } = setup()
    expect(() => add_data({ id: 'x', args: { url: 'a' } })).toThrow(
      'needs the tool',
    )
    expect(() => add_data({ id: 'x', tool: 'set_view', args: {} })).toThrow(
      'Unknown tool',
    )
    expect(() => add_data({ id: 'x', tool: 'load_mesh', args: {} })).toThrow(
      'needs a url',
    )
    expect(() =>
      add_data({ id: 'mni', tool: 'load_volume', args: { url: 'b' } }),
    ).toThrow('already data called "mni"')
    expect(() => add_data({ id: 'x', from: 'nope' })).toThrow(
      'no data "nope" to start from',
    )
    expect(load_data({ id: 'nope' })).rejects.toThrow('There is: mni, motor')
  })

  it('removes an agent entry and keeps the page entries', () => {
    const { add_data, remove_data } = setup()
    add_data({ id: 'tracts', tool: 'load_mesh', args: { url: '/m.trx' } })
    expect(remove_data({ id: 'tracts' })).toEqual({ data: ['mni', 'motor'] })
    expect(() => remove_data({ id: 'mni' })).toThrow("the page's own data")
  })

  it('says so on a page without a palette, or a loader it lacks', async () => {
    const host = hostOf(baseView())
    expect(() => dataHandlers(host).list_data({})).toThrow('no data palette')
    host.data = dataPalette(CATALOG)
    await expect(dataHandlers(host).load_data({ id: 'mni' })).rejects.toThrow(
      'cannot load volume',
    )
  })
})
