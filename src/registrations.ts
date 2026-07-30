import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export type Client = "codex" | "claude";
export interface McpSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export async function getRegistration(client: Client, name: string): Promise<McpSpec | undefined> {
  const args = client === "codex" ? ["mcp", "get", name, "--json"] : ["mcp", "get", name];
  const result = await execFileAsync(client, args, { timeout: 15000, maxBuffer: 1024 * 1024 })
    .then((value) => value, (error: unknown) => {
      if (isExitError(error)) return undefined;
      throw error;
    });
  if (!result) return undefined;
  return parseRegistration(client, result.stdout);
}

export async function addRegistration(client: Client, name: string, spec: McpSpec): Promise<void> {
  const envArgs = Object.entries(spec.env).sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([key, value]) => ["--env", `${key}=${value}`]);
  const args = client === "codex"
    ? ["mcp", "add", name, ...envArgs, "--", spec.command, ...spec.args]
    : ["mcp", "add", "--scope", "user", "--transport", "stdio", name, ...envArgs,
      "--", spec.command, ...spec.args];
  await execFileAsync(client, args, { timeout: 30000 });
}

export async function removeRegistration(client: Client, name: string): Promise<void> {
  const args = client === "claude" ? ["mcp", "remove", "--scope", "user", name] : ["mcp", "remove", name];
  await execFileAsync(client, args, { timeout: 15000 });
}

export function sameSpec(left: McpSpec | undefined, right: McpSpec): boolean {
  if (!left || left.command !== right.command ||
      JSON.stringify(left.args) !== JSON.stringify(right.args)) return false;
  const normalize = (value: Record<string, string>) =>
    Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  return JSON.stringify(normalize(left.env)) === JSON.stringify(normalize(right.env));
}

export function parseRegistration(client: Client, output: string): McpSpec {
  const trimmed = output.trim();
  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (client === "claude" && String(parsed.scope ?? "").toLowerCase() !== "user") {
      throw new Error("claude registration scope is not user");
    }
    const transport = parsed.transport && typeof parsed.transport === "object"
      ? parsed.transport as Record<string, unknown> : parsed;
    if (transport.type !== undefined && transport.type !== "stdio") {
      throw new Error(`${client} registration is not stdio`);
    }
    if (typeof transport.command !== "string") throw new Error(`${client} registration has no command`);
    const args = Array.isArray(transport.args) && transport.args.every((value) => typeof value === "string")
      ? transport.args as string[] : [];
    const env = transport.env && typeof transport.env === "object"
      ? Object.fromEntries(Object.entries(transport.env as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {};
    return { command: transport.command, args, env };
  }
  const field = (name: string): string | undefined =>
    output.match(new RegExp(`^[ \\t]*${name}:[ \\t]*([^\\r\\n]*?)[ \\t]*$`, "mi"))?.[1];
  const command = field("Command");
  if (!command) throw new Error(`cannot parse ${client} MCP command`);
  if (client === "claude") {
    const scopeValue = field("Scope");
    if (!scopeValue || !/^User config(?:\s+\(available in all your projects\))?$/.test(scopeValue)) {
      throw new Error("claude registration scope is not user config");
    }
  }
  const displayedArgs = field("Args") ?? "";
  const displayedEnv = field("Environment") ?? "";
  return {
    command,
    args: displayedArgs ? [`<displayed:${displayedArgs}>`] : [],
    env: displayedEnv ? { "<displayed>": displayedEnv } : {}
  };
}

function isExitError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error &&
    typeof (error as { code?: unknown }).code === "number");
}
