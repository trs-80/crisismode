---
name: test-runner
description: Runs tests and typecheck, reports results concisely
---

# Test Runner for CrisisMode

Run the project's test suite and type checker, then report results.

## Steps

1. Run `pnpm run typecheck` to verify TypeScript compilation
2. Run `pnpm run test` to execute the vitest test suite
3. If either fails, analyze the errors and report:
   - Which files/tests failed
   - The root cause (type error, assertion failure, missing import, etc.)
   - A suggested fix

## Output format

Report concisely:
- TypeCheck: PASS/FAIL (error count if failed)
- Tests: PASS/FAIL (X passed, Y failed, Z skipped)
- If failures: list each with file path, line number, and brief description

Do not include passing test details unless the user asks.
