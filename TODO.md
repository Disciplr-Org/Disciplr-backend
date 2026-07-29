# Fix: toPublicVault throws on real DB vault rows

## Steps

- [x] Step 0: Analyze issue and gather context (completed)
- [x] Step 1: Confirm plan with user (completed)
- [x] Step 2: Update `src/utils/mappers.ts` — fix `toPublicVault` to read DB column names (`creator`, `end_date`)
- [x] Step 3: Update `src/tests/mappers.test.ts` — fix `makeVault` fixture and assertions to match DB row shape
- [x] Step 4: Update `src/tests/enterpriseExposure.test.ts` — fix mock vault to use DB row shape
- [ ] Step 5: Run tests to verify the fix (blocked — npm install in progress)

**Note:** `npm install` is still running in the terminal. Once it completes, run:
```
cd c:/Users/dj/Documents/Revora-Contract/Disciplr-backend; npm test
```
to verify the changes.
