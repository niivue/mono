import tintype from 'tintype/plugin'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    tintype({
      formatCommand: 'bunx biome format --stdin-file-path=file.ts',
    }),
  ],
  test: {
    setupFiles: ['tintype/setup'],
    include: ['__tests__/**/*.test.ts'],
  },
})
