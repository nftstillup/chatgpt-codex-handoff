import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HandoffQueue } from "../dist/handoff/queue.js";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-codex-handoff-demo-"));
const queue = new HandoffQueue(stateDir, "demo");
const owner = "synthetic-demo-client";

try {
  const published = queue.publish({
    summary: "Synthetic demo project with no private data.",
    reviewed: true,
  });

  const submitted = queue.submit(owner, {
    projectId: "demo",
    requestId: "demo-request-0001",
    summaryVersion: published.summaryVersion,
    request: "Produce a synthetic handoff result.",
    acceptance: "Complete the synthetic task with a reviewed result.",
  });

  const claimed = queue.claim();
  if (!claimed) throw new Error("Expected one queued task");

  queue.report({
    taskId: claimed.taskId,
    receipt: claimed.receipt,
    status: "succeeded",
    summary: "Synthetic handoff completed successfully.",
    reviewed: true,
  });

  console.log(JSON.stringify({
    project: published.projectId,
    submittedStatus: submitted.status,
    final: queue.status(owner, submitted.taskId),
  }, null, 2));
} finally {
  queue.close();
  fs.rmSync(stateDir, { recursive: true, force: true });
}
