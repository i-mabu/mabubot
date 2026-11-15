// ===== 1. インポート =====
import {
  ChannelType,
  type ChatInputCommandInteraction,
  type GuildMember,
} from "discord.js";
import type { MabusabaStore } from "./store.js";
import {
  EMBED_COLOR_ERROR,
  EMBED_COLOR_INFO,
  EMBED_COLOR_SUCCESS,
  buildEmbed,
  replyEmbed,
} from "./util.js";

// ===== 2. ウェルカムメッセージ =====
export function renderWelcomeMessage(
  template: string | null,
  member: GuildMember,
): string {
  const text =
    template?.trim() ||
    "ようこそ {server} へ、{user} さん！ {count}人目のメンバーです 🎉";
  return text
    .replaceAll("{user}", `<@${member.id}>`)
    .replaceAll("{server}", member.guild.name)
    .replaceAll("{count}", String(member.guild.memberCount));
}

// Sent on GuildMemberAdd when a welcome channel is set.
export async function sendWelcome(
  member: GuildMember,
  store: MabusabaStore,
): Promise<void> {
  const welcome = store.getWelcome(member.guild.id);
  if (!welcome) return;
  const channel = await member.guild.channels
    .fetch(welcome.channel_id)
    .catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) return;
  if (!channel.isSendable()) return;
  const embed = buildEmbed(
    `👋 ようこそ、${member.user.username} さん！`,
    renderWelcomeMessage(welcome.message, member),
    EMBED_COLOR_INFO,
    [
      { name: "👤 ユーザー", value: `<@${member.id}>`, inline: true },
      {
        name: "📅 アカウント作成日",
        value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`,
        inline: true,
      },
    ],
  );
  await channel.send({ embeds: [embed] }).catch(() => undefined);
}

// Maximum autoroles per guild, to keep the list sane.

// ===== 3. 自動ロール =====
export const MAX_AUTOROLES = 10;

// Apply the autoroles on GuildMemberAdd. Failures (missing
// permission, role hierarchy) are logged, never thrown — a join
// must not fail because a role could not be added. Roles are added
// in one call when possible; if that fails, each role is retried
// on its own so one bad role does not block the rest.
export async function applyAutorole(
  member: GuildMember,
  store: MabusabaStore,
): Promise<void> {
  const roleIds = store.getAutoroles(member.guild.id);
  if (!roleIds.length) return;
  try {
    await member.roles.add(roleIds);
    return;
  } catch {
    // Fall through to per-role retries below.
  }
  for (const roleId of roleIds) {
    try {
      await member.roles.add(roleId);
    } catch (error) {
      console.error(
        `[mabusaba] autorole failed for ${member.id} in ${member.guild.id} (role ${roleId}):`,
        error,
      );
    }
  }
}

// ===== 4. コマンド処理 =====
export async function handleWelcomeCommand(
  interaction: ChatInputCommandInteraction,
  store: MabusabaStore,
): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await replyEmbed(
      interaction,
      "⚠️ サーバー内で使用してください",
      "このコマンドはサーバー内で使用してください。",
      EMBED_COLOR_ERROR,
    );
    return;
  }
  const sub = interaction.options.getSubcommand();
  if (sub === "show") {
    const welcome = store.getWelcome(guildId);
    if (!welcome) {
      await replyEmbed(
        interaction,
        "👋 歓迎メッセージ",
        "歓迎メッセージは設定されていません。`/welcome set` で設定してください。",
      );
      return;
    }
    await replyEmbed(
      interaction,
      "👋 歓迎メッセージ",
      `通知先：<#${welcome.channel_id}>\nメッセージ：${welcome.message ?? "（既定のメッセージ）"}\n\nプレースホルダ：{user}（メンション）{server}（サーバー名）{count}（メンバー数）`,
    );
    return;
  }
  if (sub === "disable") {
    store.deleteWelcome(guildId);
    await replyEmbed(
      interaction,
      "👋 歓迎メッセージを止めました",
      "参加時の歓迎メッセージを送信しなくなります。",
      EMBED_COLOR_SUCCESS,
    );
    return;
  }
  if (sub === "test") {
    const welcome = store.getWelcome(guildId);
    if (!welcome) {
      await replyEmbed(
        interaction,
        "⚠️ 未設定です",
        "まず `/welcome set` で通知先を設定してください。",
        EMBED_COLOR_ERROR,
      );
      return;
    }
    const member = interaction.member;
    if (!member || !("guild" in member)) {
      await replyEmbed(
        interaction,
        "⚠️ サーバー内で使用してください",
        "このコマンドはサーバー内で使用してください。",
        EMBED_COLOR_ERROR,
      );
      return;
    }
    await replyEmbed(
      interaction,
      "👋 歓迎メッセージのテスト",
      renderWelcomeMessage(welcome.message, member as GuildMember),
      EMBED_COLOR_INFO,
      false,
    );
    return;
  }
  // set — channel (required) comes before message (optional).
  const channel = interaction.options.getChannel("channel", true);
  // A whitespace-only message means the default text at render time;
  // store it as unset so `show` does not display a blank message.
  const message = interaction.options.getString("message")?.trim() || null;
  store.setWelcome(guildId, channel.id, message);
  await replyEmbed(
    interaction,
    "👋 歓迎メッセージを設定しました",
    `通知先：<#${channel.id}>\nメッセージ：${message ?? "（既定のメッセージ）"}`,
    EMBED_COLOR_SUCCESS,
  );
}

