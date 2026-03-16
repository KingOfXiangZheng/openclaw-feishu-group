/**
 * Bot-to-Bot Relay Module
 *
 * Enables bots to trigger each other via @mentions in group chats.
 * When a bot sends a message with @mention tags for other bots,
 * this module creates synthetic events to trigger the mentioned bots.
 *
 * Also provides dynamic teammate discovery for all agents.
 */

import type { ClawdbotConfig, RuntimeEnv, HistoryEntry } from "openclaw/plugin-sdk";
import type { FeishuMessageEvent } from "./bot.js";
import { handleFeishuMessage } from "./bot.js";

// Bot registry: maps bot OpenID to { accountId, name, specialty }
interface BotInfo {
  accountId: string;
  openId: string;
  name: string;
  specialty?: string;
}
const botRegistry = new Map<string, BotInfo>();

// Config and runtime references for relay
let relayConfig: ClawdbotConfig | null = null;
let relayRuntime: RuntimeEnv | null = null;
// Shared chat histories reference
let relayChatHistories: Map<string, HistoryEntry[]> | null = null;

/**
 * Register a bot for relay (called during monitor startup).
 * Bot name and specialty are resolved from probe result and account config — no hardcoding.
 */
export function registerBotForRelay(params: {
  accountId: string;
  botOpenId: string;
  botName?: string;
  specialty?: string;
  cfg: ClawdbotConfig;
  runtime?: RuntimeEnv;
  chatHistories: Map<string, HistoryEntry[]>;
}): void {
  const { accountId, botOpenId, botName, specialty, cfg, runtime, chatHistories } = params;

  const resolvedName = botName ?? accountId;

  const botInfo: BotInfo = {
    accountId,
    openId: botOpenId,
    name: resolvedName,
    specialty,
  };

  botRegistry.set(botOpenId, botInfo);
  relayConfig = cfg;
  relayRuntime = runtime ?? null;
  relayChatHistories = chatHistories;
  runtime?.log?.(`bot-relay: registered ${accountId} as "${resolvedName}" (${botOpenId})${specialty ? `, specialty: ${specialty}` : ""}, total bots: ${botRegistry.size}`);
}

/**
 * Unregister a bot from relay
 */
export function unregisterBotFromRelay(botOpenId: string): void {
  botRegistry.delete(botOpenId);
}

// Per-group bot presence: tracks which bots are active in which groups.
// Key: chatId, Value: Set of accountIds seen in that group.
const groupPresence = new Map<string, Set<string>>();

/**
 * Record that a bot is present in a group (called when bot processes a message in that group).
 */
export function markBotPresentInGroup(chatId: string, accountId: string): void {
  let members = groupPresence.get(chatId);
  if (!members) {
    members = new Set();
    groupPresence.set(chatId, members);
  }
  members.add(accountId);
}

/**
 * Get all registered teammates that are present in a specific group (excluding the current bot).
 * Returns formatted string for injection into agent context.
 */
export function getTeammatesContext(excludeAccountId?: string, chatId?: string): string {
  const presentAccountIds = chatId ? groupPresence.get(chatId) : undefined;

  const teammates = Array.from(botRegistry.values())
    .filter(bot => {
      if (bot.accountId === excludeAccountId) return false;
      // If we have group presence data, only include bots seen in this group
      if (presentAccountIds) return presentAccountIds.has(bot.accountId);
      return true;
    });

  if (teammates.length === 0) {
    return "";
  }

  const lines = [
    "",
    "## 🤝 群内可用的 AI 队友",
    "",
    "你可以 @mention 以下队友来协作：",
    "",
    "| 队友 | 专长 | @mention 格式 |",
    "|------|------|---------------|",
  ];

  for (const bot of teammates) {
    const mentionFormat = `\`<at user_id="${bot.openId}">${bot.name}</at>\``;
    lines.push(`| **${bot.name}** | ${bot.specialty ?? "通用"} | ${mentionFormat} |`);
  }

  lines.push("");
  lines.push("### 如何正确 @mention");
  lines.push("");
  lines.push("在你的回复中直接写入 `<at user_id=\"...\">名字</at>` 格式。");
  lines.push("");
  lines.push("⚠️ 必须使用 `<at user_id=\"...\">` 格式，纯文本 `@名字` 不会触发队友。");
  lines.push("");

  return lines.join("\n");
}

