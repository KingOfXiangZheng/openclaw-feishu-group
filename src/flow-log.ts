/**
 * Flow Log Module
 *
 * Writes structured conversation flow logs to per-group files.
 * Files are stored at: ~/.openclaw/flow-logs/<chatId>.log
 *
 * Each line is a timestamped flow event showing sender, receiver,
 * trigger source, and a short content preview.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const FLOW_LOG_DIR = path.join(os.homedir(), ".openclaw", "flow-logs");

let dirEnsured = false;

function ensureDir(): void {
  if (dirEnsured) return;
  fs.mkdirSync(FLOW_LOG_DIR, { recursive: true });
  dirEnsured = true;
}

function preview(s: string | undefined): string {
  if (!s) return "";
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length > 10 ? clean.slice(0, 10) + "..." : clean;
}

function ts(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function appendLine(chatId: string, line: string): void {
  ensureDir();
  const file = path.join(FLOW_LOG_DIR, `${chatId}.log`);
  fs.appendFileSync(file, `[${ts()}] ${line}\n`);
}

/** User/bot → bot (received message) */
export function flowReceived(params: {
  chatId: string;
  sender: string;
  receiver: string;
  type: "mention" | "group" | "DM" | "relay" | "skip";
  content?: string;
  triggeredBy?: string;
}): void {
  const { chatId, sender, receiver, type, content, triggeredBy } = params;
  const p = preview(content);
  const extra = triggeredBy ? ` triggered_by=${triggeredBy}` : "";
  appendLine(chatId, `${sender} → ${receiver} (${type})${extra} ${p}`);
}

/** Bot sent reply */
export function flowReplied(params: {
  chatId: string;
  botName: string;
  triggeredBy?: string;
  content?: string;
}): void {
  const { chatId, botName, triggeredBy, content } = params;
  const p = preview(content);
  const extra = triggeredBy ? ` triggered_by=${triggeredBy}` : "";
  appendLine(chatId, `${botName} replied${extra} ${p}`);
}

/** Bot relay: bot A → @bot B */
export function flowRelay(params: {
  chatId: string;
  from: string;
  to: string;
  content?: string;
}): void {
  const { chatId, from, to, content } = params;
  const p = preview(content);
  appendLine(chatId, `${from} → @${to} (relay) ${p}`);
}
