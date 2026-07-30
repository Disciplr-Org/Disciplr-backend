import { isValidTransition, ALLOWED_TRANSITIONS } from './vaultTransitions';
import fc from 'fast-check';

type TerminalStatus = 'completed' | 'failed' | 'cancelled';

describe('vaultTransitions property tests', () => {
  const states = Object.keys(ALLOWED_TRANSITIONS) as (keyof typeof ALLOWED_TRANSITIONS)[];
  const terminals: TerminalStatus[] = ['completed', 'failed', 'cancelled'];

  test('isValidTransition matches allowed transitions list', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...states),
        fc.constantFrom(...terminals),
        (from, to) => {
          const expected = ALLOWED_TRANSITIONS[from].includes(to);
          return isValidTransition(from, to) === expected;
        }
      )
    );
  });
});
