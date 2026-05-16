# Custom-Forwarding-Discord-Bot

# Discord Quote Mirror Bot

A self-hosted Discord bot that watches a source bot (such as [Make it a Quote](https://top.gg/bot/make-it-a-quote)) and automatically forwards its image output to one or more target channels. Reactions from every copy of a message — the original quote, the source-bot post, and all mirrored copies — are merged into a single unified count displayed as interactive emoji buttons. Optionally, messages that reach a configurable reaction threshold are promoted to a dedicated highlights channel.

---

## Features

- **Multi-channel mirroring** — forwards source-bot messages to any number of target channels simultaneously.
- **Unified reaction buttons** — reactions on the source message, the original quoted message, and every mirrored copy are deduplicated and merged into live emoji buttons on all copies.
- **Highlights / viral detection** — when unique reactor count exceeds a configurable percentage of your human member role, the message is automatically reposted to a highlights channel.
- **Persistent state** — tracked messages and mirror mappings survive restarts via a JSON state file. Reaction state is rebuilt live from Discord on the next event.
- **Automatic pruning** — entries older than a configurable number of hours are pruned on startup and every 12 hours.
- **Edit and delete propagation** — edits and deletions on the source message are propagated to all mirrors and highlight copies.
- **Both Make it a Quote invocation styles** — handles both the reply-mention style (`@QuoteBot`) and the right-click Apps menu style, correctly syncing reactions from the original quoted message in either case.
- **Special user messages** — append a custom italic footer to any mirrored quote authored by a configured user ID.
- **Greeting message** — responds with a configurable message when the bot is @mentioned without a reply context.
- **`/reload` slash command** — moderator-only command that re-syncs all state entries: forwards any missing mirrors, fixes emoji counts, and checks highlight eligibility for every tracked message.
- **Background startup reload** — the startup sync runs in the background so the bot is fully responsive to new events immediately.

---

## Requirements

- Node.js v18 or later
- A Discord bot token with the following privileged intents enabled in the [Discord Developer Portal](https://discord.com/developers/applications):
  - **Server Members Intent** (required for accurate human role member counts)
  - **Message Content Intent**

---

## Installation

```bash
git clone https://github.com/your-username/your-repo.git
cd your-repo
npm install discord.js
```

---

## Configuration

All configuration is done through environment variables. There is no config file.

### Required

| Variable | Description |
|---|---|
| `DISCORD_BOT_TOKEN` | Your bot's token from the Discord Developer Portal. |
| `SOURCE_BOT_ID` | User ID(s) of the bot(s) whose messages should be mirrored. Comma-separated for multiple. |
| `TARGET_CHANNEL_ID` | Channel ID(s) to forward messages into. Comma-separated for multiple. |
| `IGNORED_CHANNEL_ID` | Channel ID(s) where source-bot messages should be ignored. Comma-separated. Set to a dummy value (e.g. `0`) if you don't need this. |

### Optional — Highlights

| Variable | Description | Default |
|---|---|---|
| `HIGHLIGHT_ID` | Channel ID for the highlights channel. Leave unset to disable highlights entirely. | *(disabled)* |
| `HUMAN_ROLE_ID` | Role ID whose member count is used as the highlight threshold denominator. Required if `HIGHLIGHT_ID` is set. | — |
| `HIGHLIGHT_PERCENTAGE` | Percentage of human role members (0–100) that must have reacted for a message to be highlighted. Set to `0` to highlight every message with at least one reaction. | `0` |

### Optional — Moderation & Behaviour

| Variable | Description | Default |
|---|---|---|
| `MOD_ID` | Role ID whose members are allowed to use the `/reload` command. | *(command disabled)* |
| `TIMEOUT` | Hours after which mirror entries are pruned. Set to `0` to disable pruning. | `168` (7 days) |
| `STATE_FILE` | Path to the JSON state file. | `./mirror-state.json` |
| `GREETING_MESSAGE` | Message sent when the bot is @mentioned without a reply context. | *(no greeting)* |
| `SPECIAL_USER_MESSAGES` | Per-user italic footers appended to mirrored quotes. Format: `USER_ID=Message text,USER_ID2=Other text`. | *(none)* |

### Example `.env`

```env
DISCORD_BOT_TOKEN=your-token-here
SOURCE_BOT_ID=123456789012345678
TARGET_CHANNEL_ID=111111111111111111,222222222222222222
IGNORED_CHANNEL_ID=333333333333333333

MOD_ID=444444444444444444
HIGHLIGHT_ID=555555555555555555
HUMAN_ROLE_ID=666666666666666666
HIGHLIGHT_PERCENTAGE=10

TIMEOUT=168
STATE_FILE=./mirror-state.json
GREETING_MESSAGE=Hey! I mirror quotes from the quote bot.
SPECIAL_USER_MESSAGES=777777777777777777=A very special person ✨
```

---

## Running the Bot

```bash
node bot.js
```

Or with environment variables inline:

```bash
DISCORD_BOT_TOKEN=... SOURCE_BOT_ID=... TARGET_CHANNEL_ID=... IGNORED_CHANNEL_ID=... node bot.js
```

For persistent hosting, use a process manager like [PM2](https://pm2.keymetrics.io/):

```bash
npm install -g pm2
pm2 start bot.js --name quote-mirror
pm2 save
```

---

## How It Works

### Mirroring

When the source bot posts a message containing media (an image, video, or attachment), the mirror bot:

1. Extracts the media URL from the message's attachments, embed images, or inline content URLs.
2. Fetches author information from the quoted message reference chain.
3. Builds a formatted message containing a hidden markdown image link (so Discord unfurls it inline without a separate attachment), a jump link to the original, the source channel mention, and the quote author's name.
4. Sends the formatted message to every configured target channel.
5. Attaches emoji reaction buttons showing the current reaction counts, merged across all copies of the message.
6. Checks the highlight threshold and posts to the highlight channel if it is met.

Because the media is embedded as a hidden markdown link (`[ ](url)`) rather than a file attachment, the message can be edited in place when the source changes without losing its reactions.

### Reaction Sync

The bot maintains a single merged reaction state per source message, spanning:

- The source-bot message itself
- The original quoted message (the one the quote was made from)
- All mirrored copies in target channels
- The highlight copy (if sent)

When any reaction is added or removed on any of these messages, the state is rebuilt from scratch from Discord and pushed as updated buttons to all copies. The same user reacting on multiple copies counts only once.

### Invocation Style Detection

Make it a Quote supports two trigger styles, and the bot handles both:

- **Reply-mention style** — A user replies to message A with `@QuoteBot`. QuoteBot replies to that mention (B) with the quote (C). The bot follows the reference chain `C → B → A` to find the original.
- **Apps menu style** — A user right-clicks message A and uses the Apps menu. QuoteBot replies directly to A with the quote (C). The bot follows `C → A`.

In both cases, reactions from the original message A and the quote C are merged.

### State File

State is persisted to a JSON file on every change. The format is:

```json
{
  "savedAt": 1700000000000,
  "entries": {
    "<sourceMessageId>": {
      "sourceChannelId": "...",
      "quotedMessageId": "...",
      "mirrors": [
        {
          "mirroredId": "...",
          "targetChannelId": "...",
          "highlightId": "..." ,
          "mirroredAt": 1700000000000
        }
      ]
    }
  }
}
```

`quotedMessageId` is stored so that the O(1) reverse-lookup map (`quotedToSource`) can be restored on restart without fetching messages from Discord.

---

## Slash Commands

### `/reload`

Available to members with the configured `MOD_ID` role.

Runs a full three-pass re-sync across all state entries:

| Pass | Description |
|---|---|
| **Pass 1** | Forwards any source messages not yet mirrored to every target channel. |
| **Pass 2** | Re-syncs emoji button counts on every tracked message by pulling fresh reaction data from Discord. |
| **Pass 3** | Checks highlight eligibility for every tracked message that doesn't yet have a highlight copy. |

Results are reported ephemerally (visible only to the invoking moderator).

---

## Bot Permissions

The bot requires the following permissions in each relevant channel:

| Permission | Reason |
|---|---|
| **Read Messages / View Channel** | To see source-bot messages in monitored channels. |
| **Send Messages** | To post mirrored messages and highlights. |
| **Read Message History** | To fetch messages for reaction syncing and state rebuilding. |
| **Add Reactions** | Not strictly required, but recommended. |
| **Manage Messages** | To delete mirrored copies when the source is deleted or its media is removed. |

---

## Privileged Intents

Two privileged intents must be enabled in the Discord Developer Portal under **Bot → Privileged Gateway Intents**:

- **Server Members Intent** — used to fetch all guild members when computing the highlight threshold denominator.
- **Message Content Intent** — used to read message content for media URL extraction.

---

## Architecture Notes

The bot maintains five in-memory maps as its runtime state:

| Map | Key → Value | Purpose |
|---|---|---|
| `mirroredMessages` | `sourceId → MirrorEntry[]` | All mirror/highlight copies of each source message. |
| `sourceChannelMap` | `sourceId → channelId` | Where to fetch a source message from on reaction events. |
| `reactionState` | `sourceId → Map<emojiKey, Set<userId>>` | Merged reaction state across all copies. Not persisted. |
| `mirrorToSource` | `mirroredId / highlightId → sourceId` | O(1) reverse lookup for reactions on bot-sent copies. |
| `quotedToSource` | `quotedMessageId → sourceId` | O(1) reverse lookup for reactions on the original quoted message. Persisted. |

`reactionState` is intentionally not persisted — it would go stale while the bot is offline, and is cheaply rebuilt from Discord on the next reaction event.
