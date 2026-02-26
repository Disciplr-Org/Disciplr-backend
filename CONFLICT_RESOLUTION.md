# Merge Conflict Resolution Guide

## Current Status
The repository appears to be clean and up to date, but if you're encountering conflicts in a different context (GitHub PR, different branch, etc.), here's how to resolve them.

## Files with Potential Conflicts

### 1. README.md
**Common Issues:**
- Documentation updates conflicting
- API endpoint descriptions
- Setup instructions

**Resolution Strategy:**
- Keep the most comprehensive documentation
- Merge both sets of API examples
- Preserve both setup methods if different

### 2. package.json & package-lock.json
**Common Issues:**
- Dependency version conflicts
- New dependencies added in both branches
- Script conflicts

**Resolution Strategy:**
```bash
# For package-lock.json conflicts, often safest to regenerate:
rm package-lock.json
npm install
git add package-lock.json
```

For package.json:
- Merge dependencies (keep highest compatible versions)
- Combine script sections
- Preserve all new dependencies

### 3. src/index.ts
**Common Issues:**
- Import statement conflicts
- Route registration order
- ETL service initialization

**Resolution Strategy:**
- Keep all unique imports
- Ensure all routes are registered
- Preserve ETL manager initialization

### 4. src/routes/transactions.ts
**Common Issues:**
- New endpoint conflicts
- Validation logic differences
- Import conflicts

**Resolution Strategy:**
- Keep all unique endpoints
- Merge validation logic
- Preserve all required imports

## Quick Resolution Commands

### Option 1: Keep Our Changes (if your branch has priority)
```bash
git checkout --ours README.md package.json package-lock.json src/index.ts src/routes/transactions.ts
git add README.md package.json package-lock.json src/index.ts src/routes/transactions.ts
git commit
```

### Option 2: Keep Their Changes (if upstream has priority)
```bash
git checkout --theirs README.md package.json package-lock.json src/index.ts src/routes/transactions.ts
git add README.md package.json package-lock.json src/index.ts src/routes/transactions.ts
git commit
```

### Option 3: Manual Resolution (Recommended)
```bash
# Use VS Code's merge conflict editor
code .

# Or use git diff to see conflicts
git diff

# After resolving conflicts:
git add README.md package.json package-lock.json src/index.ts src/routes/transactions.ts
git commit
```

## Resolution Scripts

### Windows
```bash
resolve-conflicts.bat
```

### Linux/Mac
```bash
chmod +x resolve-conflicts.sh
./resolve-conflicts.sh
```

## Specific Conflict Patterns

### Package Dependencies
```json
// Keep this structure
{
  "dependencies": {
    // Merge all dependencies here
    "express": "^4.21.0",
    "stellar-sdk": "^12.2.0",
    // Add any new dependencies from both branches
  },
  "scripts": {
    // Combine all scripts
    "dev": "...",
    "test": "...",
    // Add any new scripts
  }
}
```

### Route Registration
```typescript
// Keep this order
app.use('/api/health', healthRouter)
app.use('/api/vaults', vaultsRouter)
app.use('/api/transactions', transactionsRouter)
```

### Import Statements
```typescript
// Merge all imports
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import dotenv from 'dotenv'
// Add any new imports from both branches
```

## After Resolution

1. **Test the system:**
```bash
npm run build
npm test
```

2. **Verify functionality:**
```bash
npm run dev
curl http://localhost:3000/api/health
```

3. **Push resolved changes:**
```bash
git push origin main
```

## Prevention Tips

- Pull latest changes before starting work: `git pull origin main`
- Create feature branches for new work
- Commit frequently with clear messages
- Use `npm install` after package.json changes to regenerate package-lock.json

## Need Help?

If conflicts persist after trying these solutions:
1. Share the specific conflict content
2. Run `git diff` and share the output
3. Use the resolution scripts for automated checking
