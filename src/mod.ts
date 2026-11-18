// ===== 1. インポート =====
import {
  ChannelType,
  GuildMember,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type Client,
} from "discord.js";
import type { MabusabaStore } from "./store.js";
import {
  EMBED_COLOR_ERROR,
  EMBED_COLOR_INFO,
  EMBED_COLOR_SUCCESS,
  buildEmbed,
  formatDuration,
  joinLinesWithinLimit,
  parseDurationMs,
  replyEmbed,
} from "./util.js";

// ===== 2. 定数とモデレーションログ =====
export const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;

// Send a moderation action to the guild's mod-log channel, if set.
export async function sendModLog(
  client: Client,
  store: MabusabaStore,
  guildId: string,
  title: string,
  description: string,
): Promise<void> {
  const channelId = store.getModLog(guildId);
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (
    !channel ||
    channel.type !== ChannelType.GuildText ||
    !channel.isSendable()
  )
    return;
  await channel
    .send({ embeds: [buildEmbed(title, description, EMBED_COLOR_INFO)] })
    .catch(() => undefined);
}

// ===== 3. 権限と階層のチェック =====
function requireGuild(interaction: ChatInputCommandInteraction): string | null {
  return interaction.guildId;
}

// Runtime permission check: /mod has no command-wide
// default_member_permissions (each subcommand needs a different
// permission), so each subcommand enforces its own permission here.
async function requirePerm(
  interaction: ChatInputCommandInteraction,
  perm: bigint,
  label: string,
): Promise<boolean> {
  if (interaction.memberPermissions?.has(perm)) return true;
  await replyEmbed(
    interaction,
    "🛡️ 権限がありません",
    `この操作には「${label}」権限が必要です。`,
    EMBED_COLOR_ERROR,
  );
  return false;
}

// Executor-vs-target hierarchy: Discord only checks the *bot's*
// role position when it times out / kicks / bans, so without this
// a moderator could punish a member whose role is equal to or
// higher than their own (e.g. another moderator, or an admin whose
// role still sits below the bot's). The guild owner may act on
// anyone; nobody may act on themselves.
function targetOutranksExecutor(
  interaction: ChatInputCommandInteraction,
  target: GuildMember,
): boolean {
  if (target.id === interaction.user.id) return true;
  if (interaction.user.id === interaction.guild?.ownerId) return false;
  const executor = interaction.member;
  if (!(executor instanceof GuildMember)) return false; // uncached API member: cannot evaluate, let Discord decide
  return target.roles.highest.position >= executor.roles.highest.position;
}

async function requireHierarchy(
  interaction: ChatInputCommandInteraction,
  target: GuildMember,
): Promise<boolean> {
  if (!targetOutranksExecutor(interaction, target)) return true;
  await replyEmbed(
    interaction,
    "🛡️ 実行できません",
    "自分と同等以上の役職のメンバーには実行できません。",
    EMBED_COLOR_ERROR,
  );
  return false;
}

