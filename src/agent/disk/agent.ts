// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { RecoveryAgent, ReplanResult } from '../interface.js';
import type { AgentContext } from '../../types/agent-context.js';
import type { DiagnosisResult } from '../../types/diagnosis-result.js';
import type { ExecutionState } from '../../types/execution-state.js';
import type { HealthAssessment, HealthSignal } from '../../types/health.js';
import type { RecoveryPlan } from '../../types/recovery-plan.js';
import type { RecoveryStep } from '../../types/step-types.js';
import { signalStatus, buildHealthAssessment } from '../../framework/health-helpers.js';
import { createPlanEnvelope } from '../../framework/plan-helpers.js';
import { defaultReplan } from '../interface.js';
import { diskManifest } from './manifest.js';
import type { DiskBackend, FilesystemUsage } from './backend.js';
import { DiskSimulator } from './simulator.js';

const CRITICAL_USAGE_PERCENT = 95;
const WARNING_USAGE_PERCENT = 85;
const CRITICAL_INODE_PERCENT = 95;
const WARNING_INODE_PERCENT = 85;

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

export class DiskExhaustionAgent implements RecoveryAgent {
  manifest = diskManifest;
  backend: DiskBackend;

  constructor(backend?: DiskBackend) {
    this.backend = backend ?? new DiskSimulator();
  }

  async assessHealth(_context: AgentContext): Promise<HealthAssessment> {
    const observedAt = new Date().toISOString();
    const filesystems = await this.backend.getDiskUsage();

    const criticalFs = filesystems.filter((fs) => fs.usagePercent >= CRITICAL_USAGE_PERCENT);
    const warningFs = filesystems.filter((fs) => fs.usagePercent >= WARNING_USAGE_PERCENT && fs.usagePercent < CRITICAL_USAGE_PERCENT);
    const criticalInodes = filesystems.filter((fs) => fs.inodeUsagePercent >= CRITICAL_INODE_PERCENT);
    const warningInodes = filesystems.filter((fs) => fs.inodeUsagePercent >= WARNING_INODE_PERCENT && fs.inodeUsagePercent < CRITICAL_INODE_PERCENT);

    const status = criticalFs.length > 0 || criticalInodes.length > 0
      ? 'unhealthy'
      : warningFs.length > 0 || warningInodes.length > 0
        ? 'recovering'
        : 'healthy';

    const signals: HealthSignal[] = [
      {
        source: 'disk_usage',
        status: signalStatus(criticalFs.length > 0, warningFs.length > 0),
        detail: filesystems
          .map((fs) => `${fs.mountPoint}: ${fs.usagePercent}% used (${formatBytes(fs.availableBytes)} free)`)
          .join('; '),
        observedAt,
      },
      {
        source: 'inode_usage',
        status: signalStatus(criticalInodes.length > 0, warningInodes.length > 0),
        detail: filesystems
          .filter((fs) => fs.totalInodes > 0)
          .map((fs) => `${fs.mountPoint}: ${fs.inodeUsagePercent}% inodes used (${(fs.totalInodes - fs.usedInodes).toLocaleString()} free)`)
          .join('; ') || 'No inode data available.',
        observedAt,
      },
    ];

    return buildHealthAssessment({
      status,
      signals,
      confidence: 0.98,
      summary: {
        healthy: 'Disk usage is healthy. All filesystems have sufficient free space and inodes.',
        recovering: 'Disk usage is elevated. One or more filesystems are approaching capacity.',
        unhealthy: 'Disk usage is critical. One or more filesystems are nearly full or have exhausted inodes.',
      },
      actions: {
        healthy: ['No action required. Continue monitoring disk usage trends.'],
        recovering: ['Investigate growing filesystems. Consider cleaning caches, rotating logs, or expanding storage.'],
        unhealthy: ['Immediately free disk space. Identify and remove large files, old logs, or unused packages.'],
      },
    });
  }

