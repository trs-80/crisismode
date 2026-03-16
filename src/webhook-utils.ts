// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

export interface AlertManagerAlert {
  status: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  startsAt: string;
  endsAt: string;
  generatorURL?: string;
}

export interface AlertManagerPayload {
  version: string;
  status: string;
  alerts: AlertManagerAlert[];
}

export function validateAlertPayload(body: unknown): body is AlertManagerPayload {
  if (typeof body !== 'object' || body === null) return false;
  const obj = body as Record<string, unknown>;
  if (typeof obj.version !== 'string' || typeof obj.status !== 'string') return false;
  if (!Array.isArray(obj.alerts)) return false;

  return obj.alerts.every((alert) => validateAlert(alert));
}

export function getFiringAlerts(payload: AlertManagerPayload): AlertManagerAlert[] {
  return payload.alerts.filter((alert) => alert.status === 'firing');
}

function validateAlert(alert: unknown): alert is AlertManagerAlert {
  if (typeof alert !== 'object' || alert === null) return false;
  const obj = alert as Record<string, unknown>;

  return typeof obj.status === 'string'
    && typeof obj.labels === 'object'
    && obj.labels !== null
    && typeof obj.annotations === 'object'
    && obj.annotations !== null
    && typeof obj.startsAt === 'string'
    && typeof obj.endsAt === 'string';
}
