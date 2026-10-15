import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export const rpcMessageSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string().optional(), data: z.unknown().optional() }).optional(),
}).passthrough();
export type RpcMessage = z.infer<typeof rpcMessageSchema>;
export type NativeProvider = "codex" | "claude-code";
export type BridgeClient = {
  request(method: string, params: unknown): Promise<unknown>;
  send(message: RpcMessage): void;
  close(): void;
};
export type LaunchBridge = (args: {
  provider: NativeProvider;
  bbRoot: string;
  dataDir: string;
  onMessage(message: RpcMessage): void;
  onExit(error: Error): void;
}) => Promise<BridgeClient>;

export const launchBridge: LaunchBridge = async (args) => {
  const childDir = join(args.dataDir, "native", args.provider);
  await mkdir(childDir, { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, [
    join(args.bbRoot, "host-daemon/dist/bb-provider-bridge-worker.mjs"),
    join(args.bbRoot, `server/dist/builtin-plugins/provider-${args.provider}/dist/host.js`),
    `provider-${args.provider}`, childDir,
  ], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
  return connectBridge(child, args);
};

export function connectBridge(child: ChildProcessWithoutNullStreams, args: {
  onMessage(message: RpcMessage): void;
  onExit(error: Error): void;
}): BridgeClient {
  let sequence = 0;
  let closed = false;
  let stderr = "";
  const pending = new Map<string, {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  const send = (message: RpcMessage) => {
    if (closed || child.stdin.destroyed) throw new Error("Native provider bridge is closed");
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const fail = (error: Error) => {
    const wasClosed = closed;
    closed = true;
    for (const call of pending.values()) {
      clearTimeout(call.timer);
      call.reject(error);
    }
    pending.clear();
    if (!wasClosed) args.onExit(error);
  };
  createInterface({ input: child.stdout }).on("line", (line) => {
    try {
      const message = rpcMessageSchema.parse(JSON.parse(line));
      const call = typeof message.id === "string" && message.method === undefined ? pending.get(message.id) : undefined;
      if (call !== undefined) {
        pending.delete(String(message.id));
        clearTimeout(call.timer);
        if (message.error !== undefined) call.reject(new Error(message.error.message ?? "Native bridge request failed"));
        else call.resolve(message.result);
      } else args.onMessage(message);
    } catch (error) {
      fail(new Error(`Invalid native bridge output: ${error instanceof Error ? error.message : String(error)}`));
      child.kill("SIGTERM");
    }
  });
  child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8192); });
  child.once("error", fail);
  child.once("exit", (code, signal) => fail(new Error(`Native provider bridge exited (${code ?? signal ?? "unknown"})${stderr ? `: ${stderr}` : ""}`)));
  child.stdin.on("error", fail);
  return {
    request(method, params) {
      const id = `auto-internal-${++sequence}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Native provider request timed out: ${method}`));
        }, 120_000);
        timer.unref();
        pending.set(id, { resolve, reject, timer });
        try { send({ jsonrpc: "2.0", id, method, params }); }
        catch (error) {
          pending.delete(id);
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    send,
    close() {
      if (closed) return;
      closed = true;
      for (const call of pending.values()) {
        clearTimeout(call.timer);
        call.reject(new Error("Native provider bridge was released"));
      }
      pending.clear();
      child.stdin.end();
      child.kill("SIGTERM");
      const timer = setTimeout(() => { child.kill("SIGKILL"); }, 3000);
      timer.unref();
      child.once("exit", () => clearTimeout(timer));
    },
  };
}
