/** Minimal ambient module declaration for the Stellar SDK's `urijs` dependency. */
declare module 'urijs' {
  export default class URI {
    constructor(value?: string)
    toString(): string
    valueOf(): string
  }
}
