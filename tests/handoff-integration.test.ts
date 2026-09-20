import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { request as httpRequest } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHandoffBridge } from "../src/handoff/server.js";
import { makeTmpDir, cleanup, pkceVerifierAndChallenge } from "./helpers.js";

let dir: string;
let bridge: Awaited<ReturnType<typeof startHandoffBridge>>;
let client: Client;
let reader: Client;
let other: Client;
const clients: Client[] = [];
const json = (r: { content?: unknown }) => JSON.parse((r.content as { text: string }[])[0].text);
const local = (route: string, data: object = {}, token?: string, extraHeaders: Record<string, string> = {}) => fetch(`${bridge.baseUrl}/local/${route}`, {
  method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token ?? bridge.workerToken}`, ...extraHeaders }, body: JSON.stringify(data),
});
async function connect(token: string) {
  const c = new Client({ name: "synthetic-handoff-test", version: "1" });
  clients.push(c);
  await c.connect(new StreamableHTTPClientTransport(new URL(`${bridge.baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  return c;
}

beforeAll(async () => {
  dir = makeTmpDir("handoff-http");
  bridge = await startHandoffBridge({ stateDir: dir, projectId: "demo" });
  // Canary resembles a backend export: it must never be discoverable through MCP.
  fs.writeFileSync(path.join(dir, "backend-export.json"), '{"canary":"NEVER_EXPORT_SYNTHETIC_BACKEND"}');
  client = await connect(bridge.authStore.issueTokens({ clientId: "alice", scopes: ["handoff.read", "handoff.submit"] }).accessToken);
  reader = await connect(bridge.authStore.issueTokens({ clientId: "reader", scopes: ["handoff.read"] }).accessToken);
  other = await connect(bridge.authStore.issueTokens({ clientId: "bob", scopes: ["handoff.read", "handoff.submit"] }).accessToken);
});
afterAll(async () => {
  for (const c of clients) await c.close();
  await bridge.close(); cleanup(dir);
});

describe("restricted HTTP/MCP handoff using synthetic data", () => {
  it("only exposes three tools and advertises only handoff scopes", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["project_summary", "submit_task", "task_status"]);
    expect(tools.find((t) => t.name === "submit_task")?.annotations?.readOnlyHint).toBe(false);
    const metadata = await fetch(`${bridge.baseUrl}/.well-known/oauth-authorization-server`).then((r) => r.json());
    expect(metadata.scopes_supported).toEqual(["handoff.read", "handoff.submit", "offline_access"]);
    for (const name of ["workspace_info", "read_file", "search_workspace", "git_diff", "execution_output", "execute_shell"]) {
      const r = await client.callTool({ name, arguments: { path: "backend-export.json", query: "canary" } });
      expect(r.isError).toBe(true);
      expect(JSON.stringify(r)).not.toContain("NEVER_EXPORT_SYNTHETIC_BACKEND");
    }
  });

  it("completes submit, local fake-worker claim, reviewed report and remote status", async () => {
    expect((await local("publish", { summary: "Synthetic demo counter, ready for a fake-worker test", reviewed: true })).status).toBe(200);
    const summary = json(await client.callTool({ name: "project_summary", arguments: {} }));
    const args = { projectId: "demo", requestId: "http-request-001", summaryVersion: summary.summaryVersion,
      request: "Simulate a counter change using fake data", acceptance: "Return a simulated result" };
    expect((await client.callTool({ name: "submit_task", arguments: { ...args, command: "delete", cwd: "../../production" } })).isError).toBe(true);
    expect((await client.callTool({ name: "submit_task", arguments: { ...args, projectId: "another-project" } })).isError).toBe(true);
    const results = await Promise.all([client.callTool({ name: "submit_task", arguments: args }), client.callTool({ name: "submit_task", arguments: args })]);
    const task = json(results[0]);
    expect(json(results[1]).taskId).toBe(task.taskId);
    expect(task.status).toBe("queued");
    expect((await reader.callTool({ name: "submit_task", arguments: args })).isError).toBe(true);
    expect((await other.callTool({ name: "task_status", arguments: { taskId: task.taskId } })).isError).toBe(true);
    const claims = await Promise.all([local("claim").then((r) => r.json()), local("claim").then((r) => r.json())]);
    expect(claims.filter((c) => c.task !== null)).toHaveLength(1);
    const claim = claims.find((c) => c.task)?.task;
    expect(claim.taskId).toBe(task.taskId);
    expect(claim.policy).toContain("explicit user approval");
    expect((await local("report", { taskId: task.taskId, receipt: claim.receipt, status: "succeeded", summary: "Fake-worker simulation passed; no real agent ran", reviewed: true })).status).toBe(200);
    const result = json(await client.callTool({ name: "task_status", arguments: { taskId: task.taskId } }));
    expect(result.status).toBe("succeeded");
    expect(result.result).toContain("simulation");
    expect(JSON.stringify(result)).not.toContain(claim.receipt);
    expect(fs.readFileSync(path.join(dir, "backend-export.json"), "utf8")).toContain("NEVER_EXPORT_SYNTHETIC_BACKEND");
  });

  it("denies unauthenticated MCP and using remote tokens on local worker routes", async () => {
    const r = await fetch(`${bridge.baseUrl}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(r.status).toBe(401);
    const remoteToken = bridge.authStore.issueTokens({ clientId: "remote", scopes: ["handoff.read", "handoff.submit"] }).accessToken;
    for (const route of ["claim", "report", "publish", "pairing", "revoke"]) expect((await local(route, {}, remoteToken)).status).toBe(404);
    const workerOnMcp = await fetch(`${bridge.baseUrl}/mcp`, { method: "POST", headers: { authorization: `Bearer ${bridge.workerToken}`, "content-type": "application/json" }, body: "{}" });
    expect(workerOnMcp.status).toBe(401);
    const legacy = await connect(bridge.authStore.issueTokens({ clientId: "legacy", scopes: ["workspace.read", "git.read", "execution.read"] }).accessToken);
    expect((await legacy.callTool({ name: "project_summary", arguments: {} })).isError).toBe(true);
  });

  it("rejects browser origins, proxy headers, spoofed Host, oversize bodies and legacy admin routes", async () => {
    for (const headers of [{ origin: "https://example.com" }, { "x-forwarded-for": "127.0.0.1" }, { forwarded: "for=127.0.0.1" }, { "cf-connecting-ip": "127.0.0.1" }]) {
      expect((await local("claim", {}, undefined, headers as Record<string, string>)).status, JSON.stringify(headers)).toBe(403);
    }
    // fetch normalizes Host on this runtime; use raw HTTP to test actual rebinding input.
    const spoofedHost = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(`${bridge.baseUrl}/local/claim`, {
        method: "POST", headers: { host: "attacker.example", authorization: `Bearer ${bridge.workerToken}` },
      }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
      req.on("error", reject); req.end();
    });
    expect(spoofedHost).toBe(403);
    expect((await local("publish", { summary: "a".repeat(30000), reviewed: true })).status).toBe(400);
    expect((await fetch(`${bridge.baseUrl}/admin/tunnel/start`, { method: "POST" })).status).toBe(404);
  });

  it("pairs through OAuth PKCE without granting legacy workspace scopes", async () => {
    const registration = await fetch(`${bridge.baseUrl}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "fake-client", redirect_uris: ["http://localhost/callback"] }) }).then((r) => r.json());
    const { verifier, challenge } = pkceVerifierAndChallenge();
    const query = new URLSearchParams({ client_id: registration.client_id, redirect_uri: "http://localhost/callback", response_type: "code",
      code_challenge: challenge, code_challenge_method: "S256", scope: "workspace.read" });
    const denied = await fetch(`${bridge.baseUrl}/oauth/authorize?${query}`, { redirect: "manual" });
    expect(denied.headers.get("location")).toContain("invalid_scope");
    query.set("scope", "handoff.read handoff.submit");
    const page = await fetch(`${bridge.baseUrl}/oauth/authorize?${query}`).then((r) => r.text());
    expect(page).not.toContain("(read-only)");
    const requestId = /name="request_id" value="([^"]+)"/.exec(page)![1];
    const pair = await local("pairing").then((r) => r.json());
    const authorize = await fetch(`${bridge.baseUrl}/oauth/authorize`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ request_id: requestId, pairing_code: pair.code }) });
    const code = new URL(authorize.headers.get("location")!).searchParams.get("code")!;
    const tokenResponse = await fetch(`${bridge.baseUrl}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: registration.client_id, redirect_uri: "http://localhost/callback", code, code_verifier: verifier }) });
    expect(tokenResponse.status).toBe(200);
    const token = await tokenResponse.json();
    expect(token.scope).toBe("handoff.read handoff.submit");
    const pairedClient = await connect(token.access_token);
    expect((await pairedClient.callTool({ name: "project_summary", arguments: {} })).isError).not.toBe(true);
    await local("revoke");
    const revoked = await fetch(`${bridge.baseUrl}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token.access_token}`, "content-type": "application/json" }, body: "{}" });
    expect(revoked.status).toBe(401);
  });
});
