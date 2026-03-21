// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * TlsBackend — interface for inspecting TLS certificates and endpoint health.
 * Both the simulator and live client implement this.
 */

import type { ExecutionBackend } from '../../framework/backend.js';

/** Certificate details from a TLS endpoint */
export interface CertificateInfo {
  subject: { CN: string; O?: string; OU?: string };
  issuer: { CN: string; O?: string };
  validFrom: string;
  validTo: string;
  daysUntilExpiry: number;
  serialNumber: string;
  fingerprint256: string;
  subjectAltNames: string[];
  keySize: number;
  keyAlgorithm: string;
  signatureAlgorithm: string;
  selfSigned: boolean;
}

/** Result of inspecting a single TLS endpoint */
export interface EndpointInspection {
  host: string;
  port: number;
  certificate: CertificateInfo | null;
  tlsVersion: string | null;
  cipherSuite: string | null;
  connectLatencyMs: number;
  error: string | null;
}

/** Result of chain validation against the system CA store */
export interface ChainValidation {
  host: string;
  port: number;
  valid: boolean;
  chainLength: number;
  hostnameMatch: boolean;
  error: string | null;
  errorCode: string | null;
}

/** Configured endpoint to monitor */
export interface TlsEndpointConfig {
  host: string;
  port: number;
  label?: string;
}

export interface TlsBackend extends ExecutionBackend {
  /** Connect to an endpoint and inspect its certificate */
  inspectEndpoint(host: string, port: number): Promise<EndpointInspection>;

  /** Validate the certificate chain against system CA store */
  checkChainValidity(host: string, port: number): Promise<ChainValidation>;

  /** Get the configured endpoints to monitor */
  getEndpointConfig(): Promise<TlsEndpointConfig[]>;

  /** Simulator-only state transition hook */
  transition?(to: string): void;
}
