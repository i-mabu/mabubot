// ===== 1. インポート =====
import type {
  ChatInputCommandInteraction,
  Client,
  Guild,
  TextChannel,
} from "discord.js";
import type { MabusabaStore } from "./store.js";
import {
  EMBED_COLOR_ERROR,
  EMBED_COLOR_INFO,
  EMBED_COLOR_SUCCESS,
  randomInt,
  replyEmbed,
} from "./util.js";
import { awardXp } from "./level.js";

// ===== 2. 数当てゲーム =====
// Number-guessing games live in memory only (per guild + channel +
// user), as specified: a restart ends any game in progress.
interface NumberGame {
  answer: number;
  attempts: number;
  maxAttempts: number;
  startedAtMs: number;
}

const numberGames = new Map<string, NumberGame>();

// A started game expires after this long. Without an expiry, an
// abandoned game blocked the user from ever starting a new one in
// that channel (start only said "already in progress") and the map
// grew forever; startedAtMs was recorded but never used.
export const NUMBER_GAME_TTL_MS = 30 * 60_000;

export function numberGameExpired(game: NumberGame, now = Date.now()): boolean {
  return now - game.startedAtMs > NUMBER_GAME_TTL_MS;
}

// The +30 XP reward for winning the number game has its own
// per-user cooldown: hint-assisted binary search can win a game in
// a few guesses, so without it the reward could be farmed back to
// back. Playing (and winning) is never blocked — only the XP grant
// is. The cooldown lives in the store (kind below), separate from
// the per-message XP cooldown, and is scoped per guild + user like
// XP itself (switching channels does not reset it).
export const NUMBER_GAME_XP_COOLDOWN_MS = 10 * 60_000;
export const NUMBER_GAME_XP_COOLDOWN_KIND = "number_game_xp";

// Milliseconds until the number-game XP can be granted again
// (0 when it can be granted now).
export function numberGameXpCooldownRemainingMs(
  lastAwardedAtMs: number | null,
  now = Date.now(),
): number {
  if (lastAwardedAtMs === null) return 0;
  const remaining = NUMBER_GAME_XP_COOLDOWN_MS - (now - lastAwardedAtMs);
  return remaining > 0 ? remaining : 0;
}

// Returns the live game for a key, dropping (and reporting) an
// expired one so a fresh game can be started.
function takeActiveGame(key: string): NumberGame | undefined {
  const game = numberGames.get(key);
  if (game && numberGameExpired(game)) {
    numberGames.delete(key);
    return undefined;
  }
  return game;
}

function numberGameKey(
  guildId: string,
  channelId: string,
  userId: string,
): string {
  return `${guildId}:${channelId}:${userId}`;
}

// ===== 3. じゃんけん =====
const JANKEN = {
  goo: { label: "グー", emoji: "✊" },
  choki: { label: "チョキ", emoji: "✌️" },
  paa: { label: "パー", emoji: "🖐️" },
} as const;

type JankenChoice = keyof typeof JANKEN;

function jankenWinner(
  user: JankenChoice,
  bot: JankenChoice,
): "win" | "lose" | "draw" {
  if (user === bot) return "draw";
  if (
    (user === "goo" && bot === "choki") ||
    (user === "choki" && bot === "paa") ||
    (user === "paa" && bot === "goo")
  ) {
    return "win";
  }
  return "lose";
}

// ===== 4. スロット =====
const SLOT_SYMBOLS = ["🍒", "🍋", "🍇", "⭐", "🔔", "💎"];

function slotResult(): {
  symbols: [string, string, string];
  win: boolean;
  jackpot: boolean;
} {
  const pick = (): string =>
    SLOT_SYMBOLS[randomInt(0, SLOT_SYMBOLS.length - 1)]!;
  const symbols: [string, string, string] = [pick(), pick(), pick()];
  const win = symbols[0] === symbols[1] && symbols[1] === symbols[2];
  return { symbols, win, jackpot: win && symbols[0] === "💎" };
}

