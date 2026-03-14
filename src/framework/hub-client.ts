/**
 * HubClient — communicates with the hub API for spoke enrollment,
 * heartbeat, forensic record submission, and policy retrieval.
 */

export interface HubConfig {
  endpoint: string;
  spokeId?: string;
  bootstrapToken?: string;
}

interface HubResponse {
  [key: string]: unknown;
}

export class HubClient {
  private endpoint: string;
  private spokeId: string | null;

  constructor(private config: HubConfig) {
    this.endpoint = config.endpoint.replace(/\/+$/, '');
    this.spokeId = config.spokeId ?? null;
  }

  async bootstrap(environmentId: string): Promise<{
    spokeId: string;
    identity: { type: string; expiresAt: string };
  }> {
    const res = await this.post('/api/v1/spoke/bootstrap', {
      token: this.config.bootstrapToken,
      environment_id: environmentId,
    });
    this.spokeId = res.spoke_id as string;
    return {
      spokeId: this.spokeId,
      identity: res.identity as { type: string; expiresAt: string },
    };
  }

  async heartbeat(): Promise<void> {
    await this.post('/api/v1/spoke/heartbeat', {
      spoke_id: this.spokeId,
      timestamp: new Date().toISOString(),
    });
  }

  async submitForensicRecord(record: unknown): Promise<{ recordId: string }> {
    const res = await this.post('/api/v1/forensics', record);
    return { recordId: res.record_id as string };
  }

  async fetchPolicies(): Promise<{
    revision: number;
    policies: Record<string, unknown>;
  }> {
    const res = await this.get('/api/v1/policies');
    return {
      revision: res.revision as number,
      policies: res.policies as Record<string, unknown>,
    };
  }

  async requestApproval(stepId: string, presentation: unknown): Promise<{
    decision: string;
    decidedBy: string;
  }> {
    const res = await this.post('/api/v1/approvals', {
      spoke_id: this.spokeId,
      step_id: stepId,
      presentation,
    });
    return {
      decision: res.decision as string,
      decidedBy: res.decided_by as string,
    };
  }

  private async post(path: string, body: unknown): Promise<HubResponse> {
    const res = await fetch(`${this.endpoint}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Hub API error: ${res.status} ${res.statusText} on POST ${path}`);
    }
    return res.json() as Promise<HubResponse>;
  }

  private async get(path: string): Promise<HubResponse> {
    const res = await fetch(`${this.endpoint}${path}`);
    if (!res.ok) {
      throw new Error(`Hub API error: ${res.status} ${res.statusText} on GET ${path}`);
    }
    return res.json() as Promise<HubResponse>;
  }
}
