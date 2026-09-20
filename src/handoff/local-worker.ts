import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { runCodexTextTask, type WorkerResult } from "./codex-worker.js";
import { IsolatedWorkspace } from "./isolated-workspace.js";

const claimSchema = z.object({ taskId: z.string().uuid(), projectId: z.string(), request: z.string().max(6000),
  acceptance: z.string().max(2000), receipt: z.string().min(32).max(128) });

/** Consume exactly one local claim. Remote publication is fixed status text only. */
export async function runNextTextTask(opts: {
  baseUrl: string; workerToken: string; executable: string; outputDir: string;
  prefixArgs?: string[]; timeoutMs?: number;
  desktopProject?: { projectId: string; label: string };
  snapshotDir?: string;
}) {
  const base = new URL(opts.baseUrl);
  if (base.protocol !== "http:" || base.hostname !== "127.0.0.1" || base.username || base.password || base.search || base.hash || base.pathname !== "/") {
    throw new Error("Worker requires a loopback bridge origin");
  }
  const outputDir = path.resolve(opts.outputDir);
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(outputDir).isSymbolicLink()) throw new Error("Linked output directory denied");
  const post = async (route: string, data: object) => {
    const response = await fetch(new URL(`/local/${route}`, base), { method: "POST", redirect: "error",
      headers: { authorization: `Bearer ${opts.workerToken}`, "content-type": "application/json" },
      body: JSON.stringify(data), signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Local worker request failed (${response.status})`);
    return response.json();
  };
  const claimed = await post("claim", {});
  if (claimed.task === null) return { idle: true as const };
  const task = claimSchema.parse(claimed.task);
  let resultFile: string | undefined;
  let outcome: WorkerResult;
  let codeReview: ReturnType<IsolatedWorkspace["review"]> | undefined;
  let reviewFile: string | undefined;
  try {
    // Fresh directory per run: never reuse a project directory or desktop thread.
    const jobDir = fs.mkdtempSync(path.join(outputDir, "text-job-"));
    const cwd = path.join(jobDir, "work"); fs.mkdirSync(cwd, { mode: 0o700 });
    const workspace = opts.snapshotDir ? new IsolatedWorkspace(cwd, opts.snapshotDir, task.projectId) : undefined;
    outcome = await runCodexTextTask({ executable: opts.executable, prefixArgs: opts.prefixArgs, cwd,
      request: task.request, acceptance: task.acceptance, timeoutMs: opts.timeoutMs, workspace,
      ...(opts.desktopProject ? {
        desktopTask: { projectId: opts.desktopProject.projectId,
          title: `[GPT 交接] ${opts.desktopProject.label} · ${task.taskId.slice(0, 8)}` },
        onThreadCreated: async (threadId: string) => {
          // Record locally as well in case HTTP registration fails after thread creation.
          fs.writeFileSync(path.join(jobDir, "desktop-task.json"), JSON.stringify({ taskId: task.taskId, threadId }), { flag: "wx", mode: 0o600 });
          await post("link", { taskId: task.taskId, receipt: task.receipt, threadId });
        },
      } : {}) });
    if (workspace) {
      // Independently re-run the fixed regression suite against the final bytes.
      await workspace.test();
      codeReview = workspace.review();
      reviewFile = path.join(jobDir, "review.json");
      fs.writeFileSync(reviewFile, JSON.stringify(codeReview, null, 2), { flag: "wx", mode: 0o600 });
      if (outcome.status === "succeeded" && (!codeReview.tests?.passed || !codeReview.changedFiles.length)) {
        outcome = { ...outcome, status: "needs_attention", reason: !codeReview.tests?.passed ? "isolated_tests_failed" : "no_code_changes" };
      }
    }
    resultFile = path.join(jobDir, "result.txt");
    fs.writeFileSync(resultFile, `${opts.snapshotDir ? "Isolated Codex code task" : "Independent Codex text task"}\nTask: ${task.taskId}\nStatus: ${outcome.status}\nReason: ${outcome.reason}\n\n${outcome.text ?? "No model output published."}\n`, { flag: "wx", mode: 0o600 });
  } catch {
    outcome = { status: "needs_attention", reason: "local_execution_failed", policyVerified: false };
  }
  // Do not relay free-form model output as "reviewed" based on a heuristic scan.
  const summary = codeReview
    ? `Isolated code task ${outcome.status}. Changed files: ${codeReview.changedFiles.length}. Synchronous sandbox tests: ${codeReview.tests?.passed ? "passed" : "not passed"}; assertions: ${codeReview.tests?.assertions ?? 0}. Changes and detailed results are retained locally for review. Original project untouched; no deployment or automatic merge. Full application integration tests were not run.`
    : outcome.status === "succeeded"
    ? "Codex returned a text result and declared the requested deliverable complete. Content acceptance still requires local review. Detailed output is retained locally. No project modification was requested."
    : outcome.reason === "input_required"
      ? "Codex needs a user decision or clarification. The task is not complete; read the question in its Codex task before continuing."
    : outcome.status === "needs_approval"
      ? "The worker requested an action beyond text processing and stopped without granting approval."
      : "The independent worker stopped without a verified successful result. Local inspection is required before retrying.";
  await post("report", { taskId: task.taskId, receipt: task.receipt, status: outcome.status, summary, reviewed: true });
  return { idle: false as const, taskId: task.taskId, status: outcome.status, reason: outcome.reason,
    policyVerified: outcome.policyVerified, resultFile, reviewFile, codexTaskId: outcome.threadId };
}
