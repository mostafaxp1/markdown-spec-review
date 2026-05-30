/**
 * Agent registry + invocation logic for the "Address comments" feature.
 *
 * The interactive Comments view can hand the whole document — plus the inline
 * review comments in it — to a terminal coding agent (Claude Code, Codex,
 * GitHub Copilot CLI, or Antigravity) and ask it to revise the prose so each
 * comment is addressed. This module is the single place that knows, per agent:
 *
 *   - which executable to run (with a user override via `ai.commands`),
 *   - whether it is installed,
 *   - which models it offers (best-effort detection; see `detectModels`),
 *   - how to turn (model, effort, prompt, run-mode) into an argv, and
 *   - how to shell-quote that argv for a terminal command line.
 *
 * It also builds the natural-language instructions both run modes feed the
 * agent. Everything here is pure/host-side (Node + vscode config only); the
 * webview never sees it — it just shows the picker and posts the user's choice.
 *
 * NOTE: only the Claude Code invocation is verified against an installed CLI.
 * The Codex / Copilot / Antigravity argv shapes are best-effort defaults based
 * on their documented headless flags; if one drifts, it is a one-line edit here
 * (or the user can repoint the binary with `markdownComments.ai.commands`).
 */

import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  COMMENT_BLOCK_RE,
  parseComment,
  ParsedComment,
} from './commentFormat';

const execFileP = promisify(execFile);

export type AgentId = 'claude-code' | 'codex' | 'copilot' | 'antigravity';
export type RunMode = 'terminal' | 'headless';
export type Effort = 'low' | 'medium' | 'high';

export const AGENT_IDS: AgentId[] = ['claude-code', 'codex', 'copilot', 'antigravity'];
export const EFFORTS: Effort[] = ['low', 'medium', 'high'];

interface AgentMeta {
  label: string;
  /** Default executable name (overridable via `markdownComments.ai.commands`). */
  bin: string;
  /** Best-effort, curated model list — see detectModels(). */
  curatedModels: string[];
}

const AGENTS: Record<AgentId, AgentMeta> = {
  'claude-code': {
    label: 'Claude Code',
    bin: 'claude',
    // Claude Code has no "list models" command; these are its stable aliases.
    curatedModels: ['opus', 'sonnet', 'haiku'],
  },
  codex: {
    label: 'Codex',
    bin: 'codex',
    curatedModels: ['gpt-5-codex', 'gpt-5', 'o3', 'o4-mini'],
  },
  copilot: {
    label: 'GitHub Copilot CLI',
    bin: 'copilot',
    curatedModels: ['claude-sonnet-4.5', 'gpt-5', 'gpt-4.1'],
  },
  antigravity: {
    label: 'Antigravity',
    bin: 'antigravity',
    curatedModels: ['gemini-2.5-pro', 'gemini-2.0-flash'],
  },
};

