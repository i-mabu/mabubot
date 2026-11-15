// ===== 1. インポート =====
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateId,
  joinLinesWithinLimit,
  levelFromTotalXp,
  parseDurationMs,
  parseTimeInput,
  totalXpForLevel,
  xpForLevel,
} from "../util.js";
import {
  jankenWinner,
  numberGameExpired,
  NUMBER_GAME_TTL_MS,
} from "../games.js";
import { MabusabaStore } from "../store.js";

// Fixed "now": 2026-11-14 12:00 JST = 03:00 UTC.

// ===== 2. テスト用ヘルパー =====
const NOW = Date.UTC(2026, 10, 14, 3, 0, 0);
const jst = (h: number, m = 0, day = 14): number =>
  Date.UTC(2026, 10, day, h - 9, m, 0);

// ===== 3. XP・レベル =====
describe("XP / levels", () => {
  it("xpForLevel matches 5n^2 + 50n + 100", () => {
    assert.equal(xpForLevel(0), 100);
    assert.equal(xpForLevel(1), 155);
    assert.equal(xpForLevel(2), 220);
    assert.equal(xpForLevel(5), 475);
  });

  it("totalXpForLevel accumulates per-level XP", () => {
    assert.equal(totalXpForLevel(0), 0);
    assert.equal(totalXpForLevel(1), 100);
    assert.equal(totalXpForLevel(2), 255);
    assert.equal(totalXpForLevel(3), 475);
  });

  it("totalXpForLevel closed form matches the naive sum", () => {
    let expected = 0;
    for (let level = 0; level <= 60; level++) {
      assert.equal(totalXpForLevel(level), expected);
      expected += xpForLevel(level);
    }
  });

  it("levelFromTotalXp finds the level at boundaries", () => {
    assert.deepEqual(levelFromTotalXp(0), {
      level: 0,
      xpIntoLevel: 0,
      xpNeededForNext: 100,
    });
    assert.deepEqual(levelFromTotalXp(99), {
      level: 0,
      xpIntoLevel: 99,
      xpNeededForNext: 100,
    });
    assert.deepEqual(levelFromTotalXp(100), {
      level: 1,
      xpIntoLevel: 0,
      xpNeededForNext: 155,
    });
    assert.deepEqual(levelFromTotalXp(254), {
      level: 1,
      xpIntoLevel: 154,
      xpNeededForNext: 155,
    });
    assert.deepEqual(levelFromTotalXp(255), {
      level: 2,
      xpIntoLevel: 0,
      xpNeededForNext: 220,
    });
    assert.deepEqual(levelFromTotalXp(1000), {
      level: 4,
      xpIntoLevel: 230,
      xpNeededForNext: 380,
    });
  });
});

// ===== 4. parseDurationMs =====
describe("parseDurationMs", () => {
  it("parses English and Japanese units", () => {
    assert.equal(parseDurationMs("10m"), 600_000);
    assert.equal(parseDurationMs("1h"), 3_600_000);
    assert.equal(parseDurationMs("1d"), 86_400_000);
    assert.equal(parseDurationMs("30s"), 30_000);
    assert.equal(parseDurationMs("30分"), 1_800_000);
    assert.equal(parseDurationMs("2時間"), 7_200_000);
    assert.equal(parseDurationMs("3日"), 259_200_000);
  });

  it("parses combinations", () => {
    assert.equal(parseDurationMs("1時間30分"), 5_400_000);
    assert.equal(parseDurationMs("1d12h"), 129_600_000);
    assert.equal(parseDurationMs("90分"), 5_400_000);
  });

  it("rejects unusable input", () => {
    assert.equal(parseDurationMs("abc"), null);
    assert.equal(parseDurationMs("0m"), null);
    assert.equal(parseDurationMs(""), null);
    assert.equal(parseDurationMs("10x"), null);
  });
});

// ===== 5. parseTimeInput =====
describe("parseTimeInput (future, JST)", () => {
  it("parses relative future times", () => {
    assert.equal(parseTimeInput("30分後", NOW), NOW + 1_800_000);
    assert.equal(parseTimeInput("2時間後", NOW), NOW + 7_200_000);
    assert.equal(parseTimeInput("1時間30分後", NOW), NOW + 5_400_000);
  });

  it("parses weeks in relative future times", () => {
    assert.equal(parseTimeInput("1週間後", NOW), NOW + 7 * 86_400_000);
    assert.equal(parseTimeInput("2週後", NOW), NOW + 14 * 86_400_000);
    assert.equal(parseTimeInput("1週間2日後", NOW), NOW + 9 * 86_400_000);
  });

  it("rejects relative times with stray text", () => {
    assert.equal(parseTimeInput("abc30分後", NOW), null);
    assert.equal(parseTimeInput("30分xyz後", NOW), null);
    assert.equal(parseTimeInput("30分30分後", NOW), null);
  });

  it("parses clock times today, or tomorrow when past", () => {
    assert.equal(parseTimeInput("21:00", NOW), jst(21));
    assert.equal(parseTimeInput("10:00", NOW), jst(10, 0, 15));
  });

  it("parses a full-width colon in clock times", () => {
    assert.equal(parseTimeInput("21：00", NOW), jst(21));
  });

  it("parses dated times", () => {
    assert.equal(parseTimeInput("2026-11-14 21:00", NOW), jst(21));
    assert.equal(parseTimeInput("11-14 21:00", NOW), jst(21));
  });

  it("rolls a past month/day to next year", () => {
    assert.equal(
      parseTimeInput("11-13 21:00", NOW),
      Date.UTC(2027, 10, 13, 12, 0, 0),
    );
    assert.equal(
      parseTimeInput("1-1 10:00", NOW),
      Date.UTC(2027, 0, 1, 1, 0, 0),
    );
  });

  it("rejects past times and garbage", () => {
    assert.equal(parseTimeInput("2026-11-13 21:00", NOW), null);
    assert.equal(parseTimeInput("あした", NOW), null);
    assert.equal(parseTimeInput("", NOW), null);
  });
});

