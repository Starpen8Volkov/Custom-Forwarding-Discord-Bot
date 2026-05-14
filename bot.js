const { Client, GatewayIntentBits, Events } = require("discord.js");

// ── Configuration ────────────────────────────────────────────────────────────
// Each of these accepts comma-separated values, e.g. "123,456,789"
const SOURCE_BOT_IDS     = (process.env.SOURCE_BOT_ID     || "").split(",").map(s => s.trim()).filter(Boolean);
const TARGET_CHANNEL_IDS = (process.env.TARGET_CHANNEL_ID || "").split(",").map(s => s.trim()).filter(Boolean);
const IGNORED_CHANNEL_IDS= (process.env.IGNORED_CHANNEL_ID|| "").split(",").map(s => s.trim()).filter(Boolean);

// Format: "USER_ID=Some message,USER_ID2=Another message"
// Whenever a quote is authored by one of these users, the message is appended in italics.
const SPECIAL_USER_MESSAGES = Object.fromEntries(
  (process.env.SPECIAL_USER_MESSAGES || "")
    .split(",")
    .map(s => s.trim())
    .filter(s => s.includes("="))
    .map(s => {
      const idx = s.indexOf("=");
      return [s.slice(0, idx).trim(), s.slice(idx + 1).trim()];
    })
);

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
// ─────────────────────────────────────────────────────────────────────────────

if (!BOT_TOKEN) {
  console.error("❌  DISCORD_BOT_TOKEN environment variable is not set.");
  process.exit(1);
}
if (SOURCE_BOT_IDS.length === 0) {
  console.error("❌  SOURCE_BOT_ID environment variable is not set.");
  process.exit(1);
}
if (TARGET_CHANNEL_IDS.length === 0) {
  console.error("❌  TARGET_CHANNEL_ID environment variable is not set.");
  process.exit(1);
}
if (IGNORED_CHANNEL_IDS.length === 0) {
  console.error("❌  IGNORED_CHANNEL_ID environment variable is not set.");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
});

