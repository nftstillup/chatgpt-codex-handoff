import express, { type Request, type Response, type NextFunction } from "express";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { AuthStore, safeEqual } from "../auth/store.js";
import { bearerAuth } from "../auth/middleware.js";
import { createOAuthRouter } from "../auth/oauth.js";
import { PairingManager } from "../pairing/manager.js";
import { createMcpHttpHandler } from "../mcp/http.js";
import { nullLogger } from "../logger/index.js";
import { HandoffQueue, HandoffError } from "./queue.js";
import { createHandoffMcp, HANDOFF_SCOPES, type HandoffTarget } from "./mcp.js";
import { runNextTextTask } from "./local-worker.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

/** Loopback server with optional private ingress and text or reviewed-snapshot worker. */
export async function startHandoffBridge(opts: { stateDir: string; projectId: string; port?: number;
  privateTunnel?: boolean;
  label?: string; additionalTargets?: HandoffTarget[];
  textWorker?: { executable: string; outputDir: string; prefixArgs?: string[]; timeoutMs?: number;
    desktopProject?: { projectId: string; label: string }; snapshotDir?: string } }) {
  if (opts.port !== undefined && (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535)) {
    throw new HandoffError("Invalid port");
  }
  const ids = [opts.projectId, ...(opts.additionalTargets ?? []).map(t => t.queue.projectId)];
  if (new Set(ids).size !== ids.length || ids.length > 10) throw new HandoffError("Invalid project registry");
  const queue = new HandoffQueue(opts.stateDir, opts.projectId);
  let authStore: AuthStore;
  try {
    const authFile = path.join(path.resolve(opts.stateDir), "auth.json");
    if (fs.existsSync(authFile) && fs.lstatSync(authFile).isSymbolicLink()) {
      throw new HandoffError("Linked auth file denied");
    }
    authStore = new AuthStore(`handoff-${opts.projectId}`, { file: authFile });
  } catch (error) { queue.close(); throw error; }
  const pairing = new PairingManager(`handoff-${opts.projectId}`);
  const workerToken = randomBytes(32).toString("base64url");
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  let baseUrl = "";
  let stopping = false;
  let activeWorker: Promise<void> | undefined;
  let workerFailed = false;
  let wakeRequested = false;
  let lastTunnelRejection: string[] = [];
  const lastResults: Awaited<ReturnType<typeof runNextTextTask>>[] = [];
  const wakeWorker = () => {
    if (!opts.textWorker || stopping || workerFailed) return;
    wakeRequested = true;
    if (activeWorker) return;
    activeWorker = (async () => {
      while (!stopping) {
        wakeRequested = false;
        const result = await runNextTextTask({ ...opts.textWorker!, baseUrl, workerToken });
        if (result.idle) break;
        lastResults.push(result);
        if (lastResults.length > 20) lastResults.shift();
      }
    })().catch(() => { workerFailed = true; }).finally(() => {
      activeWorker = undefined;
      if (wakeRequested) wakeWorker();
    });
  };
  // This stage is NOT tunnel-ready: reject proxied traffic and browser-origin
  // script calls. Fixed Host check prevents local DNS rebinding.
  app.use((req, res, next) => {
    const forwarded = Object.keys(req.headers).some((h) => h === "forwarded" || h.startsWith("x-forwarded-") || h.startsWith("cf-"));
    if (!baseUrl || req.get("host") !== new URL(baseUrl).host || req.headers.origin || forwarded) {
      res.status(403).json({ error: "local_only" });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use(createOAuthRouter({ store: authStore, pairing, workspaceName: opts.projectId,
    getBaseUrl: () => baseUrl, logger: nullLogger, supportedScopes: HANDOFF_SCOPES }));
  const target: HandoffTarget = { queue, onSubmitted: wakeWorker, label: opts.label ?? opts.projectId,
    executionMode: opts.textWorker?.snapshotDir ? "isolated-code" : "text", available: () => !stopping && !workerFailed };
  const mcp = createMcpHttpHandler(() => createHandoffMcp(queue, wakeWorker, target.executionMode,
    opts.additionalTargets, target.label, target.available), nullLogger);
  app.use("/mcp", (_req, res, next) => { if (stopping || workerFailed) res.status(503).json({ error: "local_attention_required" }); else next(); });
  app.all("/mcp", express.json({ limit: "24kb" }),
    bearerAuth({ store: authStore, workspaceId: `handoff-${opts.projectId}`, getBaseUrl: () => baseUrl, logger: nullLogger }),
    (req, res) => { void mcp(req, res); });

  const localGuard = (req: Request, res: Response, next: NextFunction) => {
    const remote = req.socket.remoteAddress;
    if (remote !== "127.0.0.1" || !safeEqual(req.get("authorization") ?? "", `Bearer ${workerToken}`)) {
      res.status(404).end(); return;
    }
    next();
  };
  app.use("/local", localGuard, express.json({ limit: "24kb" }));
  const local = (fn: (body: unknown) => unknown) => (req: Request, res: Response) => {
    try { res.json(fn(req.body)); }
    catch (error) { res.status(400).json({ error: error instanceof HandoffError ? error.message : "Request rejected" }); }
  };
  app.post("/local/publish", local((body) => queue.publish(body)));
  app.post("/local/claim", local(() => ({ task: queue.claim() })));
  app.post("/local/report", local((body) => queue.report(body)));
  app.post("/local/link", local((body) => queue.link(body)));
  app.post("/local/pairing", local(() => pairing.create()));
  app.post("/local/revoke", local(() => {
    const revoked = authStore.revokeAll(); pairing.invalidateAll(); return { revoked };
  }));
  app.get("/local/worker-status", local(() => ({ enabled: Boolean(opts.textWorker), active: Boolean(activeWorker), failed: workerFailed, lastResults, lastTunnelRejection })));
  app.use((_req, res) => { res.status(404).end(); });
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(400).json({ error: "Request rejected" });
  });
  const server = app.listen(opts.port ?? 0, "127.0.0.1");
  try {
    await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  } catch (error) { queue.close(); throw error; }
  const address = server.address();
  if (!address || typeof address === "string") { server.close(); queue.close(); throw new Error("Listen failed"); }
  baseUrl = `http://127.0.0.1:${address.port}`;
  // Optional private tunnel ingress has no OAuth or local-management routes.
  // The account-scoped tunnel authenticates its users; its local runtime holds
  // this separate, one-hour MCP credential. All those users share one owner.
  let tunnelServer: ReturnType<typeof app.listen> | undefined;
  let tunnel: { baseUrl: string; token: string; expiresAt: number; rotateToken: () => void } | undefined;
  if (opts.privateTunnel) {
    let credential = authStore.issueTokens({ clientId: "private-tunnel-demo", scopes: ["handoff.read", "handoff.submit"] });
    let token = credential.accessToken;
    const ingress = express();
    ingress.disable("x-powered-by");
    ingress.set("trust proxy", false);
    ingress.use((req, res, next) => {
      res.setHeader("Cache-Control", "no-store");
      if (!tunnel || req.socket.remoteAddress !== "127.0.0.1" || req.get("host") !== new URL(tunnel.baseUrl).host || req.headers.origin) {
        lastTunnelRejection = [!tunnel && "not_ready", req.socket.remoteAddress !== "127.0.0.1" && "not_loopback", tunnel && req.get("host") !== new URL(tunnel.baseUrl).host && "wrong_host", req.headers.origin && "origin"].filter(Boolean) as string[];
        res.status(403).end(); return;
      }
      if (req.originalUrl !== "/mcp") { res.status(404).end(); return; }
      if (!safeEqual(req.get("authorization") ?? "", `Bearer ${token}`) || !authStore.verifyAccessToken(token).ok) {
        res.status(401).json({ error: "unauthorized" }); return;
      }
      // The official runtime forwards proxy metadata. It is never an identity
      // signal: authenticate the local bearer first, then discard that metadata.
      for (const h of Object.keys(req.headers)) if (h === "forwarded" || h.startsWith("x-forwarded-") || h.startsWith("cf-")) delete req.headers[h];
      if (stopping || workerFailed) { res.status(503).end(); return; }
      (req as Request & { auth?: AuthInfo }).auth = { token, clientId: "private-tunnel-demo", scopes: ["handoff.read", "handoff.submit"] };
      next();
    });
    ingress.all("/mcp", express.json({ limit: "24kb" }), (req, res) => { void mcp(req, res); });
    ingress.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => { res.status(400).json({ error: "Request rejected" }); });
    tunnelServer = ingress.listen(0, "127.0.0.1");
    try {
      await new Promise<void>((resolve, reject) => { tunnelServer!.once("listening", resolve); tunnelServer!.once("error", reject); });
      const ingressAddress = tunnelServer.address();
      if (!ingressAddress || typeof ingressAddress === "string") throw new Error("Private ingress failed");
      tunnel = { baseUrl: `http://127.0.0.1:${ingressAddress.port}`, token,
        expiresAt: Date.now() + credential.expiresIn * 1000,
        // Local in-process lifecycle control only; never exposed through MCP.
        rotateToken: () => {
          if (stopping) throw new HandoffError("Bridge stopping");
          const previous = token;
          credential = authStore.issueTokens({ clientId: "private-tunnel-demo", scopes: ["handoff.read", "handoff.submit"] });
          token = credential.accessToken;
          tunnel!.token = token;
          tunnel!.expiresAt = Date.now() + credential.expiresIn * 1000;
          authStore.revokeToken(previous);
        } };
    } catch (error) { tunnelServer.close(); server.close(); queue.close(); throw error; }
  }
  wakeWorker();
  let closed = false;
  return { baseUrl, workerToken, authStore, tunnel, target, async close() {
    if (closed) return;
    closed = true;
    stopping = true;
    await activeWorker;
    if (tunnelServer) await new Promise<void>((resolve) => tunnelServer!.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    queue.close();
  } };
}
