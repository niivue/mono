// Fails when a Playwright JSON report contains a skipped test, or no tests;
// lists flaky ones (passed on retry) without failing.
//
// The full-suite-metal job runs on a real GPU, where nothing should skip. GPU
// specs skip rather than fail when an adapter or backend is missing, so a skip
// there means coverage was lost while the job stayed green.
//
// Usage: bun .github/scripts/check-no-skipped-tests.ts <results.json>

import { readFileSync } from 'node:fs'

type Annotation = { type: string; description?: string }
type ReportTest = { status: string; annotations?: Annotation[] }
type ReportSpec = {
  title: string
  file: string
  line: number
  tests: ReportTest[]
}
type ReportSuite = { specs?: ReportSpec[]; suites?: ReportSuite[] }
type Report = { suites?: ReportSuite[] }

const reportPath = process.argv[2]
if (!reportPath) {
  console.error(
    'usage: bun .github/scripts/check-no-skipped-tests.ts <results.json>',
  )
  process.exit(2)
}

function collectSpecs(suites: ReportSuite[] = []): ReportSpec[] {
  return suites.flatMap((suite) => [
    ...(suite.specs ?? []),
    ...collectSpecs(suite.suites),
  ])
}

const report = JSON.parse(readFileSync(reportPath, 'utf8')) as Report
const specs = collectSpecs(report.suites)
const total = specs.reduce((sum, spec) => sum + spec.tests.length, 0)

if (total === 0) {
  console.error(`No tests found in ${reportPath}.`)
  process.exit(1)
}

const skipped = specs.flatMap((spec) =>
  spec.tests
    .filter((test) => test.status === 'skipped')
    .map((test) => {
      const reason = test.annotations
        ?.filter((note) => note.type === 'skip' && note.description)
        .map((note) => note.description)
        .join('; ')
      const where = `${spec.file}:${spec.line} ${spec.title}`
      return reason ? `${where}: ${reason}` : where
    }),
)

if (skipped.length > 0) {
  console.error(`${skipped.length} of ${total} tests were skipped:`)
  for (const line of skipped) console.error(`  ${line}`)
  process.exit(1)
}

// A retried pass (#723) is reported, not failed, so a local run cannot hide it.
const flaky = specs.flatMap((spec) =>
  spec.tests
    .filter((test) => test.status === 'flaky')
    .map(() => `${spec.file}:${spec.line} ${spec.title}`),
)
if (flaky.length > 0) {
  console.log(`${flaky.length} of ${total} tests passed only on retry:`)
  for (const line of flaky) console.log(`  ${line}`)
}

console.log(`${total} tests, none skipped.`)
