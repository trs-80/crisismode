// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * Re-export shared AWS utilities from the common location.
 * Preserves backward compatibility for existing backup provider imports.
 */

export {
  tryImportAws,
  resolveAwsCredentials,
  type AwsCredentialResult,
} from '../aws-common.js';
