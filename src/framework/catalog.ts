// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Pre-authorized action catalogs.
 *
 * A catalog entry is a standing, human-granted approval: "for this agent, this
 * scenario, in this environment, up to this risk level, you may act without
 * asking again." Because it removes a human from the loop, every criterion the
 * entry declares is enforced here, and the whole mechanism fails closed:
 *
 *  - no configured catalog source  -> nothing is pre-authorized
 *  - entry not in the operator's `preAuthorizedCatalogs` -> not applied
 *  - expired, unparseable, or unevaluable criterion -> not applied
 *
 * There is deliberately no built-in catalog entry. Catalogs come from a
 * configured source (`configureCatalogSource`) — real config or the hub. The
 * demo installs its own illustrative fixture (`src/demo/catalog-fixture.ts`).
 */

import semver from 'semver';
import type { CatalogEntry } from '../types/catalog-entry.js';
import type { RecoveryPlan } from '../types/recovery-plan.js';
import type { Command, RiskLevel } from '../types/common.js';
import type { RecoveryStep } from '../types/step-types.js';
import { derivePlanMaxRiskLevel, riskExceeds } from './risk.js';

/** Everything `matchCatalog` needs beyond the plan itself. */
export interface CatalogMatchInput {
  /**
   * Catalog ids the operator explicitly pre-authorized for this run
   * (`AgentContext.preAuthorizedCatalogs`). An entry not listed here is never
   * applied, however well it matches.
   */
  preAuthorizedCatalogs: readonly string[];
  /**
   * Deployment environment this plan will run against. Undefined means
   * "unknown", which fails closed against any entry that declares one.
   */
  environment?: string | undefined;
  /** Evaluation time; defaults to now. Injectable for tests. */
  now?: Date | undefined;
}

export interface CatalogMatchResult {
  matched: boolean;
  catalogEntry: CatalogEntry | null;
  coveredRiskLevels: RiskLevel[];
  matchDetails: string[];
}

const NO_MATCH_INPUT: CatalogMatchInput = { preAuthorizedCatalogs: [] };

/**
 * The catalog entries in force for this process.
 *
 * Single-writer by contract: install the source once at process start, before
 * any recovery runs, and do not mutate it afterwards. `matchCatalog` reads this
 * global at call time, so a `configureCatalogSource` or `clearCatalogSource`
 * call made while a recovery is in flight changes the standing approvals that
 * recovery is executing under — the webhook receiver in particular serves
 * overlapping HTTP requests, so two alerts can be mid-plan at once. If catalogs
 * ever need to refresh at runtime (a hub push, a config reload), take an
 * immutable snapshot and pass it through `CatalogMatchInput` rather than
 * rewriting this global.
 */
let configuredCatalogs: CatalogEntry[] = [];

/**
 * Install the catalog entries in force for this process. Until this is called
 * with a non-empty list, nothing is pre-authorized. Call once at startup; see
 * the single-writer note on `configuredCatalogs`.
 */
export function configureCatalogSource(entries: readonly CatalogEntry[]): void {
  configuredCatalogs = [...entries];
}

/** Remove all configured catalog entries (fail-closed default state). */
export function clearCatalogSource(): void {
  configuredCatalogs = [];
}

/**
 * The first configured catalog entry, or null when no catalog source has been
 * configured. Returns null on the production path by design — there is no
 * built-in standing approval.
 */
export function getCatalogEntry(): CatalogEntry | null {
  return configuredCatalogs[0] ?? null;
}

export function matchCatalog(
  plan: RecoveryPlan,
  input: CatalogMatchInput = NO_MATCH_INPUT,
): CatalogMatchResult {
  const entries = configuredCatalogs;
  if (entries.length === 0) {
    return {
      matched: false,
      catalogEntry: null,
      coveredRiskLevels: [],
      matchDetails: [
        'No pre-authorized catalog source is configured; every approval must be granted by a human.',
      ],
    };
  }

  const details: string[] = [];
  for (const entry of entries) {
    const evaluation = evaluateEntry(entry, plan, input);
    details.push(...evaluation.details);
    if (evaluation.failures.length === 0) {
      const covered = coveredLevelsFor(entry);
      details.push(
        `Catalog '${entry.metadata.catalogId}' matched; covers ${covered.join(', ') || 'no'} risk levels.`,
      );
      return {
        matched: true,
        catalogEntry: entry,
        coveredRiskLevels: covered,
        matchDetails: details,
      };
    }
  }

  return { matched: false, catalogEntry: null, coveredRiskLevels: [], matchDetails: details };
}