export function agentLabel(agent: AgentId): string {
  return AGENTS[agent]?.label ?? agent;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface AiSettings {
  agent: AgentId;
  runMode: RunMode;
  model: string;
  effort: Effort;
}

function cfg() {
  return vscode.workspace.getConfiguration('markdownComments');
}

export function getAiSettings(): AiSettings {
  const c = cfg();
  const agent = c.get<string>('ai.agent', 'claude-code');
  const runMode = c.get<string>('ai.runMode', 'terminal');
  const effort = c.get<string>('ai.effort', 'medium');
  return {
    agent: (AGENT_IDS as string[]).includes(agent) ? (agent as AgentId) : 'claude-code',
    runMode: runMode === 'headless' ? 'headless' : 'terminal',
    model: (c.get<string>('ai.model', '') || '').trim(),
    effort: (EFFORTS as string[]).includes(effort) ? (effort as Effort) : 'medium',
  };
}

/** The executable for an agent, honoring the `ai.commands` override map. */
export function resolveBin(agent: AgentId): string {
  const overrides = cfg().get<Record<string, string>>('ai.commands', {}) || {};
  const override = typeof overrides[agent] === 'string' ? overrides[agent].trim() : '';
  return override || AGENTS[agent].bin;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/** Whether the agent's executable is runnable on this machine. */
export async function isAgentInstalled(agent: AgentId): Promise<boolean> {
  const bin = resolveBin(agent);
  try {
    await execFileP(bin, ['--version'], { timeout: 4000, windowsHide: true });
    return true;
  } catch (err: any) {
    // ENOENT => not on PATH. Any other failure (non-zero exit, unknown flag,
    // timeout) still means the binary exists and ran, so treat it as installed.
    return err?.code !== 'ENOENT';
  }
}

/**
 * Best-effort model list for an agent ("auto-detect from CLI", with a curated
 * fallback). None of these CLIs expose a reliable machine-readable
 * list-models command today, so detection is necessarily light: we read what
 * we can (e.g. the model named in Codex's config.toml) and merge it ahead of a
 * curated list of well-known models. The user can always pick "Default" or set
 * any string via `markdownComments.ai.model`, so a stale list is never a wall.
 */
export async function detectModels(agent: AgentId): Promise<string[]> {
  const curated = AGENTS[agent].curatedModels.slice();
  try {
    const detected = await probeModels(agent);
    return dedupe([...detected, ...curated]);
  } catch {
    return curated;
  }
}

async function probeModels(agent: AgentId): Promise<string[]> {
  switch (agent) {
    case 'codex':
      return readCodexConfigModel();
    default:
      // No reliable probe — fall back to the curated list.
      return [];
  }
}

/** Pull the active `model = "…"` out of Codex's config.toml, if present. */
async function readCodexConfigModel(): Promise<string[]> {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const file = path.join(home, 'config.toml');
  const text = await fs.readFile(file, 'utf8');
  const m = /^\s*model\s*=\s*["']?([^"'\n#]+?)["']?\s*(?:#.*)?$/m.exec(text);
  return m ? [m[1].trim()] : [];
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const t = (v || '').trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Comment extraction (shared with the run path so instructions list the same
// comments the view shows)
// ---------------------------------------------------------------------------

export function extractComments(text: string): ParsedComment[] {
  COMMENT_BLOCK_RE.lastIndex = 0;
  const out: ParsedComment[] = [];
  let match: RegExpExecArray | null;
  while ((match = COMMENT_BLOCK_RE.exec(text)) !== null) {
    const inner = match[0].replace(/^<!--/, '').replace(/-->$/, '');
    const parsed = parseComment(inner);
    if (parsed) {
      out.push(parsed);
    }
  }
  return out;
}

/** Comments still needing work — i.e. not already carrying a Resolved: line. */
export function isResolved(c: ParsedComment): boolean {
  return /^\s*resolved\s*:/im.test(c.body);
}

// ---------------------------------------------------------------------------
// Instructions (the prompt body both run modes feed the agent)
// ---------------------------------------------------------------------------

const EFFORT_HINT: Record<Effort, string> = {
  low: '',
  medium: 'Take care to fully understand each comment before editing.',
  high:
    'Think hard about each comment and reason carefully through the implications ' +
    'of every edit before making it.',
};

export interface InstructionsInput {
  docPath: string;
  comments: ParsedComment[];
  effort: Effort;
}

/**
 * Build the natural-language instructions the agent follows. Headless mode
 * passes this verbatim as the prompt; terminal mode writes it to a temp file
 * and points the agent at it (keeps the command line short and quote-safe).
 *
 * The disposition matches the user's chosen behavior: KEEP every comment block
 * and append a `Resolved: …` line to its body (an audit trail), rather than
 * deleting addressed comments.
 */
export function buildInstructions(input: InstructionsInput): string {
  const { docPath, comments, effort } = input;
  const pending = comments.filter((c) => !isResolved(c));
  const list = comments.length
    ? comments
        .map((c, i) => {
          const meta = [
            c.author ? `author: ${c.author}` : '',
            c.date ? `date: ${c.date}` : '',
            isResolved(c) ? 'already resolved' : '',
          ]
            .filter(Boolean)
            .join(', ');
          const body = c.body.replace(/\r?\n/g, '\n      ').trim();
          return `  ${i + 1}. (${meta || 'no metadata'})\n      ${body}`;
        })
        .join('\n')
    : '  (none)';

  const hint = EFFORT_HINT[effort] ? `\n${EFFORT_HINT[effort]}\n` : '';

  return `# Address review comments

You are revising a Markdown document to resolve the inline review comments it
contains, then saving it. Make the edits directly in the file.

## Target file

${docPath}

## Comment format

Review comments are stored as HTML comment blocks in this exact shape:

    <!-- mdc:comment
    author: <name>
    date: <date>

    <comment body — one or more lines>
    -->

Each comment refers to the Markdown block (heading, paragraph, list, etc.)
immediately ABOVE it. The file has ${comments.length} such comment block(s); ${pending.length} still need(s) work.

## Your task

For each \`mdc:comment\` block, in document order:

1. Read the comment body — it is a reviewer's note about the block above it.
2. Edit that block (and only what the note asks about) so the note is addressed.
3. Do NOT delete or move the comment block. Keep it exactly where it is, and keep
   its \`mdc:comment\`, \`author:\` and \`date:\` header lines and the blank line
   after them unchanged.
4. Append ONE new line to the END of the comment body, immediately before the
   closing \`-->\`, of the form:

       Resolved: <a short sentence describing what you changed>

5. If a comment body already contains a line starting with \`Resolved:\`, it has
   already been handled — leave that comment and the block above it untouched.

## Rules

- Change only prose a comment refers to, plus the \`Resolved:\` lines you add.
  Leave every other part of the document unchanged.
- Never write the sequence \`-->\` inside a comment body (it would end the block
  early); rephrase if necessary.
- Preserve the document's voice, formatting and heading structure.
- When you are finished, save the file.

## Comments currently in the file

${list}
${hint}`;
}

// ---------------------------------------------------------------------------
// Invocation
// ---------------------------------------------------------------------------

export interface Invocation {
  bin: string;
  args: string[];
}

export interface InvocationInput {
  agent: AgentId;
  runMode: RunMode;
  model: string;
  effort: Effort;
  /** The prompt argv value (full instructions for headless; a short pointer
   *  to the instructions file for terminal — the caller decides). */
  prompt: string;
}

/**
 * Turn the user's choices into a concrete `{ bin, args }` to run. Headless runs
 * add the agent's "act autonomously / accept edits" flags so the file is
 * actually written without an interactive approval; terminal runs keep the
 * session interactive (still seeded with the prompt) so the user can watch.
 */
export function buildInvocation(input: InvocationInput): Invocation {
  const { agent, runMode, model, effort, prompt } = input;
  const bin = resolveBin(agent);
  const headless = runMode === 'headless';

  switch (agent) {
    case 'claude-code': {
      const args: string[] = [];
      if (model) {
        args.push('--model', model);
      }
      // Headless must write files without prompting (acceptEdits) and print
      // non-interactively (-p). Terminal mode stays interactive so the user
      // watches and approves edits as they go.
      if (headless) {
        args.push('--permission-mode', 'acceptEdits', '-p');
      }
      args.push(prompt);
      return { bin, args };
    }

    case 'codex': {
      const args: string[] = [];
      if (headless) {
        args.push('exec');
      }
      if (model) {
        args.push('--model', model);
      }
      // Native reasoning-effort knob (no shell quoting here — argv is passed
      // directly for headless, and the terminal quoter wraps it as needed).
      args.push('-c', `model_reasoning_effort=${effort}`);
      if (headless) {
        args.push('--full-auto');
      }
      args.push(prompt);
      return { bin, args };
    }

    case 'copilot': {
      const args: string[] = [];
      if (model) {
        args.push('--model', model);
      }
      if (headless) {
        args.push('--allow-all-tools', '-p');
      }
      args.push(prompt);
      return { bin, args };
    }

    case 'antigravity': {
      const args: string[] = [];
      if (model) {
        args.push('--model', model);
      }
      if (headless) {
        args.push('-p');
      }
      args.push(prompt);
      return { bin, args };
    }
  }
}

// ---------------------------------------------------------------------------
// Terminal command-line quoting
// ---------------------------------------------------------------------------

/** Render an `{ bin, args }` as a single shell command line for a terminal. */
export function toCommandLine(inv: Invocation, platform: NodeJS.Platform = process.platform): string {
  return [inv.bin, ...inv.args].map((a) => quoteArg(a, platform)).join(' ');
}

function quoteArg(arg: string, platform: NodeJS.Platform): string {
  // Bare, shell-safe tokens (flags, simple model names, paths without spaces)
  // are passed through unquoted.
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) {
    return arg;
  }
  if (platform === 'win32') {
    // PowerShell / cmd: double-quote, doubling embedded quotes.
    return `"${arg.replace(/"/g, '""')}"`;
  }
  // POSIX: single-quote, closing/escaping/reopening for embedded single quotes.
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}
