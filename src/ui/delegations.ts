import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readDelegation, type ListedDelegation } from "../runtime/delegations.ts";
import type { RecoveredRun } from "../runtime/result-store.ts";

export const DELEGATION_TRACE_FILE = "trace.jsonl";

export interface DelegationViewerContext {
  hasUI?: boolean;
  ui: {
    select(title: string, items: string[]): Promise<string | null | undefined>;
    notify(message: string, level?: "info" | "warning" | "error"): void;
    custom?: <T>(
      factory: (
        tui: { requestRender(): void },
        theme: {
          fg(color: string, text: string): string;
          bold(text: string): string;
        },
        keybindings: unknown,
        done: (value: T) => void,
      ) => {
        render(width: number): string[];
        handleInput(data: string): void;
        invalidate?(): void;
      },
      options?: {
        overlay?: boolean;
        overlayOptions?: {
          anchor?: string;
          width?: number | string;
          minWidth?: number;
          maxHeight?: number | string;
          margin?: number | { top?: number; right?: number; bottom?: number; left?: number };
        };
      },
    ) => Promise<T>;
  };
}

export interface DelegationViewerOptions {
  listDelegations: (status?: string, limit?: number) => ListedDelegation[];
  readDelegation: typeof readDelegation;
}

interface DelegationListItem {
  id: string;
  label: string;
  description: string;
  status: string;
  agent: string;
  modelRef: string;
}

interface DelegationSnapshot {
  id: string;
  agent: string;
  status: string;
  modelRef: string;
  runDir: string;
  rawOutputPath: string;
  stderrPath: string | null;
  summary: string | null;
  trace: string;
  rawOutput: string;
  stderr: string;
  usage: { input: number; output: number; totalTokens: number; model: string };
}

export async function openDelegationViewer(
  ctx: DelegationViewerContext,
  options: DelegationViewerOptions,
): Promise<void> {
  if (ctx.hasUI === false) return;

  const items = buildDelegationListItems(options.listDelegations(undefined, 100), options.readDelegation);
  if (items.length === 0) {
    ctx.ui.notify("No delegations found.", "info");
    return;
  }

  const selectedId = await chooseDelegation(ctx, items);
  if (!selectedId) return;

  await showDelegationDetails(ctx, selectedId, options.readDelegation);
}

export function buildDelegationListItems(
  delegations: ListedDelegation[],
  recover: typeof readDelegation,
): DelegationListItem[] {
  return delegations.map((delegation) => {
    const recovered = safeRecover(recover, delegation.id);
    const modelRef = recovered?.record.modelRef ?? "default";
    const status = recovered?.status?.status ?? delegation.status;
    const summary = recovered?.status?.summary ?? delegation.summary ?? "";
    const agent = delegation.agent;
    return {
      id: delegation.id,
      status,
      agent,
      modelRef,
      label: `${agent}  ${delegation.id}  [${status}]  ${modelRef}`,
      description: summary || recovered?.record.runDir || delegation.runDir,
    };
  });
}

