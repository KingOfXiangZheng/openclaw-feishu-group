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
import { recordBotReply } from "./shared-history.js";
import { triggerBotRelay } from "./bot-relay.js";
import { getBotLogName } from "./bot-relay.js";
import { flowReplied } from "./flow-log.js";

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
  relayChain?: string[];
};

export function createFeishuReplyDispatcher(params: CreateFeishuReplyDispatcherParams) {
  const core = getFeishuRuntime();
  const { cfg, agentId, chatId, replyToMessageId, mentionTargets, accountId } = params;
  const relayChain = params.relayChain ?? [];
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
  // Track the last text recorded to shared history to avoid duplicates
  // when deliver is called multiple times (block + final) with overlapping content.
  let lastRecordedText = "";

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
        params.runtime.log?.(`feishu[${getBotLogName(account.accountId, account.name)}] ${message}`),
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

        const botLogLabel = getBotLogName(account.accountId, account.name);
        const preview = text.replace(/\s+/g, " ").slice(0, 80);
        params.runtime.log?.(`feishu[${botLogLabel}]: sending reply to ${chatId} (kind=${info?.kind ?? "none"}, len=${text.length}) ${preview}...`);

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
            params.runtime.log?.(`feishu[${botLogLabel}]: streaming final to ${chatId} (len=${text.length})`);

            // Record bot reply BEFORE closeStreaming so that a streaming-close
            // failure does not prevent the entry from being persisted.
            if (chatId.startsWith("oc_")) {
              const botName = account.name ?? accountId;

              recordBotReply({
                chatId,
                messageId: `bot_${Date.now()}_${accountId}`,
                botAccountId: accountId,
                botName,
                body: text,
              });

              flowReplied({ chatId, botName, content: text });

              triggerBotRelay({
                sourceAccountId: accountId,
                sourceBotName: botName,
                chatId,
                messageText: text,
                relayChain,
              });
            }

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
        // Record on every deliver call (block or final) so no reply is lost.
        // Skip if the text is identical to the last recorded text (block→final overlap).
        if (chatId.startsWith("oc_") && text !== lastRecordedText) {
          const botName = account.name ?? accountId;

          recordBotReply({
            chatId,
            messageId: `bot_${Date.now()}_${accountId}`,
            botAccountId: accountId,
            botName,
            body: text,
          });

          flowReplied({ chatId, botName, content: text });

          // Trigger Bot-to-Bot relay only on final delivery (or when no kind is specified)
          // to avoid triggering relay prematurely on block deliveries.
          if (!info?.kind || info.kind === "final") {
            triggerBotRelay({
              sourceAccountId: accountId,
              sourceBotName: botName,
              chatId,
              messageText: text,
              relayChain,
            });
          }

          lastRecordedText = text;
        }
      },
      onError: async (error, info) => {
        const errDetail = (error as any)?.response?.data ? ` detail=${JSON.stringify((error as any).response.data)}` : "";
        params.runtime.error?.(
          `feishu[${getBotLogName(account.accountId, account.name)}] ${info.kind} reply failed: ${String(error)}${errDetail}`,
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
