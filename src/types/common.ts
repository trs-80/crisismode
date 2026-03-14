export type RiskLevel = 'routine' | 'elevated' | 'high' | 'critical';

export type TrustLevel = 'observe' | 'copilot' | 'autopilot' | 'full_autonomy';

export type CapturePolicy = 'required' | 'best_effort' | 'deferred';

export type CaptureCost = 'negligible' | 'moderate' | 'expensive';

export type CaptureType =
  | 'sql_query'
  | 'file_snapshot'
  | 'command_output'
  | 'api_snapshot'
  | 'filesystem_snapshot'
  | 'custom';

export type CascadeRisk = 'none' | 'low' | 'medium' | 'high';

export type Urgency = 'low' | 'medium' | 'high' | 'critical';

export type TimeoutAction = 'escalate' | 'abort' | 'skip' | 'pause';

export interface CheckExpression {
  type: string;
  statement?: string;
  operation?: string;
  parameters?: Record<string, unknown>;
  expect: {
    operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte';
    value: unknown;
  };
}

export interface Command {
  type: 'sql' | 'structured_command' | 'kubernetes_api' | 'api_call' | 'configuration_change';
  subtype?: string;
  statement?: string;
  operation?: string;
  parameters?: Record<string, unknown>;
}

export interface BlastRadius {
  directComponents: string[];
  indirectComponents: string[];
  maxImpact: string;
  cascadeRisk: CascadeRisk;
}

export interface CaptureDirective {
  name: string;
  captureType: CaptureType;
  statement?: string;
  targets?: string[];
  captureCost: CaptureCost;
  capturePolicy: CapturePolicy;
  retention?: string;
  format?: string;
  availableTo?: string;
}

export interface RetryPolicy {
  maxRetries: number;
  retryable: boolean;
}

export interface RollbackDirective {
  type: 'automatic' | 'manual' | 'command';
  description: string;
  estimatedDuration?: string;
  command?: Command;
}

export interface Recipient {
  role: string;
  urgency: Urgency;
}

export interface Approver {
  role: string;
  required: boolean;
}

export interface PreCondition {
  description: string;
  check: CheckExpression;
}

export interface SuccessCriteria {
  description: string;
  check: CheckExpression;
}

export interface StatePreservation {
  before: CaptureDirective[];
  after: CaptureDirective[];
}
