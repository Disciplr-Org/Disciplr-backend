import os
import re

auth_ts_path = 'src/middleware/auth.ts'

legacy_code = """
/**
 * @deprecated Use standard `authenticate` instead. Legacy mock auth for early dev. Tracking removal in #454
 */
export const requireUserAuth = (req: Request, res: Response, next: NextFunction): void => {
    const headerUserId = req.header('x-user-id')?.trim()
    let bearerUserId = null
    const authHeader = req.header('authorization')
    if (authHeader) {
        const match = /^Bearer\s+(.+)$/i.exec(authHeader)
        if (match) {
            const token = match[1].trim()
            bearerUserId = token.startsWith('user:') ? token.slice(5) : token
        }
    }
    const userId = headerUserId || bearerUserId
    
    if (!userId) {
        res.status(401).json({
            error: 'Authentication required. Provide x-user-id header or Authorization: Bearer user:<user-id>.',
        })
        return
    }
    
    // @ts-ignore - Preserving legacy property assignment
    req.authUser = { userId }
    next()
}
"""

# 1. Append legacy code to auth.ts
with open(auth_ts_path, 'a', encoding='utf-8') as f:
    f.write(legacy_code)

# 2. Update imports across the codebase
for root, dirs, files in os.walk('src'):
    for file in files:
        if file.endswith('.ts'):
            filepath = os.path.join(root, file)
            with open(filepath, 'r', encoding='utf-8') as f:
                content = f.read()
            
            # Rewrite imports
            new_content = re.sub(r'(/|\\\\)auth\.middleware(\.js)?', r'\g<1>auth.js', content)
            new_content = re.sub(r'(/|\\\\)userAuth(\.js)?', r'\g<1>auth.js', new_content)

            if new_content != content:
                with open(filepath, 'w', encoding='utf-8') as f:
                    f.write(new_content)

# 3. Delete obsolete files
if os.path.exists('src/middleware/auth.middleware.ts'):
    os.remove('src/middleware/auth.middleware.ts')
if os.path.exists('src/middleware/userAuth.ts'):
    os.remove('src/middleware/userAuth.ts')

# 4. Create the test file
test_content = """import { Request, Response, NextFunction } from 'express'
import { requireUserAuth } from '../middleware/auth.js'

describe('Auth Middleware Consolidation', () => {
    it('requireUserAuth sets authUser from x-user-id header', () => {
        const req = { header: (name: string) => name === 'x-user-id' ? 'legacy-123' : undefined } as any
        const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as any
        const next = jest.fn()
        
        requireUserAuth(req, res, next)
        
        expect(req.authUser.userId).toBe('legacy-123')
        expect(next).toHaveBeenCalled()
    })

    it('requireUserAuth rejects missing auth', () => {
        const req = { header: () => undefined } as any
        const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as any
        const next = jest.fn()
        
        requireUserAuth(req, res, next)
        
        expect(res.status).toHaveBeenCalledWith(401)
        expect(next).not.toHaveBeenCalled()
    })
})
"""
os.makedirs('src/tests', exist_ok=True)
with open('src/tests/authMiddlewareConsolidation.test.ts', 'w', encoding='utf-8') as f:
    f.write(test_content)

# 5. Update docs
docs_path = 'docs/auth.md'
if os.path.exists(docs_path):
    with open(docs_path, 'a', encoding='utf-8') as f:
        f.write('\n\n## Middleware Consolidation\n`auth.middleware.ts` and `userAuth.ts` have been consolidated into `auth.ts`. Please import `authenticate` and `authorize` strictly from `src/middleware/auth.js`. `requireUserAuth` is deprecated and will be removed in #454.\n')

print('Consolidation complete. Installing dependencies and running tests...')