/**
 * Parse @mention tags from bot reply text
 * Format: <at user_id="ou_xxx">Name</at>
 */
export function parseMentionTags(text: string): { openId: string; name: string }[] {
  const regex = /<at\s+user_id="(ou_[a-f0-9]+)"[^>]*>([^<]*)<\/at>/gi;
  const mentions: { openId: string; name: string }[] = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    mentions.push({ openId: match[1], name: match[2] });
  }
  return mentions;
}

/**
 * Check if an OpenID belongs to a registered bot
 */
export function isBotOpenId(openId: string): boolean {
  return botRegistry.has(openId);
}

/**
 * Get accountId for a bot OpenID
 */
export function getBotAccountId(openId: string): string | undefined {
  return botRegistry.get(openId)?.accountId;
}

/**
 * Get bot info by OpenID
 */
export function getBotInfo(openId: string): BotInfo | undefined {
  return botRegistry.get(openId);
}

/**
 * Trigger relay for mentioned bots
 * Called after a bot sends a reply
 */
export async function triggerBotRelay(params: {
  sourceAccountId: string;
  sourceBotName: string;
  chatId: string;
  messageText: string;
  originalMessageId?: string;
}): Promise<void> {
  if (!relayConfig || !relayChatHistories) {
    return;
  }

  const { sourceAccountId, sourceBotName, chatId, messageText, originalMessageId } = params;
  const mentions = parseMentionTags(messageText);
  
  // Find bots that were mentioned (ignore self)
  const botMentions = mentions.filter(m => {
    if (!isBotOpenId(m.openId)) return false;

    const targetAccountId = getBotAccountId(m.openId);
    if (!targetAccountId) return false;

    // ignore self mention
    return targetAccountId !== sourceAccountId;
  });
  if (botMentions.length === 0) {
    return;
  }

  relayRuntime?.log?.(`bot-relay: ${sourceAccountId} mentioned ${botMentions.length} bot(s): ${botMentions.map(m => m.name).join(", ")}`);

  // Trigger each mentioned bot with a synthetic event
  for (const mention of botMentions) {
    const targetAccountId = getBotAccountId(mention.openId);
    if (!targetAccountId) continue;

    // Create synthetic event that looks like a user message
    const syntheticEvent: FeishuMessageEvent = {
      message: {
        message_id: `synthetic_${Date.now()}_${targetAccountId}`,
        chat_id: chatId,
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: messageText }),
        mentions: [{ id: { open_id: mention.openId }, name: mention.name, key: "@_user_1" }],
      },
      sender: {
        sender_id: { open_id: `bot_${sourceAccountId}` },
        sender_type: "bot",
      },
      // Mark as synthetic for potential special handling
      _synthetic: true,
      _sourceBot: sourceAccountId,
      _sourceBotName: sourceBotName,
    } as FeishuMessageEvent & { _synthetic?: boolean; _sourceBot?: string; _sourceBotName?: string };

    try {
      await handleFeishuMessage({
        cfg: relayConfig,
        event: syntheticEvent,
        botOpenId: mention.openId,
        runtime: relayRuntime ?? undefined,
        chatHistories: relayChatHistories,
        accountId: targetAccountId,
      });
      relayRuntime?.log?.(`bot-relay: triggered ${targetAccountId} successfully`);
    } catch (err) {
      relayRuntime?.error?.(`bot-relay: failed to trigger ${targetAccountId}: ${String(err)}`);
    }
  }
}

/**
 * Get all registered bots info
 */
export function getRegisteredBots(): { openId: string; accountId: string; name: string }[] {
  return Array.from(botRegistry.entries()).map(([openId, info]) => ({
    openId,
    accountId: info.accountId,
    name: info.name,
  }));
}

/**
 * Resolve a display name for a sender ID (openId or accountId).
 * Looks up the bot registry; returns undefined if not found.
 */
export function resolveBotDisplayName(id: string): string | undefined {
  // Try by openId first
  const byOpenId = botRegistry.get(id);
  if (byOpenId) return byOpenId.name;

  // Try by accountId
  for (const info of botRegistry.values()) {
    if (info.accountId === id) return info.name;
  }

  return undefined;
}

