import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PluginError, launchReview, prepareReview, resolveLauncher, runCommand } from "./open.mjs";

function fixture(overrides = {}) {
  const pane = {
    pane_id: "w1:p1",
    workspace_id: "w1",
    cwd: "/original",
    agent: "opencode",
    focused: true,
    agent_session: { kind: "id", agent: "opencode", value: "ses_test" },
    ...overrides.pane,
  };
  const context = {
    focused_pane_id: pane.pane_id,
    focused_pane_cwd: "/original",
    focused_pane_agent: pane.agent,
    invocation_source: "mirror",
    ...overrides.context,
  };
  const env = {
    HERDR_ENV: "1",
    HERDR_BIN_PATH: "/bin/herdr",
    HERDR_PANE_ID: "w9:p9",
    HERDR_PLUGIN_ID: "annotate-opencode",
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify(context),
    ...overrides.env,
  };
  const session = overrides.session ?? { id: "ses_test", location: { directory: "/worktrees/a b;$x" } };
  const calls = [];
  let paneReads = 0;
  const run = (program, args, commandEnv) => {
    calls.push({ program, args, env: commandEnv });
    if (args[0] === "pane" && args[1] === "get") {
      paneReads++;
      const current = paneReads > 1 ? overrides.latestPane ?? pane : pane;
      return JSON.stringify({ result: { pane: {
        ...current,
        focused: (overrides.activePane ?? pane.pane_id) === current.pane_id,
      } } });
    }
    if (args[0] === "plugin") {
      return JSON.stringify({ result: { plugins: [{
        plugin_id: "annotate",
        enabled: overrides.enabled ?? true,
        plugin_root: "/opt/herdr/plugins/annotate",
        actions: [{ id: "open", command: overrides.command ?? ["./bin/annotate", "herdr", "open"] }],
      }] } });
    }
    if (program === "/opt/herdr/plugins/annotate/bin/annotate") return "opened\n";
    // Mirror the wrapping performed by the real runCommand.
    if (overrides.apiError) throw new PluginError("COMMAND_FAILED", "Failed to run opencode (ENOENT).");
    if (overrides.apiOutput !== undefined) return overrides.apiOutput;
    return JSON.stringify({ data: session });
  };
  const isExecutable = typeof overrides.isExecutable === "function"
    ? overrides.isExecutable
    : () => overrides.executableExists ?? true;
  return {
    env, run, calls,
    settings: overrides.settings ?? {},
    isDirectory: () => overrides.directoryExists ?? true,
    isExecutable,
  };
}

function throwsCode(fn, code) {
  assert.throws(fn, (error) => error?.code === code);
}

test("uses the session location, not cwd or the wrapper's own pane", () => {
  const f = fixture();
  const plan = prepareReview(f);
  assert.equal(plan.paneID, "w1:p1");
  assert.equal(plan.directory, "/worktrees/a b;$x");
  assert.deepEqual(plan.args, ["herdr", "open", "/worktrees/a b;$x", "--deliver-to", "w1:p1"]);
  assert.equal(plan.program, "/opt/herdr/plugins/annotate/bin/annotate");
  assert.equal(plan.env.HERDR_PLUGIN_ID, "annotate");
  assert.equal(plan.env.HERDR_PLUGIN_ROOT, "/opt/herdr/plugins/annotate");
  assert.equal(JSON.parse(plan.env.HERDR_PLUGIN_CONTEXT_JSON).invocation_source, "mirror");
});

test("passes paths containing shell metacharacters as one argument", () => {
  const f = fixture();
  const plan = prepareReview(f);
  assert.equal(launchReview(plan, f.run), "opened\n");
  assert.equal(f.calls.at(-1).args[2], "/worktrees/a b;$x");
});

test("preserves the original Annotate action for other agents and shells", () => {
  for (const agent of ["claude", undefined]) {
    const f = fixture({ pane: { agent } });
    const plan = prepareReview(f);
    assert.equal(plan.directory, undefined);
    assert.deepEqual(plan.args, ["herdr", "open"]);
    assert.equal(f.calls.some((call) => call.program === "opencode"), false);
  }
});

test("supports explicit pane selection for diagnostic runs", () => {
  const f = fixture({ env: { HERDR_PLUGIN_CONTEXT_JSON: undefined } });
  const plan = prepareReview({ ...f, paneID: "w1:p1" });
  assert.equal(plan.paneID, "w1:p1");
  assert.equal(JSON.parse(plan.env.HERDR_PLUGIN_CONTEXT_JSON).focused_pane_agent, "opencode");
});

test("supports manually running from the calling Herdr pane", () => {
  const f = fixture({ env: { HERDR_PLUGIN_CONTEXT_JSON: undefined, HERDR_PANE_ID: "w1:p1" } });
  assert.equal(prepareReview(f).paneID, "w1:p1");
});

test("supports a configured API executable and server without a shell", () => {
  const f = fixture({ settings: { opencodeApi: ["/custom/oc", "api", "--server", "http://localhost:9999"] } });
  prepareReview(f);
  const call = f.calls.find((item) => item.program === "/custom/oc");
  assert.deepEqual(call.args, ["api", "--server", "http://localhost:9999", "get", "/api/session/ses_test"]);
});

test("requires Herdr and never falls back to a globally focused pane", () => {
  throwsCode(() => prepareReview(fixture({ env: { HERDR_ENV: "0" } })), "NOT_HERDR");
  throwsCode(() => prepareReview(fixture({
    env: { HERDR_PLUGIN_CONTEXT_JSON: undefined, HERDR_PANE_ID: undefined },
  })), "NO_PANE_ID");
});

