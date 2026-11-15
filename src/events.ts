// =============
// 1. インポート
// =============
import {
  ChannelType,
  PermissionFlagsBits,
  type Client,
  type Message,
} from "discord.js";
import type { MabusabaStore } from "./store.js";
import { applyAutorole, sendWelcome } from "./welcome.js";
import {
  XP_COOLDOWN_MS,
  XP_PER_MESSAGE_MAX,
  XP_PER_MESSAGE_MIN,
  awardXp,
} from "./level.js";
import { handlePollButton } from "./poll.js";
import { handleRecruitButton } from "./recruit.js";
import { sendModLog } from "./mod.js";
import { formatDuration, randomInt } from "./util.js";

// =======================
// 2. スパム対策の定数と型
// =======================
// Anti-spam thresholds: 6+ messages in 5s, or 5+ identical
// messages in 10s, from the same user -> 10-minute timeout.
const SPAM_WINDOW_MS = 5_000;
const SPAM_COUNT = 6;
const SPAM_SAME_WINDOW_MS = 10_000;
const SPAM_SAME_COUNT = 5;
const AUTO_TIMEOUT_MS = 10 * 60_000;
const AUTO_TIMEOUT_COOLDOWN_MS = 60_000;

interface RecentMessage {
  atMs: number;
  content: string;
  messageId: string;
  channelId: string;
}

// ===============
// 3. イベント登録
// ===============
export function registerEvents(client: Client, store: MabusabaStore): void {
  const recentByUser = new Map<string, RecentMessage[]>();
  const lastAutoTimeout = new Map<string, number>();

  // Prune bookkeeping for users who stopped posting; without this
  // both maps grow by one entry per user ever seen, forever.
  const prune = setInterval(() => {
    const now = Date.now();
    for (const [key, recent] of recentByUser) {
      if (
        !recent.length ||
        now - recent[recent.length - 1]!.atMs > SPAM_SAME_WINDOW_MS
      )
        recentByUser.delete(key);
    }
    for (const [key, at] of lastAutoTimeout) {
      if (now - at > AUTO_TIMEOUT_COOLDOWN_MS) lastAutoTimeout.delete(key);
    }
  }, 10 * 60_000);
  prune.unref();

  client.on("guildMemberAdd", async (member) => {
    if (member.user.bot) return;
    await sendWelcome(member, store);
    await applyAutorole(member, store);
  });

  client.on("messageCreate", async (message: Message) => {
    if (!message.guildId || !message.guild || message.author.bot) return;
    if (message.channel.type !== ChannelType.GuildText) return;
    const guildId = message.guildId;
    const userId = message.author.id;
    const now = Date.now();

    // --- Anti-spam (runs before XP so spam never earns XP) ---
    const key = `${guildId}:${userId}`;
    const recent = (recentByUser.get(key) ?? []).filter(
      (r) => now - r.atMs <= SPAM_SAME_WINDOW_MS,
    );
    recent.push({
      atMs: now,
      content: message.content,
      messageId: message.id,
      channelId: message.channelId,
    });
    recentByUser.set(key, recent);
    const in5s = recent.filter((r) => now - r.atMs <= SPAM_WINDOW_MS).length;
    const sameIn10s = recent.filter(
      (r) => r.content === message.content && message.content.length > 0,
    ).length;
    if (
      (in5s >= SPAM_COUNT || sameIn10s >= SPAM_SAME_COUNT) &&
      now - (lastAutoTimeout.get(key) ?? 0) > AUTO_TIMEOUT_COOLDOWN_MS
    ) {
      const member = await message.guild.members
        .fetch(userId)
        .catch(() => null);
      // Moderators and the owner are never auto-timed-out: a mod
      // posting quickly while handling an incident is doing their
      // job. (The owner / high roles were already safe via
      // `moderatable`, but a mod whose role sits below the bot's
      // was not.)
      const exempt =
        member !== null &&
        (member.id === message.guild.ownerId ||
          member.permissions.has(PermissionFlagsBits.ModerateMembers) ||
          member.permissions.has(PermissionFlagsBits.Administrator));
      if (exempt) {
        // Reset the window and let the message earn XP as usual.
        recentByUser.set(key, []);
      } else {
        lastAutoTimeout.set(key, now);
        if (member?.moderatable) {
          await member
            .timeout(AUTO_TIMEOUT_MS, "荒らし対策：短時間の連投を検知")
            .catch(() => undefined);
          // Delete the spam messages. They are tracked per
          // guild+user, so they can span several channels — group
          // by channel and bulk-delete in each one. (Deleting every
          // ID in the *current* channel, one by one, silently left
          // spam posted in other channels in place.)
          const byChannel = new Map<string, string[]>();
          for (const r of recent) {
            const ids = byChannel.get(r.channelId) ?? [];
            ids.push(r.messageId);
            byChannel.set(r.channelId, ids);
          }
          for (const [channelId, ids] of byChannel) {
            const ch =
              channelId === message.channelId
                ? message.channel
                : await message.guild.channels
                    .fetch(channelId)
                    .catch(() => null);
            if (!ch || !("bulkDelete" in ch)) continue;
            for (let i = 0; i < ids.length; i += 100) {
              await ch
                .bulkDelete(ids.slice(i, i + 100), true)
                .catch(() => undefined);
            }
          }
          await sendModLog(
            client,
            store,
            guildId,
            "🚨 荒らし対策：自動タイムアウト",
            `<@${userId}> を ${formatDuration(AUTO_TIMEOUT_MS)} タイムアウトしました。\n理由：短時間の連投（${in5s}件/5秒）または同一内容の連投（${sameIn10s}件/10秒）を検知`,
          );
        }
        recentByUser.set(key, []);
        return;
      }
    }

    // --- XP: 15-25 per message, 60s cooldown per user per guild ---
    const row = store.getXp(guildId, userId);
    if (row && now - row.last_xp_at_ms < XP_COOLDOWN_MS) return;
    const amount = randomInt(XP_PER_MESSAGE_MIN, XP_PER_MESSAGE_MAX);
    await awardXp(
      client,
      store,
      message.guild,
      message.channel,
      userId,
      amount,
    ).catch(() => undefined);
  });

  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isButton()) return;
    try {
      if (interaction.customId.startsWith("poll:"))
        await handlePollButton(interaction, store);
      else if (interaction.customId.startsWith("recruit:"))
        await handleRecruitButton(interaction, store);
    } catch (error) {
      console.error("button interaction failed", error);
      if (!interaction.replied) {
        await interaction
          .reply({ content: "処理に失敗しました。", ephemeral: true })
          .catch(() => undefined);
      }
    }
  });
}
