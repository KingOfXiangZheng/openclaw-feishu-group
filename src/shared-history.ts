/**
 * Shared History Module
 * 
 * Provides persistent, cross-bot chat history storage.
 * All bots in the same group chat share the same history file.
 * 
 * History files are stored at: ~/.openclaw/shared-history/<chatId>.jsonl
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface SharedHistoryEntry {
  timestamp: number;
  messageId: string;
  sender: string;        // openId of sender (user or bot)
  senderName?: string;   // display name
  senderType: "user" | "bot";
  botAccountId?: string; // which bot sent this (if senderType is "bot")
  body: string;
}

const HISTORY_DIR = path.join(os.homedir(), ".openclaw", "shared-history");
const MAX_HISTORY_ENTRIES = 50;
const botNameDict: Record<string, string> = {
  "cli_a92490cee8b85cc7": "Quinn",
  "cli_a911b6848cb89cb0": "Alex",
  "cli_a8f2d86efc22d01c": "Nova",
  "cli_a8f2dafa39a3101c": "Mia",
  "cli_a927c63b1578dcb6": "Luma",
  "cli_a927c0d3a4f89cc2": "Caleb",
  "ou_f847776208327494ad1de1a70176aae3":"boss(用户)"
};
// Ensure directory exists
function ensureHistoryDir(): void {
  if (!fs.existsSync(HISTORY_DIR)) {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
  }
}

function getHistoryFilePath(chatId: string): string {
  // Sanitize chatId for filesystem
  const safeId = chatId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(HISTORY_DIR, `${safeId}.jsonl`);
}

/**
 * Append a history entry to the shared history file
 */
export function appendSharedHistory(chatId: string, entry: SharedHistoryEntry): void {
  ensureHistoryDir();
  const filePath = getHistoryFilePath(chatId);
  const line = JSON.stringify(entry) + "\n";
  fs.appendFileSync(filePath, line, "utf-8");
}

/**
 * Read recent history entries from the shared history file
 */
export function readSharedHistory(chatId: string, limit: number = MAX_HISTORY_ENTRIES): SharedHistoryEntry[] {
  const filePath = getHistoryFilePath(chatId);
  
  if (!fs.existsSync(filePath)) {
    return [];
  }
  
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);
  
  // Get last N entries
  const recentLines = lines.slice(-limit);
  
  return recentLines.map(line => {
    try {
      return JSON.parse(line) as SharedHistoryEntry;
    } catch {
      return null;
    }
  }).filter((e): e is SharedHistoryEntry => e !== null);
}

/**
 * Build context string from shared history for injection into agent prompt
 */
export function buildSharedHistoryContext(
  chatId: string,
  limit: number = MAX_HISTORY_ENTRIES,
  excludeMessageId?: string
): string {
  const entries = readSharedHistory(chatId, limit);
  
  if (entries.length === 0) {
    return "";
  }
  
  // Filter out the current message if provided
  const filtered = excludeMessageId 
    ? entries.filter(e => e.messageId !== excludeMessageId)
    : entries;
  
  if (filtered.length === 0) {
    return "";
  }
  
  const lines = filtered.map(e => {
    const name = e.senderName ?? e.sender;
    const resolvedName = botNameDict[name] ?? name;
    const prefix = e.senderType === "bot"
        ? `[Bot:${resolvedName ?? "unknown"}]`
        : name.startsWith("bot_")
            ? `[Bot:${botNameDict[name.slice(4)] ?? name}]`
            : "[User]";
    const resolvedName2 =
        botNameDict[name] ??
        (name.startsWith("bot_") ? botNameDict[name.slice(4)] : undefined) ??
        name;
    return `${prefix} ${resolvedName2}: ${e.body}`;
  });
  
  return `\n--- Recent Chat History (shared across all bots) ---\n${lines.join("\n")}\n--- End of History ---\n`;
}

// Persistent last-seen timestamps file
const LAST_SEEN_FILE = path.join(HISTORY_DIR, "_last_seen.json");

// In-memory cache, lazily loaded from disk
let lastSeenCache: Record<string, number> | null = null;

function loadLastSeen(): Record<string, number> {
  if (lastSeenCache) return lastSeenCache;
  try {
    if (fs.existsSync(LAST_SEEN_FILE)) {
      lastSeenCache = JSON.parse(fs.readFileSync(LAST_SEEN_FILE, "utf-8"));
      return lastSeenCache!;
    }
  } catch {
    // Corrupted file, start fresh
  }
  lastSeenCache = {};
  return lastSeenCache;
}

function saveLastSeen(): void {
  if (!lastSeenCache) return;
  ensureHistoryDir();
  fs.writeFileSync(LAST_SEEN_FILE, JSON.stringify(lastSeenCache), "utf-8");
}

function lastSeenKey(chatId: string, botAccountId: string): string {
  return `${chatId}:${botAccountId}`;
}

/**
 * Mark the current timestamp as "seen" for a bot in a chat.
 * Persisted to disk so it survives restarts.
 */
export function markSharedHistorySeen(chatId: string, botAccountId: string): void {
  const map = loadLastSeen();
  map[lastSeenKey(chatId, botAccountId)] = Date.now();
  saveLastSeen();
}

/**
 * Build incremental context: only entries from OTHER bots/users since this bot last saw the history.
 * Returns empty string if nothing new from others.
 */
export function buildIncrementalSharedHistoryContext(
  chatId: string,
  botAccountId: string,
  limit: number = MAX_HISTORY_ENTRIES,
): string {
  const map = loadLastSeen();
  const since = map[lastSeenKey(chatId, botAccountId)] ?? 0;

  const entries = readSharedHistory(chatId, limit);
  if (entries.length === 0) return "";

  // Only entries after the last time this bot saw the history,
  // and only from OTHER participants (other bots or users)
  const incremental = entries.filter(e =>
    e.timestamp > since && e.botAccountId !== botAccountId
  );

  if (incremental.length === 0) return "";

  const lines = incremental.map(e => {
    const name = e.senderName ?? e.sender;
    const resolvedName = botNameDict[name] ?? name;
    const prefix = e.senderType === "bot"
      ? `[Bot:${resolvedName ?? "unknown"}]`
      : name.startsWith("bot_")
        ? `[Bot:${botNameDict[name.slice(4)] ?? name}]`
        : "[User]";
    const resolvedName2 =
      botNameDict[name] ??
      (name.startsWith("bot_") ? botNameDict[name.slice(4)] : undefined) ??
      name;
    return `${prefix} ${resolvedName2}: ${e.body}`;
  });

  return `\n--- New messages from other participants ---\n${lines.join("\n")}\n--- End ---\n`;
}

/**
 * Record a user message to shared history
 */
export function recordUserMessage(params: {
  chatId: string;
  messageId: string;
  sender: string;
  senderName?: string;
  body: string;
}): void {
  appendSharedHistory(params.chatId, {
    timestamp: Date.now(),
    messageId: params.messageId,
    sender: params.sender,
    senderName: params.senderName,
    senderType: "user",
    body: params.body,
  });
}

/**
 * Record a bot reply to shared history
 */
export function recordBotReply(params: {
  chatId: string;
  messageId: string;
  botAccountId: string;
  botName?: string;
  body: string;
}): void {
  appendSharedHistory(params.chatId, {
    timestamp: Date.now(),
    messageId: params.messageId,
    sender: params.botAccountId,
    senderName: params.botName,
    senderType: "bot",
    botAccountId: params.botAccountId,
    body: params.body,
  });
}

