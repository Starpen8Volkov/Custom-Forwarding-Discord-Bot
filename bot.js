const {
  Client,
  GatewayIntentBits,
  Events,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const https = require("https");
const http  = require("http");

// ── Configuration ────────────────────────────────────────────────────────────
// Each of these accepts comma-separated values, e.g. "123,456,789"
const SOURCE_BOT_IDS      = (process.env.SOURCE_BOT_ID      || "").split(",").map(s => s.trim()).filter(Boolean);
const TARGET_CHANNEL_IDS  = (process.env.TARGET_CHANNEL_ID  || "").split(",").map(s => s.trim()).filter(Boolean);
const IGNORED_CHANNEL_IDS = (process.env.IGNORED_CHANNEL_ID || "").split(",").map(s => s.trim()).filter(Boolean);

// Highlight / viral detection
const HIGHLIGHT_CHANNEL_ID = (process.env.HIGHLIGHT_ID         || "").trim();
const HUMAN_ROLE_ID        = (process.env.HUMAN_ROLE_ID        || "").trim();
const HIGHLIGHT_PERCENTAGE = parseFloat(process.env.HIGHLIGHT_PERCENTAGE || "0") / 100; // stored as 0-1

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
    // GuildMembers is a privileged intent — enable it in the Discord Developer
    // Portal (Bot → Privileged Gateway Intents → Server Members Intent) and
    // uncomment the line below for accurate human-role member counts.
    // GatewayIntentBits.GuildMembers,
  ],
});

// ── State maps ───────────────────────────────────────────────────────────────

/**
 * mirroredMessages:  sourceMessageId → MirrorEntry[]
 *
 * MirrorEntry: {
 *   mirroredId      : string,          ← id of the bot-sent copy in the target channel
 *   targetChannelId : string,
 *   highlightId     : string | null,   ← id of the highlight-channel copy (if sent)
 * }
 */
const mirroredMessages = new Map();

/**
 * sourceChannelMap:  sourceMessageId → sourceChannelId
 *
 * Stored at mirror time so that reaction events on the *original quoted* message
 * can re-fetch the source-bot message without hunting through channel caches.
 */
const sourceChannelMap = new Map();

/**
 * reactionState:  sourceMessageId → Map< emojiKey, Set<userId> >
 *
 * Single source of truth for ALL emoji reactions across every copy of a mirrored
 * message: the source-bot message, the original quoted message, the bot-sent
 * mirrored message(s), and the highlight copy.
 *
 * emojiKey for unicode emoji : the character itself, e.g. "👍"
 * emojiKey for custom emoji  : "<name>:<id>",          e.g. "pepehands:123456789"
 *
 * Populated from two sources:
 *   • syncExternalReactions() — reads Discord reactions on the source-bot message
 *     and the original quoted message and merges them (same user + same emoji
 *     on both messages counts only once).
 *   • InteractionCreate — toggles a user in/out when they click a button.
 *
 * Button-press entries survive re-syncs; syncExternalReactions only adds users,
 * it does not remove users who pressed a button.
 */
const reactionState = new Map();

/**
 * mirrorToSource:  mirroredMsgId | highlightMsgId → sourceMessageId
 *
 * Reverse lookup used by the button-interaction handler to find which source
 * message (and therefore which reactionState entry) owns a given button message.
 */
