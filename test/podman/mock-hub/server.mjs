// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

// Mock Hub API — minimal HTTP server that simulates the CrisisMode hub
// for spoke testing. No dependencies required (runs on Node built-in http).

import { createServer } from 'node:http';

const PORT = 8080;
const spokes = new Map();
const forensicRecords = [];
let requestCount = 0;

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function log(method, path, status) {
  console.log(`[${new Date().toISOString()}] ${method} ${path} → ${status}`);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}

const routes = {
  // Spoke bootstrap — returns mock identity
  'POST /api/v1/spoke/bootstrap': async (req, res) => {
    const body = await readBody(req);
    const spokeId = `spoke-${Date.now()}`;
    spokes.set(spokeId, {
      id: spokeId,
      bootstrapToken: body.token,
      enrolledAt: new Date().toISOString(),
      status: 'active',
    });
    json(res, 200, {
      spoke_id: spokeId,
      identity: {
        type: 'mtls',
        certificate: '-----BEGIN CERTIFICATE-----\nMOCK_CERT\n-----END CERTIFICATE-----',
        key: '-----BEGIN PRIVATE KEY-----\nMOCK_KEY\n-----END PRIVATE KEY-----',
        ca: '-----BEGIN CERTIFICATE-----\nMOCK_CA\n-----END CERTIFICATE-----',
        expires_at: new Date(Date.now() + 90 * 86400000).toISOString(),
      },
      environment: {
        id: body.environment_id || 'env-test-001',
        name: 'test-cluster',
      },
    });
  },

  // Heartbeat
  'POST /api/v1/spoke/heartbeat': async (req, res) => {
    const body = await readBody(req);
    json(res, 200, {
      ack: true,
      hub_time: new Date().toISOString(),
      spoke_id: body.spoke_id,
    });
  },

  // Trigger ingress — accepts alert, returns mock plan assignment
  'POST /api/v1/triggers': async (req, res) => {
    const body = await readBody(req);
    json(res, 200, {
      trigger_id: `trigger-${Date.now()}`,
      matched_agent: 'pg-replication-recovery',
      matched_scenario: 'replication_lag_cascade',
      catalog_covered: true,
      plan_assignment: {
        status: 'assigned',
        execution_mode: 'copilot',
      },
    });
  },

  // Forensic record submission
  'POST /api/v1/forensics': async (req, res) => {
    const body = await readBody(req);
    forensicRecords.push({
      received_at: new Date().toISOString(),
      ...body,
    });
    console.log(`  📋 Forensic record received: ${body.execution_id || 'unknown'} — ${body.summary?.outcome || 'unknown'}`);
    json(res, 200, {
      ack: true,
      record_id: `fr-${Date.now()}`,
    });
  },

  // Cached policies
  'GET /api/v1/policies': async (_req, res) => {
    json(res, 200, {
      revision: 1,
      timestamp: new Date().toISOString(),
      policies: {
        approval_required_above: 'elevated',
        max_risk_level: 'high',
        auto_execute_scenarios: ['replication_lag_cascade'],
        shell_commands_allowed: false,
        max_concurrent_plans: 5,
        staleness_thresholds: {
          warning_seconds: 3600,
          degraded_seconds: 86400,
          lockout_seconds: 604800,
        },
      },
    });
  },

  // Approval response (simulate auto-approve)
  'POST /api/v1/approvals': async (req, res) => {
    const body = await readBody(req);
    json(res, 200, {
      approval_id: `approval-${Date.now()}`,
      decision: 'approved',
      decided_by: 'mock-hub-auto',
      decided_at: new Date().toISOString(),
      step_id: body.step_id,
    });
  },

  // List forensic records (for inspection)
  'GET /api/v1/forensics': async (_req, res) => {
    json(res, 200, {
      count: forensicRecords.length,
      records: forensicRecords.slice(-20),
    });
  },

  // List enrolled spokes (for inspection)
  'GET /api/v1/spokes': async (_req, res) => {
    json(res, 200, {
      count: spokes.size,
      spokes: [...spokes.values()],
    });
  },

  // Health check
  'GET /health': async (_req, res) => {
    json(res, 200, {
      status: 'ok',
      uptime: process.uptime(),
      requests: requestCount,
      spokes: spokes.size,
      forensicRecords: forensicRecords.length,
    });
  },
};

const server = createServer(async (req, res) => {
  requestCount++;
  const key = `${req.method} ${req.url?.split('?')[0]}`;

  if (routes[key]) {
    try {
      await routes[key](req, res);
      log(req.method, req.url, res.statusCode);
    } catch (err) {
      console.error(`Error handling ${key}:`, err);
      json(res, 500, { error: err.message });
    }
  } else {
    log(req.method, req.url, 404);
    json(res, 404, { error: 'not found', available: Object.keys(routes) });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🏢 Mock Hub API listening on :${PORT}`);
  console.log(`   Routes: ${Object.keys(routes).join(', ')}`);
});
