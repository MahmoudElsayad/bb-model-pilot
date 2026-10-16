import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeNativeClassifierAsk,
  nativeClassifierCommand,
} from "./native-classifier.js";
const configuration = {
  provider: "native",
  nativeProvider: "codex",
  model: "bb-catalog-model",
  effort: "low",
} as const;
const questions = {
  connection: {
    type: "choice",
    instructions: "Choose connected.",
    criteria: { connected: "The connection works." },
  },
} as const;
test("native commands reuse local sign-ins with isolated configuration and denied tool access", () => {
  const codex = nativeClassifierCommand(configuration, "schema.json", {});
  for (const flag of [
    "--ignore-user-config",
    "--ignore-rules",
    "--ephemeral",
    "read-only",
    "features.shell_tool=false",
    "features.unified_exec=false",
    'web_search="disabled"',
    'approval_policy="never"',
  ])
    assert.ok(codex.args.includes(flag));
  const claude = nativeClassifierCommand(
    { ...configuration, nativeProvider: "claude-code" },
    "schema.json",
    {},
  );
  assert.equal(claude.args[claude.args.indexOf("--tools") + 1], "");
  assert.equal(claude.args[claude.args.indexOf("--setting-sources") + 1], "");
  assert.ok(claude.args.includes("--strict-mcp-config"));
  assert.ok(claude.args.includes("--no-session-persistence"));
});
async function withFakeCli(
  script: string,
  run: (directory: string) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "pilot-native-test-"));
  const original = process.env.PATH;
  try {
    const file = join(directory, "codex");
    await writeFile(
      file,
      `#!${process.execPath}\nif(process.argv[2]==='mcp'){console.log('[{\"name\":\"test-server\"}]');process.exit(0);}
if (!process.argv.includes('mcp_servers={"test-server"={enabled=false,command="false"}}')) process.exit(9);
${script}`,
    );
    await chmod(file, 0o700);
    process.env.PATH = `${directory}:${original}`;
    await run(directory);
    assert.deepEqual(
      (await readdir(directory)).filter((name) =>
        name.startsWith("classifier-"),
      ),
      [],
    );
  } finally {
    process.env.PATH = original;
    await rm(directory, { recursive: true, force: true });
  }
}
test("native classification parses exact choices and actual usage then removes temporary sessions", async () => {
  await withFakeCli(
    `process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'{"connection":{"connected":100}}'}}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:43,cached_input_tokens:12,output_tokens:9}}));});`,
    async (directory) => {
      const result = await makeNativeClassifierAsk(configuration, {
        dataDir: directory,
      })("test", questions);
      assert.equal(result.answers?.connection?.choice, "connected");
      assert.equal(result.jev.inputTokens, 43);
      assert.equal(result.jev.classifier?.outputTokens, 9);
      assert.equal(result.jev.classifier?.estimatedUsd, null);
    },
  );
});
test("native classification rejects unknown choices without guessing", async () => {
  await withFakeCli(
    `process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'{"connection":{"unknown":100}}'}})));`,
    async (directory) => {
      const result = await makeNativeClassifierAsk(configuration, {
        dataDir: directory,
      })("test", questions);
      assert.equal(result.answers, null);
    },
  );
});
test("native classification rejects tool output and authentication failures", async () => {
  for (const script of [
    `process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',text:'tool output'}})));`,
    `process.stderr.write('sign in required');process.exit(1);`,
  ])
    await withFakeCli(script, async (directory) => {
      const result = await makeNativeClassifierAsk(configuration, {
        dataDir: directory,
      })("test", questions);
      assert.equal(result.answers, null);
      assert.equal(result.jev.classifier?.estimatedUsd, null);
    });
});
test("native classification terminates a timed-out process and removes its private directory", async () => {
  await withFakeCli(
    `process.stdin.resume();setTimeout(()=>{},60000);`,
    async (directory) => {
      const result = await makeNativeClassifierAsk(configuration, {
        dataDir: directory,
        timeoutMs: 30,
      })("test", questions);
      assert.equal(result.answers, null);
      assert.ok(result.jev.ms < 3000);
    },
  );
});

test("native classification passes the user name the Claude CLI needs to find its login", async () => {
  const original = { USER: process.env.USER, LOGNAME: process.env.LOGNAME };
  process.env.USER = "pilot-user";
  process.env.LOGNAME = "pilot-user";
  try {
    await withFakeCli(
      `process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:process.env.USER==='pilot-user'&&process.env.LOGNAME==='pilot-user'?'{"connection":{"connected":100}}':'{}'}})));`,
      async (directory) => {
        const result = await makeNativeClassifierAsk(configuration, {
          dataDir: directory,
        })("test", questions);
        assert.equal(result.answers?.connection?.choice, "connected");
      },
    );
  } finally {
    for (const [key, value] of Object.entries(original))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
});