// Maps  sourceMessageId  →  { mirroredId, targetChannelId }[]
// One source message can be mirrored to multiple target channels.
const mirroredMessages = new Map();

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Collect every attachment URL + embed image/video URL from a message. */
function extractMedia(message) {
  const seen = new Set();
  const urls = [];

  function add(url) {
    if (url && !seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }

  // 1. Direct file attachments
  for (const attachment of message.attachments.values()) {
    add(attachment.url);
  }

  // 2. Embed fields — Make it a Quote posts the generated image here
  for (const embed of message.embeds) {
    add(embed.image?.url);
    add(embed.image?.proxyURL);
    add(embed.video?.url);
    add(embed.thumbnail?.url);
  }

  // 3. Raw image/video URLs in message content
  const urlPattern = /https?:\/\/\S+\.(?:png|jpe?g|gif|webp|mp4|mov|webm)(?:\?\S*)?/gi;
  const contentMatches = message.content.match(urlPattern) || [];
  for (const url of contentMatches) {
    add(url);
  }

  return urls;
}

/**
 * Attempt to extract the quote author's display name from a Make it a Quote message.
 *
 * Make it a Quote can be triggered two ways:
 *   A) Mention-style: the bot is @mentioned with a replied-to message.
 *      The source message has a `reference` pointing to the quoted message.
 *   B) App-command style: right-click → Apps → Make it a Quote.
 *      The embed's `description` or `footer` typically contains the author name,
 *      OR the `reference` is set to the original message.
 *
 * We try, in order:
 *   1. Fetch the referenced (replied-to) message and return its author.
 *   2. Parse the embed footer text (Make it a Quote puts "- AuthorName" there).
 *   3. Parse the embed description.
 *   4. Fall back to null.
 */
async function extractQuoteAuthor(message) {
  // 1. Try the message reference (works for both trigger styles)
  if (message.reference?.messageId) {
    try {
      const refChannel = await client.channels.fetch(message.reference.channelId);
      const refMessage = await refChannel.messages.fetch(message.reference.messageId);
      return {
        id:   refMessage.author.id,
        name: refMessage.member?.displayName || refMessage.author.displayName || refMessage.author.username,
      };
    } catch {
      // Reference message may be deleted — fall through
    }
  }

  // 2. Try embed footer — Make it a Quote formats it as "- Display Name\n@handle" or similar
  for (const embed of message.embeds) {
    const footer = embed.footer?.text || "";
    // Match "- SomeName" at the start of a line
    const footerMatch = footer.match(/^-\s+(.+)/m);
    if (footerMatch) return { id: null, name: footerMatch[1].trim() };

    // 3. Try embed description
    const desc = embed.description || "";
    const descMatch = desc.match(/^-\s+(.+)/m);
    if (descMatch) return { id: null, name: descMatch[1].trim() };
  }

  return null;
}

/**
 * Build the text payload sent / edited in the target channel.
 *
 * Format:
 *   [Jump to original](url)
 *   <#channelId> | quoted by **AuthorName**
 *   <media url(s)>
 *   *✨❝ Special message ❞✨*   ← only for special users
 */
async function buildContent(sourceMessage, mediaUrls) {
  const jump   = sourceMessage.url;
  const origin = `<#${sourceMessage.channelId}>`;
  const author = await extractQuoteAuthor(sourceMessage);

  const authorPart = author ? ` | **@${author.name}**` : "Unknown";
  const header = `${origin}${authorPart}`;

  const lines = [`[Jump to original](${jump})`, header, ...mediaUrls];

  // Special user suffix
  if (author?.id && SPECIAL_USER_MESSAGES[author.id]) {
    const specialMsg = SPECIAL_USER_MESSAGES[author.id];
    lines.push(`✨ * ${specialMsg} * ✨`);
  }

  return lines.join("\n");
}

/** Return true when we should act on this message. */
function isRelevant(message) {
  return (
    SOURCE_BOT_IDS.includes(message.author.id) &&
    !IGNORED_CHANNEL_IDS.includes(message.channelId)
  );
}

/** Fetch or create the list of mirror entries for a source message ID. */
function getMirrors(sourceId) {
  if (!mirroredMessages.has(sourceId)) mirroredMessages.set(sourceId, []);
  return mirroredMessages.get(sourceId);
}

/**
 * Mirror a message to all target channels.
 * Returns an array of { mirroredId, targetChannelId } for bookkeeping.
 */
async function mirrorToAllTargets(sourceMessage, mediaUrls) {
  const content = await buildContent(sourceMessage, mediaUrls);
  const results = [];

  for (const channelId of TARGET_CHANNEL_IDS) {
    try {
      const targetChannel = await client.channels.fetch(channelId);
      if (!targetChannel?.isTextBased()) {
        console.warn(`⚠️  Target channel ${channelId} is not a text channel.`);
        continue;
      }
      const mirrored = await targetChannel.send(content);
      results.push({ mirroredId: mirrored.id, targetChannelId: channelId });
      console.log(`📤  Mirrored ${sourceMessage.id} → ${mirrored.id} in #${channelId}`);
    } catch (err) {
      console.error(`❌  Failed to mirror to channel ${channelId}:`, err);
    }
  }

  return results;
}

/** Sync all current reactions on the source message to a mirrored message. */
async function syncReactions(sourceMessage, mirroredMsg) {
  // Remove all existing reactions on the mirror first
  try { await mirroredMsg.reactions.removeAll(); } catch { /* may lack permission */ }

  for (const [, reaction] of sourceMessage.reactions.cache) {
    try {
      await mirroredMsg.react(reaction.emoji.id ?? reaction.emoji.name);
    } catch (err) {
      console.warn(`⚠️  Could not mirror reaction ${reaction.emoji.name}:`, err.message);
    }
  }
}

// ── Event handlers ───────────────────────────────────────────────────────────

client.once(Events.ClientReady, () => {
  console.log(`✅  Logged in as ${client.user.tag}`);
  console.log(`   Monitoring bots/users : ${SOURCE_BOT_IDS.join(", ")}`);
  console.log(`   Mirroring to          : ${TARGET_CHANNEL_IDS.join(", ")}`);
  console.log(`   Ignoring channels     : ${IGNORED_CHANNEL_IDS.join(", ")}`);
  if (Object.keys(SPECIAL_USER_MESSAGES).length > 0) {
    console.log(`   Special users         : ${Object.keys(SPECIAL_USER_MESSAGES).join(", ")}`);
  }
});

// New message ─────────────────────────────────────────────────────────────────
client.on(Events.MessageCreate, async (message) => {
  // Debug: log every message from any monitored source
  if (SOURCE_BOT_IDS.includes(message.author.id)) {
    console.log("═══════════════════════════════════════");
    console.log(`📨 Message from ${message.author.id} in channel ${message.channelId}`);
    console.log(`   Content     : ${message.content || "(empty)"}`);
    console.log(`   Attachments : ${message.attachments.size}`);
    for (const [, a] of message.attachments) console.log(`     - ${a.url}`);
    console.log(`   Embeds      : ${message.embeds.length}`);
    for (const e of message.embeds) {
      console.log(`     type       : ${e.type}`);
      console.log(`     url        : ${e.url}`);
      console.log(`     image.url  : ${e.image?.url}`);
      console.log(`     image.proxy: ${e.image?.proxyURL}`);
      console.log(`     video.url  : ${e.video?.url}`);
      console.log(`     thumb.url  : ${e.thumbnail?.url}`);
      console.log(`     footer     : ${e.footer?.text}`);
      console.log(`     description: ${e.description}`);
    }
    console.log(`   Reference   : ${message.reference?.messageId ?? "none"}`);
    console.log("═══════════════════════════════════════");
  }

  if (!isRelevant(message)) return;

  const mediaUrls = extractMedia(message);
  if (mediaUrls.length === 0) {
    console.log("⚠️  Relevant message had no extractable media, skipping.");
    return;
  }

  const mirrors = await mirrorToAllTargets(message, mediaUrls);
  if (mirrors.length > 0) mirroredMessages.set(message.id, mirrors);
});

// Edited message ──────────────────────────────────────────────────────────────
client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
  if (newMessage.partial) {
    try { newMessage = await newMessage.fetch(); }
    catch (err) { console.error("❌  Could not fetch updated message:", err); return; }
  }

  if (!isRelevant(newMessage)) return;

  const mediaUrls = extractMedia(newMessage);
  const mirrors   = getMirrors(newMessage.id);

  // Case 1: never mirrored before, but now has media (Make it a Quote edits in the image)
  if (mirrors.length === 0) {
    if (mediaUrls.length === 0) return;
    const newMirrors = await mirrorToAllTargets(newMessage, mediaUrls);
    if (newMirrors.length > 0) mirroredMessages.set(newMessage.id, newMirrors);
    return;
  }

  // Case 2: already mirrored — update or delete each mirror
  const content = mediaUrls.length > 0 ? await buildContent(newMessage, mediaUrls) : null;

  for (const entry of [...mirrors]) {
    try {
      const targetChannel = await client.channels.fetch(entry.targetChannelId);
      const mirroredMsg   = await targetChannel.messages.fetch(entry.mirroredId);

      if (!content) {
        await mirroredMsg.delete();
        mirrors.splice(mirrors.indexOf(entry), 1);
        console.log(`🗑️   Deleted mirror ${entry.mirroredId} (media removed)`);
        // Also delete the source bot message — when a quote is removed, Make it a Quote
        // replaces the embed with "[ Removed by @user ]" but keeps the message alive.
        // We clean it up here so nothing lingers in the source channel.
        try {
          await newMessage.delete();
          console.log(`🗑️   Deleted source message ${newMessage.id} (quote removed)`);
        } catch (srcErr) {
          console.warn(`⚠️  Could not delete source message ${newMessage.id}:`, srcErr.message);
        }
      } else {
        await mirroredMsg.edit(content);
        console.log(`✏️   Edited mirror ${entry.mirroredId}`);
      }
    } catch (err) {
      console.error(`❌  Failed to update mirror ${entry.mirroredId}:`, err);
    }
  }

  if (mirrors.length === 0) mirroredMessages.delete(newMessage.id);
});

