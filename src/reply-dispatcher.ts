import {
  createReplyPrefixContext,
  createTypingCallbacks,
  logTypingFailure,
  type ClawdbotConfig,
  type ReplyPayload,
  type RuntimeEnv,
} from "openclaw/plugin-sdk";
import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { buildMentionedCardContent, type MentionTarget } from "./mention.js";
import { normalizeFeishuMarkdownLinks } from "./text/markdown-links.js";
import { getFeishuRuntime } from "./runtime.js";
import { sendMarkdownCardFeishu, sendMessageFeishu } from "./send.js";
import { FeishuStreamingSession } from "./streaming-card.js";
import { resolveReceiveIdType } from "./targets.js";
import { addTypingIndicator, removeTypingIndicator, type TypingIndicatorState } from "./typing.js";
// Shared history for cross-bot context
import { recordBotReply } from "./shared-history.js";
// Bot-to-Bot relay for triggering mentioned bots
import { triggerBotRelay, notifyGather, parseMentionTags, isBotOpenId, getBotAccountId, getRegisteredBots } from "./bot-relay.js";

/** Detect if text contains markdown elements that benefit from card rendering */
function shouldUseCard(text: string): boolean {
  return /```[\s\S]*?```/.test(text) || /\|.+\|[\r\n]+\|[-:| ]+\|/.test(text);
}

export type CreateFeishuReplyDispatcherParams = {
  cfg: ClawdbotConfig;
  agentId: string;
  runtime: RuntimeEnv;
  chatId: string;
  replyToMessageId?: string;
  mentionTargets?: MentionTarget[];
  accountId?: string;
};

