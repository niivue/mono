import { CoverageReport } from 'monocart-coverage-reports'
import { coverageOptions } from './coverage'

// Global setup for an E2E_COVERAGE=1 run (see e2e/coverage.ts): clears the
// previous run's cache, then, as the returned teardown, turns what the workers
// added into coverage-e2e/lcov.info.
export default async function globalSetup(): Promise<() => Promise<void>> {
  new CoverageReport(coverageOptions).cleanCache()
  return async () => {
    await new CoverageReport(coverageOptions).generate()
  }
}
