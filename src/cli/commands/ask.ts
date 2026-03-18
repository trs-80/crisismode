// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CrisisMode Contributors

/**
 * `crisismode ask "my postgres is slow"` — natural language AI diagnosis.
 *
 * Two modes:
 * - Single-shot: `crisismode ask "question"` — answers and exits
 * - REPL: `crisismode ask` (no question) — interactive multi-turn session
 *
 * The REPL accumulates conversation history so follow-up questions have
 * full context from previous turns. Integrates watch patterns and root
 * cause synthesis when available.
 */

import { createInterface } from 'node:readline';
import { sanitizeInput } from '../../framework/ai-diagnosis.js';
import { getNetworkProfile } from '../../framework/network-profile.js';
import { printBanner, printInfo, printWarning } from '../output.js';
import { missingEnvVar } from '../errors.js';

// ── Types ──

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ReplContext {
  history: ConversationMessage[];
  systemContext: string[];
}

const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_HISTORY_TURNS = 20;

const SYSTEM_PROMPT = `You are an infrastructure recovery specialist embedded in the CrisisMode CLI tool. You're in a multi-turn diagnostic conversation with an operator who may be dealing with a live incident.

Guidelines:
- Be direct and actionable. Lead with the most important thing.
- Include specific commands when helpful (SQL queries, docker commands, systemctl, kubectl).
- Rate urgency: CRITICAL (act now), HIGH (fix soon), MEDIUM (schedule fix), LOW (monitor).
- Keep responses concise — operators in a crisis need speed, not essays.
- Build on previous context — don't repeat what you've already said unless asked.
- Ask clarifying questions when the problem is ambiguous.
- If the operator shares new diagnostic output, re-evaluate your previous assessment.
- Reference previous findings when they're relevant to the current question.

Supported systems: PostgreSQL, Redis, etcd, Kafka, Kubernetes, Ceph, Flink.
Cross-system awareness: consider cascade failures, shared root causes, and upstream/downstream dependencies.`;

// ── Single-shot mode (backward compatible) ──

export async function runAsk(question: string): Promise<void> {
  printBanner();

  if (!process.env.ANTHROPIC_API_KEY) {
    throw missingEnvVar('ANTHROPIC_API_KEY', 'required for AI-powered diagnosis');
  }

  printInfo(`Question: ${question}`);
  console.log('');

  const { universalAiDiagnosis } = await import('../../framework/ai-diagnosis-universal.js');
  const result = await universalAiDiagnosis({ question });

  if (result.source === 'ai') {
    console.log(result.response);
  } else {
    printWarning('AI diagnosis unavailable. Showing basic guidance.');
    console.log(result.response);
  }
  console.log('');
}

// ── REPL mode ──

export async function runAskRepl(): Promise<void> {
  printBanner();

  if (!process.env.ANTHROPIC_API_KEY) {
    throw missingEnvVar('ANTHROPIC_API_KEY', 'required for interactive diagnosis');
  }

  const profile = getNetworkProfile();
  if (profile && profile.internet.status === 'unavailable') {
    printWarning('No internet connectivity — AI diagnosis requires network access.');
    return;
  }

  printInfo('Interactive diagnosis session. Type your question, or:');
  printInfo('  /context   — show accumulated context');
  printInfo('  /clear     — reset conversation history');
  printInfo('  /exit      — end session');
  console.log('');

  const ctx: ReplContext = {
    history: [],
    systemContext: [],
  };

  // Try to load watch state for additional context
  await loadWatchContext(ctx);

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'crisismode> ',
    terminal: process.stdin.isTTY === true,
  });

  rl.prompt();

  for await (const line of rl) {
    const input = line.trim();

    if (!input) {
      rl.prompt();
      continue;
    }

    // Handle REPL commands
    if (input.startsWith('/')) {
      const handled = handleReplCommand(input, ctx);
      if (handled === 'exit') {
        rl.close();
        return;
      }
      rl.prompt();
      continue;
    }

    // Send question to AI with conversation history
    try {
      const response = await sendWithHistory(ctx, input);
      console.log('');
      console.log(response);
      console.log('');
    } catch (err) {
      printWarning(`AI error: ${err instanceof Error ? err.message : String(err)}`);
    }

    rl.prompt();
  }

  // EOF or stream closed
  printInfo('Session ended.');
}

// ── REPL commands ──

function handleReplCommand(input: string, ctx: ReplContext): 'exit' | 'handled' {
  const cmd = input.toLowerCase().split(/\s+/)[0];

  switch (cmd) {
    case '/exit':
    case '/quit':
    case '/q':
      printInfo(`Session ended. ${ctx.history.length / 2} exchanges.`);
      return 'exit';

    case '/clear':
      ctx.history = [];
      printInfo('Conversation history cleared.');
      return 'handled';

    case '/context':
      printInfo(`Conversation turns: ${Math.floor(ctx.history.length / 2)}`);
      if (ctx.systemContext.length > 0) {
        printInfo('Background context:');
        for (const c of ctx.systemContext) {
          printInfo(`  - ${c}`);
        }
      }
      return 'handled';

    default:
      printWarning(`Unknown command: ${cmd}. Available: /context, /clear, /exit`);
      return 'handled';
  }
}

// ── AI conversation ──

async function sendWithHistory(ctx: ReplContext, question: string): Promise<string> {
  const sanitized = sanitizeInput(question);

  ctx.history.push({ role: 'user', content: sanitized });

  // Trim history to keep within token budget
  while (ctx.history.length > MAX_HISTORY_TURNS * 2) {
    ctx.history.shift();
    ctx.history.shift();
  }

  // Build system prompt with accumulated context
  const systemParts = [SYSTEM_PROMPT];
  if (ctx.systemContext.length > 0) {
    systemParts.push('\nBackground context from watch/scan:');
    for (const c of ctx.systemContext) {
      systemParts.push(`- ${c}`);
    }
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

    const messages = ctx.history.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

    const response = await client.messages.create(
      {
        model: DEFAULT_MODEL,
        max_tokens: 1024,
        messages,
        system: systemParts.join('\n'),
      },
      { signal: controller.signal },
    );

    clearTimeout(timeoutId);

    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => ('text' in block ? block.text : ''))
      .join('');

    const trimmed = text.trim();
    ctx.history.push({ role: 'assistant', content: trimmed });
    return trimmed;
  } catch (err) {
    clearTimeout(timeoutId);
    // Remove the user message that failed
    ctx.history.pop();
    throw err;
  }
}

// ── Watch context loader ──

async function loadWatchContext(ctx: ReplContext): Promise<void> {
  try {
    const { readFileSync, existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const { homedir } = await import('node:os');

    const stateDir = resolve(homedir(), '.crisismode');
    const watchFile = resolve(stateDir, 'watch-state.json');

    if (!existsSync(watchFile)) return;

    const data = JSON.parse(readFileSync(watchFile, 'utf-8'));
    if (!data || !data.snapshots) return;

    const { WatchState } = await import('../../framework/watch-state.js');
    const state = WatchState.deserialise(data);
    const card = state.getHealthCard();

    ctx.systemContext.push(`Last observed: ${card.target} is ${card.currentStatus} (${(card.currentConfidence * 100).toFixed(0)}% confidence)`);
    ctx.systemContext.push(`Uptime: ${card.uptimePercent}%, observed ${card.totalCycles} cycles`);

    if (card.patterns.length > 0) {
      for (const p of card.patterns) {
        ctx.systemContext.push(`Pattern: ${p.description}`);
      }
    }

    printInfo(`Loaded watch context for ${card.target}`);
  } catch {
    // Watch state not available — that's fine
  }
}
