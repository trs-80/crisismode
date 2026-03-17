// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * GitHub integration stub.
 *
 * Implements SourceControlIntegration for GitHub repositories.
 * Currently a stub — methods throw with a helpful message indicating
 * they are not yet functional.
 *
 * To use: set the GITHUB_TOKEN environment variable or pass a token
 * to the constructor.
 */

import type { SourceControlIntegration, CommitInfo, DeployInfo, CIStatus } from './index.js';

export class GitHubIntegration implements SourceControlIntegration {
  name = 'github';
  connected = false;

  private token: string | undefined;
  private owner: string;
  private repo: string;

  constructor(options: { owner: string; repo: string; token?: string }) {
    this.owner = options.owner;
    this.repo = options.repo;
    this.token = options.token ?? process.env.GITHUB_TOKEN;
  }

  async connect(): Promise<void> {
    if (!this.token) {
      throw new Error(
        'GITHUB_TOKEN required. Set the GITHUB_TOKEN environment variable or pass a token to the constructor.',
      );
    }
    // In the future: validate the token against the GitHub API
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async getRecentCommits(_limit: number): Promise<CommitInfo[]> {
    this.assertConnected();
    throw new Error(
      `GitHubIntegration.getRecentCommits() is not yet implemented. ` +
      `This will query the GitHub API for recent commits to ${this.owner}/${this.repo}.`,
    );
  }

  async getDeployHistory(_limit: number): Promise<DeployInfo[]> {
    this.assertConnected();
    throw new Error(
      `GitHubIntegration.getDeployHistory() is not yet implemented. ` +
      `This will query GitHub deployments for ${this.owner}/${this.repo}.`,
    );
  }

  async getCIStatus(_sha: string): Promise<CIStatus> {
    this.assertConnected();
    throw new Error(
      `GitHubIntegration.getCIStatus() is not yet implemented. ` +
      `This will query GitHub check runs and commit statuses for ${this.owner}/${this.repo}.`,
    );
  }

  private assertConnected(): void {
    if (!this.connected) {
      throw new Error('GitHubIntegration is not connected. Call connect() first.');
    }
  }
}
