/**
 * Local chat with the workforce without WhatsApp.
 * Uses the real Agent SDK (needs ANTHROPIC_API_KEY) but prints replies to the terminal.
 *
 *   npm run simulate
 */
import readline from "node:readline";
import { config } from "../src/config.js";
import { sdkRunner } from "../src/agents.js";
import { buildApp } from "../src/index.js";
import { Store } from "../src/store.js";
import { ConsoleMessenger } from "../src/whatsapp.js";

const me = config.allowedNumbers[0] ?? "447700900000";
if (!config.allowedNumbers.length) config.allowedNumbers.push(me);

const store = new Store(config.dataDir);
const { orchestrator } = buildApp({ messenger: new ConsoleMessenger(), runner: sdkRunner, store });

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
console.log(`Simulating WhatsApp as ${me}. Type a message, or /help. Ctrl+C to quit.`);
const ask = () =>
  rl.question("you> ", async (line) => {
    if (line.trim()) await orchestrator.handle(me, line);
    ask();
  });
ask();