// Deleted message ─────────────────────────────────────────────────────────────
client.on(Events.MessageDelete, async (message) => {
  const mirrors = mirroredMessages.get(message.id);
  if (!mirrors || mirrors.length === 0) return;

  for (const entry of mirrors) {
    try {
      const targetChannel = await client.channels.fetch(entry.targetChannelId);
      const mirroredMsg   = await targetChannel.messages.fetch(entry.mirroredId);
      await mirroredMsg.delete();
      console.log(`🗑️   Deleted mirror ${entry.mirroredId} for deleted source ${message.id}`);
    } catch (err) {
      console.warn(`⚠️  Could not delete mirror ${entry.mirroredId}:`, err.message);
    }
  }

  mirroredMessages.delete(message.id);
});

// Reaction added ──────────────────────────────────────────────────────────────
client.on(Events.MessageReactionAdd, async (reaction, user) => {
  // Ignore reactions from our own bot (prevents loops)
  if (user.id === client.user.id) return;

  // Resolve partial reaction
  if (reaction.partial) {
    try { reaction = await reaction.fetch(); }
    catch (err) { console.error("❌  Could not fetch reaction:", err); return; }
  }

  const sourceMessage = reaction.message;
  if (!SOURCE_BOT_IDS.includes(sourceMessage.author?.id)) return;

  const mirrors = mirroredMessages.get(sourceMessage.id);
  if (!mirrors || mirrors.length === 0) return;

  for (const entry of mirrors) {
    try {
      const targetChannel = await client.channels.fetch(entry.targetChannelId);
      const mirroredMsg   = await targetChannel.messages.fetch(entry.mirroredId);
      await mirroredMsg.react(reaction.emoji.id ?? reaction.emoji.name);
    } catch (err) {
      console.warn(`⚠️  Could not sync reaction add to mirror ${entry.mirroredId}:`, err.message);
    }
  }
});

