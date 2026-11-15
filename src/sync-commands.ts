import { REST, Routes } from "discord.js";
import { allCommands } from "./commands.js";

// Overwrite-sync for application commands.
//
// `npm run sync:commands` is the ONLY place commands are registered.
// The bot itself never syncs on startup (see index.ts), so a stale
// command can never come back by restarting the bot.
//
// How it overwrites:
//  1. GET the current global commands (to report what will be removed).
//  2. PUT the desired set. Discord's PUT on application commands is a
//     full replacement: every command not in the body is deleted, and
//     every command in the body is created/updated. Nothing is merged.
//  3. GET again and verify the live set is exactly the desired set.
//     If it is not, exit non-zero instead of claiming success.
//
// Env vars (DISCORD_TOKEN / DISCORD_APPLICATION_ID) must be exported in
// the shell or supplied via systemd EnvironmentFile. This file does NOT
// read .env (no dotenv dependency).
const token = process.env.DISCORD_TOKEN?.trim();
const applicationId = process.env.DISCORD_APPLICATION_ID?.trim();
if (!token || !applicationId) {
  console.error("DISCORD_TOKEN and DISCORD_APPLICATION_ID are required.");
  process.exit(1);
}

const desired = allCommands.map((c) => c.toJSON());
const desiredNames = desired.map((c) => c.name).sort();
const rest = new REST({ version: "10" }).setToken(token);

const before = (await rest.get(
  Routes.applicationCommands(applicationId),
)) as Array<{ name: string }>;
const beforeNames = before.map((c) => c.name).sort();
const removed = beforeNames.filter((name) => !desiredNames.includes(name));
const added = desiredNames.filter((name) => !beforeNames.includes(name));

await rest.put(Routes.applicationCommands(applicationId), { body: desired });

const after = (await rest.get(
  Routes.applicationCommands(applicationId),
)) as Array<{ name: string }>;
const afterNames = after.map((c) => c.name).sort();
if (JSON.stringify(afterNames) !== JSON.stringify(desiredNames)) {
  console.error(
    `Overwrite sync verification failed. Expected: ${desiredNames.join(", ")}. Live: ${afterNames.join(", ")}.`,
  );
  process.exit(1);
}

console.log(
  `Application commands overwrite-synced (${before.length} -> ${after.length}).`,
);
if (added.length) console.log(`Added: ${added.join(", ")}`);
if (removed.length) console.log(`Removed: ${removed.join(", ")}`);
console.log(`Live commands: ${afterNames.join(", ")}`);
