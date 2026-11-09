import nextJest from 'next/jest.js'

// Run in a zone that is not UTC, as a browser often is, so that a date that depends on the zone it
// renders in fails a test. The workers inherit the variable from this process.
process.env.TZ = 'Asia/Ho_Chi_Minh'

const createJestConfig = nextJest({
  // Provide the path to your Next.js app to load next.config.js and .env files in your test environment
  dir: './',
})

// Add any custom config to be passed to Jest
const config = {
  coverageProvider: 'v8',
  testEnvironment: 'jsdom',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  moduleNameMapper: {
    '^@/shared/(.*)$': '<rootDir>/src/shared/$1',
    '^@/lib/db$': '<rootDir>/../shared/lib/db',
    '^@/(.*)$': '<rootDir>/$1',
  },
}

// next/jest does not transform node_modules, but jose, openid-client, and oauth4webapi ship
// only ESM. next/jest writes two node_modules patterns (plain and pnpm) that each allow a list
// of packages starting with geist. Add the three packages to that list in both patterns.
const ESM_PACKAGES = 'jose|openid-client|oauth4webapi'

const jestConfig = async () => {
  const resolved = await createJestConfig(config)()
  resolved.transformIgnorePatterns = resolved.transformIgnorePatterns.map((pattern) =>
    pattern.includes('node_modules') ? pattern.replaceAll('(geist|', `(${ESM_PACKAGES}|geist|`) : pattern,
  )
  return resolved
}

export default jestConfig
