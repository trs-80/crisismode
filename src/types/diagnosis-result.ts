export interface DiagnosisResult {
  status: 'identified' | 'partial' | 'inconclusive' | 'unable';
  scenario: string | null;
  confidence: number;
  findings: DiagnosisFinding[];
  diagnosticPlanNeeded: boolean;
}

export interface DiagnosisFinding {
  source: string;
  observation: string;
  severity: 'info' | 'warning' | 'critical';
  data?: Record<string, unknown>;
}
