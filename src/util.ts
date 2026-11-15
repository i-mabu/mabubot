// =============
// 1. インポート
// =============
import { randomBytes } from "node:crypto";
import { EmbedBuilder, type ChatInputCommandInteraction } from "discord.js";

// =====================
// 2. 埋め込みの共通部品
// =====================
// Shared look for every reply: embeds, never plain text.
export const EMBED_COLOR_INFO = 0x5865f2;
export const EMBED_COLOR_SUCCESS = 0x57f287;
export const EMBED_COLOR_ERROR = 0xed4245;
export const EMBED_FOOTER = "✨ まぶさば";

export function buildEmbed(
  title: string,
  description: string,
  color: number = EMBED_COLOR_INFO,
  fields?: Array<{ name: string; value: string; inline?: boolean }>,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color)
    .setFooter({ text: EMBED_FOOTER })
    .setTimestamp(new Date());
  if (fields?.length) embed.addFields(fields);
  return embed;
}

// All command replies go through here so they share the same look.
// Ephemeral replies also support embeds: an interaction reply with
// embeds + ephemeral:true renders as an embed visible only to the
// command user.
export async function replyEmbed(
  interaction: ChatInputCommandInteraction,
  title: string,
  description: string,
  color: number = EMBED_COLOR_INFO,
  ephemeral = true,
  fields?: Array<{ name: string; value: string; inline?: boolean }>,
): Promise<void> {
  const embed = buildEmbed(title, description, color, fields);
  if (interaction.replied || interaction.deferred) {
    await interaction.followUp({ embeds: [embed], ephemeral });
  } else {
    await interaction.reply({ embeds: [embed], ephemeral });
  }
}

