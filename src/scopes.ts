/** OAuth scopes. Read access is part of every grant; write access is optional. */
export const READ = 'opengym:read'
export const WRITE = 'opengym:write'
export type Scope = typeof READ | typeof WRITE
export const ALL_SCOPES: readonly Scope[] = [READ, WRITE]

export const scopesFor = (tool: { write?: boolean }): Scope[] => (tool.write ? [READ, WRITE] : [READ])
