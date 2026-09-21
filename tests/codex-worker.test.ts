import { describe, expect, it } from "vitest";
import { buildCodexWorkerEnv } from "../src/handoff/codex-worker.js";

describe("Codex worker environment isolation", () => {
  it("keeps only explicitly allowlisted variables", () => {
    const env = buildCodexWorkerEnv({
      PATH: "C:\\tools",
      TEMP: "C:\\temp",
      CODEX_HOME: "C:\\codex-home",
      CODEX_ACCESS_TOKEN: "synthetic-codex-token",

      GITHUB_TOKEN: "NEVER_INHERIT_GITHUB_TOKEN",
      AWS_SECRET_ACCESS_KEY: "NEVER_INHERIT_AWS_SECRET",
      DATABASE_URL: "postgres://should-not-leak",
      RANDOM_PRIVATE_SECRET: "NEVER_INHERIT_PRIVATE_SECRET",
    });

    expect(env.PATH).toBe("C:\\tools");
    expect(env.TEMP).toBe("C:\\temp");
    expect(env.CODEX_HOME).toBe("C:\\codex-home");
    expect(env.CODEX_ACCESS_TOKEN).toBe("synthetic-codex-token");

    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.RANDOM_PRIVATE_SECRET).toBeUndefined();

    expect(JSON.stringify(env)).not.toContain("NEVER_INHERIT");
    expect(JSON.stringify(env)).not.toContain("should-not-leak");
  });
});