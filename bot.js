const {
  Client,
  GatewayIntentBits,
  Events,
  AttachmentBuilder,
} = require("discord.js");
const https = require("https");
const http  = require("http");

// ── Configuration ────────────────────────────────────────────────────────────
// Each of these accepts comma-separated values, e.g. "123,456,789"
const SOURCE_BOT_IDS      = (process.env.SOURCE_BOT_ID      || "").split(",").map(s => s.trim()).filter(Boolean);
const TARGET_CHANNEL_IDS  = (process.env.TARGET_CHANNEL_ID  || "").split(",").map(s => s.trim()).filter(Boolean);
const IGNORED_CHANNEL_IDS = (process.env.IGNORED_CHANNEL_ID || "").split(",").map(s => s.trim()).filter(Boolean);

// Highlight / viral detection
const HIGHLIGHT_CHANNEL_ID  = (process.env.HIGHLIGHT_ID         || "").trim();
const HUMAN_ROLE_ID          = (process.env.HUMAN_ROLE_ID        || "").trim();
const HIGHLIGHT_PERCENTAGE   = parseFloat(process.env.HIGHLIGHT_PERCENTAGE || "0") / 100; // stored as 0-1

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

/**
 * mirroredMessages:  sourceMessageId → MirrorEntry[]
 *
 * MirrorEntry: {
 *   mirroredId      : string,
 *   targetChannelId : string,
 *   highlightId     : string | null,   ← id of the highlight-channel copy (if sent)
 * }
 */
const mirroredMessages = new Map();

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

// ── Reaction helpers ─────────────────────────────────────────────────────────

/**
 * Merge reactions from two messages (the forwarded source and the original
 * quoted message it references), deduplicating users per emoji.
 *
 * Returns Map< emojiKey, Set<userId> >
 * where emojiKey is "<name>:<id>" for custom or just the unicode char for built-ins.
 */
async function collectMergedReactions(sourceMessage) {
  // Map: emojiKey → Set<userId>
  const merged = new Map();

  async function absorb(msg) {
    // Ensure we have a full message object
    let fullMsg = msg;
    if (msg.partial) {
      try { fullMsg = await msg.fetch(); } catch { return; }
    }
    for (const [, reaction] of fullMsg.reactions.cache) {
      const key = reaction.emoji.id
        ? `${reaction.emoji.name}:${reaction.emoji.id}`
        : reaction.emoji.name;
      if (!merged.has(key)) merged.set(key, new Set());
      const users = merged.get(key);
      try {
        // Fetch all users who reacted with this emoji
        const reactors = await reaction.users.fetch();
        for (const [userId] of reactors) {
          users.add(userId);
        }
      } catch (err) {
        console.warn(`⚠️  Could not fetch users for reaction ${key}:`, err.message);
        // Fall back to just the count if we can't fetch users
        users.add(`__count_${reaction.count}`);
      }
    }
  }

  // 1. Absorb reactions from the forwarded (source) message
  await absorb(sourceMessage);

  // 2. Absorb reactions from the original quoted message (if any)
  if (sourceMessage.reference?.messageId) {
    try {
      const refChannel = await client.channels.fetch(sourceMessage.reference.channelId);
      const refMessage = await refChannel.messages.fetch(sourceMessage.reference.messageId);
      await absorb(refMessage);
    } catch {
      // Original may be deleted; ignore
    }
  }

  return merged;
}

/**
 * Apply merged reactions (from source + original quote) to a mirrored message.
 * Removes all existing reactions first, then adds one reaction per unique emoji.
 * Discord doesn't let bots set counts directly — we add the reaction once so it
 * shows as a reaction bubble, and the true merged count is displayed in the
 * message text footer (see buildReactionCountLine).
 */
async function applyMergedReactions(sourceMessage, mirroredMsg) {
  // Remove existing bot reactions
  try { await mirroredMsg.reactions.removeAll(); } catch { /* may lack permission */ }

  const merged = await collectMergedReactions(sourceMessage);

  for (const [emojiKey, userSet] of merged) {
    if (userSet.size === 0) continue;
    // Resolve emoji identifier back for react()
    const emojiId = emojiKey.includes(":") ? emojiKey.split(":")[1] : emojiKey;
    const emojiArg = emojiId || emojiKey;
    try {
      await mirroredMsg.react(emojiArg);
    } catch (err) {
      console.warn(`⚠️  Could not react with ${emojiKey}:`, err.message);
    }
  }

  return merged;
}

