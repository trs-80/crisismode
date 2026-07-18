// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

import type { ReadinessRule } from '../types.js';
import { connectionHeadroomRule } from './connection-headroom.js';
import { connectionLimitTierRule } from './connection-limit-tier.js';
import { longTransactionsRule } from './long-transactions.js';
import { missingIndexRule } from './missing-index.js';
import { slowQueriesRule } from './slow-queries.js';
import { serverlessPoolingRule } from './serverless-pooling.js';

export const allRules: ReadinessRule[] = [
  connectionHeadroomRule,
  connectionLimitTierRule,
  longTransactionsRule,
  missingIndexRule,
  slowQueriesRule,
  serverlessPoolingRule,
];
