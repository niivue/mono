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
      'guide/sync',
      'guide/drawing',
      'guide/animation',
      'guide/fonts',
    ],
  },
  { label: 'Reference', items: ['reference/events', 'reference/migrating'] },
] satisfies Sidebar

const resourcesGroup = {
  label: 'Resources',
  items: [{ label: 'Gallery', link: '/gallery/' }, 'guide/develop'],
} satisfies Sidebar[number]

/** Every NiiVue page in reading order, without the Packages section. */
export const sidebar = [...guideGroups, resourcesGroup] satisfies Sidebar

/**
 * The Packages section, in this order. `dir` is the folder under packages/;
 * its docs/ folder becomes /packages/<dir>/. niivue is the main content
 * above, and dev-images is test data for this repository.
 */
export const PACKAGES = [
  { dir: 'nv-react', label: 'React' },
  { dir: 'nv-web-component', label: 'Web component' },
  { dir: 'uikit', label: 'UIKit' },
  { dir: 'ipyniivue', label: 'Jupyter' },
  { dir: 'niivue-swift', label: 'Swift' },
  { dir: 'niivue-web-bridge', label: 'Web bridge' },
  { dir: 'nv-ext-tile', label: 'Slides and OME-Zarr' },
  { dir: 'nv-ext-niimath', label: 'Image filters' },
  { dir: 'nv-ext-image-processing', label: 'Image processing' },
  { dir: 'nv-ext-drawing', label: 'Drawing tools' },
  { dir: 'nv-ext-isosurface', label: 'Isosurfaces' },
  { dir: 'nv-ext-save-html', label: 'HTML export' },
  { dir: 'nv-mcp', label: 'AI agents (MCP)' },
  { dir: 'nv-ohif', label: 'OHIF viewer' },
]

export const UNLISTED_PACKAGES = ['niivue', 'dev-images']

/** The whole sidebar, given the Packages section. */
export function fullSidebar(packages: Sidebar[number]): Sidebar {
  return [...guideGroups, packages, resourcesGroup]
}
