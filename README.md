# clawd-feishu

飞书 (Feishu/Lark) 频道插件，用于 [OpenClaw](https://github.com/openclaw/openclaw)。

> [Wiki](https://github.com/m1heng/clawdbot-feishu/wiki) · [Discussions](https://github.com/m1heng/clawdbot-feishu/discussions) · [CONTRIBUTING.md](./CONTRIBUTING.md)

---

## 安装与升级

```bash
# 安装
openclaw plugins install @m1heng-clawd/feishu

# 升级
openclaw plugins update feishu

# 查看版本
openclaw plugins list | rg -i feishu
```

> Windows 如果 `openclaw plugins install` 失败，可手动下载 tarball 安装：
> ```bash
> npm pack @m1heng-clawd/feishu
> openclaw plugins install ./m1heng-clawd-feishu-<version>.tgz
> ```

---

## 核心功能

### 基础能力

- WebSocket / Webhook 两种连接模式
- 私聊 (DM) 和群聊
- 消息回复与引用上下文
- 图片/文件收发（入站 + 出站）
- 输入状态指示（emoji 反应）
- 卡片渲染模式（代码高亮、表格、链接）
- 私聊配对审批 (pairing) 流程

### 飞书工具集

| 工具 | 说明 |
|------|------|
| `feishu_doc` | 文档读写、创建、Markdown 导入 |
| `feishu_wiki` | 知识库空间浏览、搜索、节点管理 |
| `feishu_drive` | 云空间文件夹管理、文件操作 |
| `feishu_bitable` | 多维表格字段和记录的增删改查 |
| `feishu_task` | 任务创建、更新、删除（v2 API） |
| `feishu_perm` | 权限管理（可选，敏感） |

---

## 群聊多机器人协作（重点）

这是本插件最核心的差异化能力：在一个飞书群里放入多个 AI 机器人，它们各有专长，能自动发现彼此、共享上下文、互相协作。

### 架构概览

```
飞书群聊
├── 用户发消息 @Quinn "帮我做个市场调研"
│
├── Quinn（秘书）收到消息
│   ├── 看到 [Chat messages since your last reply] 了解上下文
│   ├── 看到 [System: 群内可协作的 AI 队友] 知道有哪些队友
│   ├── 判断需要 Alex（产品研究）协助
│   └── 回复中 @Alex，触发 bot-to-bot relay
│
├── Alex 被触发（synthetic event）
│   ├── 同样能看到群聊历史上下文
│   ├── 执行市场调研任务
│   └── 回复 @Quinn 交付结果
│
└── Quinn 收到 Alex 的回复（gather 机制）
    └── 汇总后回复用户
```

### 1. 队友自动发现

机器人不需要硬编码彼此的信息。每个机器人在群里处理消息时会自动注册自己的存在，其他机器人就能发现它。

配置每个机器人的身份：

```yaml
channels:
  feishu:
    accounts:
      quinn-bot:
        appId: "cli_xxx"
        appSecret: "secret"
        name: "Quinn"
        specialty: "个人秘书 - 日程管理、任务协调"
      alex-bot:
        appId: "cli_yyy"
        appSecret: "secret"
        name: "Alex"
        specialty: "产品趋势研究 - 市场情报、竞争分析"
      nova-bot:
        appId: "cli_zzz"
        appSecret: "secret"
        name: "Nova"
        specialty: "全栈工程师 - 前后端开发、架构设计"
```

每个机器人在群里说话后，其他机器人的上下文中会自动出现队友信息：

```
[System: 以下是群内可协作的 AI 队友信息，仅供你在需要时参考。]

- Alex（产品趋势研究 - 市场情报、竞争分析）: <at user_id="ou_xxx">Alex</at>
- Nova（全栈工程师 - 前后端开发、架构设计）: <at user_id="ou_yyy">Nova</at>

[规则]
- 只在你确实无法独立完成、且该任务明确属于某位队友专长时，才 @mention 队友。
- 不要为了展示队友列表或礼貌性介绍而 @mention，这会触发对方执行任务。
```

队友列表是按群隔离的 — 不同群里可能有不同的机器人组合。

### 2. 跨机器人共享历史

所有机器人共享同一份群聊历史（存储在 `~/.openclaw/shared-history/`），采用增量同步机制：

- 每个机器人只看到自己上次处理消息以来的新消息
- 用户消息和机器人回复都会被记录
- 去重机制避免同一条消息被多个机器人重复记录
- 时间戳持久化到磁盘，重启不丢失

这些跨机器人的历史条目会被合并到 `[Chat messages since your last reply]` 中，和 OpenClaw 自身的会话历史无缝融合，而不是作为单独的块出现。

### 3. Bot-to-Bot Relay（机器人互相触发）

当机器人 A 的回复中 @了机器人 B，系统会自动创建 synthetic event 触发 B：

- B 收到的消息包含完整的群聊上下文
- B 能看到共享历史，了解之前发生了什么
- B 的回复会被记录到共享历史中

#### Relay 深度限制

为防止机器人之间 @mention 形成无限循环，系统会追踪 relay 链的深度。超过上限后自动停止触发。

默认深度为 5，可全局或按群配置：

```yaml
channels:
  feishu:
    maxRelayDepth: 5          # 全局默认
    groups:
      oc_xxx:
        maxRelayDepth: 10     # 该群允许更深的对话链
      oc_yyy:
        maxRelayDepth: 2      # 该群严格限制
```

深度计算：用户直接 @bot 不计入深度。从第一次 bot-to-bot relay 开始计数，每转发一层 +1。

### 4. @全体成员 支持

在群里发送 @全体成员 会触发群内所有机器人响应，等同于逐个 @每个机器人。

### 5. @mention 转发

用户消息中 @的人会被自动传递到机器人回复中：

- 群聊：`@bot @张三 说你好` → 机器人回复自动 @张三
- 私聊：`@张三 说你好` → 机器人回复自动 @张三

### 6. @mention 名字保留

群聊历史中会保留 @mention 的实际名字，而不是显示 `@_user_1` 这样的占位符。例如用户发送 `@Quinn 你好`，历史中会显示 `@Quinn 你好` 而不是 `@_user_1 你好`。

### 7. 话题隔离会话

群聊支持按话题（thread）隔离会话，同一个群里不同话题的对话互不干扰：

```yaml
channels:
  feishu:
    groups:
      oc_xxx:
        topicSessionMode: "enabled"
```

### 8. 对话流程日志

系统会按群自动记录结构化的对话流程日志，存储在 `~/.openclaw/flow-logs/<chatId>.log`。

每行包含时间戳、发送人、接收人、触发类型和消息内容预览（前10字）：

```
[2026-03-17 14:30:05] 刘湘政 → Alex (mention) @产品Alex 让a...
[2026-03-17 14:30:06] Alex replied 收到，boss！👋...
[2026-03-17 14:30:06] Alex → @Nova (relay) 你好 Nova，我...
[2026-03-17 14:30:07] Nova replied 收到！技术方案...
```

触发类型说明：
- `mention` — 用户 @机器人
- `group` — 群消息（未 @）
- `DM` — 私聊
- `relay` — bot-to-bot 转发
- `skip` — 未被 @，跳过处理

---

## 配置

### 快速开始

1. 在 [飞书开放平台](https://open.feishu.cn) 创建自建应用
2. 获取 App ID 和 App Secret
3. 开启权限并配置事件订阅
4. 配置插件：

```bash
openclaw config set channels.feishu.appId "cli_xxxxx"
openclaw config set channels.feishu.appSecret "your_app_secret"
openclaw config set channels.feishu.enabled true
```

### 完整配置项

```yaml
channels:
  feishu:
    enabled: true
    appId: "cli_xxxxx"
    appSecret: "secret"
    domain: "feishu"              # "feishu" | "lark" | 自定义 URL
    connectionMode: "websocket"   # "websocket"（推荐）| "webhook"
    dmPolicy: "pairing"           # "pairing" | "open" | "allowlist"
    allowFrom: []                 # 私聊白名单（open_id/user_id）
    groupPolicy: "allowlist"      # "open" | "allowlist" | "disabled"
    requireMention: true          # 群聊是否需要 @机器人
    groupCommandMentionBypass: "single_bot"  # "never" | "single_bot" | "always"
    mediaMaxMb: 30
    renderMode: "auto"            # "auto" | "raw" | "card"
    maxRelayDepth: 5              # bot-to-bot relay 最大深度（默认 5）

    # 多账号（多机器人）配置
    accounts:
      bot-1:
        appId: "cli_xxx"
        appSecret: "secret"
        name: "Quinn"
        specialty: "个人秘书"
      bot-2:
        appId: "cli_yyy"
        appSecret: "secret"
        name: "Alex"
        specialty: "产品研究"
```

### 必需权限

| 权限 | 说明 |
|------|------|
| `im:message` | 发送和接收消息 |
| `im:message.p2p_msg:readonly` | 读取私聊消息 |
| `im:message.group_at_msg:readonly` | 接收群内 @机器人 消息 |
| `im:message:send_as_bot` | 以机器人身份发送消息 |
| `im:resource` | 上传和下载图片/文件 |

### 推荐权限

| 权限 | 说明 |
|------|------|
| `contact:user.base:readonly` | 获取用户姓名（群聊历史中显示真实姓名而非 ID） |

### 事件订阅 ⚠️

> 最容易遗漏的配置。如果机器人能发消息但收不到，检查这里。

在飞书开放平台 → 事件与回调：

1. 选择 **使用长连接接收事件**（对应 `websocket` 模式）
2. 添加事件：

| 事件 | 说明 |
|------|------|
| `im.message.receive_v1` | 接收消息（必需） |
| `im.message.message_read_v1` | 消息已读回执 |
| `im.chat.member.bot.added_v1` | 机器人进群 |
| `im.chat.member.bot.deleted_v1` | 机器人被移出群 |

### 私聊策略

| `dmPolicy` | 说明 |
|------------|------|
| `pairing` | 用户私聊获取配对码，管理员 `openclaw pairing approve feishu <code>` 审批 |
| `open` | 所有人可用（需设 `allowFrom: ["*"]`） |
| `allowlist` | 仅白名单用户 |

### 连接模式

| 模式 | 说明 |
|------|------|
| `websocket` | 默认推荐，无需公网地址 |
| `webhook` | 需要公网 URL，适合服务器部署 |

Webhook 额外配置：

```yaml
channels:
  feishu:
    connectionMode: "webhook"
    webhookPort: 3000
    webhookPath: "/feishu/events"
    encryptKey: "your_encrypt_key"
    verificationToken: "your_verify_token"
```

### 渲染模式

| 模式 | 说明 |
|------|------|
| `auto` | 自动检测：有代码块/表格用卡片，否则纯文本 |
| `raw` | 始终纯文本 |
| `card` | 始终卡片（完整 Markdown 渲染） |

---

## 资源访问注意事项

### 云空间 (Drive)

机器人没有自己的根目录，只能访问被分享给它的文件夹。需要手动将文件夹分享给机器人。

### 知识库 (Wiki)

API 权限不够，还需要在知识库空间设置中将机器人添加为成员。

### 多维表格 (Bitable)

同样需要将多维表格分享给机器人。支持 `/base/XXX` 和 `/wiki/XXX` 两种 URL 格式。

### 任务 (Task)

- 创建任务时建议将用户设为负责人，否则用户看不到任务
- 机器人只能给自己创建的任务添加子任务
- 任务清单的所有者建议保持为机器人

---

## 动态 Agent 创建

为每个私聊用户自动创建隔离的 agent 实例：

```yaml
channels:
  feishu:
    dynamicAgentCreation:
      enabled: true
      workspaceTemplate: "~/workspaces/feishu-{agentId}"
      agentDirTemplate: "~/.openclaw/agents/{agentId}/agent"
      maxAgents: 100
```

每个用户拥有独立的工作空间、对话历史和记忆文件。

---

## 工具权限速查

<details>
<summary>只读权限（最低要求）</summary>

| 权限 | 工具 |
|------|------|
| `docx:document:readonly` | `feishu_doc` |
| `drive:drive:readonly` | `feishu_drive` |
| `wiki:wiki:readonly` | `feishu_wiki` |
| `bitable:app:readonly` | `feishu_bitable` |
| `task:task:read` | `feishu_task_get` |
| `task:tasklist:read` | `feishu_tasklist_get/list` |
| `task:comment:read` | `feishu_task_comment_list/get` |
| `task:attachment:read` | `feishu_task_attachment_list/get` |

</details>

<details>
<summary>读写权限（创建/编辑/删除）</summary>

| 权限 | 工具 |
|------|------|
| `docx:document` | `feishu_doc` 创建/编辑 |
| `docx:document.block:convert` | Markdown 转 blocks |
| `drive:drive` | 上传图片、创建文件夹、移动/删除 |
| `wiki:wiki` | 创建/移动/重命名节点 |
| `bitable:app` | 多维表格增删改 |
| `task:task:write` | 任务增删改 |
| `task:tasklist:write` | 任务清单管理 |
| `task:comment:write` | 任务评论管理 |
| `task:attachment:write` | 任务附件管理 |

</details>

---

## FAQ

**机器人收不到消息？**
检查事件订阅配置，确认连接模式匹配。

**发消息 403？**
确认 `im:message:send_as_bot` 权限已通过。

**清除历史 / 新对话？**
发送 `/new` 命令。

**群聊历史中显示 ou_xxx 而不是名字？**
授予 `contact:user.base:readonly` 权限。

**机器人不知道群里有哪些队友？**
每个机器人需要在群里至少处理过一条消息才会被发现。可以 @全体成员 让所有机器人都响应一次。

---

## License

MIT
