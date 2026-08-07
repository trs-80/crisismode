// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import { AWS_RDS_CHECK_IDS } from '../../../agent/aws-rds/check-ids.js';
import type { RemediationGuide } from '../../../types/remediation-guide.js';

/**
 * The aws-rds console paths that used to be inline prose in agent.ts. Content
 * is the same guidance, restructured; `<instance>`, `<target-storage-gb>`,
 * `<security-group-id>` and `<db-port>` are substituted per-target at render
 * time via applyGuideVariables().
 */
export const awsRdsGuides: RemediationGuide[] = [
  {
    id: 'aws-rds-increase-storage',
    platform: 'aws-rds',
    title: 'Increase allocated storage on RDS instance <instance>',
    applicableFindingTypes: [AWS_RDS_CHECK_IDS.storageFull],
    url: 'https://console.aws.amazon.com/rds/',
    consoleSteps: [
      'Open the RDS console → Databases → <instance>.',
      'Choose Modify → Allocated storage and raise it to <target-storage-gb> GiB.',
      'Choose Apply immediately to take effect now, or leave it for the next maintenance window.',
    ],
    cliEquivalent:
      'aws rds modify-db-instance --db-instance-identifier <instance> --allocated-storage <target-storage-gb> --apply-immediately',
    expectedAfter: 'Free storage rises above the threshold and the instance returns to available.',
    verifiedOn: '2026-08-05',
  },
  {
    id: 'aws-rds-connection-saturation',
    platform: 'aws-rds',
    title: 'Reduce connection saturation on RDS instance <instance>',
    applicableFindingTypes: [AWS_RDS_CHECK_IDS.connectionSaturation],
    url: 'https://console.aws.amazon.com/rds/',
    consoleSteps: [
      'Open the RDS console → Databases → <instance>.',
      'Either put connection pooling in front of the database (RDS Proxy), or choose Modify → DB instance class and select a larger class.',
    ],
    cliEquivalent:
      'aws rds modify-db-instance --db-instance-identifier <instance> --db-instance-class <larger-class> --apply-immediately',
    expectedAfter: 'Connection count settles well below the instance limit.',
    caution:
      'Applying a class change reboots the instance immediately — schedule during low traffic, or omit --apply-immediately to wait for the next maintenance window.',
    verifiedOn: '2026-08-05',
  },
  {
    id: 'aws-rds-open-security-group',
    platform: 'aws-rds',
    title: 'Open RDS security group ingress on instance <instance>',
    applicableFindingTypes: [AWS_RDS_CHECK_IDS.securityGroup],
    url: 'https://console.aws.amazon.com/ec2/',
    consoleSteps: [
      'Open the EC2 console → Security Groups → <security-group-id>.',
      'Choose Inbound rules → Edit inbound rules, and allow TCP port <db-port> with your application\'s security group as the source.',
    ],
    cliEquivalent:
      'aws ec2 authorize-security-group-ingress --group-id <security-group-id> --protocol tcp --port <db-port> --source-group <app-security-group-id>',
    expectedAfter: 'The application can open connections to the database again.',
    caution:
      'Use the application\'s security group as the source. Opening the database port to 0.0.0.0/0 exposes it to the internet.',
    verifiedOn: '2026-08-05',
  },
  {
    id: 'aws-rds-instance-not-available',
    platform: 'aws-rds',
    title: 'Bring RDS instance <instance> back to available',
    applicableFindingTypes: [AWS_RDS_CHECK_IDS.instanceStatus],
    url: 'https://console.aws.amazon.com/rds/',
    consoleSteps: [
      'Open the RDS console → Databases → <instance> and read the current status and status reason.',
      'Check Logs & events → Recent events for what changed.',
      'If the status is \'stopped\', choose Actions → Start.',
      'If the status is \'rebooting\' or maintenance is in progress, wait and monitor — no action is needed unless it fails to return to \'available\'.',
      'Otherwise, review recent events and contact AWS support if the instance does not return to \'available\'.',
    ],
    cliEquivalent:
      'aws rds describe-db-instances --db-instance-identifier <instance> (then, if stopped: aws rds start-db-instance --db-instance-identifier <instance>)',
    expectedAfter: 'Instance status returns to \'available\' and clients can connect.',
    verifiedOn: '2026-08-05',
  },
];