  async diagnose(_context: AgentContext): Promise<DiagnosisResult> {
    const [filesystems, logStatus] = await Promise.all([
      this.backend.getDiskUsage(),
      this.backend.getLogRotationStatus('/var/log'),
    ]);

    const criticalFs = filesystems.filter((fs) => fs.usagePercent >= CRITICAL_USAGE_PERCENT);
    const warningFs = filesystems.filter((fs) => fs.usagePercent >= WARNING_USAGE_PERCENT && fs.usagePercent < CRITICAL_USAGE_PERCENT);
    const criticalInodes = filesystems.filter((fs) => fs.inodeUsagePercent >= CRITICAL_INODE_PERCENT);
    const bootFull = filesystems.find((fs) => fs.mountPoint === '/boot' && fs.usagePercent >= CRITICAL_USAGE_PERCENT);
    const logDirBloated = logStatus.totalSizeBytes > 5 * 1024 * 1024 * 1024; // >5GB

    // Also scan for large files on the most full filesystem
    const worstFs = [...filesystems].sort((a, b) => b.usagePercent - a.usagePercent)[0];
    const largeEntries = worstFs
      ? await this.backend.getLargestEntries(worstFs.mountPoint, 10)
      : [];

    // Scenario classification — first match wins
    let scenario: string | null;
    let confidence: number;

    if (criticalFs.length > 0 && criticalFs.some((fs) => fs.usagePercent >= 99)) {
      scenario = 'disk_full';
      confidence = 0.98;
    } else if (bootFull) {
      scenario = 'boot_partition_full';
      confidence = 0.95;
    } else if (criticalInodes.length > 0) {
      scenario = 'inode_exhaustion';
      confidence = 0.95;
    } else if (logDirBloated && (criticalFs.length > 0 || warningFs.length > 0)) {
      scenario = 'log_directory_bloat';
      confidence = 0.92;
    } else if (criticalFs.length > 0 || warningFs.length > 0) {
      scenario = 'disk_nearly_full';
      confidence = 0.90;
    } else {
      scenario = null;
      confidence = 1.0;
    }

    return {
      status: scenario === null ? 'inconclusive' : 'identified',
      scenario,
      confidence,
      findings: [
        {
          source: 'filesystem_usage',
          observation: criticalFs.length > 0
            ? `${criticalFs.length} filesystem(s) critically full: ${criticalFs.map((fs) => `${fs.mountPoint} at ${fs.usagePercent}% (${formatBytes(fs.availableBytes)} free)`).join(', ')}.`
            : warningFs.length > 0
              ? `${warningFs.length} filesystem(s) approaching capacity: ${warningFs.map((fs) => `${fs.mountPoint} at ${fs.usagePercent}%`).join(', ')}.`
              : 'All filesystems have sufficient space.',
          severity: criticalFs.length > 0 ? 'critical' : warningFs.length > 0 ? 'warning' : 'info',
          data: { filesystems },
        },
        {
          source: 'inode_usage',
          observation: criticalInodes.length > 0
            ? `${criticalInodes.length} filesystem(s) with critical inode usage: ${criticalInodes.map((fs) => `${fs.mountPoint} at ${fs.inodeUsagePercent}% inodes`).join(', ')}.`
            : 'Inode usage is within normal limits.',
          severity: criticalInodes.length > 0 ? 'critical' : 'info',
          data: { criticalInodes },
        },
        {
          source: 'log_rotation',
          observation: `Log directory: ${formatBytes(logStatus.totalSizeBytes)}, ${logStatus.fileCount} files (${logStatus.compressedCount} compressed, ${logStatus.uncompressedCount} uncompressed).${logDirBloated ? ' Log directory is bloated (>5GB).' : ''}`,
          severity: logDirBloated ? 'warning' : 'info',
          data: { logStatus },
        },
        {
          source: 'large_entries',
          observation: largeEntries.length > 0
            ? `Largest entries on ${worstFs?.mountPoint ?? '/'}: ${largeEntries.slice(0, 5).map((e) => `${e.path} (${formatBytes(e.sizeBytes)})`).join(', ')}.`
            : 'No large entries found.',
          severity: largeEntries.some((e) => e.sizeBytes > 1024 * 1024 * 1024) ? 'warning' : 'info',
          data: { largeEntries },
        },
      ],
      diagnosticPlanNeeded: false,
    };
  }

