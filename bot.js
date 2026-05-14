const { Client, GatewayIntentBits, Events } = require("discord.js");

// ── Configuration ────────────────────────────────────────────────────────────
const SOURCE_BOT_ID      = "949479338275913799";   // Bot to monitor
const TARGET_CHANNEL_ID  = "1504414781946331287";  // Where media gets mirrored
const IGNORED_CHANNEL_ID = "1504402520523673620";  // Source channel to ignore

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;   // Set in your environment
// ─────────────────────────────────────────────────────────────────────────────

if (!BOT_TOKEN) {
  console.error("❌  DISCORD_BOT_TOKEN environment variable is not set.");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Maps  sourceMessageId  →  mirroredMessageId
// Persists for the lifetime of the process; see README for persistent options.
const mirroredMessages = new Map();

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Collect every attachment URL + embed image/video URL from a message. */
function extractMedia(message) {
  const urls = [];

  // Direct file attachments
  for (const attachment of message.attachments.values()) {
    urls.push(attachment.url);
  }

  // Embedded images / videos (link-unfurls, rich embeds, etc.)
  for (const embed of message.embeds) {
    if (embed.image?.url)     urls.push(embed.image.url);
    if (embed.video?.url)     urls.push(embed.video.url);
    if (embed.thumbnail?.url) urls.push(embed.thumbnail.url);
  }

  return urls;
}

/** Build the text payload sent / edited in the target channel. */
function buildContent(sourceMessage, mediaUrls) {
  const jump   = sourceMessage.url;
  const origin = `<#${sourceMessage.channelId}>`;
  const header = `📎 **Media from ${origin}** | [Jump to original](${jump})`;
  return [header, ...mediaUrls].join("\n");
}

/** Return true when we should act on this message. */
function isRelevant(message) {
  return (
    message.author.id === SOURCE_BOT_ID &&
    message.channelId  !== IGNORED_CHANNEL_ID
  );
}

// ── Event handlers ───────────────────────────────────────────────────────────

client.once(Events.ClientReady, () => {
  console.log(`✅  Logged in as ${client.user.tag}`);
  console.log(`   Monitoring bot : ${SOURCE_BOT_ID}`);
  console.log(`   Mirroring to   : #${TARGET_CHANNEL_ID}`);
  console.log(`   Ignoring       : #${IGNORED_CHANNEL_ID}`);
});

// New message ─────────────────────────────────────────────────────────────────
client.on(Events.MessageCreate, async (message) => {
  if (!isRelevant(message)) return;

  const mediaUrls = extractMedia(message);
  if (mediaUrls.length === 0) return;

  try {
    const targetChannel = await client.channels.fetch(TARGET_CHANNEL_ID);
    if (!targetChannel?.isTextBased()) {
      console.warn("⚠️  Target channel is not a text channel.");
      return;
    }

    const content    = buildContent(message, mediaUrls);
    const mirrored   = await targetChannel.send(content);

    mirroredMessages.set(message.id, mirrored.id);
    console.log(`📤  Mirrored message ${message.id}  →  ${mirrored.id}`);
  } catch (err) {
    console.error("❌  Failed to mirror message:", err);
  }
});

// Edited message ──────────────────────────────────────────────────────────────
client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
  // newMessage may be partial; fetch if needed
  if (newMessage.partial) {
    try { newMessage = await newMessage.fetch(); }
    catch (err) { console.error("❌  Could not fetch updated message:", err); return; }
  }

  if (!isRelevant(newMessage)) return;

  const mirroredId = mirroredMessages.get(newMessage.id);
  if (!mirroredId) return; // We never mirrored this one (no media originally)

  const mediaUrls = extractMedia(newMessage);

  try {
    const targetChannel = await client.channels.fetch(TARGET_CHANNEL_ID);
    const mirroredMsg   = await targetChannel.messages.fetch(mirroredId);

    if (mediaUrls.length === 0) {
      // Media was removed — delete the mirror
      await mirroredMsg.delete();
      mirroredMessages.delete(newMessage.id);
      console.log(`🗑️   Deleted mirror for ${newMessage.id} (media removed)`);
    } else {
      // Media was updated — edit the mirror
      const content = buildContent(newMessage, mediaUrls);
      await mirroredMsg.edit(content);
      console.log(`✏️   Edited mirror for ${newMessage.id}`);
    }
  } catch (err) {
    console.error("❌  Failed to update mirrored message:", err);
  }
});

// Deleted message ─────────────────────────────────────────────────────────────
client.on(Events.MessageDelete, async (message) => {
  const mirroredId = mirroredMessages.get(message.id);
  if (!mirroredId) return;

  try {
    const targetChannel = await client.channels.fetch(TARGET_CHANNEL_ID);
    const mirroredMsg   = await targetChannel.messages.fetch(mirroredId);
    await mirroredMsg.delete();
    mirroredMessages.delete(message.id);
    console.log(`🗑️   Deleted mirror for deleted source ${message.id}`);
  } catch (err) {
    // Mirror may have already been deleted manually — not fatal
    console.warn("⚠️  Could not delete mirror:", err.message);
    mirroredMessages.delete(message.id);
  }
});

// ── Connect ──────────────────────────────────────────────────────────────────
client.login(BOT_TOKEN);
