// Plain stub — no jest.fn() since this runs before the jest environment is set up
export const hash = async (_plain: string) => '$argon2id$mock'
export const verify = async (_hash: string, _plain: string) => true
export const argon2id = 2
const argon2 = { hash, verify, argon2id }
export default argon2