const mirrorToSource = new Map();

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Download a URL and return a Buffer. */
function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    lib.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchBuffer(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

/** Guess a filename + extension from a URL. */
function guessFilename(url) {
  try {
    const pathname = new URL(url).pathname;
    const base = pathname.split("/").pop() || "image";
    // Strip query params that leaked into the basename
    return base.split("?")[0] || "image.png";
  } catch {
    return "image.png";
  }
}

/**
 * Download all media URLs and return an array of AttachmentBuilder objects.
 * Falls back gracefully: if any individual download fails we skip that file.
 */
async function buildAttachments(mediaUrls) {
  const attachments = [];
  for (const url of mediaUrls) {
    try {
      const buffer   = await fetchBuffer(url);
      const filename = guessFilename(url);
      attachments.push(new AttachmentBuilder(buffer, { name: filename }));
    } catch (err) {
      console.warn(`⚠️  Could not download media ${url}:`, err.message);
    }
  }
  return attachments;
}

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
 * Build the text content sent in the target channel.
 *
 * Layout (all as message text, media is sent as a file attachment):
 *   [Jump to original](url)
 *   <#channelId> | **@AuthorName**
 *   *✨ Special message ✨*   ← only for special users; sits below media text, above reactions
 *
 * The image is sent as an attachment so it renders inline without the blue URL link.
 */
async function buildContent(sourceMessage) {
  const jump   = sourceMessage.url;
  const origin = `<#${sourceMessage.channelId}>`;
  const author = await extractQuoteAuthor(sourceMessage);

  const authorPart = author ? ` | **@${author.name}**` : " | Unknown";
  const header = `${origin}${authorPart}`;

  const lines = [`[Jump to original](${jump})`, header];

  // Special user message — placed below media text, above reactions
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

// ── Emoji key helpers ─────────────────────────────────────────────────────────

/**
 * Canonical string key for a Discord emoji:
 *   custom  → "<name>:<id>"
 *   unicode → the character itself
 */
function toEmojiKey(emoji) {
  return emoji.id ? `${emoji.name}:${emoji.id}` : emoji.name;
}

/**
 * Convert an emojiKey back to the argument Discord.js needs for ButtonBuilder.setEmoji().
 *   unicode → the character string
 *   custom  → { name, id } object
 */
function emojiArgFromKey(key) {
  if (key.includes(":")) {
    const colonIdx = key.indexOf(":");
    return { name: key.slice(0, colonIdx), id: key.slice(colonIdx + 1) };
  }
  return key;
}

/**
 * Button customId encoding.  Must stay under Discord's 100-char limit.
 * Format: "rxn:<emojiKey>"
 */
function encodeButtonId(key) {
  return `rxn:${key}`.slice(0, 100);
}

function decodeButtonId(customId) {
  if (!customId.startsWith("rxn:")) return null;
  return customId.slice(4);
}

// ── Button rendering ──────────────────────────────────────────────────────────

/**
 * Build ActionRow(s) of emoji buttons from a Map<emojiKey, Set<userId>>.
 *
 * Each button:
 *   • Emoji label  — the actual emoji character / custom emoji
 *   • Count label  — number of unique users in the set
 *   • Style        — Primary (blurple) if viewerUserId is in the set (i.e. "you reacted"),
 *                    Secondary (grey) otherwise — matching Discord's own toggle appearance.
 *
 * Discord buttons do NOT support hover tooltips (no title/description field on
 * message components), so we cannot list reacted users on hover.
 *
 * Discord limits: 5 buttons per ActionRow, 5 rows per message (25 buttons max).
 * Emojis with zero count are skipped.
 */
function buildButtonRows(mergedMap, viewerUserId = null) {
  const buttons = [];

  for (const [key, userSet] of mergedMap) {
    const count = userSet.size;
    if (count === 0) continue;

    const isActive = viewerUserId !== null && userSet.has(viewerUserId);

    const btn = new ButtonBuilder()
      .setCustomId(encodeButtonId(key))
      .setEmoji(emojiArgFromKey(key))
      .setLabel(String(count))
      .setStyle(isActive ? ButtonStyle.Primary : ButtonStyle.Secondary);

    buttons.push(btn);
    if (buttons.length >= 25) break; // hard Discord cap
  }

  if (buttons.length === 0) return [];

  // Chunk into rows of 5
  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
  }
  return rows;
}

// ── Reaction-state management ─────────────────────────────────────────────────

/** Get or initialise the reactionState entry for a sourceId. */
function getOrCreateState(sourceId) {
  if (!reactionState.has(sourceId)) reactionState.set(sourceId, new Map());
  return reactionState.get(sourceId);
}

/**
 * Read actual Discord reactions from:
 *   1. The source-bot message itself.
 *   2. The original quoted message it references (if any).
 *
 * Merge them into reactionState[sourceId], deduplicating same user + same emoji
 * across the two messages.  Button-press entries written by InteractionCreate
 * are preserved — this function only adds, never removes.
 *
 * Returns the updated Map<emojiKey, Set<userId>>.
 */
async function syncExternalReactions(sourceMessage) {
  const sourceId = sourceMessage.id;
  const state    = getOrCreateState(sourceId);

  async function absorb(msg) {
    let fullMsg = msg;
    if (msg.partial) {
      try { fullMsg = await msg.fetch(); } catch { return; }
    }
    for (const [, reaction] of fullMsg.reactions.cache) {
      const key = toEmojiKey(reaction.emoji);
      if (!state.has(key)) state.set(key, new Set());
      const users = state.get(key);
      try {
        const reactors = await reaction.users.fetch();
        for (const [userId] of reactors) {
          users.add(userId);
        }
      } catch (err) {
        console.warn(`⚠️  Could not fetch users for reaction ${key}:`, err.message);
        // Sentinel so the emoji still appears as a button even without user ids
        users.add(`__count_${reaction.count}`);
      }
    }
  }

  // 1. Reactions on the forwarded (source-bot) message itself
  await absorb(sourceMessage);

  // 2. Reactions on the original quoted message (if any)
  if (sourceMessage.reference?.messageId) {
    try {
      const refChannel = await client.channels.fetch(sourceMessage.reference.channelId);
      const refMessage = await refChannel.messages.fetch(sourceMessage.reference.messageId);
      await absorb(refMessage);
    } catch {
      // Original may be deleted — ignore
    }
  }

  return state;
}

/**
 * Push the current merged state as button rows to every bot-sent copy that
 * belongs to sourceId: the mirrored message(s) and the highlight copy (if any).
 *
 * viewerMap is an optional Map<msgId, userId> used to show the per-user toggle
 * state (Primary) on a specific message for a specific viewer.
 */
async function pushButtons(sourceId, viewerMap = new Map()) {
  const state   = reactionState.get(sourceId);
  if (!state) return;

  const mirrors = mirroredMessages.get(sourceId);
  if (!mirrors || mirrors.length === 0) return;

  for (const entry of mirrors) {
    // Mirrored message
    try {
      const viewer = viewerMap.get(entry.mirroredId) ?? null;
      const rows   = buildButtonRows(state, viewer);
      const ch     = await client.channels.fetch(entry.targetChannelId);
      const msg    = await ch.messages.fetch(entry.mirroredId);
      await msg.edit({ components: rows });
    } catch (err) {
      console.warn(`⚠️  Could not push buttons to mirror ${entry.mirroredId}:`, err.message);
    }

    // Highlight copy
    if (entry.highlightId) {
      try {
        const viewer = viewerMap.get(entry.highlightId) ?? null;
        const rows   = buildButtonRows(state, viewer);
        const hlCh   = await client.channels.fetch(HIGHLIGHT_CHANNEL_ID);
        const hlMsg  = await hlCh.messages.fetch(entry.highlightId);
        await hlMsg.edit({ components: rows });
      } catch (err) {
        console.warn(`⚠️  Could not push buttons to highlight ${entry.highlightId}:`, err.message);
      }
    }
  }
}

/**
 * Full sync pipeline (used by reaction-event handlers):
 *   1. Pull external reactions (source + quoted original) into state.
 *   2. Push updated buttons (neutral view) to all bot-sent copies.
 * Returns the state map for further use (e.g. highlight threshold check).
 */
async function syncAndPush(sourceMessage) {
  const state = await syncExternalReactions(sourceMessage);
  await pushButtons(sourceMessage.id);
  return state;
}

// ── Highlight helpers ─────────────────────────────────────────────────────────

/** Count members in the guild that have the HUMAN_ROLE_ID role. */
async function countHumanMembers(guild) {
  if (!HUMAN_ROLE_ID) return 0;
  try {
    const role = await guild.roles.fetch(HUMAN_ROLE_ID);
    if (!role) return 0;

    // Best case: cache is populated (GuildMembers intent enabled)
    if (role.members.size > 0) return role.members.size;

    // Fallback: paginate guild.members.list filtered by role
    // This REST call is allowed without the privileged intent.
    let total = 0;
    let after = "0";
    while (true) {
      const batch = await guild.members.list({ limit: 1000, after });
      if (batch.size === 0) break;
      for (const [, member] of batch) {
        if (member.roles.cache.has(HUMAN_ROLE_ID)) total++;
      }
      if (batch.size < 1000) break;
      after = batch.lastKey();
    }
    return total;
  } catch (err) {
    console.warn("⚠️  Could not count human role members:", err.message);
    return 0;
  }
}

/**
 * Return the total number of unique users who have reacted with any emoji.
 * Sentinel "__count_N" entries are excluded from the unique-user tally.
 */
function countUniqueReactors(state) {
  const all = new Set();
  for (const userSet of state.values()) {
    for (const uid of userSet) {
      if (!uid.startsWith("__count_")) all.add(uid);
    }
  }
  return all.size;
}

/**
 * Send a highlight copy if the reaction threshold is now met.
 * Returns the highlight message id if sent, null otherwise.
 */
async function maybeSendHighlight(sourceMessage, content, attachments, state) {
  if (!HIGHLIGHT_CHANNEL_ID || !HUMAN_ROLE_ID || HIGHLIGHT_PERCENTAGE <= 0) return null;

  const guild = sourceMessage.guild;
  if (!guild) return null;

  const humanCount   = await countHumanMembers(guild);
  const reactorCount = countUniqueReactors(state);

  if (humanCount === 0) return null;

  const ratio = reactorCount / humanCount;
  console.log(
    `📊  Highlight check: ${reactorCount} reactors / ${humanCount} humans = ${(ratio * 100).toFixed(1)}% ` +
    `(threshold ${(HIGHLIGHT_PERCENTAGE * 100).toFixed(1)}%)`
  );

  if (ratio < HIGHLIGHT_PERCENTAGE) return null;

  try {
    const hlChannel = await client.channels.fetch(HIGHLIGHT_CHANNEL_ID);
    if (!hlChannel?.isTextBased()) return null;

    const rows  = buildButtonRows(state); // neutral view
    const hlMsg = await hlChannel.send({ content, files: attachments, components: rows });
    console.log(`⭐  Sent highlight copy → ${hlMsg.id} in #${HIGHLIGHT_CHANNEL_ID}`);
    return hlMsg.id;
  } catch (err) {
    console.error("❌  Failed to send highlight message:", err);
    return null;
  }
}

// ── Core mirroring ────────────────────────────────────────────────────────────

/**
 * Mirror a message to all target channels, attaching emoji buttons.
 * Returns an array of MirrorEntry objects for bookkeeping.
 */
async function mirrorToAllTargets(sourceMessage, mediaUrls) {
  const content     = await buildContent(sourceMessage);
  const attachments = await buildAttachments(mediaUrls);

  // Seed reaction state from external reactions before the first send
  const state = await syncExternalReactions(sourceMessage);
  const rows  = buildButtonRows(state); // neutral view on first render

  const results = [];

  for (const channelId of TARGET_CHANNEL_IDS) {
    try {
      const targetChannel = await client.channels.fetch(channelId);
      if (!targetChannel?.isTextBased()) {
        console.warn(`⚠️  Target channel ${channelId} is not a text channel.`);
        continue;
      }

      const mirrored = await targetChannel.send({ content, files: attachments, components: rows });
      console.log(`📤  Mirrored ${sourceMessage.id} → ${mirrored.id} in #${channelId}`);

      // Register reverse lookup
      mirrorToSource.set(mirrored.id, sourceMessage.id);

      // Check highlight threshold
      const highlightId = await maybeSendHighlight(sourceMessage, content, attachments, state);
      if (highlightId) mirrorToSource.set(highlightId, sourceMessage.id);

      results.push({
        mirroredId:      mirrored.id,
        targetChannelId: channelId,
        highlightId:     highlightId ?? null,
      });
    } catch (err) {
      console.error(`❌  Failed to mirror to channel ${channelId}:`, err);
    }
  }

  // Store the source channel so reaction events on the quoted message can re-fetch
  sourceChannelMap.set(sourceMessage.id, sourceMessage.channelId);

  return results;
}

// ── Event handlers ───────────────────────────────────────────────────────────

client.once(Events.ClientReady, () => {
  console.log(`✅  Logged in as ${client.user.tag}`);
  console.log(`   Monitoring bots/users : ${SOURCE_BOT_IDS.join(", ")}`);
  console.log(`   Mirroring to          : ${TARGET_CHANNEL_IDS.join(", ")}`);
  console.log(`   Ignoring channels     : ${IGNORED_CHANNEL_IDS.join(", ")}`);
  if (HIGHLIGHT_CHANNEL_ID) {
    console.log(`   Highlight channel     : ${HIGHLIGHT_CHANNEL_ID}`);
    console.log(`   Highlight threshold   : ${(HIGHLIGHT_PERCENTAGE * 100).toFixed(1)}% of role ${HUMAN_ROLE_ID}`);
  }
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
  const content     = mediaUrls.length > 0 ? await buildContent(newMessage)    : null;
  const attachments = mediaUrls.length > 0 ? await buildAttachments(mediaUrls) : null;

  for (const entry of [...mirrors]) {
    try {
      const targetChannel = await client.channels.fetch(entry.targetChannelId);
      const mirroredMsg   = await targetChannel.messages.fetch(entry.mirroredId);

      if (!content) {
        // ── No more media: delete mirrored copy, highlight copy, and the source message ──
        await mirroredMsg.delete();
        mirrorToSource.delete(entry.mirroredId);
        mirrors.splice(mirrors.indexOf(entry), 1);
        console.log(`🗑️   Deleted mirror ${entry.mirroredId} (media removed)`);

        if (entry.highlightId) {
          try {
            const hlChannel = await client.channels.fetch(HIGHLIGHT_CHANNEL_ID);
            const hlMsg     = await hlChannel.messages.fetch(entry.highlightId);
            await hlMsg.delete();
            mirrorToSource.delete(entry.highlightId);
            console.log(`🗑️   Deleted highlight copy ${entry.highlightId}`);
          } catch (hlErr) {
            console.warn(`⚠️  Could not delete highlight copy ${entry.highlightId}:`, hlErr.message);
          }
          entry.highlightId = null;
        }

        // Also delete the source bot message (the "forwarded" message from the other bot)
        try {
          await newMessage.delete();
          console.log(`🗑️   Deleted source message ${newMessage.id} (quote removed)`);
        } catch (srcErr) {
          console.warn(`⚠️  Could not delete source message ${newMessage.id}:`, srcErr.message);
        }

      } else {
        // ── Re-send mirror with fresh attachments + updated buttons ──
        // (Discord.js doesn't support replacing attachments on an existing message cleanly)
        const state = await syncExternalReactions(newMessage);
        const rows  = buildButtonRows(state);

        const newMirrored = await targetChannel.send({ content, files: attachments, components: rows });
        await mirroredMsg.delete().catch(() => {});

        mirrorToSource.delete(entry.mirroredId);
        mirrorToSource.set(newMirrored.id, newMessage.id);
        entry.mirroredId = newMirrored.id;

        // Update highlight copy if it exists
        if (entry.highlightId) {
          try {
            const hlChannel = await client.channels.fetch(HIGHLIGHT_CHANNEL_ID);
            const hlMsg     = await hlChannel.messages.fetch(entry.highlightId);
            const newHl     = await hlChannel.send({ content, files: attachments, components: rows });
            await hlMsg.delete().catch(() => {});
            mirrorToSource.delete(entry.highlightId);
            mirrorToSource.set(newHl.id, newMessage.id);
            entry.highlightId = newHl.id;
          } catch (hlErr) {
            console.warn(`⚠️  Could not update highlight copy:`, hlErr.message);
          }
        } else {
          // Check if the updated reactions now cross the highlight threshold
          const newHighlightId = await maybeSendHighlight(newMessage, content, attachments, state);
          if (newHighlightId) {
            mirrorToSource.set(newHighlightId, newMessage.id);
            entry.highlightId = newHighlightId;
          }
        }

        console.log(`✏️   Re-sent mirror as ${newMirrored.id} (edit with new attachments)`);
      }
    } catch (err) {
      console.error(`❌  Failed to update mirror ${entry.mirroredId}:`, err);
    }
  }

  if (mirrors.length === 0) {
    mirroredMessages.delete(newMessage.id);
    reactionState.delete(newMessage.id);
    sourceChannelMap.delete(newMessage.id);
  }
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
      mirrorToSource.delete(entry.mirroredId);
      console.log(`🗑️   Deleted mirror ${entry.mirroredId} for deleted source ${message.id}`);
    } catch (err) {
      console.warn(`⚠️  Could not delete mirror ${entry.mirroredId}:`, err.message);
    }

    // Delete highlight copy too
    if (entry.highlightId) {
      try {
        const hlChannel = await client.channels.fetch(HIGHLIGHT_CHANNEL_ID);
        const hlMsg     = await hlChannel.messages.fetch(entry.highlightId);
        await hlMsg.delete();
        mirrorToSource.delete(entry.highlightId);
        console.log(`🗑️   Deleted highlight copy ${entry.highlightId} for deleted source ${message.id}`);
      } catch (hlErr) {
        console.warn(`⚠️  Could not delete highlight copy ${entry.highlightId}:`, hlErr.message);
      }
    }
  }

  mirroredMessages.delete(message.id);
  reactionState.delete(message.id);
  sourceChannelMap.delete(message.id);
});

