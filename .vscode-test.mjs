import { defineConfig } from "@vscode/test-cli";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import fixtureModule from "./out/test/fixture.js";

// This process stays up while the tests run, so its pid stands in for a live Claude session.
// A short base keeps VS Code's sockets (user data dir, TMPDIR) within the macOS path limit.
const fixture = fixtureModule.createFixture(process.pid, "/tmp");
const userData = join(fixture.root, "user-data");
process.on("exit", () => rmSync(fixture.root, { recursive: true, force: true }));

// Terminals run a plain shell without the user's rc files, so the stub `claude` stays first on PATH.
const terminal = (os) => ({
  [`terminal.integrated.profiles.${os}`]: { sh: { path: "/bin/sh" } },
  [`terminal.integrated.defaultProfile.${os}`]: "sh",
  [`terminal.integrated.env.${os}`]: { PATH: `${fixture.bin}:\${env:PATH}` },
});
mkdirSync(join(userData, "User"), { recursive: true });
mkdirSync(join(fixture.root, "tmp"));
writeFileSync(
  join(userData, "User", "settings.json"),
  JSON.stringify({ ...terminal("osx"), ...terminal("linux"), "security.workspace.trust.enabled": false }),
);

export default defineConfig({
  files: "out/test/integration/**/*.test.js",
  workspaceFolder: fixture.alpha,
  // Fresh settings and view state on every run.
  launchArgs: [`--user-data-dir=${userData}`],
  env: {
    CLAUDE_CONFIG_DIR: fixture.claudeDir,
    // Stub `gh` and `claude`: no GitHub calls, never the real Claude.
    PATH: `${fixture.bin}:${process.env.PATH}`,
    // Keeps the window registry and handoff file away from real VS Code windows.
    TMPDIR: join(fixture.root, "tmp"),
    FIXTURE: JSON.stringify(fixture),
  },
  mocha: { ui: "tdd", timeout: 20_000 },
});
