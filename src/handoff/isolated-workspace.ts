import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import ts from "typescript";
import { getQuickJS } from "quickjs-emscripten";
import { z } from "zod";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const relative = z.string().max(160).regex(/^(?:src|test)\/(?:[A-Za-z][A-Za-z0-9_-]*\/)*[A-Za-z][A-Za-z0-9_.-]*\.ts$/)
  .refine(s => !s.includes(".."));
const profileSchema = z.object({ version: z.literal(1), projectId: z.string(),
  files: z.array(z.object({ path: relative, sha256: z.string().regex(/^[a-f0-9]{64}$/), writable: z.boolean() }).strict()).min(1).max(30),
}).strict();
const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }).strict(),
  z.object({ action: z.literal("read"), path: relative }).strict(),
  z.object({ action: z.literal("write"), path: relative, content: z.string().max(65536) }).strict(),
  z.object({ action: z.literal("test") }).strict(),
]);
export type CheckResult = { passed: boolean; assertions: number; files: number; reason?: string };

/** A reviewed snapshot is the entire filesystem visible to generated code.
 * No shell, process, fetch, host require, or original-project path is exposed.
 */
export class IsolatedWorkspace {
  private readonly initial = new Map<string, string>();
  private readonly writable = new Set<string>();
  private readonly names = new Set<string>();
  private latestCheck?: { digest: string; result: CheckResult };
  readonly tool = { type: "function", name: "isolated_workspace",
    description: "Develop only in the reviewed isolated copy. Actions: list; read(path); write(path,content); test. Only listed writable source files and new test/*.test.ts files may be edited. test runs synchronous TypeScript/JavaScript in QuickJS WebAssembly with no host files, network, shell or packages. Tests import { assert } from 'sandbox:assert'; assert(condition, message). Immutable regression tests also run. This is not Node, Vitest or a full application test environment. No deployment or original project writes are available.",
    inputSchema: { type: "object", properties: { action: { type: "string", enum: ["list", "read", "write", "test"] },
      path: { type: "string" }, content: { type: "string" } }, required: ["action"], additionalProperties: false } };

  constructor(readonly root: string, snapshotDir: string, expectedProjectId: string) {
    if (!path.isAbsolute(root) || !path.isAbsolute(snapshotDir)) throw new Error("Absolute local directories required");
    if (fs.lstatSync(root).isSymbolicLink() || fs.lstatSync(snapshotDir).isSymbolicLink()) throw new Error("Linked directory denied");
    const manifestPath = this.fileAt(snapshotDir, "manifest.json");
    const manifestStat = fs.lstatSync(manifestPath);
    if (!manifestStat.isFile() || manifestStat.size > 32768 || manifestStat.nlink !== 1) throw new Error("Invalid manifest");
    const manifest = profileSchema.parse(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
    if (manifest.projectId !== expectedProjectId) throw new Error("Snapshot project mismatch");
    for (const entry of manifest.files) {
      if (this.names.has(entry.path)) throw new Error("Duplicate snapshot path");
      const source = this.readAt(snapshotDir, entry.path);
      if (hash(source) !== entry.sha256) throw new Error("Reviewed snapshot changed; local review required");
      this.initial.set(entry.path, source); this.names.add(entry.path);
      if (entry.writable) this.writable.add(entry.path);
      const target = this.fileAt(root, entry.path);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, source, { flag: "wx", mode: 0o600 });
    }
  }

  private fileAt(root: string, name: string) {
    if (fs.lstatSync(root).isSymbolicLink()) throw new Error("Linked root denied");
    const resolvedRoot = fs.realpathSync.native(root);
    const target = path.resolve(resolvedRoot, name);
    if (!target.startsWith(resolvedRoot + path.sep)) throw new Error("Path denied");
    let current = resolvedRoot;
    for (const part of path.relative(resolvedRoot, target).split(path.sep)) {
      current = path.join(current, part);
      if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error("Linked path denied");
    }
    return target;
  }