export function isCatalogCovered(riskLevel: RiskLevel, coveredLevels: RiskLevel[]): boolean {
  return coveredLevels.includes(riskLevel);
}

// --- Criterion evaluation -------------------------------------------------

interface EntryEvaluation {
  details: string[];
  failures: string[];
}

function evaluateEntry(
  entry: CatalogEntry,
  plan: RecoveryPlan,
  input: CatalogMatchInput,
): EntryEvaluation {
  const id = entry.metadata.catalogId;
  const criteria = entry.matchCriteria;
  const details: string[] = [];
  const failures: string[] = [];

  const reject = (reason: string): void => {
    failures.push(reason);
    details.push(`Catalog '${id}' rejected: ${reason}`);
  };
  const accept = (note: string): void => {
    details.push(`Catalog '${id}': ${note}`);
  };

  // 1. Operator consent — the catalog only applies if the operator authorized it.
  if (!input.preAuthorizedCatalogs.includes(id)) {
    reject(
      `catalog '${id}' is not pre-authorized by the operator (context.preAuthorizedCatalogs)`,
    );
  } else {
    accept('operator pre-authorized this catalog');
  }

  // 2. Expiry — an expired standing approval approves nothing.
  const now = input.now ?? new Date();
  const expiresAt = Date.parse(entry.metadata.expiresAt);
  if (Number.isNaN(expiresAt)) {
    reject(`catalog '${id}' has an unparseable expiresAt '${entry.metadata.expiresAt}'`);
  } else if (expiresAt <= now.getTime()) {
    reject(
      `catalog approval expired at ${entry.metadata.expiresAt} (evaluated ${now.toISOString()}); re-approval is required`,
    );
  } else {
    accept(`approval is unexpired (expires ${entry.metadata.expiresAt})`);
  }

  // 3. Agent name.
  if (plan.metadata.agentName !== criteria.agentName) {
    reject(
      `plan agent name '${plan.metadata.agentName}' does not match catalog agentName '${criteria.agentName}'`,
    );
  } else {
    accept(`agent name matches (${criteria.agentName})`);
  }

  // 4. Scenario.
  if (plan.metadata.scenario !== criteria.scenario) {
    reject(
      `plan scenario '${plan.metadata.scenario}' does not match catalog scenario '${criteria.scenario}'`,
    );
  } else {
    accept(`scenario matches (${criteria.scenario})`);
  }

  // 5. Environment.
  if (input.environment === undefined) {
    reject(
      `the deployment environment is unknown, and this catalog is only approved for environment '${criteria.environment}'`,
    );
  } else if (input.environment !== criteria.environment) {
    reject(
      `environment '${input.environment}' does not match the approved environment '${criteria.environment}'`,
    );
  } else {
    accept(`environment matches (${criteria.environment})`);
  }

  // 6. Agent version constraint.
  if (!semver.valid(plan.metadata.agentVersion)) {
    reject(
      `plan agent version '${plan.metadata.agentVersion}' is not a valid semantic version, so agentVersionConstraint '${criteria.agentVersionConstraint}' cannot be evaluated`,
    );
  } else if (!semver.validRange(criteria.agentVersionConstraint)) {
    reject(
      `catalog agentVersionConstraint '${criteria.agentVersionConstraint}' is not a valid semver range`,
    );
  } else if (semver.prerelease(plan.metadata.agentVersion) !== null) {
    // semver ranges exclude prereleases by default, so this would otherwise be
    // rejected with a message that reads like a version-range mismatch. Say the
    // real reason instead: standing approvals are granted to released builds.
    reject(
      `plan agent version '${plan.metadata.agentVersion}' is a prerelease build; a standing catalog approval is only granted to released agent versions`,
    );
  } else if (!semver.satisfies(plan.metadata.agentVersion, criteria.agentVersionConstraint)) {
    reject(
      `plan agent version '${plan.metadata.agentVersion}' does not satisfy agentVersionConstraint '${criteria.agentVersionConstraint}'`,
    );
  } else {
    accept(`agent version ${plan.metadata.agentVersion} satisfies ${criteria.agentVersionConstraint}`);
  }

  // 7. Max risk level.
  const planRisk = derivePlanMaxRiskLevel(plan);
  if (riskExceeds(planRisk, criteria.maxRiskLevel)) {
    reject(
      `plan risk level '${planRisk}' exceeds catalog maxRiskLevel '${criteria.maxRiskLevel}'`,
    );
  } else {
    accept(`plan risk level '${planRisk}' is within maxRiskLevel '${criteria.maxRiskLevel}'`);
  }

  // 8. Step count.
  if (plan.steps.length > criteria.maxStepCount) {
    reject(`plan step count ${plan.steps.length} exceeds maxStepCount ${criteria.maxStepCount}`);
  } else {
    accept(`step count ${plan.steps.length} is within maxStepCount ${criteria.maxStepCount}`);
  }

  // 9. Required step patterns, including their declared positions.
  const patternReasons = evaluateStepPatterns(plan, criteria.requiredStepPatterns);
  for (const reason of patternReasons) reject(reason);
  if (patternReasons.length === 0 && criteria.requiredStepPatterns.length > 0) {
    accept(
      `required step patterns satisfied (${criteria.requiredStepPatterns.map((p) => p.type).join(', ')})`,
    );
  }

  // 10. Forbidden operations, checked against the actual step commands.
  const forbiddenReasons = evaluateForbiddenOperations(plan, criteria.forbiddenOperations);
  for (const reason of forbiddenReasons) reject(reason);
  if (forbiddenReasons.length === 0 && criteria.forbiddenOperations.length > 0) {
    accept(
      `no step performs a forbidden operation (${criteria.forbiddenOperations.join(', ')})`,
    );
  }

  // 11. Estimated duration.
  const maxSeconds = parseIsoDurationSeconds(criteria.maxEstimatedDuration);
  const planSeconds = parseIsoDurationSeconds(plan.metadata.estimatedDuration);
  if (maxSeconds === null) {
    reject(
      `catalog maxEstimatedDuration '${criteria.maxEstimatedDuration}' is not a parseable ISO-8601 duration`,
    );
  } else if (planSeconds === null) {
    reject(
      `plan estimated duration '${plan.metadata.estimatedDuration}' is not a parseable ISO-8601 duration, so maxEstimatedDuration '${criteria.maxEstimatedDuration}' cannot be enforced`,
    );
  } else if (planSeconds > maxSeconds) {
    reject(
      `plan estimated duration '${plan.metadata.estimatedDuration}' exceeds maxEstimatedDuration '${criteria.maxEstimatedDuration}'`,
    );
  } else {
    accept(
      `estimated duration ${plan.metadata.estimatedDuration} is within ${criteria.maxEstimatedDuration}`,
    );
  }

  return { details, failures };
}

