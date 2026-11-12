import type { StarlightUserConfig } from '@astrojs/starlight/types'

// The reading order of the guides. It sets the sidebar, each page's
// previous/next links, and the order of llms.txt and llms-full.txt.
export const sidebar = [
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
  { label: 'Integrations', items: ['guide/react', 'guide/extensions'] },
  {
    label: 'Resources',
    items: [{ label: 'Gallery', link: '/gallery/' }, 'guide/develop'],
  },
] satisfies NonNullable<StarlightUserConfig['sidebar']>