  private readAt(root: string, name: string) {
    const target = this.fileAt(root, name);
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536) throw new Error("Invalid workspace file");
    return fs.readFileSync(target, "utf8");
  }

  private contents() {
    return new Map([...this.names].sort().map(name => [name, this.readAt(this.root, name)]));
  }

  private digest(files: Map<string, string>) { return hash(JSON.stringify([...files])); }

  async handle(input: unknown): Promise<object> {
    const action = actionSchema.parse(input);
    if (action.action === "list") return { files: [...this.names].sort().map(name => ({ path: name, writable: this.writable.has(name) || !this.initial.has(name) })) };
    if (action.action === "test") return this.test();
    if (action.action === "read") {
      if (!this.names.has(action.path)) throw new Error("File is outside the reviewed scope");
      return { path: action.path, content: this.readAt(this.root, action.path) };
    }
    const newTest = !this.names.has(action.path) && /^test\/[A-Za-z][A-Za-z0-9_-]*\.test\.ts$/.test(action.path);
    if (!this.writable.has(action.path) && !(this.names.has(action.path) && !this.initial.has(action.path)) && !newTest) throw new Error("File is not writable in this scope");
    if (this.names.size >= 40 && newTest) throw new Error("Workspace capacity reached");
    const all = this.contents(); all.set(action.path, action.content);
    if ([...all.values()].reduce((n, s) => n + Buffer.byteLength(s), 0) > 1_000_000) throw new Error("Workspace byte limit");
    const target = this.fileAt(this.root, action.path);
    if (fs.existsSync(target)) this.readAt(this.root, action.path);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const temp = this.fileAt(this.root, `test-${randomUUID()}.tmp`);
    fs.writeFileSync(temp, action.content, { flag: "wx", mode: 0o600 });
    try { fs.renameSync(temp, target); } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
    this.names.add(action.path); this.latestCheck = undefined;
    return { written: action.path, originalProjectModified: false };
  }

  async test(): Promise<CheckResult> {
    const sources = this.contents();
    const modules = new Map<string, string>();
    for (const [name, code] of sources) {
      // Never load tsconfig.json, plugins, installed packages or source-tree imports.
      const compiled = ts.transpileModule(code, { fileName: name, reportDiagnostics: true,
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, isolatedModules: true, verbatimModuleSyntax: true } });
      if (compiled.diagnostics?.some(d => d.category === ts.DiagnosticCategory.Error)) {
        const result = { passed: false, assertions: 0, files: 0, reason: `TypeScript syntax error in ${name}` };
        this.latestCheck = { digest: this.digest(sources), result }; return result;
      }
      modules.set(name, compiled.outputText);
    }
    const tests = [...sources.keys()].filter(n => n.startsWith("test/") && n.endsWith(".test.ts"));
    let assertions = 0, completed = 0;
    const QuickJS = await getQuickJS();
    let reason: string | undefined;
    for (const test of tests) {
      const runtime = QuickJS.newRuntime();
      runtime.setMemoryLimit(8 * 1024 * 1024); runtime.setMaxStackSize(256 * 1024);
      const deadline = Date.now() + 1000;
      runtime.setInterruptHandler(() => Date.now() > deadline);
      runtime.setModuleLoader(name => {
        if (name === "sandbox:assert") return "export const assert = globalThis.__checkedAssert;";
        const code = modules.get(name);
        if (code === undefined) throw new Error("Import is outside the reviewed workspace");
        return code;
      }, (base, name) => {
        if (name === "sandbox:assert") return name;
        if (!name.startsWith("./") && !name.startsWith("../")) throw new Error("External imports denied");
        let resolved = path.posix.normalize(path.posix.join(path.posix.dirname(base), name));
        if (resolved.endsWith(".js")) resolved = resolved.slice(0, -3) + ".ts";
        if (!resolved.endsWith(".ts")) resolved += ".ts";
        if (!modules.has(resolved)) throw new Error("Import is outside the reviewed workspace");
        return resolved;
      });
      const context = runtime.newContext();
      let failedAssertion = false;
      const checkedAssert = context.newFunction("assert", condition => {
        assertions++;
        if (!context.eq(condition, context.true)) { failedAssertion = true; return { error: context.newError("Assertion failed") }; }
        return context.undefined;
      });
      context.setProp(context.global, "__checkedAssert", checkedAssert); checkedAssert.dispose();
      try {
        const result = context.evalCode(modules.get(test)!, test, { type: "module" });
        if (result.error) { result.error.dispose(); reason = `Test failed or exceeded limits: ${test}`; }
        else {
          // Async tests are intentionally unsupported: never count pending assertions as passed.
          const state = context.getPromiseState(result.value);
          if (state.type !== "fulfilled") reason = `Asynchronous test unsupported: ${test}`;
          if (state.type === "fulfilled" && !state.notAPromise) state.value.dispose();
          if (state.type === "rejected") state.error.dispose();
          result.value.dispose();
          if (runtime.hasPendingJob()) reason = `Asynchronous test unsupported: ${test}`;
        }
        if (failedAssertion) reason = `Assertion failed: ${test}`;
      } catch { reason = `Test runtime stopped: ${test}`; }
      finally { context.dispose(); runtime.dispose(); }
      if (reason) break;
      completed++;
    }
    const result: CheckResult = { passed: !reason && assertions > 0 && tests.length > 0, assertions, files: completed,
      ...(reason || !assertions ? { reason: reason ?? "No assertions executed" } : {}) };
    this.latestCheck = { digest: this.digest(sources), result };
    return result;
  }

  review() {
    const files = this.contents();
    const changedFiles = [...files].filter(([n, s]) => this.initial.get(n) !== s).map(([name]) => name);
    const tests = this.latestCheck?.digest === this.digest(files) ? this.latestCheck.result : null;
    return { changedFiles, tests, originalProjectModified: false, automaticMerge: false,
      validationScope: "Synchronous pure TypeScript/JavaScript tests in QuickJS; no full typecheck, Node, Cloudflare, database or network integration tests.",
      changes: changedFiles.map(name => ({ path: name, before: this.initial.get(name) ?? null, after: files.get(name)! })) };
  }
}