// ===== 4. コマンド処理 =====
export async function handleModCommand(
  interaction: ChatInputCommandInteraction,
  client: Client,
  store: MabusabaStore,
): Promise<void> {
  const guildId = requireGuild(interaction);
  if (!guildId || !interaction.guild) {
    await replyEmbed(
      interaction,
      "⚠️ サーバー内で使用してください",
      "このコマンドはサーバー内で使用してください。",
      EMBED_COLOR_ERROR,
    );
    return;
  }
  const sub = interaction.options.getSubcommand();
  const group = interaction.options.getSubcommandGroup(false);

  // /mod log is a subcommand group (set / disable).

  // ----- 4.1 ログ設定 -----
  if (group === "log") {
    if (
      !(await requirePerm(
        interaction,
        PermissionFlagsBits.ManageGuild,
        "サーバーの管理",
      ))
    )
      return;
    if (sub === "disable") {
      store.deleteModLog(guildId);
      await replyEmbed(
        interaction,
        "🛡️ モデレーションログを止めました",
        "モデレーションログの送信を止めます。",
        EMBED_COLOR_SUCCESS,
      );
      return;
    }
    const channel = interaction.options.getChannel("channel", true);
    store.setModLog(guildId, channel.id);
    await replyEmbed(
      interaction,
      "🛡️ モデレーションログを設定しました",
      `モデレーションログを <#${channel.id}> に送信します。`,
      EMBED_COLOR_SUCCESS,
    );
    return;
  }

  // /mod warn is a subcommand group (add / list).

  // ----- 4.2 警告 -----
  if (group === "warn") {
    if (
      !(await requirePerm(
        interaction,
        PermissionFlagsBits.ModerateMembers,
        "メンバーをモデレート",
      ))
    )
      return;
    const user = interaction.options.getUser("user", true);
    if (sub === "list") {
      const warns = store.listWarns(guildId, user.id);
      if (!warns.length) {
        await replyEmbed(
          interaction,
          `⚠️ <@${user.id}> の警告`,
          "警告はありません。",
        );
        return;
      }
      const lines = warns.map(
        (w) =>
          `#${w.id}　<t:${Math.floor(w.created_at_ms / 1000)}:f>　<@${w.moderator_id}>\n　${w.reason || "（理由なし）"}`,
      );
      // A long warn history would overflow Discord's 4096-char
      // embed description limit and fail the whole reply.
      const { text, omitted } = joinLinesWithinLimit(lines);
      await replyEmbed(
        interaction,
        `⚠️ <@${user.id}> の警告（${warns.length}件）`,
        omitted ? `${text}\n…他 ${omitted} 件（古い警告は省略）` : text,
      );
      return;
    }
    // add — user (required) comes before reason (optional).
    const reason =
      interaction.options.getString("reason")?.trim() || "理由なし";
    const id = store.addWarn(guildId, user.id, interaction.user.id, reason);
    await replyEmbed(
      interaction,
      "⚠️ 警告を追加しました",
      `<@${user.id}> に警告 #${id} を追加しました。\n理由：${reason}\n累計：${store.countWarns(guildId, user.id)}件`,
      EMBED_COLOR_SUCCESS,
    );
    await sendModLog(
      client,
      store,
      guildId,
      "⚠️ 警告",
      `<@${user.id}> に警告 #${id} を追加（実行者：<@${interaction.user.id}>）\n理由：${reason}`,
    );
    return;
  }

  // ----- 4.3 タイムアウト -----
  if (sub === "timeout") {
    if (
      !(await requirePerm(
        interaction,
        PermissionFlagsBits.ModerateMembers,
        "メンバーをモデレート",
      ))
    )
      return;
    const user = interaction.options.getUser("user", true);
    const durationInput = interaction.options.getString("duration", true);
    const reason =
      interaction.options.getString("reason")?.trim() || "理由なし";
    const ms = parseDurationMs(durationInput);
    if (ms === null || ms > MAX_TIMEOUT_MS) {
      await replyEmbed(
        interaction,
        "⚠️ 期間を読み取れませんでした",
        "例：`10m` / `1h` / `1d` / `30分` / `2時間`（最大28日）",
        EMBED_COLOR_ERROR,
      );
      return;
    }
    const member = await interaction.guild.members
      .fetch(user.id)
      .catch(() => null);
    if (!member) {
      await replyEmbed(
        interaction,
        "⚠️ メンバーが見つかりません",
        "指定したユーザーはこのサーバーにいません。",
        EMBED_COLOR_ERROR,
      );
      return;
    }
    if (!(await requireHierarchy(interaction, member))) return;
    try {
      await member.timeout(ms, reason);
    } catch (error) {
      console.error("[mabusaba] timeout failed:", error);
      await replyEmbed(
        interaction,
        "⚠️ タイムアウトできませんでした",
        "Botの権限が不足しているか、役職の階層が足りません。",
        EMBED_COLOR_ERROR,
      );
      return;
    }
    await replyEmbed(
      interaction,
      "🔇 タイムアウトしました",
      `<@${user.id}> を ${formatDuration(ms)} タイムアウトしました。\n理由：${reason}`,
      EMBED_COLOR_SUCCESS,
    );
    await sendModLog(
      client,
      store,
      guildId,
      "🔇 タイムアウト",
      `<@${user.id}> を ${formatDuration(ms)} タイムアウト（実行者：<@${interaction.user.id}>）\n理由：${reason}`,
    );
    return;
  }

  // ----- 4.4 タイムアウト解除 -----
  if (sub === "untimeout") {
    if (
      !(await requirePerm(
        interaction,
        PermissionFlagsBits.ModerateMembers,
        "メンバーをモデレート",
      ))
    )
      return;
    const user = interaction.options.getUser("user", true);
    const member = await interaction.guild.members
      .fetch(user.id)
      .catch(() => null);
    if (!member) {
      await replyEmbed(
        interaction,
        "⚠️ メンバーが見つかりません",
        "指定したユーザーはこのサーバーにいません。",
        EMBED_COLOR_ERROR,
      );
      return;
    }
    try {
      await member.timeout(null);
    } catch (error) {
      console.error("[mabusaba] untimeout failed:", error);
      await replyEmbed(
        interaction,
        "⚠️ タイムアウト解除できませんでした",
        "Botの権限が不足している可能性があります。",
        EMBED_COLOR_ERROR,
      );
      return;
    }
    await replyEmbed(
      interaction,
      "🔊 タイムアウトを解除しました",
      `<@${user.id}> のタイムアウトを解除しました。`,
      EMBED_COLOR_SUCCESS,
    );
    await sendModLog(
      client,
      store,
      guildId,
      "🔊 タイムアウト解除",
      `<@${user.id}> のタイムアウトを解除（実行者：<@${interaction.user.id}>）`,
    );
    return;
  }

  // ----- 4.5 キック -----
  if (sub === "kick") {
    if (
      !(await requirePerm(
        interaction,
        PermissionFlagsBits.KickMembers,
        "メンバーをキック",
      ))
    )
      return;
    const user = interaction.options.getUser("user", true);
    const reason =
      interaction.options.getString("reason")?.trim() || "理由なし";
    const member = await interaction.guild.members
      .fetch(user.id)
      .catch(() => null);
    if (!member) {
      await replyEmbed(
        interaction,
        "⚠️ メンバーが見つかりません",
        "指定したユーザーはこのサーバーにいません。",
        EMBED_COLOR_ERROR,
      );
      return;
    }
    if (!(await requireHierarchy(interaction, member))) return;
    try {
      await member.kick(reason);
    } catch (error) {
      console.error("[mabusaba] kick failed:", error);
      await replyEmbed(
        interaction,
        "⚠️ キックできませんでした",
        "Botの権限が不足しているか、役職の階層が足りません。",
        EMBED_COLOR_ERROR,
      );
      return;
    }
    await replyEmbed(
      interaction,
      "👢 キックしました",
      `<@${user.id}> をキックしました。\n理由：${reason}`,
      EMBED_COLOR_SUCCESS,
    );
    await sendModLog(
      client,
      store,
      guildId,
      "👢 キック",
      `<@${user.id}> をキック（実行者：<@${interaction.user.id}>）\n理由：${reason}`,
    );
    return;
  }

  // ----- 4.6 バン -----
  if (sub === "ban") {
    if (
      !(await requirePerm(
        interaction,
        PermissionFlagsBits.BanMembers,
        "メンバーをBAN",
      ))
    )
      return;
    const user = interaction.options.getUser("user", true);
    const deleteDays = interaction.options.getInteger("delete-days") ?? 0;
    const reason =
      interaction.options.getString("reason")?.trim() || "理由なし";
    // Banning a non-member (pre-emptive ban) stays allowed; when the
    // target *is* a member, the executor hierarchy applies as well.
    const targetMember = await interaction.guild.members
      .fetch(user.id)
      .catch(() => null);
    if (targetMember && !(await requireHierarchy(interaction, targetMember)))
      return;
    try {
      await interaction.guild.members.ban(user.id, {
        deleteMessageDays: deleteDays,
        reason,
      });
    } catch (error) {
      console.error("[mabusaba] ban failed:", error);
      await replyEmbed(
        interaction,
        "⚠️ BANできませんでした",
        "Botの権限が不足しているか、役職の階層が足りません。",
        EMBED_COLOR_ERROR,
      );
      return;
    }
    await replyEmbed(
      interaction,
      "🔨 BANしました",
      `<@${user.id}> をBANしました。\n理由：${reason}${deleteDays ? `\n過去${deleteDays}日分のメッセージを削除しました。` : ""}`,
      EMBED_COLOR_SUCCESS,
    );
    await sendModLog(
      client,
      store,
      guildId,
      "🔨 BAN",
      `<@${user.id}> をBAN（実行者：<@${interaction.user.id}>）\n理由：${reason}`,
    );
    return;
  }

  // ----- 4.7 バン解除 -----
  if (sub === "unban") {
    if (
      !(await requirePerm(
        interaction,
        PermissionFlagsBits.BanMembers,
        "メンバーをBAN",
      ))
    )
      return;
    const userId = interaction.options.getString("user-id", true).trim();
    try {
      await interaction.guild.members.unban(userId);
    } catch (error) {
      console.error("[mabusaba] unban failed:", error);
      await replyEmbed(
        interaction,
        "⚠️ BAN解除できませんでした",
        "ユーザーIDを確認してください。BANされていないか、権限が不足している可能性があります。",
        EMBED_COLOR_ERROR,
      );
      return;
    }
    await replyEmbed(
      interaction,
      "🔓 BANを解除しました",
      `<@${userId}> のBANを解除しました。`,
      EMBED_COLOR_SUCCESS,
    );
    await sendModLog(
      client,
      store,
      guildId,
      "🔓 BAN解除",
      `<@${userId}> のBANを解除（実行者：<@${interaction.user.id}>）`,
    );
    return;
  }

  // ----- 4.8 メッセージ一括削除 -----
  if (sub === "clear") {
    if (
      !(await requirePerm(
        interaction,
        PermissionFlagsBits.ManageGuild,
        "サーバーの管理",
      ))
    )
      return;
    const count = interaction.options.getInteger("count", true);
    const channel = interaction.channel;
    if (!channel || !("bulkDelete" in channel)) {
      await replyEmbed(
        interaction,
        "⚠️ サーバー内で使用してください",
        "このコマンドはサーバーのテキストチャンネルで使用してください。",
        EMBED_COLOR_ERROR,
      );
      return;
    }
    try {
      const deleted = await channel.bulkDelete(count, true);
      await replyEmbed(
        interaction,
        "🗑️ メッセージを削除しました",
        `${deleted.size}件のメッセージを削除しました。`,
        EMBED_COLOR_SUCCESS,
      );
      await sendModLog(
        client,
        store,
        guildId,
        "🗑️ メッセージ一括削除",
        `<#${channel.id}> で ${deleted.size}件を削除（実行者：<@${interaction.user.id}>）`,
      );
    } catch (error) {
      console.error("[mabusaba] clear failed:", error);
      await replyEmbed(
        interaction,
        "⚠️ 削除できませんでした",
        "14日より前のメッセージは一括削除できません。Botの権限も確認してください。",
        EMBED_COLOR_ERROR,
      );
    }
    return;
  }

  await replyEmbed(
    interaction,
    "⚠️ 不明なサブコマンドです",
    "不明なサブコマンドです。",
    EMBED_COLOR_ERROR,
  );
}