/** Risk levels the entry grants, capped at its own declared maxRiskLevel. */
function coveredLevelsFor(entry: CatalogEntry): RiskLevel[] {
  return entry.authorization.satisfiesApprovalFor.filter(
    (level) => !riskExceeds(level, entry.matchCriteria.maxRiskLevel),
  );
}

// --- Step pattern evaluation ----------------------------------------------

interface FlatStep {
  index: number;
  step: RecoveryStep;
}

/**
 * Flatten conditional branches, keeping the position of the owning top-level
 * step so `before_first_mutation` can still be evaluated.
 *
 * Recurses: nested conditionals are not representable in `NonConditionalStep`
 * and the validator rejects them, but `matchCatalog` is a public entry point
 * that can be handed a plan which never went through the validator (a
 * playbook, a third-party plugin), and a forbidden command must not hide one
 * level deeper than the traversal looks. `walkSteps` in `step-walker.ts` is
 * deliberately not reused here: it descends only one level and carries no step
 * index, so it cannot answer either question this function is asked.
 */
function flattenSteps(steps: RecoveryStep[]): FlatStep[] {
  const flat: FlatStep[] = [];
  const visit = (step: RecoveryStep, index: number): void => {
    flat.push({ index, step });
    if (step.type === 'conditional') {
      visit(step.thenStep, index);
      if (step.elseStep !== 'skip') visit(step.elseStep, index);
    }
  };
  steps.forEach((step, index) => visit(step, index));
  return flat;
}

function evaluateStepPatterns(
  plan: RecoveryPlan,
  patterns: CatalogEntry['matchCriteria']['requiredStepPatterns'],
): string[] {
  const flat = flattenSteps(plan.steps);
  const mutations = flat.filter((f) => f.step.type === 'system_action');
  const firstMutationIndex = mutations.length > 0 ? mutations[0]!.index : null;
  const reasons: string[] = [];

  for (const pattern of patterns) {
    const matches = flat.filter((f) => f.step.type === pattern.type);
    if (matches.length === 0) {
      reasons.push(`plan is missing required step pattern '${pattern.type}'`);
      continue;
    }
    if (pattern.position === 'any') continue;
    if (pattern.position === 'before_first_mutation') {
      if (firstMutationIndex === null) continue;
      if (!matches.some((f) => f.index < firstMutationIndex)) {
        reasons.push(
          `required step pattern '${pattern.type}' must appear before_first_mutation, but the first '${pattern.type}' step is at index ${matches[0]!.index} and the first mutating step is at index ${firstMutationIndex}`,
        );
      }
      continue;
    }
    // An unrecognized position is a criterion we cannot enforce — fail closed.
    reasons.push(
      `required step pattern '${pattern.type}' declares unsupported position '${pattern.position}', which cannot be enforced`,
    );
  }

  return reasons;
}