async function chooseDelegation(ctx: DelegationViewerContext, items: DelegationListItem[]): Promise<string | null> {
  if (!ctx.ui.custom) {
    const labels = items.map((item) => item.label);
    const selected = await ctx.ui.select("Subagents", labels);
    return items.find((item) => item.label === selected)?.id ?? null;
  }

  return ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
    let selectedIndex = 0;
    let scrollOffset = 0;
    const visibleRows = Math.min(Math.max(items.length, 6), 14);

    const moveSelection = (delta: number) => {
      selectedIndex = Math.min(items.length - 1, Math.max(0, selectedIndex + delta));
      if (selectedIndex < scrollOffset) scrollOffset = selectedIndex;
      if (selectedIndex >= scrollOffset + visibleRows) scrollOffset = selectedIndex - visibleRows + 1;
      tui.requestRender();
    };

    return {
      render(width: number) {
        const innerWidth = Math.max(30, width - 2);
        const visibleItems = items.slice(scrollOffset, scrollOffset + visibleRows);
        const lines = [topBorder(theme, innerWidth)];
        lines.push(borderLine(theme, innerWidth, color(theme, "accent", bold(theme, "Background delegations"))));
        lines.push(borderLine(theme, innerWidth, color(theme, "muted", "agent · delegation id · status · model")));
        lines.push(borderLine(theme, innerWidth, ""));

        for (const item of visibleItems) {
          const absoluteIndex = scrollOffset + visibleItems.indexOf(item);
          const selected = absoluteIndex === selectedIndex;
          const prefix = selected ? "› " : "  ";
          lines.push(borderLine(theme, innerWidth, selected ? color(theme, "accent", `${prefix}${item.label}`) : `${prefix}${item.label}`));
          if (item.description) {
            lines.push(borderLine(theme, innerWidth, color(theme, "muted", `  ${item.description}`)));
          }
        }
        for (let index = visibleItems.length; index < visibleRows; index += 1) {
          lines.push(borderLine(theme, innerWidth, ""));
        }

        lines.push(borderLine(theme, innerWidth, ""));
        lines.push(borderLine(theme, innerWidth, color(theme, "dim", `↑↓/jk navigate • enter details • esc/q close (${selectedIndex + 1}/${items.length})`)));
        lines.push(bottomBorder(theme, innerWidth));
        return lines;
      },
      handleInput(data: string) {
        if (isUpKey(data)) return moveSelection(-1);
        if (isDownKey(data)) return moveSelection(1);
        if (isPageUpKey(data)) return moveSelection(-visibleRows);
        if (isPageDownKey(data)) return moveSelection(visibleRows);
        if (isEnterKey(data)) return done(items[selectedIndex]?.id ?? null);
        if (isCancelKey(data)) return done(null);
      },
      invalidate() {},
    };
  }, {
    overlay: true,
    overlayOptions: {
      anchor: "center",
      width: "78%",
      minWidth: 76,
      maxHeight: "82%",
      margin: 1,
    },
  });
}

