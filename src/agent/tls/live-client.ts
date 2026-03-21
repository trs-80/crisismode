// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * TlsLiveClient — inspects real TLS certificates using node:tls.
 *
 * Connects to endpoints, extracts certificate details, validates chains
 * against the system CA store. Zero external dependencies.
 */

import { connect as tlsConnect, type DetailedPeerCertificate } from 'node:tls';
import type {
  TlsBackend,
  CertificateInfo,
  EndpointInspection,
  ChainValidation,
  TlsEndpointConfig,
} from './backend.js';
import type { CheckExpression, Command } from '../../types/common.js';
import type { CapabilityProviderDescriptor } from '../../types/plugin.js';
import { compareCheckValue } from '../../framework/check-helpers.js';

export interface TlsLiveConfig {
  /** Endpoints to monitor */
  endpoints?: TlsEndpointConfig[];
  /** Connection timeout in ms (default: 5000) */
  connectTimeoutMs?: number;
  /** Expiry warning threshold in days (default: 30) */
  expiryWarningDays?: number;
}

export class TlsLiveClient implements TlsBackend {
  private config: TlsLiveConfig;

  constructor(config?: TlsLiveConfig) {
    this.config = config ?? {};
  }

  async getEndpointConfig(): Promise<TlsEndpointConfig[]> {
    return this.config.endpoints ?? [];
  }