// ===== 5. ゲームコマンド処理 =====
export async function handleGameCommand(
  interaction: ChatInputCommandInteraction,
  client: Client,
  store: MabusabaStore,
): Promise<void> {
  const guildId = interaction.guildId;
  if (
    !guildId ||
    !interaction.guild ||
    !interaction.channel ||
    !("send" in interaction.channel)
  ) {
    await replyEmbed(
      interaction,
      "⚠️ サーバー内で使用してください",
      "このコマンドはサーバー内で使用してください。",
      EMBED_COLOR_ERROR,
    );
    return;
  }
  const guild = interaction.guild as Guild;
  const channel = interaction.channel as TextChannel;
  const group = interaction.options.getSubcommandGroup(false);
  const sub = interaction.options.getSubcommand();

  // Wins grant +10 XP (number guessing: +30 XP on a correct guess,
  // with a 10-minute per-user cooldown on that XP — see 5.4).
  // Game XP must not reset the per-message XP cooldown.
  const grantWinXp = async (): Promise<void> => {
    await awardXp(client, store, guild, channel, interaction.user.id, 10, {
      touchCooldown: false,
    }).catch(() => undefined);
  };

  // ----- 5.1 じゃんけん -----
  if (sub === "janken") {
    const choice = interaction.options.getString(
      "choice",
      true,
    ) as JankenChoice;
    const botChoice = (["goo", "choki", "paa"] as const)[randomInt(0, 2)]!;
    const result = jankenWinner(choice, botChoice);
    const text =
      result === "win"
        ? "🎉 あなたの勝ち！ +10 XP"
        : result === "lose"
          ? "😢 あなたの負け…"
          : "🤝 あいこ！";
    await replyEmbed(
      interaction,
      "✊✌️🖐️ じゃんけん",
      `あなた：${JANKEN[choice].emoji} ${JANKEN[choice].label}\nまぶさば：${JANKEN[botChoice].emoji} ${JANKEN[botChoice].label}\n\n${text}`,
      result === "win" ? EMBED_COLOR_SUCCESS : EMBED_COLOR_INFO,
      false,
    );
    if (result === "win") await grantWinXp();
    return;
  }

  // ----- 5.2 コイン -----
  if (sub === "coin") {
    const heads = Math.random() < 0.5;
    await replyEmbed(
      interaction,
      "🪙 コイントス",
      heads ? "🪙 **表** が出ました！" : "🪙 **裏** が出ました！",
      EMBED_COLOR_INFO,
      false,
    );
    return;
  }

  // ----- 5.3 スロット -----
  if (sub === "slot") {
    const { symbols, win, jackpot } = slotResult();
    const line = symbols.join(" | ");
    await replyEmbed(
      interaction,
      "🎰 スロット",
      `${line}\n\n${jackpot ? "💎💎💎 ジャックポット！ +10 XP" : win ? "🎉 そろった！ +10 XP" : "😢 はずれ…もう一度挑戦してみてね"}`,
      win ? EMBED_COLOR_SUCCESS : EMBED_COLOR_INFO,
      false,
    );
    if (win) await grantWinXp();
    return;
  }

  // ----- 5.4 数当てゲーム -----
  if (group === "number") {
    // /game number is a subcommand group: start / guess.
    const leaf = interaction.options.getSubcommand(true);
    const key = numberGameKey(
      guildId,
      interaction.channelId,
      interaction.user.id,
    );
    if (leaf === "start") {
      const existing = takeActiveGame(key);
      if (existing) {
        await replyEmbed(
          interaction,
          "🔢 数当てゲーム",
          `すでに進行中のゲームがあります。残り ${existing.maxAttempts - existing.attempts} 回です。\n\`/game number guess\` で数字を当ててみてください。`,
        );
        return;
      }
      numberGames.set(key, {
        answer: randomInt(1, 100),
        attempts: 0,
        maxAttempts: 10,
        startedAtMs: Date.now(),
      });
      await replyEmbed(
        interaction,
        "🔢 数当てゲーム開始！",
        "1〜100の数字を当ててください。10回まで挑戦できます（開始から30分で時間切れになります）。\n`/game number guess number:<数字>` で回答してください。",
        EMBED_COLOR_INFO,
        false,
      );
      return;
    }
    // guess — number (required).
    const guess = interaction.options.getInteger("number", true);
    const game = takeActiveGame(key);
    if (!game) {
      await replyEmbed(
        interaction,
        "⚠️ ゲームが始まっていません",
        "まず `/game number start` でゲームを始めてください（開始から30分経ったゲームは時間切れで終了します）。",
        EMBED_COLOR_ERROR,
      );
      return;
    }
    game.attempts++;
    const left = game.maxAttempts - game.attempts;
    if (guess === game.answer) {
      numberGames.delete(key);
      const xpRemainingMs = numberGameXpCooldownRemainingMs(
        store.getCooldownLastAt(
          guildId,
          interaction.user.id,
          NUMBER_GAME_XP_COOLDOWN_KIND,
        ),
      );
      if (xpRemainingMs > 0) {
        // On cooldown: the win still counts, but no XP is granted.
        const minutes = Math.ceil(xpRemainingMs / 60_000);
        await replyEmbed(
          interaction,
          "🎉 正解！",
          `正解は **${game.answer}** でした！ ${game.attempts}回目で当てました。\n⏳ 数当てゲームのXPはクールダウン中（あと約${minutes}分）のため、今回はXPは付与されませんでした。`,
          EMBED_COLOR_SUCCESS,
          false,
        );
        return;
      }
      await replyEmbed(
        interaction,
        "🎉 正解！",
        `正解は **${game.answer}** でした！ ${game.attempts}回目で当てました。\n+30 XP を獲得しました！`,
        EMBED_COLOR_SUCCESS,
        false,
      );
      store.recordCooldown(
        guildId,
        interaction.user.id,
        NUMBER_GAME_XP_COOLDOWN_KIND,
      );
      await awardXp(client, store, guild, channel, interaction.user.id, 30, {
        touchCooldown: false,
      }).catch(() => undefined);
      return;
    }
    if (left <= 0) {
      numberGames.delete(key);
      await replyEmbed(
        interaction,
        "😢 ゲームオーバー",
        `10回使い切りました…。正解は **${game.answer}** でした。\n\`/game number start\` でもう一度挑戦できます。`,
        EMBED_COLOR_ERROR,
        false,
      );
      return;
    }
    const hint =
      guess < game.answer
        ? "もっと **大きい** 数字です ⬆️"
        : "もっと **小さい** 数字です ⬇️";
    await replyEmbed(
      interaction,
      "🔢 数当てゲーム",
      `${guess} は違います。${hint}\n残り ${left} 回です。`,
      EMBED_COLOR_INFO,
      false,
    );
    return;
  }

  await replyEmbed(
    interaction,
    "⚠️ 不明なゲームです",
    "不明なゲームです。",
    EMBED_COLOR_ERROR,
  );
}

// ===== 6. テスト用エクスポート =====
// Exported for tests (pure logic, no Discord needed).
export { jankenWinner, slotResult };