// ===== 6. generateId =====
describe("generateId", () => {
  it("produces unique ids", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generateId()));
    assert.equal(ids.size, 1000);
  });
});

// ===== 7. joinLinesWithinLimit =====
describe("joinLinesWithinLimit", () => {
  it("keeps short lists intact and truncates long ones", () => {
    assert.deepEqual(joinLinesWithinLimit(["a", "b"], 100), {
      text: "a\nb",
      omitted: 0,
    });
    const lines = Array.from({ length: 10 }, () => "x".repeat(100));
    const { text, omitted } = joinLinesWithinLimit(lines, 350);
    assert.ok(text.length <= 350);
    assert.ok(omitted > 0);
  });
});

// ===== 8. 数当てゲームの有効期限 =====
describe("number game expiry", () => {
  it("expires games older than the TTL", () => {
    const game = { answer: 42, attempts: 0, maxAttempts: 10, startedAtMs: NOW };
    assert.equal(numberGameExpired(game, NOW + NUMBER_GAME_TTL_MS - 1), false);
    assert.equal(numberGameExpired(game, NOW + NUMBER_GAME_TTL_MS + 1), true);
  });
});

// ===== 9. じゃんけん =====
describe("janken", () => {
  it("goo beats choki, loses to paa, draws itself", () => {
    assert.equal(jankenWinner("goo", "choki"), "win");
    assert.equal(jankenWinner("goo", "paa"), "lose");
    assert.equal(jankenWinner("goo", "goo"), "draw");
    assert.equal(jankenWinner("choki", "paa"), "win");
    assert.equal(jankenWinner("paa", "goo"), "win");
  });
});

// ===== 10. ストア =====
describe("store (SQLite)", () => {
  it("welcome, XP, warns, polls and timers round-trip", () => {
    const dir = mkdtempSync(join(tmpdir(), "mabusaba-test-"));
    const store = new MabusabaStore(dir);
    try {
      store.setWelcome("g1", "c1", "ようこそ {user} さん");
      assert.equal(store.getWelcome("g1")?.channel_id, "c1");
      store.deleteWelcome("g1");
      assert.equal(store.getWelcome("g1"), null);

      const { after } = store.addXp("g1", "u1", 120);
      assert.equal(after.xp, 120);
      assert.deepEqual(levelFromTotalXp(after.xp).level, 1);
      store.setLevel("g1", "u1", 1);
      assert.equal(store.getXp("g1", "u1")?.level, 1);
      assert.equal(store.topXp("g1", 10)[0]?.user_id, "u1");

      const warnId = store.addWarn("g1", "u1", "mod1", "連投");
      assert.equal(store.listWarns("g1", "u1").length, 1);
      assert.equal(store.listWarns("g1", "u1")[0]?.id, warnId);
      assert.equal(store.countWarns("g1", "u1"), 1);

      store.createPoll({
        id: "p1",
        guild_id: "g1",
        channel_id: "c1",
        message_id: "m1",
        question: "好きなのは？",
        options: ["A", "B"],
        ends_at_ms: NOW + 60000,
        created_by: "u1",
      });
      store.setPollVote("p1", "u1", 0);
      store.setPollVote("p1", "u2", 1);
      store.setPollVote("p1", "u1", 1); // change vote
      assert.deepEqual(store.pollVoteCounts("p1", 2), [0, 2]);
      assert.equal(store.pollTotalVotes("p1"), 2);

      store.createTimer({
        id: "t1",
        guild_id: "g1",
        channel_id: "c1",
        user_id: "u1",
        message: "テスト",
        fires_at_ms: NOW + 60000,
        created_at_ms: NOW,
      });
      assert.equal(store.listTimers("g1").length, 1);
      store.deleteTimer("t1");
      assert.equal(store.listTimers("g1").length, 0);
    } finally {
      store.close();
    }
  });

  it("xpRank is null for a user with no XP record", () => {
    const dir = mkdtempSync(join(tmpdir(), "mabusaba-test-"));
    const store = new MabusabaStore(dir);
    try {
      store.addXp("g1", "alice", 500);
      store.addXp("g1", "bob", 100);
      // Regression: an unranked user used to be reported as 1st.
      assert.equal(store.xpRank("g1", "carol"), null);
      assert.equal(store.xpRank("g1", "alice"), 1);
      assert.equal(store.xpRank("g1", "bob"), 2);
    } finally {
      store.close();
    }
  });

  it("addXp keeps the stored level in sync with the XP total", () => {
    const dir = mkdtempSync(join(tmpdir(), "mabusaba-test-"));
    const store = new MabusabaStore(dir);
    try {
      const { after } = store.addXp("g1", "u1", 120);
      assert.equal(after.level, 1);
      assert.equal(store.getXp("g1", "u1")?.level, 1);
    } finally {
      store.close();
    }
  });

  it("addXp with touchCooldown:false leaves the message-XP cooldown alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "mabusaba-test-"));
    const store = new MabusabaStore(dir);
    try {
      store.addXp("g1", "u1", 20, { now: 1_000_000 });
      assert.equal(store.getXp("g1", "u1")?.last_xp_at_ms, 1_000_000);
      // A game reward at a later time must not move the cooldown.
      store.addXp("g1", "u1", 10, { now: 2_000_000, touchCooldown: false });
      assert.equal(store.getXp("g1", "u1")?.last_xp_at_ms, 1_000_000);
      assert.equal(store.getXp("g1", "u1")?.xp, 30);
    } finally {
      store.close();
    }
  });
});