// ── Reaction events ───────────────────────────────────────────────────────────
//
// We watch for reactions on two kinds of messages:
//
//   (A) The source-bot message itself — identified by its author being in SOURCE_BOT_IDS
//       and its id being in mirroredMessages.
//
//   (B) The original quoted message that the source-bot message references — this
//       message is authored by someone else and doesn't appear in mirroredMessages.
//       We identify it by scanning sourceChannelMap: for every tracked source, we
//       re-fetch the source-bot message and check if its reference.messageId matches
//       the message that just got a reaction.
//
// findSourceIdForQuotedMessage() handles path (B).

/**
 * Given a message id that just received a reaction, scan all tracked sources
 * to find one whose source-bot message references this id.
 * Returns the sourceMessageId, or null if no match.
 */
async function findSourceIdForQuotedMessage(quotedMessageId) {
  for (const [srcId, srcChannelId] of sourceChannelMap) {
    try {
      const srcChannel = await client.channels.fetch(srcChannelId);
      const srcMsg     = await srcChannel.messages.fetch(srcId);
      if (srcMsg.reference?.messageId === quotedMessageId) return srcId;
    } catch {
      // Source may be deleted or unavailable — skip
    }
  }
  return null;
}

// Reaction added ──────────────────────────────────────────────────────────────
client.on(Events.MessageReactionAdd, async (reaction, user) => {
  // Ignore our own bot — shouldn't happen with button-only flow, but be safe
  if (user.id === client.user.id) return;

  if (reaction.partial) {
    try { reaction = await reaction.fetch(); }
    catch (err) { console.error("❌  Could not fetch reaction:", err); return; }
  }

  const reactedMsg = reaction.message;

  // ── Path A: reaction on the source-bot message ──
  if (SOURCE_BOT_IDS.includes(reactedMsg.author?.id) && mirroredMessages.has(reactedMsg.id)) {
    let fullSource;
    try { fullSource = await reactedMsg.fetch(); } catch { return; }

    const state   = await syncAndPush(fullSource);
    const mirrors = mirroredMessages.get(fullSource.id) || [];

    // Check highlight threshold for mirrors that don't yet have a highlight copy
    for (const entry of mirrors) {
      if (!entry.highlightId && HIGHLIGHT_CHANNEL_ID) {
        const contentStr = await buildContent(fullSource);
        const mediaUrls  = extractMedia(fullSource);
        const attFiles   = await buildAttachments(mediaUrls);
        const hlId = await maybeSendHighlight(fullSource, contentStr, attFiles, state);
        if (hlId) {
          mirrorToSource.set(hlId, fullSource.id);
          entry.highlightId = hlId;
        }
      }
    }
    return;
  }

  // ── Path B: reaction on the original quoted message ──
  const sourceId = await findSourceIdForQuotedMessage(reactedMsg.id);
  if (!sourceId) return;

  const srcChannelId = sourceChannelMap.get(sourceId);
  if (!srcChannelId) return;

  try {
    const srcChannel = await client.channels.fetch(srcChannelId);
    const srcMsg     = await srcChannel.messages.fetch(sourceId);
    const state      = await syncAndPush(srcMsg);
    const mirrors    = mirroredMessages.get(sourceId) || [];

    for (const entry of mirrors) {
      if (!entry.highlightId && HIGHLIGHT_CHANNEL_ID) {
        const contentStr = await buildContent(srcMsg);
        const mediaUrls  = extractMedia(srcMsg);
        const attFiles   = await buildAttachments(mediaUrls);
        const hlId = await maybeSendHighlight(srcMsg, contentStr, attFiles, state);
        if (hlId) {
          mirrorToSource.set(hlId, sourceId);
          entry.highlightId = hlId;
        }
      }
    }
  } catch (err) {
    console.warn(`⚠️  Could not sync reaction add for quoted message ${reactedMsg.id}:`, err.message);
  }
});

