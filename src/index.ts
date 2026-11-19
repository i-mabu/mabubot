// ===== 1. インポート =====
import { Client, EmbedBuilder, GatewayIntentBits, Partials } from "discord.js";
import { MabusabaStore } from "./store.js";
import { handleChatInputCommand } from "./commands.js";
import { registerEvents } from "./events.js";
import { applyWatching } from "./watching.js";
import { reschedulePolls } from "./poll.js";
import { rescheduleRecruits } from "./recruit.js";
import { rescheduleTimers } from "./timer.js";
import { EMBED_COLOR_ERROR, EMBED_FOOTER } from "./util.js";
import { attachReadyWatchdog } from "./watchdog.js";

// ===== 2. 初期化 =====
const token = process.env.DISCORD_TOKEN?.trim();
if (!token) {
  console.error(
    "DISCORD_TOKEN is required. Copy .env.example to .env and set it.",
  );
  process.exit(1);
}
const dataDir = process.env.DATA_DIR?.trim() || "./data";
const store = new MabusabaStore(dataDir);

// Partials are needed so events still carry content/author when the
// object was not in cache.
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // privileged: join / autorole
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // privileged: XP + anti-spam need content
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildModeration, // ban/unban
  ],
  partials: [
    Partials.Message,
    Partials.Channel,
    Partials.GuildMember,
    Partials.User,
  ],
});

// Gateway安全構造: READY が来ないサイレント停滞を検知して終了する (watchdog.ts)
attachReadyWatchdog(client);

// ===== 3. 起動時の処理 =====
client.once("ready", () => {
  console.log(`Logged in as ${client.user?.tag}`);
  // Watching status: stored /watching text, else WATCHING_TEXT env, else default.
  applyWatching(client, store);
  // Re-schedule anything pending from SQLite so a restart does not
  // lose polls, recruitments or timers (overdue ones close/fire at once).
  reschedulePolls(client, store);
  rescheduleRecruits(client, store);
  rescheduleTimers(client, store);
  // Commands are NOT synced here. Run `npm run sync:commands` to
  // overwrite-sync the global commands (see src/sync-commands.ts).
  // This keeps startup from resurrecting commands deleted by a sync.
});

// ===== 4. コマンド実行時の処理 =====
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try {
    await handleChatInputCommand(interaction, client, store);
  } catch (error) {
    console.error("interaction failed", error);
    // reply() only works on an untouched interaction: once a handler
    // has replied or deferred, the error notice must go through
    // followUp, otherwise it throws and the user sees nothing.
    const embed = new EmbedBuilder()
      .setTitle("⚠️ 処理に失敗しました")
      .setDescription("処理に失敗しました。")
      .setColor(EMBED_COLOR_ERROR)
      .setFooter({ text: EMBED_FOOTER })
      .setTimestamp(new Date());
    if (interaction.replied || interaction.deferred) {
      await interaction
        .followUp({ embeds: [embed], ephemeral: true })
        .catch(() => undefined);
    } else {
      await interaction
        .reply({ embeds: [embed], ephemeral: true })
        .catch(() => undefined);
    }
  }
});

// ===== 5. イベント登録と終了処理 =====
registerEvents(client, store);

process.on("SIGINT", () => {
  store.close();
  process.exit(0);
});
process.on("SIGTERM", () => {
  store.close();
  process.exit(0);
});

await client.login(token);
