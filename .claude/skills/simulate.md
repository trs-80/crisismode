---
name: simulate
description: Run a crisis simulation scenario using an agent's simulator backend
user_invocable: true
---

# /simulate — Run a Crisis Simulation

The user wants to simulate a crisis recovery scenario. This skill walks through the full recovery lifecycle using simulator backends (no real infrastructure needed).

## Steps

1. **Identify the agent** — Ask which agent to simulate (e.g., `pg-replication`, `redis`), or list available agents from `src/agent/*/agent.ts`

2. **Set up the context** — Create an `AgentContext` with:
   - `mode: 'dry-run'` (default) or `mode: 'execute'` if the user wants the simulator to transition states
   - `correlationId` — generate a UUID
   - `triggeredBy` — `{ type: 'manual', operator: 'simulation' }`

3. **Run the lifecycle**:
   - Call `agent.diagnose(context)` — show the diagnosis findings (severity, affected components)
   - Call `agent.plan(context, diagnosis)` — show the recovery plan (steps, risk levels, rollback strategy)
   - Validate the plan using the validator from `src/framework/validator.ts`
   - Optionally execute the plan using `ExecutionEngine` from `src/framework/engine.ts`
   - If there's a replanning checkpoint, call `agent.replan()` and show the revised plan

4. **Show results** — Display:
   - Diagnosis summary
   - Plan validation result
   - Execution trace (if executed)
   - Forensic record (if available)

## Notes

- Use the simulator backend, never the live client
- The simulator's `transition()` method advances state (degraded → recovering → recovered)
- Format output clearly with step numbers and risk levels highlighted
- If the user provides a scenario name, match it to the agent's `failureScenarios` in its manifest
