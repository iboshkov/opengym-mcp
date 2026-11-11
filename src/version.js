import { createRequire } from 'node:module'

/** The service version, read once from package.json so it is declared in one place. */
export const { version } = createRequire(import.meta.url)('../package.json')
