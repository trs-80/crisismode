// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

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

export type SimulatorState = 'cert_expiring' | 'cert_invalid' | 'healthy';

export class TlsSimulator implements TlsBackend {
  private state: SimulatorState = 'cert_expiring';

  transition(to: string): void {
    this.state = to as SimulatorState;
  }

  async getEndpointConfig(): Promise<TlsEndpointConfig[]> {
    return [
      { host: 'api.example.com', port: 443, label: 'API Gateway' },
      { host: 'app.example.com', port: 443, label: 'Web App' },
      { host: 'internal.example.com', port: 8443, label: 'Internal Service' },
    ];
  }

  async inspectEndpoint(host: string, port: number): Promise<EndpointInspection> {
    const now = new Date();

    switch (this.state) {
      case 'cert_expiring': {
        const expiryDate = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000); // 5 days from now
        const cert = this.buildCert(host, expiryDate, {
          keySize: 2048,
          selfSigned: false,
        });

        if (host === 'internal.example.com') {
          // Internal service has a weaker cert
          const weakExpiry = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
          const weakCert = this.buildCert(host, weakExpiry, {
            keySize: 1024,
            selfSigned: true,
            issuerCN: host,
          });
          return { host, port, certificate: weakCert, tlsVersion: 'TLSv1.1', cipherSuite: 'RC4-SHA', connectLatencyMs: 180, error: null };
        }

        return { host, port, certificate: cert, tlsVersion: 'TLSv1.3', cipherSuite: 'TLS_AES_256_GCM_SHA384', connectLatencyMs: 45, error: null };
      }
      case 'cert_invalid': {
        if (host === 'api.example.com') {
          const expiredDate = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000); // Expired 10 days ago
          const cert = this.buildCert(host, expiredDate, { keySize: 2048, selfSigned: false });
          return { host, port, certificate: cert, tlsVersion: 'TLSv1.3', cipherSuite: 'TLS_AES_256_GCM_SHA384', connectLatencyMs: 52, error: null };
        }
        if (host === 'app.example.com') {
          // Hostname mismatch — cert is for wrong domain
          const futureDate = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
          const cert = this.buildCert('wrong-domain.example.com', futureDate, { keySize: 2048, selfSigned: false });
          return { host, port, certificate: cert, tlsVersion: 'TLSv1.3', cipherSuite: 'TLS_AES_256_GCM_SHA384', connectLatencyMs: 38, error: null };
        }
        const futureDate = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000);
        const cert = this.buildCert(host, futureDate, { keySize: 2048, selfSigned: false });
        return { host, port, certificate: cert, tlsVersion: 'TLSv1.3', cipherSuite: 'TLS_AES_256_GCM_SHA384', connectLatencyMs: 30, error: null };
      }
      case 'healthy': {
        const futureDate = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000);
        const cert = this.buildCert(host, futureDate, { keySize: 4096, selfSigned: false });
        return { host, port, certificate: cert, tlsVersion: 'TLSv1.3', cipherSuite: 'TLS_AES_256_GCM_SHA384', connectLatencyMs: 25, error: null };
      }
    }
  }

  async checkChainValidity(host: string, port: number): Promise<ChainValidation> {

    switch (this.state) {
      case 'cert_expiring':
        if (host === 'internal.example.com') {
          return { host, port, valid: false, chainLength: 1, hostnameMatch: true, error: 'self signed certificate', errorCode: 'DEPTH_ZERO_SELF_SIGNED_CERT' };
        }
        return { host, port, valid: true, chainLength: 3, hostnameMatch: true, error: null, errorCode: null };
      case 'cert_invalid':
        if (host === 'api.example.com') {
          return { host, port, valid: false, chainLength: 3, hostnameMatch: true, error: 'certificate has expired', errorCode: 'CERT_HAS_EXPIRED' };
        }
        if (host === 'app.example.com') {
          return { host, port, valid: false, chainLength: 3, hostnameMatch: false, error: 'Hostname/IP does not match certificate altnames', errorCode: 'ERR_TLS_CERT_ALTNAME_INVALID' };
        }
        return { host, port, valid: true, chainLength: 3, hostnameMatch: true, error: null, errorCode: null };
      case 'healthy':
        return { host, port, valid: true, chainLength: 3, hostnameMatch: true, error: null, errorCode: null };
    }
  }

  async executeCommand(command: Command): Promise<unknown> {
    if (command.type !== 'api_call') {
      throw new Error(`Unsupported TLS simulator command type: ${command.type}`);
    }

    switch (command.operation) {
      case 'inspect_endpoint': {
        const host = String(command.parameters?.host ?? 'api.example.com');
        const port = Number(command.parameters?.port ?? 443);
        return { inspection: await this.inspectEndpoint(host, port) };
      }
      case 'validate_chain': {
        const host = String(command.parameters?.host ?? 'api.example.com');
        const port = Number(command.parameters?.port ?? 443);
        return { validation: await this.checkChainValidity(host, port) };
      }
      case 'check_config':
        return { endpoints: await this.getEndpointConfig() };
      default:
        return { simulated: true, operation: command.operation, parameters: command.parameters };
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
        id: 'tls-simulator-read',
        kind: 'capability_provider',
        name: 'TLS Simulator Read Provider',
        maturity: 'simulator_only',
        capabilities: ['tls.endpoint.inspect', 'tls.chain.validate', 'tls.config.read'],
        executionContexts: ['tls_read'],
        targetKinds: ['tls'],
        commandTypes: ['api_call'],
        supportsDryRun: true,
        supportsExecute: true,
      },
    ];
  }

  async close(): Promise<void> {}

  private buildCert(
    cn: string,
    validTo: Date,
    opts: { keySize: number; selfSigned: boolean; issuerCN?: string },
  ): CertificateInfo {
    const now = new Date();
    const validFrom = new Date(validTo.getTime() - 365 * 24 * 60 * 60 * 1000);
    const daysUntilExpiry = Math.floor((validTo.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));

    return {
      subject: { CN: cn, O: 'Example Corp', OU: 'Engineering' },
      issuer: { CN: opts.issuerCN ?? 'Example CA', O: 'Example CA Corp' },
      validFrom: validFrom.toISOString(),
      validTo: validTo.toISOString(),
      daysUntilExpiry,
      serialNumber: 'A1B2C3D4E5F6',
      fingerprint256: 'AB:CD:EF:12:34:56:78:9A:BC:DE:F0:12:34:56:78:9A:AB:CD:EF:12:34:56:78:9A:BC:DE:F0:12:34:56:78:9A',
      subjectAltNames: [`DNS:${cn}`, `DNS:*.${cn.replace(/^[^.]+\./, '')}`],
      keySize: opts.keySize,
      keyAlgorithm: 'RSA',
      signatureAlgorithm: 'sha256WithRSAEncryption',
      selfSigned: opts.selfSigned,
    };
  }
}