async function showDelegationDetails(
  ctx: DelegationViewerContext,
  id: string,
  recover: typeof readDelegation,
): Promise<void> {
  if (!ctx.ui.custom) {
    const snapshot = await readSnapshot(id, recover);
    await ctx.ui.select(`Delegation ${id}`, formatSnapshotBody(snapshot).slice(0, 20));
    return;
  }

  let snapshot = await readSnapshot(id, recover);
  let timer: NodeJS.Timeout | undefined;

  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    let closed = false;
    let scrollFromBottom = 0;
    let lastBodySize = 0;
    const refresh = async () => {
      if (closed) return;
      snapshot = await readSnapshot(id, recover).catch(() => snapshot);
      tui.requestRender();
    };
    timer = setInterval(refresh, 900);

    return {
      render(width: number) {
        const innerWidth = Math.max(30, width - 2);
        const lines = [topBorder(theme, innerWidth)];
        lines.push(borderLine(theme, innerWidth, color(theme, "accent", bold(theme, `Delegation ${id}`))));
        lines.push(borderLine(theme, innerWidth, `${snapshot.agent} · ${snapshot.status}`));
        lines.push(borderLine(theme, innerWidth, `model: ${snapshot.usage.model || snapshot.modelRef || "default"}`));
        if (snapshot.usage.input > 0 || snapshot.usage.output > 0) {
          lines.push(borderLine(theme, innerWidth, `tokens: input=${snapshot.usage.input} output=${snapshot.usage.output} total=${snapshot.usage.totalTokens}`));
        }
        lines.push(borderLine(theme, innerWidth, color(theme, "dim", snapshot.runDir)));

        const body = formatSnapshotBody(snapshot).map((line) => {
          if (line === "Live trace" || line === "stderr" || line === "result") return color(theme, "muted", line);
          return line;
        });
        lastBodySize = body.length;
        const visibleBodyLines = 28;
        const maxScroll = Math.max(0, body.length - visibleBodyLines);
        scrollFromBottom = Math.min(scrollFromBottom, maxScroll);
        const start = Math.max(0, body.length - visibleBodyLines - scrollFromBottom);
        for (const line of body.slice(start, start + visibleBodyLines)) {
          lines.push(borderLine(theme, innerWidth, line));
        }

        lines.push(borderLine(theme, innerWidth, ""));
        const scrollLabel = maxScroll > 0 ? ` • scroll ${maxScroll - scrollFromBottom}/${maxScroll}` : "";
        lines.push(borderLine(theme, innerWidth, color(theme, "dim", `↑↓/jk scroll • pgup/pgdn fast • esc/q close${scrollLabel}`)));
        lines.push(bottomBorder(theme, innerWidth));
        return lines;
      },
      handleInput(data: string) {
        const maxScroll = Math.max(0, lastBodySize - 28);
        if (isCancelKey(data)) {
          closed = true;
          if (timer) clearInterval(timer);
          done();
        } else if (isUpKey(data)) {
          scrollFromBottom = Math.min(maxScroll, scrollFromBottom + 1);
          tui.requestRender();
        } else if (isDownKey(data)) {
          scrollFromBottom = Math.max(0, scrollFromBottom - 1);
          tui.requestRender();
        } else if (isPageUpKey(data)) {
          scrollFromBottom = Math.min(maxScroll, scrollFromBottom + 10);
          tui.requestRender();
        } else if (isPageDownKey(data)) {
          scrollFromBottom = Math.max(0, scrollFromBottom - 10);
          tui.requestRender();
        }
      },
      invalidate() {},
    };
  }, {
    overlay: true,
    overlayOptions: {
      anchor: "right-center",
      width: "72%",
      minWidth: 72,
      maxHeight: "86%",
      margin: 1,
    },
  });

  if (timer) clearInterval(timer);
}

async function readSnapshot(id: string, recover: typeof readDelegation): Promise<DelegationSnapshot> {
  const run = recover(id);
  const tracePath = path.join(run.record.runDir, DELEGATION_TRACE_FILE);
  const traceRaw = await fs.readFile(tracePath, "utf8").catch(() => "");
  const trace = tailLines(traceRaw, 120).map(formatTraceLine).filter((line): line is string => Boolean(line)).join("\n");
  const usage = extractUsageSummary(traceRaw, run.record.modelRef ?? "");

  return {
    id,
    agent: run.record.requestedAgent === run.record.canonicalAgent ? run.record.canonicalAgent : `${run.record.requestedAgent} -> ${run.record.canonicalAgent}`,
    status: run.status?.status ?? run.record.status,
    modelRef: run.record.modelRef ?? "default",
    runDir: run.record.runDir,
    rawOutputPath: run.result?.rawOutputPath ?? run.record.files.rawOutput,
    stderrPath: run.result?.stderrPath ?? (run.stderr ? run.record.files.stderr : null),
    summary: run.status?.summary ?? null,
    trace,
    rawOutput: run.rawOutput ?? "",
    stderr: run.stderr ?? "",
    usage,
  };
}

function formatSnapshotBody(snapshot: DelegationSnapshot): string[] {
  const body: string[] = [];
  if (snapshot.summary) {
    body.push("Summary");
    body.push(snapshot.summary);
    body.push("");
  }
  body.push("Live trace");
  body.push(...(snapshot.trace.trim() ? snapshot.trace.split(/\r?\n/) : ["(no trace events yet; waiting for child agent)"]));
  if (snapshot.stderr.trim()) {
    body.push("", "stderr", ...snapshot.stderr.split(/\r?\n/).filter(Boolean));
  }
  if (snapshot.rawOutput.trim()) {
    body.push("", "result", ...snapshot.rawOutput.split(/\r?\n/).filter(Boolean));
  }
  return body;
}

