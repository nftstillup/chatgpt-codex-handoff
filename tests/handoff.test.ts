import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { HandoffQueue } from "../src/handoff/queue.js";
import { makeTmpDir, cleanup } from "./helpers.js";

let dir: string;
let queue: HandoffQueue;
const request = { projectId: "demo", requestId: "request-0001", summaryVersion: 1,
  request: "Add a fake counter to the demo", acceptance: "Counter starts at zero" };
beforeEach(() => { dir = makeTmpDir("handoff"); queue = new HandoffQueue(dir, "demo"); });
afterEach(() => { queue.close(); cleanup(dir); });
const publish = () => queue.publish({ summary: "Synthetic counter project; no real data", reviewed: true });

describe("restricted handoff queue", () => {
  it("isolates progress by owner and preserves desktop identity across interrupted work", () => {
    publish();
    const a = queue.submit("alice", request);
    queue.submit("bob", request);
    const claim = queue.claim()!;
    const link = { taskId: a.taskId, receipt: claim.receipt, threadId: "00000000-0000-4000-8000-000000000001" };
    expect(() => queue.link({ ...link, receipt: "x".repeat(43) })).toThrow(/claim/);
    queue.link(link);
    expect(() => queue.link({ ...link, threadId: "00000000-0000-4000-8000-000000000002" })).toThrow(/already linked/);
    expect(queue.progress("alice").recentTasks.map(t => t.taskId)).toEqual([a.taskId]);
    expect(JSON.stringify(queue.progress("bob"))).not.toContain(link.threadId);
    queue.close(); queue = new HandoffQueue(dir, "demo");
    expect(queue.status("alice", a.taskId)).toMatchObject({ status: "needs_attention", codexTaskId: link.threadId });
    expect(() => queue.link(link)).toThrow(/claim/);
  });
  it("requires a reviewed current summary and isolates projects and client tasks", () => {
    expect(() => queue.submit("alice", request)).toThrow(/Summary/);
    expect(() => queue.publish({ summary: "Draft" })).toThrow();
    publish();
    expect(() => queue.submit("alice", { ...request, projectId: "other" })).toThrow(/Project/);
    const task = queue.submit("alice", request);
    expect(() => queue.status("bob", task.taskId)).toThrow(/not found/);
    expect(queue.status("alice", task.taskId).status).toBe("queued");
  });

  it("deduplicates retries but rejects changes under the same request ID", () => {
    publish();
    const first = queue.submit("alice", request);
    expect(queue.submit("alice", request)).toEqual(first);
    expect(() => queue.submit("alice", { ...request, request: "Something else" })).toThrow(/already used/);
    const claim = queue.claim()!;
    expect(queue.claim()).toBeNull();
    queue.report({ taskId: claim.taskId, receipt: claim.receipt, status: "succeeded", summary: "Fake counter checked", reviewed: true });
    queue.close();
    queue = new HandoffQueue(dir, "demo");
    expect(queue.submit("alice", request).status).toBe("succeeded");
    expect(queue.claim()).toBeNull();
  });

  it("rejects stale queued work after a summary update", () => {
    publish();
    const task = queue.submit("alice", request);
    publish();
    expect(() => queue.submit("alice", { ...request, requestId: "request-0002" })).toThrow(/Summary/);
    expect(queue.claim()).toBeNull();
    expect(queue.status("alice", task.taskId).status).toBe("needs_attention");
  });

  it("requires the local one-use claim receipt and never returns private fields remotely", () => {
    publish();
    const task = queue.submit("alice", request);
    const claim = queue.claim()!;
    expect(() => queue.report({ taskId: task.taskId, receipt: "x".repeat(43), status: "succeeded", summary: "Done", reviewed: true })).toThrow(/claim/);
    expect(() => queue.report({ taskId: task.taskId, receipt: claim.receipt, status: "succeeded", summary: "Done" })).toThrow();
    const report = { taskId: task.taskId, receipt: claim.receipt, status: "needs_approval", summary: "Deployment requires user approval", reviewed: true };
    queue.report(report);
    expect(() => queue.report(report)).toThrow(/claim/);
    const result = queue.status("alice", task.taskId);
    expect(result.status).toBe("needs_approval");
    for (const key of ["receipt", "receiptHash", "owner", "request", "fingerprint"]) expect(result).not.toHaveProperty(key);
    expect(queue.claim()).toBeNull();
  });

  it("rejects common sensitive output and unknown command/path fields", () => {
    for (const summary of ["password=synthetic-password", "person@example.com", "C:\\secret\\data", "123456789012345678"]) {
      expect(() => queue.publish({ summary, reviewed: true })).toThrow();
    }
    publish();
    expect(() => queue.submit("alice", { ...request, cwd: "../../production", command: "delete" })).toThrow();
    expect(() => queue.submit("alice", { ...request, request: "a".repeat(6001) })).toThrow();
    const task = queue.submit("alice", request);
    const claim = queue.claim()!;
    expect(() => queue.report({ taskId: task.taskId, receipt: claim.receipt, status: "succeeded", summary: "api_key=synthetic-value", reviewed: true })).toThrow();
    expect(queue.status("alice", task.taskId).result).toBeNull();
  });

  it("persists completed work and marks interrupted work without rerunning it", () => {
    publish();
    const first = queue.submit("alice", request);
    const claim = queue.claim()!;
    queue.close();
    queue = new HandoffQueue(dir, "demo");
    expect(queue.status("alice", first.taskId).status).toBe("needs_attention");
    expect(queue.claim()).toBeNull();
    expect(() => queue.report({ taskId: first.taskId, receipt: claim.receipt, status: "succeeded", summary: "Late result", reviewed: true })).toThrow(/claim/);
    expect(queue.submit("alice", request).taskId).toBe(first.taskId);
  });

  it("refuses concurrent writers and fails closed on corrupt state", () => {
    expect(() => new HandoffQueue(dir, "demo")).toThrow();
    queue.close();
    fs.writeFileSync(path.join(dir, "queue.json"), "invalid json");
    expect(() => new HandoffQueue(dir, "demo")).toThrow();
    expect(fs.readFileSync(path.join(dir, "queue.json"), "utf8")).toBe("invalid json");
    expect(fs.existsSync(path.join(dir, "queue.lock"))).toBe(false);
  });

  it("bounds retained work without evicting idempotency records", () => {
    publish();
    for (let i = 0; i < 100; i++) queue.submit("alice", { ...request, requestId: `request-${i.toString().padStart(4, "0")}` });
    expect(() => queue.submit("alice", { ...request, requestId: "request-0100" })).toThrow(/capacity/);
    expect(queue.submit("alice", request).status).toBe("queued");
  });
});
