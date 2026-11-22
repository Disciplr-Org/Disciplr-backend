// NodeNext resolves `import '../shared/vaultMachine.mjs'` against this sibling
// declaration file. The declarations live in vaultMachine.d.ts (also used by
// editors and Jest's ts-jest config), so re-export them here instead of
// keeping two copies in sync.
export * from './vaultMachine.js';