// ----- 4.1 自動ロールのコマンド処理 -----
export async function handleAutoroleCommand(
  interaction: ChatInputCommandInteraction,
  store: MabusabaStore,
): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await replyEmbed(
      interaction,
      "⚠️ サーバー内で使用してください",
      "このコマンドはサーバー内で使用してください。",
      EMBED_COLOR_ERROR,
    );
    return;
  }
  const sub = interaction.options.getSubcommand();
  if (sub === "show") {
    const roleIds = store.getAutoroles(guildId);
    await replyEmbed(
      interaction,
      "🎭 自動役職",
      roleIds.length
        ? `参加時に自動で付与する役職（${roleIds.length}件）：\n${roleIds.map((id) => `・<@&${id}>`).join("\n")}`
        : "自動役職は設定されていません。`/autorole set` で設定してください。",
    );
    return;
  }
  if (sub === "remove") {
    const role = interaction.options.getRole("role");
    if (role) {
      if (!store.removeAutorole(guildId, role.id)) {
        await replyEmbed(
          interaction,
          "⚠️ 設定されていません",
          `<@&${role.id}> は自動役職に設定されていません。`,
          EMBED_COLOR_ERROR,
        );
        return;
      }
      const remaining = store.getAutoroles(guildId);
      await replyEmbed(
        interaction,
        "🎭 自動役職を解除しました",
        `<@&${role.id}> の自動付与を止めました。${remaining.length ? `\n残り（${remaining.length}件）：\n${remaining.map((id) => `・<@&${id}>`).join("\n")}` : "\n自動役職はすべて解除されました。"}`,
        EMBED_COLOR_SUCCESS,
      );
      return;
    }
    store.deleteAutorole(guildId);
    await replyEmbed(
      interaction,
      "🎭 自動役職をすべて解除しました",
      "参加時の自動役職付与を止めます。",
      EMBED_COLOR_SUCCESS,
    );
    return;
  }
  // set — additive: each call adds one more role instead of replacing
  // the previous one. Repeat the command to set multiple roles.
  const role = interaction.options.getRole("role", true);
  // @everyone and integration-managed roles can never be assigned to
  // a member; accepting them here would only fail at join time.
  if (role.id === guildId || role.managed) {
    await replyEmbed(
      interaction,
      "⚠️ その役職は付与できません",
      `<@&${role.id}> は自動付与できない役職です（@everyone・連携サービス管理の役職は付与できません）。`,
      EMBED_COLOR_ERROR,
    );
    return;
  }
  const current = store.getAutoroles(guildId);
  if (current.includes(role.id)) {
    await replyEmbed(
      interaction,
      "🎭 すでに設定されています",
      `<@&${role.id}> はすでに自動役職に設定されています。`,
      EMBED_COLOR_ERROR,
    );
    return;
  }
  if (current.length >= MAX_AUTOROLES) {
    await replyEmbed(
      interaction,
      "⚠️ 上限に達しました",
      `自動役職は最大 ${MAX_AUTOROLES}件までです。先に \`/autorole remove\` で減らしてください。`,
      EMBED_COLOR_ERROR,
    );
    return;
  }
  store.addAutorole(guildId, role.id);
  const roleIds = store.getAutoroles(guildId);
  await replyEmbed(
    interaction,
    "🎭 自動役職を設定しました",
    `参加時に <@&${role.id}> を自動で付与します。\n現在の自動役職（${roleIds.length}件）：\n${roleIds.map((id) => `・<@&${id}>`).join("\n")}`,
    EMBED_COLOR_SUCCESS,
  );
}