export function createFeishuReplyDispatcher(params: CreateFeishuReplyDispatcherParams) {
  const core = getFeishuRuntime();
  const { cfg, agentId, chatId, replyToMessageId, mentionTargets, accountId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  const prefixContext = createReplyPrefixContext({ cfg, agentId });

  let typingState: TypingIndicatorState | null = null;
  const typingCallbacks = createTypingCallbacks({
    start: async () => {
      if (!replyToMessageId) {
        return;
      }
      typingState = await addTypingIndicator({ cfg, messageId: replyToMessageId, accountId });
    },
    stop: async () => {
      if (!typingState) {
        return;
      }
      await removeTypingIndicator({ cfg, state: typingState, accountId });
      typingState = null;
    },
    onStartError: (err) =>
      logTypingFailure({
        log: (message) => params.runtime.log?.(message),
        channel: "feishu",
        action: "start",
        error: err,
      }),
    onStopError: (err) =>
      logTypingFailure({
        log: (message) => params.runtime.log?.(message),
        channel: "feishu",
        action: "stop",
        error: err,
      }),
  });

  const textChunkLimit = core.channel.text.resolveTextChunkLimit(cfg, "feishu", account.accountId, {
    fallbackLimit: 4000,
  });
  const chunkMode = core.channel.text.resolveChunkMode(cfg, "feishu", account.accountId);
  const tableMode = core.channel.text.resolveMarkdownTableMode({
    cfg,
    channel: "feishu",
    accountId: account.accountId,
  });
  const renderMode = account.config?.renderMode ?? "auto";
  const streamingEnabled = account.config?.streaming === true && renderMode !== "raw";

  let streaming: FeishuStreamingSession | null = null;
  let streamText = "";
  let lastPartial = "";
  let partialUpdateQueue: Promise<void> = Promise.resolve();
  let streamingStartPromise: Promise<void> | null = null;

  const startStreaming = () => {
    if (!streamingEnabled || streamingStartPromise || streaming) {
      return;
    }
    streamingStartPromise = (async () => {
      const creds =
        account.appId && account.appSecret
          ? { appId: account.appId, appSecret: account.appSecret, domain: account.domain }
          : null;
      if (!creds) {
        return;
      }

      streaming = new FeishuStreamingSession(createFeishuClient(account), creds, (message) =>
        params.runtime.log?.(`feishu[${account.accountId}] ${message}`),
      );
      try {
        await streaming.start(chatId, resolveReceiveIdType(chatId), replyToMessageId);
      } catch (error) {
        params.runtime.error?.(`feishu: streaming start failed: ${String(error)}`);
        streaming = null;
      }
    })();
  };

  const closeStreaming = async () => {
    if (streamingStartPromise) {
      await streamingStartPromise;
    }
    await partialUpdateQueue;
    if (streaming?.isActive()) {
      let text = streamText;
      if (mentionTargets?.length) {
        text = buildMentionedCardContent(mentionTargets, text);
      }
      await streaming.close(normalizeFeishuMarkdownLinks(text));
    }
    streaming = null;
    streamingStartPromise = null;
    streamText = "";
    lastPartial = "";
  };

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      responsePrefix: prefixContext.responsePrefix,
      responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
      humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, agentId),
      onReplyStart: () => {
        if (streamingEnabled && renderMode === "card") {
          startStreaming();
        }
        void typingCallbacks.onReplyStart?.();
      },
      deliver: async (payload: ReplyPayload, info) => {
        const text = payload.text ?? "";
        if (!text.trim()) {
          return;
        }

        const useCard = renderMode === "card" || (renderMode === "auto" && shouldUseCard(text));

        if ((info?.kind === "block" || info?.kind === "final") && streamingEnabled && useCard) {
          startStreaming();
          if (streamingStartPromise) {
            await streamingStartPromise;
          }
        }

        if (streaming?.isActive()) {
          if (info?.kind === "final") {
            streamText = text;
            await closeStreaming();
          }
          return;
        }

        let first = true;
        if (useCard) {
          for (const chunk of core.channel.text.chunkTextWithMode(text, textChunkLimit, chunkMode)) {
            await sendMarkdownCardFeishu({
              cfg,
              to: chatId,
              text: chunk,
              replyToMessageId,
              mentions: first ? mentionTargets : undefined,
              accountId,
            });
            first = false;
          }
        } else {
          const converted = core.channel.text.convertMarkdownTables(text, tableMode);
          for (const chunk of core.channel.text.chunkTextWithMode(
            converted,
            textChunkLimit,
            chunkMode,
          )) {
            await sendMessageFeishu({
              cfg,
              to: chatId,
              text: chunk,
              replyToMessageId,
              mentions: first ? mentionTargets : undefined,
              accountId,
            });
            first = false;
          }
        }

        // Record bot reply to shared history (for cross-bot context)
        // Only record for group chats (chatId starts with "oc_")
        if (chatId.startsWith("oc_")) {
          const botName = account.name ?? accountId;

          recordBotReply({
            chatId,
            messageId: `bot_${Date.now()}_${accountId}`,
            botAccountId: accountId,
            botName,
            body: text,
          });

          // Notify any pending gathers that this bot has replied
          const mentionedBots = parseMentionTags(text)
            .filter(m => isBotOpenId(m.openId))
            .map(m => getBotAccountId(m.openId))
            .filter((id): id is string => !!id);

          if (mentionedBots.length > 0) {
            notifyGather({
              replierAccountId: accountId,
              replierName: botName,
              chatId,
              replyText: text,
              mentionedBotAccountIds: mentionedBots,
            });
          }

          // Trigger Bot-to-Bot relay if this message mentions other bots.
          // triggerBotRelay fans out to mentioned bots and waits for their replies (gather).
          // After gather completes, the collected replies are sent back as a synthetic
          // message to this bot so it can produce a summary.
          void (async () => {
            try {
              const replies = await triggerBotRelay({
                sourceAccountId: accountId,
                sourceBotName: botName,
                chatId,
                messageText: text,
              });

              if (replies.length > 0) {
                // Build a summary of collected replies and feed back to the source bot
                const summaryLines = replies.map(r => `[${r.botName}]: ${r.body}`);
                const summaryText = `以下是你 @mention 的队友的回复，请基于这些回复进行汇总：\n\n${summaryLines.join("\n\n")}`;

                // Find source bot's openId
                const sourceBotOpenId = getRegisteredBots()
                  .find(b => b.accountId === accountId)?.openId;

                if (sourceBotOpenId) {
                  const { handleFeishuMessage: handleMsg } = await import("./bot.js");
                  const syntheticGatherEvent = {
                    message: {
                      message_id: `gather_${Date.now()}_${accountId}`,
                      chat_id: chatId,
                      chat_type: "group" as const,
                      message_type: "text",
                      content: JSON.stringify({ text: summaryText }),
                      mentions: [{ id: { open_id: sourceBotOpenId }, name: botName, key: "@_user_1" }],
                    },
                    sender: {
                      sender_id: { open_id: "system_gather" },
                      sender_type: "system",
                    },
                    _synthetic: true,
                    _sourceBot: "gather",
                    _sourceBotName: "gather",
                  };

                  await handleMsg({
                    cfg,
                    event: syntheticGatherEvent as any,
                    botOpenId: sourceBotOpenId,
                    runtime: params.runtime,
                    accountId,
                  });
                }
              }
            } catch (err) {
              params.runtime.error?.(`feishu[${account.accountId}] gather relay failed: ${String(err)}`);
            }
          })();
        }
      },
      onError: async (error, info) => {
        params.runtime.error?.(
          `feishu[${account.accountId}] ${info.kind} reply failed: ${String(error)}`,
        );
        await closeStreaming();
        typingCallbacks.onIdle?.();
      },
      onIdle: async () => {
        await closeStreaming();
        typingCallbacks.onIdle?.();
      },
      onCleanup: () => {
        typingCallbacks.onCleanup?.();
      },
    });

  return {
    dispatcher,
    replyOptions: {
      ...replyOptions,
      onModelSelected: prefixContext.onModelSelected,
      onPartialReply: streamingEnabled
        ? (payload: ReplyPayload) => {
            const partialText = normalizeFeishuMarkdownLinks(payload.text ?? "");
            if (!partialText || partialText === lastPartial) {
              return;
            }
            lastPartial = partialText;
            streamText = partialText;
            partialUpdateQueue = partialUpdateQueue.then(async () => {
              if (streamingStartPromise) {
                await streamingStartPromise;
              }
              if (streaming?.isActive()) {
                await streaming.update(streamText);
              }
            });
          }
        : undefined,
    },
    markDispatchIdle,
  };
}