// Reaction removed ────────────────────────────────────────────────────────────
client.on(Events.MessageReactionRemove, async (reaction, user) => {
  if (user.id === client.user.id) return;

  if (reaction.partial) {
    try { reaction = await reaction.fetch(); }
    catch (err) { console.error("❌  Could not fetch reaction:", err); return; }
  }

  const reactedMsg = reaction.message;

  // ── Path A: reaction removed from the source-bot message ──
  if (SOURCE_BOT_IDS.includes(reactedMsg.author?.id) && mirroredMessages.has(reactedMsg.id)) {
    let fullSource;
    try { fullSource = await reactedMsg.fetch(); } catch { return; }
    // Re-syncing will call reaction.users.fetch() which now excludes the removed user
    await syncAndPush(fullSource);
    return;
  }

  // ── Path B: reaction removed from the original quoted message ──
  const sourceId = await findSourceIdForQuotedMessage(reactedMsg.id);
  if (!sourceId) return;

  const srcChannelId = sourceChannelMap.get(sourceId);
  if (!srcChannelId) return;

  try {
    const srcChannel = await client.channels.fetch(srcChannelId);
    const srcMsg     = await srcChannel.messages.fetch(sourceId);
    await syncAndPush(srcMsg);
  } catch (err) {
    console.warn(`⚠️  Could not sync reaction remove for quoted message ${reactedMsg.id}:`, err.message);
  }
});

