# Diagnosis eval — 2026-07-04 baseline

First run of the repeatable diagnosis eval (`pnpm run eval:diagnosis`), which
drives the sre-incident-agent-skills 14-family compatibility benchmark against
the **real** `crisismode bundle respond -` CLI (not the fixture shim the
benchmark's own 14/14 headline refers to).

## Headline

| Run | Score |
|---|---|
| No API key (abstention baseline) | 0/14 |
| AI, retired model `claude-sonnet-4-20250514` | **0/14** |
| AI, after migrating to `claude-sonnet-5` | **7/14** |

**The eval's first run caught a real outage:** the AI model hardcoded in seven
call sites was retired on 2026-06-15, so every AI diagnosis had silently
degraded to heuristics/abstention for ~3 weeks (the 404 was logged to stderr
but nothing surfaced it). Model selection is now centralized in
`src/framework/ai-model.ts` with a `CRISISMODE_AI_MODEL` override.

## Per-family results (claude-sonnet-5)

| Family | Result | Classification |
|---|---|---|
| PG connection-pool exhaustion | ✅ | |
| PG replication lag | ✅ | |
| Redis memory pressure | ✅ | |
| Kafka consumer lag | ✅ | |
| etcd consensus | ✅ | |
| Ceph storage degradation | ✅ | |
| Config drift | ✅ | |
| Queue backlog | ❌ | **Phrasing** — said "worker queue backlog", judge wants "work queue saturation"; diagnosis semantically correct |
| Kubernetes crash loop | ❌ | **Phrasing** — said "causing checkout failures", judge wants "causing checkout availability loss" |
| AI provider failover | ❌ | **Phrasing** — said "openai provider rate limiting" (more specific), judge wants "ai provider degradation" |
| DB migration | ❌ | **Phrasing** — said "migration lock contention is causing checkout failures", judge wants "stuck database migration is blocking checkout database operations" |
| Flink checkpoint | ❌ | **Real miss** — inverted causality: said backpressure causes checkpoint failures; expected checkpoint failures cause backpressure |
| Deploy rollback | ❌ | **Real miss** — misdiagnosed as config drift and stated a forbidden hypothesis (false attribution) |
| Ambiguous → abstention | ❌ | **Product gap** — abstained correctly with the exact expected hypothesis, but cited 0 evidence refs; the case requires 2 causal citations. Abstentions should cite the evidence they examined. |

## Reading the score honestly

- **Real diagnostic quality ≈ 11–12/14.** Four of the seven failures are
  substring-judge phrasing artifacts where the diagnosis was semantically
  correct (sometimes more specific than the canonical phrasing).
- **Two genuine diagnostic errors** worth fixing: Flink causal-direction
  inversion, and deploy-regression vs config-drift confusion (adjacent
  families that share symptoms).
- **One genuine product gap**: abstention responses emit no
  `evidence_refs` — they should cite the conflicting evidence that motivated
  abstention.
- The system prompt still contains the copy-canonical-phrasing instruction
  (`evidence-bundle-respond.ts`); claude-sonnet-5 follows it less literally
  than the old model. Improving the score by hard-coding more canonical
  phrasings would be benchmark gaming; improving it by fixing the causal
  ordering and family confusion would be real.

## Reproducing

```bash
pnpm run build:bundle
pnpm run eval:diagnosis            # AI run (needs ANTHROPIC_API_KEY)
pnpm run eval:diagnosis -- --no-ai # abstention baseline
```

Requires the sre-incident-agent-skills checkout as a sibling directory (or
`SRE_SKILLS_REPO=...`) with its Python package importable. Reports land in
`eval/reports/` (gitignored); commit a summary here when the score moves.
