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
import { getOutputMode, jsonOut, printBanner, printInfo, printWarning } from '../output.js';
import { missingEnvVar } from '../errors.js';
import { defaultAiModel } from '../../framework/ai-model.js';
import { callClaudeDetailed } from '../../framework/ai-client.js';

// ── Types ──

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ReplContext {
  history: ConversationMessage[];
  systemContext: string[];
}

/** One completed REPL exchange. `truncated` is required so the render path cannot ignore it. */
interface ReplTurn {
  text: string;
  truncated: boolean;
}

const DEFAULT_MODEL = defaultAiModel();
const MAX_HISTORY_TURNS = 20;

/**
 * Response budget for a REPL turn.
 *
 * Measured against live claude-sonnet-5 on 2026-08-09 with max_tokens=8192 so
 * the numbers are natural response lengths, using this module's real system
 * prompt and real accumulated history:
 *
 *   turn 1, one short question              543-684 tokens    6.7-11.9s
 *   turn 4, operator pasted pg output and
 *     asked for a full remediation sequence 1817-2339 tokens  19.6-26.6s
 *   turn 9 of a long session, "write me the
 *     complete runbook for the next shift"  2724-3638 tokens  29.0-37.1s
 *
 * Answers grow with the conversation, which is the point of a REPL that keeps
 * MAX_HISTORY_TURNS of context — so the first turn is the least informative
 * case to size against. At 1024 tokens every turn past the first was truncated,
 * and the old 30s deadline sat below the measured 29.0-37.1s of a long session,
 * so the runbook request — the most valuable thing this REPL does — could fail
 * both ways at once.
 *
 * 45s is 1.2x the measured 37.1s worst case. It is deliberately no longer: a
 * human is sitting at a prompt with no streaming and no spinner, and past this
 * point an honest AiTimeoutError beats continued silence.
 *
 * 6144 is 1.7x the measured 3638-token maximum, and intentionally above what
 * 45s can deliver at the ~95 tokens/s observed here (~4300 tokens). That
 * asymmetry is the safer failure: an answer that genuinely runs longer than the
 * deadline surfaces as a reported timeout rather than as a runbook that ends
 * halfway through a step an operator is about to execute.
 */
const RESPONSE_MAX_TOKENS = 6144;
const RESPONSE_TIMEOUT_MS = 45_000;

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

// ── Machine output ──

/**
 * One JSONL record per answer, in the CLI's standard `{ type, ... }` shape.
 *
 * `ask` used to print the answer with a bare `console.log` and route the
 * truncation notice through `printWarning`/`printInfo`, both of which return
 * early in machine mode. A `--json` consumer therefore received a partial
 * answer with nothing marking it as partial — the one caller least able to
 * notice, since it cannot read the prose and judge.
 *
 * `truncated` is a field rather than a warning because that is the only form a
 * machine consumer can act on: `.truncated` is checkable, a suppressed human
 * sentence is not. `answer` carries the partial text unchanged — it is still
 * the most useful thing we have — but never on its own.
 */
function emitAskRecord(
  question: string,
  result: { response: string; source: 'ai' | 'fallback'; truncated: boolean },
): void {
  jsonOut('ask', {
    question,
    answer: result.response,
    source: result.source,
    truncated: result.truncated,
  });
}

// ── Single-shot mode (backward compatible) ──

export async function runAsk(question: string): Promise<void> {
  printBanner();

  if (!process.env.ANTHROPIC_API_KEY) {
    throw missingEnvVar('ANTHROPIC_API_KEY', 'required for AI-powered diagnosis');
  }

  const machine = getOutputMode() === 'machine';

  if (!machine) {
    printInfo(`Question: ${question}`);
    console.log('');
  }

  const { universalAiDiagnosis } = await import('../../framework/ai-diagnosis-universal.js');
  const result = await universalAiDiagnosis({ question });

  // Machine mode emits the record instead of the prose: the blank lines and the
  // bare answer below would otherwise sit in the stream as non-JSON lines.
  if (machine) {
    emitAskRecord(question, result);
    return;
  }

  if (result.source === 'ai') {
    console.log(result.response);
  } else {
    printWarning('AI diagnosis unavailable. Showing basic guidance.');
    console.log(result.response);
  }

  if (result.truncated) {
    console.log('');
    printWarning(
      'This answer is cut off — it hit the response length limit, so the last point above is incomplete.',
    );
    printInfo('Ask a narrower question to get a complete answer.');
  }

  console.log('');
}

// ── REPL mode ──

export async function runAskRepl(): Promise<void> {
  printBanner();

  if (!process.env.ANTHROPIC_API_KEY) {
    throw missingEnvVar('ANTHROPIC_API_KEY', 'required for interactive diagnosis');
  }

  const machine = getOutputMode() === 'machine';

  const profile = getNetworkProfile();
  if (profile && profile.internet.status === 'unavailable') {
    const message = 'No internet connectivity — AI diagnosis requires network access.';
    // Same reason as the truncation record: printWarning is a no-op in machine
    // mode, so a --json REPL would otherwise exit having emitted nothing at all.
    if (machine) jsonOut('error', { message });
    else printWarning(message);
    return;
  }

  if (!machine) {
    printInfo('Interactive diagnosis session. Type your question, or:');
    printInfo('  /context   — show accumulated context');
    printInfo('  /clear     — reset conversation history');
    printInfo('  /exit      — end session');
    console.log('');
  }

  const ctx: ReplContext = {
    history: [],
    systemContext: [],
  };

  // Try to load watch state for additional context
  await loadWatchContext(ctx);

  const rl = createInterface({
    input: process.stdin,
    // No output stream in machine mode: readline would write "crisismode> " into
    // the middle of the JSONL stream. Nothing else in this loop prints there.
    output: machine ? undefined : process.stdout,
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
      const turn = await sendWithHistory(ctx, input);
      if (machine) {
        // One record per exchange, same shape as single-shot: a REPL consumer
        // reading JSONL gets `truncated` on the turn it belongs to.
        emitAskRecord(input, { response: turn.text, source: 'ai', truncated: turn.truncated });
      } else {
        console.log('');
        console.log(turn.text);
        console.log('');
        if (turn.truncated) {
          printWarning(
            'This answer is cut off — it hit the response length limit, so the last point above is incomplete.',
          );
          printInfo('Type "continue" to pick up where it stopped, or ask something narrower.');
          console.log('');
        }
      }
    } catch (err) {
      const message = `AI error: ${err instanceof Error ? err.message : String(err)}`;
      if (machine) jsonOut('error', { message });
      else printWarning(message);
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

async function sendWithHistory(ctx: ReplContext, question: string): Promise<ReplTurn> {
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

  const messages = ctx.history.map((m) => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
  }));

  try {
    const { text, stopReason } = await callClaudeDetailed({
      system: systemParts.join('\n'),
      messages,
      model: DEFAULT_MODEL,
      maxTokens: RESPONSE_MAX_TOKENS,
      timeoutMs: RESPONSE_TIMEOUT_MS,
      apiKey: process.env.ANTHROPIC_API_KEY!,
    });

    const trimmed = text.trim();

    // The partial answer still goes into history: it is what the model actually
    // said, and keeping it is what makes "continue" a working follow-up rather
    // than a request the model has no context for.
    ctx.history.push({ role: 'assistant', content: trimmed });

    // stop_reason, not a text heuristic — 2 of 20 truncated responses in a live
    // 24-trial run ended on a period and read as finished. Guessing from the
    // text would hand an operator a half-written runbook as if it were whole.
    return { text: trimmed, truncated: stopReason === 'max_tokens' };
  } catch (err) {
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
