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
      if (presentAccountIds) return presentAccountIds.has(bot.accountId);
      return true;
    });

  if (teammates.length === 0) {
    return "";
  }

  const teammateList = teammates
      .map(bot =>
          `${bot.name}（${bot.specialty ?? "通用"}） <at user_id="${bot.openId}">${bot.name}</at>`
      )
      .join("\n");

  const lines = [
    "",
    "[System: 群内其他 AI 队友]",
    "",
    teammateList,
    "",
    "⚠️ 重要规则：",
    "",
    "2. 提醒：",
    "   - @mention 应该遵守：若无其他需求，相互直接@mention后结束@mention，因为@mention后对方必然会回答，防止出现死循环",
    "",
    "3. @mention 格式：<at user_id=\"openId\">名字</at>"
  ];

  for (const bot of teammates) {
    lines.push(`   - 若要联系${bot.name}请按照输出： <at user_id="${bot.openId}">${bot.name}</at>`);
  }
  lines.push("   ！！！请严格按照这种格式进行@mention,不要按照名字（例如@quinn）,否则对方无法收到消息！！！");
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

// --- Fan-out / Gather mechanism ---
// When bot A @mentions B and C, A waits for B and C to reply back before continuing.

const GATHER_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

interface GatherEntry {
  /** accountId of the bot that replied */
  accountId: string;
  botName: string;
  body: string;
}

interface PendingGather {
  /** accountId of the bot that initiated the fan-out */
  sourceAccountId: string;
  sourceBotName: string;
  chatId: string;
  /** accountIds we're waiting for */
  pendingAccountIds: Set<string>;
  /** Replies collected so far */
  replies: GatherEntry[];
  /** Resolve the promise when gather completes */
  resolve: (replies: GatherEntry[]) => void;
  /** Timeout handle */
  timer: ReturnType<typeof setTimeout>;
}

// Key: "chatId:sourceAccountId" → only one active gather per bot per chat
const pendingGathers = new Map<string, PendingGather>();

function gatherKey(chatId: string, sourceAccountId: string): string {
  return `${chatId}:${sourceAccountId}`;
}

/**
 * Create a pending gather and return a promise that resolves when all expected bots reply
 * or when the timeout expires.
 */
function createGather(params: {
  sourceAccountId: string;
  sourceBotName: string;
  chatId: string;
  expectedAccountIds: string[];
}): Promise<GatherEntry[]> {
  const { sourceAccountId, sourceBotName, chatId, expectedAccountIds } = params;
  const key = gatherKey(chatId, sourceAccountId);

  // Cancel any existing gather for this bot in this chat
  const existing = pendingGathers.get(key);
  if (existing) {
    clearTimeout(existing.timer);
    existing.resolve(existing.replies);
    pendingGathers.delete(key);
  }

  return new Promise<GatherEntry[]>((resolve) => {
    const timer = setTimeout(() => {
      const gather = pendingGathers.get(key);
      if (gather) {
        relayRuntime?.log?.(`bot-relay: gather timeout for ${sourceAccountId} in ${chatId}, got ${gather.replies.length}/${expectedAccountIds.length} replies`);
        pendingGathers.delete(key);
        resolve(gather.replies);
      }
    }, GATHER_TIMEOUT_MS);

    pendingGathers.set(key, {
      sourceAccountId,
      sourceBotName,
      chatId,
      pendingAccountIds: new Set(expectedAccountIds),
      replies: [],
      resolve,
      timer,
    });
  });
}

/**
 * Called when a bot sends a reply that @mentions another bot.
 * If the mentioned bot has a pending gather waiting for this reply, record it.
 * Returns true if this reply was consumed by a gather (i.e. the replying bot was expected).
 */
export function notifyGather(params: {
  replierAccountId: string;
  replierName: string;
  chatId: string;
  replyText: string;
  mentionedBotAccountIds: string[];
}): boolean {
  const { replierAccountId, replierName, chatId, replyText, mentionedBotAccountIds } = params;
  let consumed = false;

  for (const targetAccountId of mentionedBotAccountIds) {
    const key = gatherKey(chatId, targetAccountId);
    const gather = pendingGathers.get(key);
    if (!gather) continue;
    if (!gather.pendingAccountIds.has(replierAccountId)) continue;

    // Record this reply
    gather.replies.push({
      accountId: replierAccountId,
      botName: replierName,
      body: replyText,
    });
    gather.pendingAccountIds.delete(replierAccountId);
    consumed = true;

    relayRuntime?.log?.(`bot-relay: gather for ${targetAccountId} received reply from ${replierAccountId}, remaining: ${gather.pendingAccountIds.size}`);

    // If all expected replies received, resolve immediately
    if (gather.pendingAccountIds.size === 0) {
      clearTimeout(gather.timer);
      pendingGathers.delete(key);
      gather.resolve(gather.replies);
    }
  }

  return consumed;
}

/**
 * Trigger relay for mentioned bots (simple version - no gather/summary)
 * Called after a bot sends a reply.
 * Sends synthetic events to mentioned bots, they will reply independently.
 */
export function triggerBotRelay(params: {
  sourceAccountId: string;
  sourceBotName: string;
  chatId: string;
  messageText: string;
  originalMessageId?: string;
}): void {
  if (!relayConfig || !relayChatHistories) {
    return;
  }

  const { sourceAccountId, sourceBotName, chatId, messageText } = params;
  const mentions = parseMentionTags(messageText);
  
  // Find bots that were mentioned (ignore self)
  const botMentions = mentions.filter(m => {
    if (!isBotOpenId(m.openId)) return false;
    const targetAccountId = getBotAccountId(m.openId);
    if (!targetAccountId) return false;
    return targetAccountId !== sourceAccountId;
  });

  if (botMentions.length === 0) {
    return;
  }

  relayRuntime?.log?.(`bot-relay: ${sourceBotName} mentioned ${botMentions.length} bot(s): ${botMentions.map(m => m.name).join(", ")}`);

  // Trigger each mentioned bot with a synthetic event
  for (const mention of botMentions) {
    const targetAccountId = getBotAccountId(mention.openId);
    if (!targetAccountId) continue;

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
      _synthetic: true,
      _sourceBot: sourceAccountId,
      _sourceBotName: sourceBotName,
    } as FeishuMessageEvent & { _synthetic?: boolean; _sourceBot?: string; _sourceBotName?: string };

    try {
      handleFeishuMessage({
        cfg: relayConfig,
        event: syntheticEvent,
        botOpenId: mention.openId,
        runtime: relayRuntime ?? undefined,
        chatHistories: relayChatHistories,
        accountId: targetAccountId,
      }).catch(err => {
        relayRuntime?.error?.(`bot-relay: failed to trigger ${targetAccountId}: ${String(err)}`);
      });
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

  // Try stripping "bot_" prefix (synthetic event senders use "bot_<accountId>")
  if (id.startsWith("bot_")) {
    const stripped = id.slice(4);
    const byStrippedOpenId = botRegistry.get(stripped);
    if (byStrippedOpenId) return byStrippedOpenId.name;
    for (const info of botRegistry.values()) {
      if (info.accountId === stripped) return info.name;
    }
  }

  return undefined;
}

