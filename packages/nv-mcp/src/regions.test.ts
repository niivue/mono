import { describe, expect, it } from 'bun:test'

import {
  ambiguityMessage,
  findRegion,
  matchRegion,
  regionMentions,
} from './regions'

const regions = [
  {
    label: 'Precentral_L',
    name: 'left precentral gyrus',
    aliases: ['Left precentral'],
  },
  {
    label: 'Precentral_R',
    name: 'right precentral gyrus',
    aliases: ['Right precentral'],
  },
  {
    label: 'Frontal_Inf_Tri_L',
    name: 'left inferior frontal gyrus, triangular part',
    aliases: ['Left frontal inferior triangular'],
  },
  { label: 'Insula_L', name: 'left insula' },
  { label: 'Hippocampus_L', name: 'left hippocampus' },
  { label: 'Hippocampus_R', name: 'right hippocampus' },
]

describe('findRegion', () => {
  it('matches a label or a spoken name exactly, whatever the case or separator', () => {
    expect(findRegion(regions, 'precentral_r').region?.label).toBe(
      'Precentral_R',
    )
    expect(findRegion(regions, 'Left Precentral Gyrus').region?.label).toBe(
      'Precentral_L',
    )
    expect(findRegion(regions, 'Precentral L').region?.label).toBe(
      'Precentral_L',
    )
    expect(findRegion(regions, ' left insula ').region?.label).toBe('Insula_L')
  })

  it('still answers to the name a region had before the table', () => {
    expect(
      findRegion(regions, 'left frontal inferior triangular').region?.label,
    ).toBe('Frontal_Inf_Tri_L')
    expect(findRegion(regions, 'right precentral').region?.label).toBe(
      'Precentral_R',
    )
  })

  it('settles on the one region containing the words', () => {
    expect(findRegion(regions, 'triangular').region?.label).toBe(
      'Frontal_Inf_Tri_L',
    )
    expect(findRegion(regions, 'frontal inferior').region?.label).toBe(
      'Frontal_Inf_Tri_L',
    )
    expect(findRegion(regions, 'left hippo').region?.label).toBe(
      'Hippocampus_L',
    )
  })

  it('hands back the candidates when the words fit several regions', () => {
    const match = findRegion(regions, 'hippocampus')
    expect(match.region).toBeNull()
    expect(match.candidates.map((r) => r.label)).toEqual([
      'Hippocampus_L',
      'Hippocampus_R',
    ])
    expect(findRegion(regions, 'precentral').candidates).toHaveLength(2)
    // An exact hit on a label is never ambiguous, even when it is a prefix of another name.
    expect(findRegion(regions, 'Hippocampus_L').region?.label).toBe(
      'Hippocampus_L',
    )
  })

  it('finds nothing, and no candidates, for an empty or unknown query', () => {
    expect(findRegion(regions, '')).toEqual({ region: null, candidates: [] })
    expect(findRegion(regions, '   ')).toEqual({ region: null, candidates: [] })
    expect(findRegion(regions, 'thalamus')).toEqual({
      region: null,
      candidates: [],
    })
  })
})

describe('matchRegion', () => {
  it('is the region a query settles on, and null when it settles on none or several', () => {
    expect(matchRegion(regions, 'Insula_L')?.label).toBe('Insula_L')
    expect(matchRegion(regions, 'hippocampus')).toBeNull()
    expect(matchRegion(regions, 'thalamus')).toBeNull()
  })
})

describe('ambiguityMessage', () => {
  it('names each candidate by label and spoken name', () => {
    const text = ambiguityMessage(
      'hippocampus',
      findRegion(regions, 'hippocampus').candidates,
    )
    expect(text).toBe(
      '"hippocampus" could mean 2 regions: Hippocampus_L (left hippocampus), Hippocampus_R (right hippocampus). Say which.',
    )
  })
})

describe('regionMentions', () => {
  const region = {
    label: 'Frontal_Inf_Tri_L',
    name: 'left inferior frontal gyrus, triangular part',
    aliases: ['Left frontal inferior triangular'],
  }

  it('looks through the label, the name and the aliases alike', () => {
    expect(regionMentions(region, 'frontal_inf')).toBe(true)
    expect(regionMentions(region, 'Triangular Part')).toBe(true)
    expect(regionMentions(region, 'frontal inferior')).toBe(true)
    expect(regionMentions(region, 'temporal')).toBe(false)
  })
})