// All reactions cleared ───────────────────────────────────────────────────────
client.on(Events.MessageReactionRemoveAll, async (message) => {
  // ── Path A: cleared on the source-bot message ──
  if (mirroredMessages.has(message.id)) {
    // Re-syncing will find zero reactions and update buttons accordingly.
    // Button-press entries in reactionState are intentionally preserved.
    let fullSource;
    try { fullSource = await message.fetch(); } catch { return; }
    await syncAndPush(fullSource);
    return;
  }

  // ── Path B: cleared on the original quoted message ──
  const sourceId = await findSourceIdForQuotedMessage(message.id);
  if (!sourceId) return;

  const srcChannelId = sourceChannelMap.get(sourceId);
  if (!srcChannelId) return;

  try {
    const srcChannel = await client.channels.fetch(srcChannelId);
    const srcMsg     = await srcChannel.messages.fetch(sourceId);
    await syncAndPush(srcMsg);
  } catch (err) {
    console.warn(`⚠️  Could not sync reaction-clear for quoted message ${message.id}:`, err.message);
  }
});

// ── Button interactions (emoji toggle) ───────────────────────────────────────
//
// When a user clicks an emoji button:
//   1. Decode the emojiKey from customId.
//   2. Look up the sourceId via mirrorToSource.
//   3. Toggle the user in/out of reactionState[sourceId][emojiKey].
//   4. Defer-update the interaction (no visible pop-up).
//   5. Push updated buttons to all bot-sent copies:
//      - For the clicked message, pass the viewer's userId so their Primary/
//        Secondary toggle renders correctly.
//      - All other copies get the neutral view (no viewer).
//   6. Check if we've now crossed the highlight threshold.

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;

  const emojiKey = decodeButtonId(interaction.customId);
  if (emojiKey === null) return; // not one of our reaction buttons

  const userId       = interaction.user.id;
  const clickedMsgId = interaction.message.id;

  // Find the source this button belongs to
  const sourceId = mirrorToSource.get(clickedMsgId);
  if (!sourceId) {
    // Unknown button — just acknowledge silently
    await interaction.deferUpdate().catch(() => {});
    return;
  }

  // Toggle user in/out for this emoji
  const state = getOrCreateState(sourceId);
  if (!state.has(emojiKey)) state.set(emojiKey, new Set());
  const userSet = state.get(emojiKey);

  if (userSet.has(userId)) {
    userSet.delete(userId);
    console.log(`➖  ${userId} un-reacted ${emojiKey} on source ${sourceId}`);
  } else {
    userSet.add(userId);
    console.log(`➕  ${userId} reacted ${emojiKey} on source ${sourceId}`);
  }

  // Acknowledge interaction immediately (required within 3 s, no visible reply)
  await interaction.deferUpdate().catch(() => {});

  // Build a viewerMap so the clicked message shows the correct Primary/Secondary state
  const viewerMap = new Map([[clickedMsgId, userId]]);
  await pushButtons(sourceId, viewerMap);

  // Check highlight threshold if any mirror still lacks a highlight copy
  const mirrors = mirroredMessages.get(sourceId) || [];
  const hasMirrorWithoutHighlight = mirrors.some(e => !e.highlightId);

  if (hasMirrorWithoutHighlight && HIGHLIGHT_CHANNEL_ID) {
    const srcChannelId = sourceChannelMap.get(sourceId);
    if (srcChannelId) {
      try {
        const srcChannel = await client.channels.fetch(srcChannelId);
        const srcMsg     = await srcChannel.messages.fetch(sourceId);
        const contentStr = await buildContent(srcMsg);
        const mediaUrls  = extractMedia(srcMsg);
        const attFiles   = await buildAttachments(mediaUrls);
        const hlId = await maybeSendHighlight(srcMsg, contentStr, attFiles, state);
        if (hlId) {
          mirrorToSource.set(hlId, sourceId);
          const entry = mirrors.find(e => !e.highlightId);
          if (entry) entry.highlightId = hlId;
        }
      } catch (err) {
        console.warn("⚠️  Highlight threshold check after button press failed:", err.message);
      }
    }
  }
});

// ── Connect ──────────────────────────────────────────────────────────────────
client.login(BOT_TOKEN);