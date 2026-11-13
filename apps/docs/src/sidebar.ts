import type { StarlightUserConfig } from '@astrojs/starlight/types'

type Sidebar = NonNullable<StarlightUserConfig['sidebar']>

// The NiiVue guides, in reading order. Their files are in
// packages/niivue/docs; this order sets the sidebar, each page's
// previous/next links, and the order of llms.txt and llms-full.txt.
const guideGroups = [
  { label: 'Start here', items: ['guide', 'guide/loading'] },
  {
    label: 'Displaying images',
    items: [
      'guide/colormaps',
      'guide/overlays',
      'guide/atlases',
      'guide/clip-planes',
    ],
  },
  { label: 'Meshes and tracts', items: ['guide/meshes', 'guide/tracts'] },
  {
    label: 'Views and interaction',
    items: [
      'guide/layout',
      'guide/interaction',
      'reference/events',
      'guide/sync',
      'guide/drawing',
      'guide/animation',
      'guide/fonts',
    ],
  },
  { label: 'Reference', items: ['reference/migrating'] },
] satisfies Sidebar

const resourcesGroup = {
  label: 'Resources',
  items: [{ label: 'Gallery', link: '/gallery/' }, 'guide/develop'],
} satisfies Sidebar[number]

/** Every NiiVue page in reading order, without the Packages section. */
export const sidebar = [...guideGroups, resourcesGroup] satisfies Sidebar

/**
 * The Packages section, in this order. `dir` is the folder under packages/;
 * its docs/ folder becomes /packages/<dir>/. `label` is the package's name
 * without the @niivue/ scope. niivue is the main content above, and
 * dev-images is test data for this repository.
 */
export const PACKAGES = [
  { dir: 'nv-react', label: 'nvreact' },
  { dir: 'nv-web-component', label: 'nv-web-component' },
  { dir: 'uikit', label: 'uikit' },
  { dir: 'ipyniivue', label: 'ipyniivue' },
  { dir: 'niivue-swift', label: 'NiiVueKit' },
  { dir: 'niivue-web-bridge', label: 'web-bridge' },
  { dir: 'nv-ext-tile', label: 'nv-ext-tile' },
  { dir: 'nv-ext-niimath', label: 'nv-ext-niimath' },
  { dir: 'nv-ext-image-processing', label: 'nv-ext-image-processing' },
  { dir: 'nv-ext-drawing', label: 'nv-ext-drawing' },
  { dir: 'nv-ext-isosurface', label: 'nv-ext-isosurface' },
  { dir: 'nv-ext-save-html', label: 'nv-ext-save-html' },
  { dir: 'nv-mcp', label: 'nv-mcp' },
  { dir: 'nv-ohif', label: 'nv-ohif' },
]

export const UNLISTED_PACKAGES = ['niivue', 'dev-images']

/** The whole sidebar, given the Packages section. */
export function fullSidebar(packages: Sidebar[number]): Sidebar {
  return [...guideGroups, packages, resourcesGroup]
}
