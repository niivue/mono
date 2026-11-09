import { expect, test } from 'bun:test'
import { getNiivueViewportModule } from './getNiivueViewportModule'
import type { OhifViewportProps } from './ohif-types'

test('the viewport gets the managers from the module params, not grid props', () => {
  const servicesManager = { services: {} }
  const commandsManager = { runCommand: () => undefined }
  const [entry] = getNiivueViewportModule({ servicesManager, commandsManager })
  if (!entry) throw new Error('no viewport entry')
  // The grid passes only display props (ViewportGrid.tsx).
  const props: OhifViewportProps = { displaySets: [], viewportId: 'vp' }
  const element = entry.component(props) as { props: OhifViewportProps }
  expect(element.props.servicesManager).toBe(servicesManager)
  expect(element.props.commandsManager).toBe(commandsManager)
  expect(element.props.viewportId).toBe('vp')
})
