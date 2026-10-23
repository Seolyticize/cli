#!/usr/bin/env node
/**
 * The `seolyticize` executable: binds the real process to the CLI.
 *
 * Kept to wiring so that everything with behaviour lives in cli.ts, where the
 * tests can reach it without a terminal.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { run } from "./cli.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Reads one line without echoing it. Readline echoes what is typed to its
 * output stream, so it is given one that discards everything; the question is
 * written to stderr first so it still appears, and stdout stays clean for
 * anything that captures it.
 */
function promptSecret(question: string): Promise<string> {
  process.stderr.write(question);
  const silent = new Writable({
    write: (_chunk, _encoding, done) => done(),
  });
  const reader = createInterface({
    input: process.stdin,
    output: silent,
    terminal: true,
  });
  return new Promise((resolve) => {
    reader.question("", (answer) => {
      reader.close();
      process.stderr.write("\n");
      resolve(answer);
    });
  });
}

process.exitCode = await run(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  readStdin,
  promptSecret,
  stdinIsTty: Boolean(process.stdin.isTTY),
  readFile: (path) => readFile(path, "utf8"),
  env: process.env,
  home: homedir(),
  stdinLines: () => createInterface({ input: process.stdin, crlfDelay: Infinity }),
});