// --- Forbidden operation evaluation ---------------------------------------

const ADMIN_PRIVILEGE_SQL =
  /^(?:grant|revoke|reassign\s+owned|set\s+role|(?:create|alter|drop)\s+(?:role|user|group)\b)/i;
const DDL_SQL =
  /^(?:create|alter|drop|truncate|rename|comment\s+on|refresh\s+materialized)\b/i;

const SQL_COMMENT = /--[^\n]*|\/\*[\s\S]*?\*\//g;

/**
 * Split a command into the statements it would execute.
 *
 * PostgreSQL's simple query protocol runs every `;`-separated statement in one
 * string, so classifying only the leading verb would let `SELECT 1; DROP TABLE
 * orders` through. Comments are stripped first so a leading `-- note` or
 * `/* note *\/` cannot hide the verb either.
 *
 * This is a conservative classifier, not a SQL parser: a `;` inside a string
 * literal or a dollar-quoted body splits wrongly, which produces extra
 * fragments and therefore extra classification. It errs toward classifying a
 * statement as forbidden rather than missing one — the right direction for a
 * check that gates standing approvals.
 */
function splitStatements(statement: string): string[] {
  return statement
    .replace(SQL_COMMENT, ' ')
    .split(';')
    .map((fragment) => fragment.trim())
    .filter((fragment) => fragment.length > 0);
}

/**
 * Operation classes a command performs, used to test `forbiddenOperations`.
 *
 * Classes are tested independently, never `else if`: `CREATE ROLE recovery_bot`
 * is both DDL and a privilege change, and a catalog forbidding only one of the
 * two must still reject it.
 */
function classifyCommand(command: Command): Set<string> {
  const classes = new Set<string>();
  if (command.subtype) classes.add(command.subtype.trim().toLowerCase());
  if (command.operation) classes.add(command.operation.trim().toLowerCase());
  const statement = command.statement;
  if (statement) {
    for (const fragment of splitStatements(statement)) {
      if (ADMIN_PRIVILEGE_SQL.test(fragment)) classes.add('admin_privilege');
      if (DDL_SQL.test(fragment)) classes.add('ddl');
    }
  }
  return classes;
}

function commandOf(step: RecoveryStep): Command | null {
  if (step.type === 'system_action' || step.type === 'diagnosis_action') return step.command;
  return null;
}

function evaluateForbiddenOperations(plan: RecoveryPlan, forbidden: string[]): string[] {
  if (forbidden.length === 0) return [];
  const normalized = forbidden.map((op) => op.trim().toLowerCase());
  const reasons: string[] = [];

  for (const { step } of flattenSteps(plan.steps)) {
    const command = commandOf(step);
    if (!command) continue;
    const classes = classifyCommand(command);
    for (const op of normalized) {
      if (classes.has(op)) {
        reasons.push(
          `step '${step.stepId}' performs forbidden operation '${op}' (${describeCommand(command)})`,
        );
      }
    }
  }

  return reasons;
}

function describeCommand(command: Command): string {
  if (command.statement) return `${command.type}: ${command.statement.trim().slice(0, 80)}`;
  if (command.operation) return `${command.type}: ${command.operation}`;
  return command.type;
}

// --- ISO-8601 duration ----------------------------------------------------

const ISO_DURATION =
  /^P(?!$)(?:(\d+)W)?(?:(\d+)D)?(?:T(?!$)(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i;

/**
 * Parse the ISO-8601 durations this framework emits (weeks/days/hours/minutes/
 * seconds). Years and months are calendar-ambiguous and are rejected rather
 * than guessed. Returns null when the value cannot be parsed.
 */
function parseIsoDurationSeconds(value: string): number | null {
  const match = ISO_DURATION.exec(value.trim());
  if (!match) return null;
  const [, weeks, days, hours, minutes, seconds] = match;
  if (!weeks && !days && !hours && !minutes && !seconds) return null;
  return (
    Number(weeks ?? 0) * 604800 +
    Number(days ?? 0) * 86400 +
    Number(hours ?? 0) * 3600 +
    Number(minutes ?? 0) * 60 +
    Number(seconds ?? 0)
  );
}