  async plan(context: AgentContext, diagnosis: DiagnosisResult): Promise<RecoveryPlan> {
    const target = String(context.trigger.payload.instance || 'local-disk');
    const scenario = diagnosis.scenario ?? 'disk_nearly_full';

    const fsData = diagnosis.findings.find((f) => f.source === 'filesystem_usage')?.data as {
      filesystems: FilesystemUsage[];
    } | undefined;
    const criticalFs = fsData?.filesystems.filter((fs) => fs.usagePercent >= CRITICAL_USAGE_PERCENT) ?? [];

    const steps: RecoveryStep[] = [
      // Step 1: Capture full disk usage baseline
      {
        stepId: 'step-001',
        type: 'diagnosis_action',
        name: 'Capture disk usage baseline',
        executionContext: 'disk_read',
        target,
        command: {
          type: 'api_call',
          operation: 'check_disk_usage',
          parameters: {},
        },
        outputCapture: {
          name: 'disk_baseline',
          format: 'structured',
          availableTo: 'subsequent_steps',
        },
        timeout: 'PT30S',
      },
      // Step 2: Identify largest space consumers
      {
        stepId: 'step-002',
        type: 'diagnosis_action',
        name: 'Identify largest space consumers',
        executionContext: 'disk_read',
        target,
        command: {
          type: 'api_call',
          operation: 'find_large_entries',
          parameters: { path: criticalFs[0]?.mountPoint ?? '/', limit: 15 },
        },
        outputCapture: {
          name: 'large_entries',
          format: 'structured',
          availableTo: 'subsequent_steps',
        },
        timeout: 'PT60S',
      },
      // Step 3: Check log rotation status
      {
        stepId: 'step-003',
        type: 'diagnosis_action',
        name: 'Check log rotation health',
        executionContext: 'disk_read',
        target,
        command: {
          type: 'api_call',
          operation: 'check_log_rotation',
          parameters: { path: '/var/log' },
        },
        outputCapture: {
          name: 'log_rotation_status',
          format: 'structured',
          availableTo: 'subsequent_steps',
        },
        timeout: 'PT30S',
      },
      // Step 4: Notify on-call with actionable guidance
      {
        stepId: 'step-004',
        type: 'human_notification',
        name: 'Notify on-call with disk recovery guidance',
        recipients: [
          { role: 'on_call_engineer', urgency: scenario === 'disk_full' ? 'critical' : 'high' },
          { role: 'system_administrator', urgency: 'high' },
        ],
        message: {
          summary: `Disk ${scenario.replace(/_/g, ' ')} detected on ${target}`,
          detail: this.buildRecoveryGuidance(scenario, criticalFs),
          contextReferences: ['disk_baseline', 'large_entries', 'log_rotation_status'],
          actionRequired: true,
        },
        channel: 'auto',
      },
      // Step 5: Checkpoint — record state for audit
      {
        stepId: 'step-005',
        type: 'checkpoint',
        name: 'Record disk state for incident report',
        description: 'Capture detailed filesystem usage for audit trail and post-incident review.',
        stateCaptures: [
          {
            name: 'disk_state_snapshot',
            captureType: 'command_output',
            statement: 'check_disk_usage',
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
        ],
      },
      // Step 6: Conditional — severity-based follow-up
      {
        stepId: 'step-006',
        type: 'conditional',
        name: 'Route based on disk usage severity',
        condition: {
          description: 'At least one filesystem has free space available',
          check: {
            type: 'api_call',
            statement: 'available_bytes',
            expect: { operator: 'gt', value: 0 },
          },
        },
        thenStep: {
          stepId: 'step-006a',
          type: 'human_notification',
          name: 'Disk recovery guidance sent',
          recipients: [{ role: 'on_call_engineer', urgency: 'medium' }],
          message: {
            summary: `Disk assessment complete for ${target}`,
            detail: 'Space is available but running low. Actionable cleanup guidance has been sent. Monitor disk usage trends and schedule cleanup.',
            contextReferences: ['disk_baseline', 'large_entries'],
            actionRequired: false,
          },
          channel: 'auto',
        },
        elseStep: {
          stepId: 'step-006b',
          type: 'human_notification',
          name: 'URGENT: Filesystem completely full',
          recipients: [
            { role: 'on_call_engineer', urgency: 'critical' },
            { role: 'system_administrator', urgency: 'critical' },
            { role: 'engineering_lead', urgency: 'high' },
          ],
          message: {
            summary: `CRITICAL: No free space remaining on ${target}`,
            detail: 'One or more filesystems are 100% full. Applications may be unable to write data, create temp files, or log. Immediate action required: delete unnecessary files, expand storage, or move data to another volume.',
            contextReferences: ['disk_baseline', 'large_entries', 'log_rotation_status'],
            actionRequired: true,
          },
          channel: 'auto',
        },
      },
      // Step 7: Replanning checkpoint
      {
        stepId: 'step-007',
        type: 'replanning_checkpoint',
        name: 'Re-check disk usage after notification',
        description: 'Verify whether disk usage has changed since notifications were sent.',
        fastReplan: true,
        replanTimeout: 'PT30S',
        diagnosticCaptures: [
          {
            name: 'post_notification_disk_state',
            captureType: 'command_output',
            statement: 'check_disk_usage',
            captureCost: 'negligible',
            capturePolicy: 'required',
          },
        ],
      },
      // Step 8: Final summary
      {
        stepId: 'step-008',
        type: 'human_notification',
        name: 'Disk exhaustion assessment summary',
        recipients: [
          { role: 'on_call_engineer', urgency: 'medium' },
          { role: 'incident_commander', urgency: 'low' },
        ],
        message: {
          summary: `Disk exhaustion assessment complete for ${target}`,
          detail: `Scenario: ${scenario.replace(/_/g, ' ')}. Filesystem usage has been captured, large files identified, log rotation checked, and responsible teams notified with cleanup guidance.`,
          contextReferences: ['post_notification_disk_state'],
          actionRequired: false,
        },
        channel: 'auto',
      },
    ];

    return {
      ...createPlanEnvelope({
        planIdSuffix: 'disk',
        agentName: 'disk-exhaustion-recovery',
        agentVersion: '1.0.0',
        scenario,
        estimatedDuration: 'PT3M',
        summary: `Assess and alert on ${scenario.replace(/_/g, ' ')} for ${target}: capture usage, identify space consumers, check log rotation, and notify teams with cleanup guidance.`,
      }),
      impact: {
        affectedSystems: [
          {
            identifier: target,
            technology: 'disk',
            role: 'filesystem',
            impactType: 'disk_assessment_and_notification',
          },
        ],
        affectedServices: criticalFs.map((fs) => `mount:${fs.mountPoint}`),
        estimatedUserImpact: scenario === 'disk_full'
          ? 'Applications may be unable to write data. Database transactions and logging may fail.'
          : 'No immediate impact. Proactive cleanup prevents future outage.',
        dataLossRisk: scenario === 'disk_full' ? 'possible' : 'none',
      },
      steps,
      rollbackStrategy: {
        type: 'stepwise',
        description: 'This plan is read-only and notification-based. No system mutations to roll back.',
      },
    };
  }

  async replan(
    _context: AgentContext,
    _diagnosis: DiagnosisResult,
    _executionState: ExecutionState,
  ): Promise<ReplanResult> {
    return defaultReplan();
  }

  private buildRecoveryGuidance(scenario: string, criticalFs: FilesystemUsage[]): string {
    const affected = criticalFs.map((fs) => `${fs.mountPoint} (${fs.usagePercent}%, ${formatBytes(fs.availableBytes)} free)`).join(', ') || 'configured filesystems';

    const commonChecklist = [
      'Check for large log files: find /var/log -type f -size +100M -exec ls -lh {} \\;',
      'Check package manager cache: du -sh /var/cache/apt/archives/ or du -sh /var/cache/yum/',
      'Check for core dumps: find / -name "core.*" -type f 2>/dev/null',
      'Check Docker/container storage: docker system df',
      'Check for old temporary files: find /tmp -type f -mtime +7 -exec ls -lh {} \\;',
      'Review disk usage by directory: du -h --max-depth=2 / | sort -rh | head -20',
    ];

    const parts = [`Affected filesystems: ${affected}.`, '', 'Recommended investigation steps:'];

    switch (scenario) {
      case 'disk_full':
        parts.push('IMMEDIATE: Free space urgently — applications cannot write.');
        parts.push(...commonChecklist);
        break;
      case 'boot_partition_full':
        parts.push('Check for old kernel versions: dpkg -l linux-image-* | grep ^ii');
        parts.push('Remove old kernels: apt autoremove --purge (Debian/Ubuntu)');
        parts.push('Or: package-cleanup --oldkernels --count=2 (RHEL/CentOS)');
        break;
      case 'inode_exhaustion':
        parts.push('Find directories with many small files: find / -xdev -printf "%h\\n" | sort | uniq -c | sort -rn | head -20');
        parts.push('Common culprit: session files, mail queue, package manager metadata');
        parts.push(...commonChecklist.slice(0, 3));
        break;
      case 'log_directory_bloat':
        parts.push('Force log rotation: logrotate -f /etc/logrotate.conf');
        parts.push('Compress old logs: find /var/log -name "*.log.*" -not -name "*.gz" -exec gzip {} \\;');
        parts.push('Check logrotate config: cat /etc/logrotate.d/*');
        parts.push(...commonChecklist.slice(0, 2));
        break;
      default:
        parts.push(...commonChecklist);
        break;
    }

    return parts.join('\n');
  }
}