// ===================
// 3. 時刻・期間の変換
// ===================
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}日`);
  if (hours) parts.push(`${hours}時間`);
  if (minutes) parts.push(`${minutes}分`);
  // Always show seconds unless a larger unit already covers whole minutes exactly.
  if (seconds || !parts.length) parts.push(`${seconds}秒`);
  return parts.join("");
}

export function discordTimestamp(ms: number): string {
  return `<t:${Math.floor(ms / 1000)}:F>`;
}

export function shortTimestamp(ms: number): string {
  return `<t:${Math.floor(ms / 1000)}:t>`;
}

export function relativeTimestamp(ms: number): string {
  return `<t:${Math.floor(ms / 1000)}:R>`;
}

// Duration parsing for /mod timeout etc.
// Accepts: `30s` / `10m` / `1h` / `1d` / `1w`, Japanese
// `30秒` / `10分` / `2時間` / `3日` / `1週間`, and combinations
// like `1時間30分` / `1d12h`. Returns ms, or null when unusable.

// --- 期間のパース ---
export function parseDurationMs(input: string): number | null {
  const text = input
    .trim()
    .replace(/[０-９]/g, (c) => String("０１２３４５６７８９".indexOf(c)))
    .replace(/　/g, " ")
    .replace(/\s+/g, "");
  if (!text) return null;
  const unitMs: Array<[RegExp, number]> = [
    [/(\d+(?:\.\d+)?)(?:週間|週|w)/, 7 * 86400000],
    [/(\d+(?:\.\d+)?)(?:日|d)/, 86400000],
    [/(\d+(?:\.\d+)?)(?:時間|時|h)/, 3600000],
    [/(\d+(?:\.\d+)?)(?:分|min|m)/, 60000],
    [/(\d+(?:\.\d+)?)(?:秒|sec|s)/, 1000],
  ];
  let total = 0;
  let matched = false;
  let rest = text;
  for (const [re, ms] of unitMs) {
    const m = rest.match(re);
    if (m) {
      matched = true;
      total += Number(m[1]) * ms;
      rest = rest.replace(m[0], "");
    }
  }
  // A bare number on its own is read as minutes.
  if (!matched && /^\d+(?:\.\d+)?$/.test(rest)) {
    total = Number(rest) * 60000;
    matched = true;
    rest = "";
  }
  if (!matched || rest !== "" || total <= 0) return null;
  return total;
}

// ===================
// 4. 日本時間ヘルパー
// ===================
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function jstParts(ms: number): {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
} {
  const date = new Date(ms + JST_OFFSET_MS);
  return {
    y: date.getUTCFullYear(),
    mo: date.getUTCMonth() + 1,
    d: date.getUTCDate(),
    h: date.getUTCHours(),
    mi: date.getUTCMinutes(),
    s: date.getUTCSeconds(),
  };
}

function jstToMs(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s = 0,
): number | null {
  if (
    mo < 1 ||
    mo > 12 ||
    d < 1 ||
    d > 31 ||
    h < 0 ||
    h > 23 ||
    mi < 0 ||
    mi > 59 ||
    s < 0 ||
    s > 59
  )
    return null;
  const ms = Date.UTC(y, mo - 1, d, h, mi, s) - JST_OFFSET_MS;
  const back = jstParts(ms);
  if (
    back.y !== y ||
    back.mo !== mo ||
    back.d !== d ||
    back.h !== h ||
    back.mi !== mi ||
    back.s !== s
  )
    return null;
  return ms;
}

// Future-time parsing for /recruit and /timer (all Japan time).
// Accepted forms:
//   - Relative future: `30分後`, `2時間後`, `1時間30分後`, `3日後`
//   - Time today: `21:00` (if already past, tomorrow is assumed)
//   - Date and time: `2026-11-14 21:00`, `2026/11/14 21:00`, `11-14 21:00`
//   - ISO 8601: `2026-11-14T21:00:00+09:00`
// Returns the epoch ms, or null when unusable or not in the future.

// --- 時刻入力のパース ---
export function parseTimeInput(input: string, now = Date.now()): number | null {
  const text = input
    .trim()
    .replace(/[０-９]/g, (c) => String("０１２３４５６７８９".indexOf(c)))
    .replace(/：/g, ":")
    .replace(/　/g, " ");
  if (!text) return null;

  // Relative future: `2時間30分後`, `30分後`, `3日後`, `1週間後`.
  // Every component must be consumed: input with stray text around
  // the numbers (e.g. `abc30分後`, `30分xyz後`) is rejected instead
  // of silently ignoring the garbage.
  const relative = text.match(/^(.+?)後$/);
  if (relative) {
    let rest = relative[1].replace(/\s+/g, "");
    const units: Array<[RegExp, number]> = [
      [/(\d+(?:\.\d+)?)(?:週間|週)/, 7 * 86400000],
      [/(\d+(?:\.\d+)?)日/, 86400000],
      [/(\d+(?:\.\d+)?)時間/, 3600000],
      [/(\d+(?:\.\d+)?)分/, 60000],
      [/(\d+(?:\.\d+)?)秒/, 1000],
    ];
    let deltaMs = 0;
    let matched = false;
    for (const [re, ms] of units) {
      const m = rest.match(re);
      if (m) {
        matched = true;
        deltaMs += Number(m[1]) * ms;
        rest = rest.replace(m[0], "");
      }
    }
    if (!matched || rest !== "" || !deltaMs) return null;
    return now + deltaMs;
  }

  let ms: number | null = null;
  const dated = text.match(
    /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/,
  );
  if (dated) {
    ms = jstToMs(
      Number(dated[1]),
      Number(dated[2]),
      Number(dated[3]),
      Number(dated[4]),
      Number(dated[5]),
      Number(dated[6] ?? 0),
    );
  } else {
    const monthDay = text.match(
      /^(\d{1,2})[/-](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/,
    );
    if (monthDay) {
      ms = jstToMs(
        jstParts(now).y,
        Number(monthDay[1]),
        Number(monthDay[2]),
        Number(monthDay[3]),
        Number(monthDay[4]),
        Number(monthDay[5] ?? 0),
      );
      // A month/day already past this year means next year, mirroring
      // how a past clock time below means tomorrow.
      if (ms !== null && ms <= now) {
        ms = jstToMs(
          jstParts(now).y + 1,
          Number(monthDay[1]),
          Number(monthDay[2]),
          Number(monthDay[3]),
          Number(monthDay[4]),
          Number(monthDay[5] ?? 0),
        );
      }
    } else {
      const timeOnly = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
      if (timeOnly) {
        const today = jstParts(now);
        ms = jstToMs(
          today.y,
          today.mo,
          today.d,
          Number(timeOnly[1]),
          Number(timeOnly[2]),
          Number(timeOnly[3] ?? 0),
        );
        // A time already past today means tomorrow.
        if (ms !== null && ms <= now) ms += 86400000;
      } else {
        const parsed = Date.parse(text);
        ms = Number.isNaN(parsed) ? null : parsed;
      }
    }
  }
  if (ms === null || ms <= now) return null;
  return ms;
}

// =================
// 5. レベル・XP計算
// =================
// xpForLevel(n): XP needed to go from level n to level n+1.
export function xpForLevel(n: number): number {
  return 5 * n * n + 50 * n + 100;
}

// Total cumulative XP needed to reach `level` from level 0.
// Closed form of sum_{i=0}^{level-1} (5i^2 + 50i + 100), so this is
// O(1) instead of a loop over every level.
export function totalXpForLevel(level: number): number {
  if (level <= 0) return 0;
  return (
    (5 * (level - 1) * level * (2 * level - 1)) / 6 +
    25 * (level - 1) * level +
    100 * level
  );
}

export interface LevelInfo {
  level: number;
  xpIntoLevel: number;
  xpNeededForNext: number;
}

export function levelFromTotalXp(totalXp: number): LevelInfo {
  let level = 0;
  let remaining = Math.max(0, totalXp);
  for (;;) {
    const needed = xpForLevel(level);
    if (remaining < needed)
      return { level, xpIntoLevel: remaining, xpNeededForNext: needed };
    remaining -= needed;
    level++;
  }
}

// =====================
// 6. 汎用ユーティリティ
// =====================
export function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Unique ID for polls / recruits / timers (stored as a SQLite primary
// key and embedded in button customIds). The old scheme — base36
// timestamp plus a 4-digit Math.random suffix — had only 9,000 values
// per millisecond, so a collision made the INSERT throw *after* the
// public message was already sent, leaving an orphan whose buttons
// never worked. 48 bits of crypto randomness makes that negligible.
export function generateId(): string {
  return `${Date.now().toString(36)}${randomBytes(6).toString("hex")}`;
}

// Join display lines into an embed description without exceeding
// Discord's 4096-character embed description limit. Lines past the
// limit are dropped and reported via `omitted` so the caller can
// note how many were left out instead of failing the whole reply.
export function joinLinesWithinLimit(
  lines: string[],
  maxChars = 3800,
): { text: string; omitted: number } {
  const kept: string[] = [];
  let length = 0;
  for (const line of lines) {
    const next = length + (kept.length ? 1 : 0) + line.length;
    if (next > maxChars) break;
    kept.push(line);
    length = next;
  }
  return { text: kept.join("\n"), omitted: lines.length - kept.length };
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
