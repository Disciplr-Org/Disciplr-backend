/** The Stellar SDK declarations reference `URI` as a global type. */
export {}

declare global {
  type URI = import('urijs').default
}
