/** OAuth scopes. Read access is part of every grant; write access is optional. */
export const READ = 'opengym:read'
export const WRITE = 'opengym:write'
export const ALL_SCOPES = [READ, WRITE]

export const scopesFor = tool => (tool.write ? [READ, WRITE] : [READ])
