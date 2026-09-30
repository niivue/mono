/**
 * The spoken name of each AAL region, in the anatomical English a listener
 * would hear from an anatomist: `Frontal_Inf_Tri_L` is "left inferior
 * frontal gyrus, triangular part", not "left frontal inferior triangular".
 *
 * The side comes first, as before, because it is the part a listener most
 * wants confirmed and the part most easily lost when the next region cuts
 * the name short. Any label missing here falls back to the generated name
 * (see `speakable` in atlas.ts).
 */

/** The paired regions, by the label stem that precedes `_L` or `_R`. */
const SIDED: Record<string, string> = {
  Precentral: 'precentral gyrus',
  Frontal_Sup: 'superior frontal gyrus',
  Frontal_Sup_Orb: 'superior frontal gyrus, orbital part',
  Frontal_Mid: 'middle frontal gyrus',
  Frontal_Mid_Orb: 'middle frontal gyrus, orbital part',
  Frontal_Inf_Oper: 'inferior frontal gyrus, opercular part',
  Frontal_Inf_Tri: 'inferior frontal gyrus, triangular part',
  Frontal_Inf_Orb: 'inferior frontal gyrus, orbital part',
  Rolandic_Oper: 'Rolandic operculum',
  Supp_Motor_Area: 'supplementary motor area',
  Olfactory: 'olfactory cortex',
  Frontal_Sup_Medial: 'superior frontal gyrus, medial part',
  Frontal_Med_Orb: 'superior frontal gyrus, medial orbital part',
  Rectus: 'gyrus rectus',
  Insula: 'insula',
  Cingulum_Ant: 'anterior cingulate gyrus',
  Cingulum_Mid: 'middle cingulate gyrus',
  Cingulum_Post: 'posterior cingulate gyrus',
  Hippocampus: 'hippocampus',
  ParaHippocampal: 'parahippocampal gyrus',
  Amygdala: 'amygdala',
  Calcarine: 'calcarine cortex',
  Cuneus: 'cuneus',
  Lingual: 'lingual gyrus',
  Occipital_Sup: 'superior occipital gyrus',
  Occipital_Mid: 'middle occipital gyrus',
  Occipital_Inf: 'inferior occipital gyrus',
  Fusiform: 'fusiform gyrus',
  Postcentral: 'postcentral gyrus',
  Parietal_Sup: 'superior parietal lobule',
  Parietal_Inf: 'inferior parietal lobule',
  SupraMarginal: 'supramarginal gyrus',
  Angular: 'angular gyrus',
  Precuneus: 'precuneus',
  Paracentral_Lobule: 'paracentral lobule',
  Caudate: 'caudate nucleus',
  Putamen: 'putamen',
  Pallidum: 'globus pallidus',
  Thalamus: 'thalamus',
  Heschl: "Heschl's gyrus",
  Temporal_Sup: 'superior temporal gyrus',
  Temporal_Pole_Sup: 'temporal pole, superior part',
  Temporal_Mid: 'middle temporal gyrus',
  Temporal_Pole_Mid: 'temporal pole, middle part',
  Temporal_Inf: 'inferior temporal gyrus',
  Cerebelum_Crus1: 'cerebellum, crus 1',
  Cerebelum_Crus2: 'cerebellum, crus 2',
  Cerebelum_3: 'cerebellum, lobule 3',
  Cerebelum_4_5: 'cerebellum, lobules 4 and 5',
  Cerebelum_6: 'cerebellum, lobule 6',
  Cerebelum_7b: 'cerebellum, lobule 7b',
  Cerebelum_8: 'cerebellum, lobule 8',
  Cerebelum_9: 'cerebellum, lobule 9',
  Cerebelum_10: 'cerebellum, lobule 10',
}

/** The midline regions, which have no side. */
const MIDLINE: Record<string, string> = {
  Vermis_1_2: 'vermis, lobules 1 and 2',
  Vermis_3: 'vermis, lobule 3',
  Vermis_4_5: 'vermis, lobules 4 and 5',
  Vermis_6: 'vermis, lobule 6',
  Vermis_7: 'vermis, lobule 7',
  Vermis_8: 'vermis, lobule 8',
  Vermis_9: 'vermis, lobule 9',
  Vermis_10: 'vermis, lobule 10',
}

/** Every AAL label with its spoken name. */
export const SPOKEN_NAMES: Readonly<Record<string, string>> =
  Object.fromEntries([
    ...Object.entries(SIDED).flatMap(([stem, name]) => [
      [`${stem}_L`, `left ${name}`],
      [`${stem}_R`, `right ${name}`],
    ]),
    ...Object.entries(MIDLINE),
  ])