  async inspectEndpoint(host: string, port: number): Promise<EndpointInspection> {
    const timeoutMs = this.config.connectTimeoutMs ?? 5000;

    return new Promise<EndpointInspection>((resolve) => {
      const start = Date.now();
      let settled = false;

      const settle = (result: EndpointInspection) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(result);
      };

      const socket = tlsConnect({
        host,
        port,
        rejectUnauthorized: false, // Allow inspection of broken certs
        servername: host,
      });

      const timer = setTimeout(() => {
        settle({
          host, port,
          certificate: null,
          tlsVersion: null,
          cipherSuite: null,
          connectLatencyMs: -1,
          error: `Connection timed out after ${timeoutMs}ms`,
        });
      }, timeoutMs);

      socket.on('secureConnect', () => {
        const latencyMs = Date.now() - start;

        try {
          const peerCert = socket.getPeerCertificate(true);
          const tlsVersion = socket.getProtocol() ?? null;
          const cipher = socket.getCipher();

          const certificate = this.parseCertificate(peerCert, host);

          settle({
            host, port,
            certificate,
            tlsVersion,
            cipherSuite: cipher?.name ?? null,
            connectLatencyMs: latencyMs,
            error: null,
          });
        } catch (err) {
          settle({
            host, port,
            certificate: null,
            tlsVersion: null,
            cipherSuite: null,
            connectLatencyMs: latencyMs,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });

      socket.on('error', (err) => {
        const latencyMs = Date.now() - start;
        settle({
          host, port,
          certificate: null,
          tlsVersion: null,
          cipherSuite: null,
          connectLatencyMs: latencyMs,
          error: err.message,
        });
      });
    });
  }

  async checkChainValidity(host: string, port: number): Promise<ChainValidation> {
    const timeoutMs = this.config.connectTimeoutMs ?? 5000;

    return new Promise<ChainValidation>((resolve) => {
      let settled = false;

      const settle = (result: ChainValidation) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(result);
      };

      const socket = tlsConnect({
        host,
        port,
        rejectUnauthorized: true, // Strict validation
        servername: host,
      });

      const timer = setTimeout(() => {
        settle({
          host, port,
          valid: false,
          chainLength: 0,
          hostnameMatch: false,
          error: `Connection timed out after ${timeoutMs}ms`,
          errorCode: 'ETIMEOUT',
        });
      }, timeoutMs);

      socket.on('secureConnect', () => {
        try {
          const chainLength = this.countChainLength(socket.getPeerCertificate(true));
          settle({
            host, port,
            valid: true,
            chainLength,
            hostnameMatch: true,
            error: null,
            errorCode: null,
          });
        } catch (err) {
          settle({
            host, port,
            valid: false,
            chainLength: 0,
            hostnameMatch: false,
            error: err instanceof Error ? err.message : String(err),
            errorCode: null,
          });
        }
      });

      socket.on('error', (err) => {
        // Extract error code for specific failure classification
        // Only assert hostnameMatch=true when error is unrelated to cert identity
        const code = (err as NodeJS.ErrnoException).code ?? '';
        const hostnameMatch = code !== 'ERR_TLS_CERT_ALTNAME_INVALID'
          && code !== 'CERT_HAS_EXPIRED'
          && code !== 'DEPTH_ZERO_SELF_SIGNED_CERT'
          && code !== 'UNABLE_TO_VERIFY_LEAF_SIGNATURE';

        settle({
          host, port,
          valid: false,
          chainLength: 0,
          hostnameMatch,
          error: err.message,
          errorCode: code || null,
        });
      });
    });
  }

  async executeCommand(command: Command): Promise<unknown> {
    if (command.type !== 'api_call') {
      throw new Error(`Unsupported TLS live client command type: ${command.type}`);
    }

    switch (command.operation) {
      case 'inspect_endpoint': {
        const host = String(command.parameters?.host ?? 'localhost');
        const port = Number(command.parameters?.port ?? 443);
        return { inspection: await this.inspectEndpoint(host, port) };
      }
      case 'validate_chain': {
        const host = String(command.parameters?.host ?? 'localhost');
        const port = Number(command.parameters?.port ?? 443);
        return { validation: await this.checkChainValidity(host, port) };
      }
      case 'check_config':
        return { endpoints: await this.getEndpointConfig() };
      default:
        return { executed: false, operation: command.operation };
    }
  }

  async evaluateCheck(check: CheckExpression): Promise<boolean> {
    const stmt = check.statement ?? '';

    if (stmt === 'cert_valid') {
      const endpoints = await this.getEndpointConfig();
      const validations = await Promise.all(
        endpoints.map((ep) => this.checkChainValidity(ep.host, ep.port)),
      );
      const validCount = validations.filter((v) => v.valid).length;
      return compareCheckValue(validCount, check.expect.operator, check.expect.value);
    }

    if (stmt.includes('days_until_expiry')) {
      const endpoints = await this.getEndpointConfig();
      const inspections = await Promise.all(
        endpoints.map((ep) => this.inspectEndpoint(ep.host, ep.port)),
      );
      const validInspections = inspections.filter((i) => i.certificate);
      if (validInspections.length === 0) return false;
      const minDays = Math.min(...validInspections.map((i) => i.certificate!.daysUntilExpiry));
      return compareCheckValue(minDays, check.expect.operator, check.expect.value);
    }

    if (stmt.includes('hostname_match')) {
      const endpoints = await this.getEndpointConfig();
      const validations = await Promise.all(
        endpoints.map((ep) => this.checkChainValidity(ep.host, ep.port)),
      );
      const allMatch = validations.every((v) => v.hostnameMatch);
      return compareCheckValue(allMatch, check.expect.operator, check.expect.value);
    }

    return true;
  }

  listCapabilityProviders(): CapabilityProviderDescriptor[] {
    return [
      {
        id: 'tls-live-read',
        kind: 'capability_provider',
        name: 'TLS Live Read Provider',
        maturity: 'live_validated',
        capabilities: ['tls.endpoint.inspect', 'tls.chain.validate', 'tls.config.read'],
        executionContexts: ['tls_read'],
        targetKinds: ['tls'],
        commandTypes: ['api_call'],
        supportsDryRun: true,
        supportsExecute: true,
      },
    ];
  }

  transition(_to: string): void {
    // No-op for live client
  }

  async close(): Promise<void> {
    // No persistent connections to close
  }

  // --- Private helpers ---

  private parseCertificate(peerCert: DetailedPeerCertificate, _host: string): CertificateInfo | null {
    if (!peerCert || !peerCert.subject) return null;

    const subject = peerCert.subject;
    const issuer = peerCert.issuer;
    const validFrom = peerCert.valid_from ?? '';
    const validTo = peerCert.valid_to ?? '';

    const now = new Date();
    const expiryDate = new Date(validTo);
    const daysUntilExpiry = Math.floor((expiryDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));

    // Parse Subject Alternative Names
    const sanString = peerCert.subjectaltname ?? '';
    const subjectAltNames = sanString
      ? sanString.split(',').map((s) => s.trim())
      : [];

    // Determine key size from bits or modulus
    const bits = peerCert.bits;
    const modulus = peerCert.modulus;
    const keySize = bits ?? (modulus ? modulus.length * 4 : 0);

    // Extract first value from cert fields that may be string or string[]
    const str = (v: string | string[] | undefined): string | undefined =>
      Array.isArray(v) ? v[0] : v;

    // Check self-signed
    const selfSigned = (str(subject.CN) ?? '') === (str(issuer.CN) ?? '') && (str(subject.O) ?? '') === (str(issuer.O) ?? '');

    return {
      subject: { CN: str(subject.CN) ?? '', O: str(subject.O), OU: str(subject.OU) },
      issuer: { CN: str(issuer.CN) ?? '', O: str(issuer.O) },
      validFrom,
      validTo,
      daysUntilExpiry,
      serialNumber: peerCert.serialNumber ?? '',
      fingerprint256: peerCert.fingerprint256 ?? '',
      subjectAltNames,
      keySize,
      keyAlgorithm: peerCert.asn1Curve ? `ECDSA (${peerCert.asn1Curve})` : 'RSA',
      signatureAlgorithm: 'unknown',
      selfSigned,
    };
  }

  private countChainLength(cert: DetailedPeerCertificate): number {
    let count = 1;
    let current: DetailedPeerCertificate = cert;
    const seen = new Set<string>();

    while (current.issuerCertificate && current.issuerCertificate !== current) {
      const fp = current.issuerCertificate.fingerprint256 ?? '';
      if (seen.has(fp)) break;
      seen.add(fp);
      current = current.issuerCertificate;
      count++;
    }

    return count;
  }
}
