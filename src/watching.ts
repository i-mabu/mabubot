// ===== 1. インポート =====
import {
  ActivityType,
  type ChatInputCommandInteraction,
  type Client,
} from "discord.js";
import type { MabusabaStore } from "./store.js";
import { EMBED_COLOR_SUCCESS, replyEmbed } from "./util.js";

// ===== 2. ステータス文の解決と適用 =====
// Default Watching text. Overridden by WATCHING_TEXT env, then by /watching set (stored in SQLite).
export const DEFAULT_WATCHING_TEXT = "まぶさばを見守り中";
export const WATCHING_SETTING_KEY = "watching_text";

export function resolveWatchingText(store: MabusabaStore): string {
  const stored = store.getSetting(WATCHING_SETTING_KEY)?.trim();
  if (stored) return stored;
  const env = process.env.WATCHING_TEXT?.trim();
  if (env) return env;
  return DEFAULT_WATCHING_TEXT;
}

export function applyWatching(client: Client, store: MabusabaStore): void {
  client.user?.setActivity(resolveWatchingText(store), {
    type: ActivityType.Watching,
  });
}

// ===== 3. コマンド処理 =====
export async function handleWatchingCommand(
  interaction: ChatInputCommandInteraction,
  client: Client,
  store: MabusabaStore,
): Promise<void> {
  const sub = interaction.options.getSubcommand();
  if (sub === "show") {
    await replyEmbed(
      interaction,
      "👀 視聴中ステータス",
      `現在の視聴中ステータス：${resolveWatchingText(store)}`,
    );
    return;
  }
  if (sub === "reset") {
    store.deleteSetting(WATCHING_SETTING_KEY);
    applyWatching(client, store);
    await replyEmbed(
      interaction,
      "👀 視聴中ステータスを既定に戻しました",
      `現在の視聴中ステータス：${resolveWatchingText(store)}`,
      EMBED_COLOR_SUCCESS,
    );
    return;
  }
  // set — presence is bot-wide, so this applies to every guild the bot is in.
  const text = interaction.options.getString("text", true).trim();
  store.setSetting(WATCHING_SETTING_KEY, text);
  applyWatching(client, store);
  await replyEmbed(
    interaction,
    "👀 視聴中ステータスを設定しました",
    text,
    EMBED_COLOR_SUCCESS,
  );
}