// Reaction removed ────────────────────────────────────────────────────────────
client.on(Events.MessageReactionRemove, async (reaction, user) => {
  if (user.id === client.user.id) return;

  if (reaction.partial) {
    try { reaction = await reaction.fetch(); }
    catch (err) { console.error("❌  Could not fetch reaction:", err); return; }
  }

  const sourceMessage = reaction.message;
  if (!SOURCE_BOT_IDS.includes(sourceMessage.author?.id)) return;

  const mirrors = mirroredMessages.get(sourceMessage.id);
  if (!mirrors || mirrors.length === 0) return;

  // Fetch the full source message to get the current reaction count
  let fullSource;
  try {
    fullSource = await sourceMessage.fetch();
  } catch {
    return;
  }

  for (const entry of mirrors) {
    try {
      const targetChannel = await client.channels.fetch(entry.targetChannelId);
      const mirroredMsg   = await targetChannel.messages.fetch(entry.mirroredId);
      // Re-sync all reactions so the mirror stays accurate
      await syncReactions(fullSource, mirroredMsg);
    } catch (err) {
      console.warn(`⚠️  Could not sync reaction remove to mirror ${entry.mirroredId}:`, err.message);
    }
  }
});

// All reactions cleared ───────────────────────────────────────────────────────
client.on(Events.MessageReactionRemoveAll, async (message) => {
  const mirrors = mirroredMessages.get(message.id);
  if (!mirrors || mirrors.length === 0) return;

  for (const entry of mirrors) {
    try {
      const targetChannel = await client.channels.fetch(entry.targetChannelId);
      const mirroredMsg   = await targetChannel.messages.fetch(entry.mirroredId);
      await mirroredMsg.reactions.removeAll();
    } catch (err) {
      console.warn(`⚠️  Could not clear reactions on mirror ${entry.mirroredId}:`, err.message);
    }
  }
});

// ── Connect ──────────────────────────────────────────────────────────────────
client.login(BOT_TOKEN);