test("rejects malformed invocation context", () => {
  throwsCode(() => prepareReview(fixture({ env: { HERDR_PLUGIN_CONTEXT_JSON: "{" } })), "CONTEXT_INVALID");
  throwsCode(() => prepareReview(fixture({ env: { HERDR_PLUGIN_CONTEXT_JSON: "[]" } })), "CONTEXT_INVALID");
});

test("requires the exact OpenCode session identity", () => {
  for (const agent_session of [undefined, { kind: "path", agent: "opencode", value: "/a" }]) {
    throwsCode(() => prepareReview(fixture({ pane: { agent_session } })), "NO_SESSION_ID");
  }
  throwsCode(() => prepareReview(fixture({ session: { id: "ses_other", location: { directory: "/a" } } })),
    "SESSION_UNAVAILABLE");
});

test("API failures never open the original directory", () => {
  const expected = ["COMMAND_FAILED", "COMMAND_NOT_JSON", "SESSION_UNAVAILABLE"];
  const overrides = [{ apiError: true }, { apiOutput: "not json" }, { apiOutput: '{"error":{}}' }];
  overrides.forEach((item, index) => {
    const f = fixture(item);
    throwsCode(() => prepareReview(f), expected[index]);
    assert.equal(f.calls.some((call) => call.program.endsWith("/bin/annotate")), false);
  });
});

test("requires an existing absolute session directory", () => {
  for (const directory of [undefined, "", "relative/path"]) {
    throwsCode(() => prepareReview(fixture({ session: { id: "ses_test", location: { directory } } })),
      "DIRECTORY_UNAVAILABLE");
  }
  throwsCode(() => prepareReview(fixture({ directoryExists: false })), "DIRECTORY_UNAVAILABLE");
});

test("detects agent and session switches during lookup", () => {
  throwsCode(() => prepareReview(fixture({ context: { focused_pane_agent: "claude" } })), "AGENT_CHANGED");
  throwsCode(() => prepareReview(fixture({ latestPane: {
    agent: "opencode", pane_id: "w1:p1",
    agent_session: { agent: "opencode", kind: "id", value: "ses_other" },
  } })), "SESSION_CHANGED");
});

test("requires an enabled and executable original Annotate launcher", () => {
  throwsCode(() => prepareReview(fixture({ enabled: false })), "ANNOTATE_NOT_FOUND");
  throwsCode(() => prepareReview(fixture({ executableExists: false })), "LAUNCHER_MISSING");
});

test("does not launch an overlay over a different active pane", () => {
  const f = fixture({ activePane: "w2:p3" });
  const plan = prepareReview(f);
  throwsCode(() => launchReview(plan, f.run), "FOCUS_MOVED");
  assert.equal(f.calls.some((call) => call.program.endsWith("/bin/annotate")), false);
});

test("checks session identity again immediately before opening the pane", () => {
  const f = fixture();
  const plan = prepareReview(f);
  const run = (program, args, env) => {
    if (args[0] === "pane" && args[1] === "get") {
      return JSON.stringify({ result: { pane: {
        pane_id: "w1:p1", focused: true, agent: "opencode",
        agent_session: { agent: "opencode", kind: "id", value: "ses_new" },
      } } });
    }
    return f.run(program, args, env);
  };
  throwsCode(() => launchReview(plan, run), "SESSION_CHANGED");
});

test("redacts command output when a command cannot be executed", () => {
  const env = { ...process.env };
  delete env.HERDR_ENV;
  assert.throws(() => runCommand("herdr-annotate-opencode-missing-binary", ["--secret", "value"], env),
    (error) => error.code === "COMMAND_FAILED" && !error.message.includes("--secret"));
});

test("resolves launchers from the plugin root, an absolute path, or PATH", () => {
  assert.equal(resolveLauncher("/plugins/annotate", "./bin/annotate", {},
    (file) => file === "/plugins/annotate/bin/annotate"), "/plugins/annotate/bin/annotate");
  assert.equal(resolveLauncher("/plugins/annotate", "/opt/bin/annotate", {},
    (file) => file === "/opt/bin/annotate"), "/opt/bin/annotate");
  assert.equal(resolveLauncher("/plugins/annotate", "annotate",
    { PATH: ["/one", "/bin"].join(path.delimiter) }, (file) => file === "/bin/annotate"), "/bin/annotate");
  throwsCode(() => resolveLauncher("/plugins/annotate", "annotate", { PATH: "/bin" }, () => false),
    "LAUNCHER_MISSING");
});

test("accepts a bare launcher name found on PATH", () => {
  const f = fixture({
    command: ["annotate", "herdr", "open"],
    env: { PATH: "/opt/bin" },
    isExecutable: (file) => file === "/opt/bin/annotate",
  });
  assert.equal(prepareReview(f).program, "/opt/bin/annotate");
});

function cli(args, env = {}) {
  const childEnv = { ...process.env };
  delete childEnv.HERDR_ENV;
  delete childEnv.HERDR_PANE_ID;
  delete childEnv.HERDR_PLUGIN_CONTEXT_JSON;
  delete childEnv.HERDR_PLUGIN_CONFIG_DIR;
  Object.assign(childEnv, env);
  return spawnSync(process.execPath, [fileURLToPath(new URL("./open.mjs", import.meta.url)), ...args],
    { encoding: "utf8", env: childEnv });
}

test("prints usage and keeps exit codes distinct", () => {
  const help = cli(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: node open\.mjs/);

  for (const args of [["--unknown"], ["--pane"], ["--pane", "--dry-run"]]) {
    const usage = cli(args);
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /Usage: node open\.mjs/);
  }

  const outside = cli([]);
  assert.equal(outside.status, 1);
  assert.match(outside.stderr, /inside a Herdr pane/);
});