function safeRecover(recover: typeof readDelegation, id: string): RecoveredRun | null {
  try {
    return recover(id);
  } catch {
    return null;
  }
}

function formatTraceLine(raw: string): string | undefined {
  try {
    const record = JSON.parse(raw) as Record<string, unknown>;
    const ts = typeof record.ts === "string" ? record.ts.slice(11, 19) : "--:--:--";
    const type = typeof record.type === "string" ? record.type : "event";
    const turn = typeof record.turnIndex === "number" ? ` turn=${record.turnIndex}` : "";
    const tool = typeof record.toolName === "string" ? ` ${record.toolName}` : "";
    const status = typeof record.status === "string" ? ` ${record.status}` : "";
    const summary = typeof record.summary === "string" ? ` — ${record.summary}` : "";
    return `${ts} ${type}${turn}${tool}${status}${summary}`;
  } catch {
    return raw.trim() || undefined;
  }
}

function extractUsageSummary(rawTrace: string, fallbackModel: string) {
  let input = 0;
  let output = 0;
  let total = 0;
  let model = fallbackModel;
  for (const line of rawTrace.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (record.type !== "token_usage") continue;
      input += typeof record.input === "number" ? record.input : 0;
      output += typeof record.output === "number" ? record.output : 0;
      total += typeof record.totalTokens === "number" ? record.totalTokens : 0;
      if (typeof record.model === "string" && record.model) model = record.model;
    } catch {}
  }
  return { input, output, totalTokens: total || input + output, model };
}

function tailLines(text: string, count: number): string[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  return lines.slice(Math.max(0, lines.length - count));
}

function topBorder(theme: { fg(color: string, text: string): string }, innerWidth: number): string {
  return color(theme, "accent", `╭${"─".repeat(innerWidth)}╮`);
}

function bottomBorder(theme: { fg(color: string, text: string): string }, innerWidth: number): string {
  return color(theme, "accent", `╰${"─".repeat(innerWidth)}╯`);
}

function borderLine(theme: { fg(color: string, text: string): string }, innerWidth: number, text: string): string {
  return color(theme, "accent", "│") + padLine(text, innerWidth) + color(theme, "accent", "│");
}

function padLine(text: string, width: number): string {
  const clean = truncateToWidth(text, width);
  const padding = Math.max(0, width - visibleWidth(clean));
  return clean + " ".repeat(padding);
}

function truncateToWidth(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  const targetWidth = Math.max(0, width - 1);
  let currentWidth = 0;
  let output = "";
  for (let index = 0; index < text.length;) {
    const ansiMatch = /^\u001b\[[0-?]*[ -/]*[@-~]/.exec(text.slice(index));
    if (ansiMatch) {
      output += ansiMatch[0];
      index += ansiMatch[0].length;
      continue;
    }
    const char = text[index];
    if (!char || currentWidth + 1 > targetWidth) break;
    output += char;
    currentWidth += 1;
    index += char.length;
  }
  const reset = /\u001b\[/.test(output) ? "\u001b[0m" : "";
  return `${output}${reset}…`;
}

function visibleWidth(text: string): number {
  return text.replaceAll(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").length;
}

function color(theme: { fg(color: string, text: string): string }, colorName: string, text: string): string {
  try {
    return theme.fg(colorName, text);
  } catch {
    return text;
  }
}

function bold(theme: { bold(text: string): string }, text: string): string {
  try {
    return theme.bold(text);
  } catch {
    return text;
  }
}

function isUpKey(data: string): boolean {
  return data === "\u001b[A" || data === "k";
}

function isDownKey(data: string): boolean {
  return data === "\u001b[B" || data === "j";
}

function isPageUpKey(data: string): boolean {
  return data === "\u001b[5~";
}

function isPageDownKey(data: string): boolean {
  return data === "\u001b[6~";
}

function isEnterKey(data: string): boolean {
  return data === "\r" || data === "\n";
}

function isCancelKey(data: string): boolean {
  return data === "\u001b" || data === "q";
}