// ── Highlight helpers ─────────────────────────────────────────────────────────

/**
 * Count members in the guild that have the HUMAN_ROLE_ID role.
 */
async function countHumanMembers(guild) {
  if (!HUMAN_ROLE_ID) return 0;
  try {
    // Fetch the role via REST — works without GuildMembers intent.
    // If GuildMembers intent IS enabled, role.members.size is accurate.
    // Without it the members cache is empty, so we fall back to a targeted
    // REST search: fetch up to 1000 members at a time by role until exhausted.
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
 * Return the total number of unique users who have reacted with any emoji,
 * from the merged reaction map.
 */
function countUniqueReactors(merged) {
  const all = new Set();
  for (const userSet of merged.values()) {
    for (const uid of userSet) {
      if (!uid.startsWith("__count_")) all.add(uid);
    }
  }
  return all.size;
}

/**
 * Send (or skip) a highlight copy if the reaction threshold is met.
 * Returns the highlight message id if sent, null otherwise.
 *
 * entry.highlightId is set so we can delete it later if needed.
 */
async function maybeSendHighlight(sourceMessage, content, attachments, merged) {
  if (!HIGHLIGHT_CHANNEL_ID || !HUMAN_ROLE_ID || HIGHLIGHT_PERCENTAGE <= 0) return null;

  const guild = sourceMessage.guild;
  if (!guild) return null;

  const humanCount   = await countHumanMembers(guild);
  const reactorCount = countUniqueReactors(merged);

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
    const hlMsg = await hlChannel.send({ content, files: attachments });
    console.log(`⭐  Sent highlight copy → ${hlMsg.id} in #${HIGHLIGHT_CHANNEL_ID}`);
    // Mirror reactions onto the highlight copy too
    await applyMergedReactions(sourceMessage, hlMsg);
    return hlMsg.id;
  } catch (err) {
    console.error("❌  Failed to send highlight message:", err);
    return null;
  }
}

// ── Core mirroring ────────────────────────────────────────────────────────────

/**
 * Mirror a message to all target channels.
 * Returns an array of MirrorEntry objects for bookkeeping.
 */
async function mirrorToAllTargets(sourceMessage, mediaUrls) {
  const content     = await buildContent(sourceMessage);
  const attachments = await buildAttachments(mediaUrls);
  const results     = [];

  for (const channelId of TARGET_CHANNEL_IDS) {
    try {
      const targetChannel = await client.channels.fetch(channelId);
      if (!targetChannel?.isTextBased()) {
        console.warn(`⚠️  Target channel ${channelId} is not a text channel.`);
        continue;
      }
      const mirrored = await targetChannel.send({ content, files: attachments });
      console.log(`📤  Mirrored ${sourceMessage.id} → ${mirrored.id} in #${channelId}`);

      // Apply merged reactions (source + original quoted message)
      const merged = await applyMergedReactions(sourceMessage, mirrored);

      // Check highlight threshold
      const highlightId = await maybeSendHighlight(sourceMessage, content, attachments, merged);

      results.push({
        mirroredId:      mirrored.id,
        targetChannelId: channelId,
        highlightId,
      });
    } catch (err) {
      console.error(`❌  Failed to mirror to channel ${channelId}:`, err);
    }
  }

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
  const content     = mediaUrls.length > 0 ? await buildContent(newMessage)         : null;
  const attachments = mediaUrls.length > 0 ? await buildAttachments(mediaUrls)      : null;

  for (const entry of [...mirrors]) {
    try {
      const targetChannel = await client.channels.fetch(entry.targetChannelId);
      const mirroredMsg   = await targetChannel.messages.fetch(entry.mirroredId);

      if (!content) {
        // Delete the mirror and any associated highlight copy
        await mirroredMsg.delete();
        mirrors.splice(mirrors.indexOf(entry), 1);
        console.log(`🗑️   Deleted mirror ${entry.mirroredId} (media removed)`);

        if (entry.highlightId) {
          try {
            const hlChannel = await client.channels.fetch(HIGHLIGHT_CHANNEL_ID);
            const hlMsg     = await hlChannel.messages.fetch(entry.highlightId);
            await hlMsg.delete();
            console.log(`🗑️   Deleted highlight copy ${entry.highlightId}`);
          } catch (hlErr) {
            console.warn(`⚠️  Could not delete highlight copy ${entry.highlightId}:`, hlErr.message);
          }
          entry.highlightId = null;
        }

        // Also delete the source bot message
        try {
          await newMessage.delete();
          console.log(`🗑️   Deleted source message ${newMessage.id} (quote removed)`);
        } catch (srcErr) {
          console.warn(`⚠️  Could not delete source message ${newMessage.id}:`, srcErr.message);
        }
      } else {
        // Edit is tricky with attachments — we must delete and resend to swap files
        // (Discord.js doesn't support replacing attachments on existing messages cleanly)
        const newMirrored = await targetChannel.send({ content, files: attachments });
        await mirroredMsg.delete().catch(() => {});
        entry.mirroredId = newMirrored.id;

        // Re-apply merged reactions
        const merged = await applyMergedReactions(newMessage, newMirrored);

        // Update highlight copy if it exists
        if (entry.highlightId) {
          try {
            const hlChannel = await client.channels.fetch(HIGHLIGHT_CHANNEL_ID);
            const hlMsg     = await hlChannel.messages.fetch(entry.highlightId);
            const newHl     = await hlChannel.send({ content, files: attachments });
            await hlMsg.delete().catch(() => {});
            entry.highlightId = newHl.id;
            await applyMergedReactions(newMessage, newHl);
          } catch (hlErr) {
            console.warn(`⚠️  Could not update highlight copy:`, hlErr.message);
          }
        } else {
          // Check if the updated reactions now clear the highlight bar
          const newHighlightId = await maybeSendHighlight(newMessage, content, attachments, merged);
          entry.highlightId = newHighlightId;
        }

        console.log(`✏️   Re-sent mirror as ${newMirrored.id} (edit with new attachments)`);
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

    // Delete highlight copy too
    if (entry.highlightId) {
      try {
        const hlChannel = await client.channels.fetch(HIGHLIGHT_CHANNEL_ID);
        const hlMsg     = await hlChannel.messages.fetch(entry.highlightId);
        await hlMsg.delete();
        console.log(`🗑️   Deleted highlight copy ${entry.highlightId} for deleted source ${message.id}`);
      } catch (hlErr) {
        console.warn(`⚠️  Could not delete highlight copy ${entry.highlightId}:`, hlErr.message);
      }
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

  // Fetch full source message to get accurate merged reactions
  let fullSource;
  try { fullSource = await sourceMessage.fetch(); }
  catch { return; }

  for (const entry of mirrors) {
    try {
      const targetChannel = await client.channels.fetch(entry.targetChannelId);
      const mirroredMsg   = await targetChannel.messages.fetch(entry.mirroredId);
      const merged        = await applyMergedReactions(fullSource, mirroredMsg);

      // Check whether we've now crossed the highlight threshold
      if (!entry.highlightId && HIGHLIGHT_CHANNEL_ID) {
        const content     = await buildContent(fullSource);
        const mediaUrls   = extractMedia(fullSource);
        const attachments = await buildAttachments(mediaUrls);
        const hlId = await maybeSendHighlight(fullSource, content, attachments, merged);
        if (hlId) entry.highlightId = hlId;
      } else if (entry.highlightId) {
        // Keep highlight copy's reactions in sync too
        try {
          const hlChannel = await client.channels.fetch(HIGHLIGHT_CHANNEL_ID);
          const hlMsg     = await hlChannel.messages.fetch(entry.highlightId);
          await applyMergedReactions(fullSource, hlMsg);
        } catch { /* ignore */ }
      }
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

  let fullSource;
  try { fullSource = await sourceMessage.fetch(); }
  catch { return; }

  for (const entry of mirrors) {
    try {
      const targetChannel = await client.channels.fetch(entry.targetChannelId);
      const mirroredMsg   = await targetChannel.messages.fetch(entry.mirroredId);
      await applyMergedReactions(fullSource, mirroredMsg);

      // Sync highlight copy if present
      if (entry.highlightId) {
        try {
          const hlChannel = await client.channels.fetch(HIGHLIGHT_CHANNEL_ID);
          const hlMsg     = await hlChannel.messages.fetch(entry.highlightId);
          await applyMergedReactions(fullSource, hlMsg);
        } catch { /* ignore */ }
      }
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

    // Clear highlight copy reactions too
    if (entry.highlightId) {
      try {
        const hlChannel = await client.channels.fetch(HIGHLIGHT_CHANNEL_ID);
        const hlMsg     = await hlChannel.messages.fetch(entry.highlightId);
        await hlMsg.reactions.removeAll();
      } catch { /* ignore */ }
    }
  }
});

// ── Connect ──────────────────────────────────────────────────────────────────
client.login(BOT_TOKEN);
