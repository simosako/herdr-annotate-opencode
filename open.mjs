import { execFileSync } from "node:child_process";
import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TITLE = "Annotate OpenCode";
const USAGE = "Usage: node open.mjs [--help] [--dry-run] [--pane <pane-id>]";

/**
 * Error carrying a stable code so callers and tests never depend on wording.
 */
export class PluginError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PluginError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new PluginError(code, message);
}

function requireValue(condition, code, message) {
  if (!condition) fail(code, message);
}

function text(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function runCommand(program, args, env) {
  try {
    return execFileSync(program, args, {
      env,
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    // Do not expose command arguments or server output: either may contain secrets.
    const reason = error.code ?? `exit ${error.status ?? "unknown"}`;
    fail("COMMAND_FAILED", `Failed to run ${path.basename(program)} (${reason}).`);
  }
}

function jsonCommand(run, program, args, env) {
  const output = run(program, args, env);
  try {
    return JSON.parse(output);
  } catch {
    fail("COMMAND_NOT_JSON", `${path.basename(program)} returned a non-JSON response.`);
  }
}

export function loadSettings(env) {
  const filename = path.join(env.HERDR_PLUGIN_CONFIG_DIR || ROOT, "settings.json");
  let settings;
  let source;
  try {
    source = readFileSync(filename, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return {};
    fail("SETTINGS_UNREADABLE", "Cannot read settings.json. Check the plugin config directory.");
  }
  try {
    settings = JSON.parse(source);
  } catch {
    fail("SETTINGS_INVALID", "Cannot read settings.json. Check that it is valid JSON.");
  }
  requireValue(settings && typeof settings === "object" && !Array.isArray(settings),
    "SETTINGS_INVALID", "settings.json must be a JSON object.");
  if (settings.opencodeApi !== undefined) {
    requireValue(Array.isArray(settings.opencodeApi) && settings.opencodeApi.length > 0 &&
      settings.opencodeApi.every(text), "SETTINGS_INVALID",
    "opencodeApi must be a non-empty array of strings.");
  }
  return settings;
}

function directoryExists(directory) {
  try {
    return statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

function executableExists(filename) {
  try {
    accessSync(filename, constants.X_OK);
    return statSync(filename).isFile();
  } catch {
    return false;
  }
}

function parseContext(env) {
  if (!env.HERDR_PLUGIN_CONTEXT_JSON) return {};
  let context;
  try {
    context = JSON.parse(env.HERDR_PLUGIN_CONTEXT_JSON);
  } catch {
    fail("CONTEXT_INVALID", "Cannot parse the Herdr invocation context.");
  }
  requireValue(context && typeof context === "object" && !Array.isArray(context),
    "CONTEXT_INVALID", "Cannot parse the Herdr invocation context.");
  return context;
}

function sessionID(pane) {
  const session = pane?.agent_session;
  requireValue(session?.kind === "id" && session.agent === "opencode" && text(session.value),
    "NO_SESSION_ID",
    "No OpenCode session ID was reported for this pane. Check Herdr's OpenCode integration.");
  return session.value;
}

/**
 * Resolve an annotate action command to an executable path.
 *
 * Absolute paths are used as-is, paths containing a separator are resolved
 * against the plugin root, and bare names are looked up on `PATH` so the
 * plugin survives annotate releases that ship a launcher differently.
 */
export function resolveLauncher(pluginRoot, command, env = process.env,
  isExecutable = executableExists) {
  if (path.isAbsolute(command)) {
    requireValue(isExecutable(command), "LAUNCHER_MISSING",
      `The annotate launcher "${command}" could not be found.`);
    return command;
  }
  if (command.includes("/") || command.includes("\\")) {
    const resolved = path.resolve(pluginRoot, command);
    requireValue(isExecutable(resolved), "LAUNCHER_MISSING",
      `The annotate launcher "${command}" could not be found.`);
    return resolved;
  }
  for (const directory of (env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, command);
    if (isExecutable(candidate)) return candidate;
  }
  fail("LAUNCHER_MISSING", `The annotate launcher "${command}" was not found on PATH.`);
}

export function prepareReview({
  env = process.env,
  paneID,
  settings = {},
  run = runCommand,
  isDirectory = directoryExists,
  isExecutable = executableExists,
} = {}) {
  requireValue(env.HERDR_ENV === "1", "NOT_HERDR", "Run this from inside a Herdr pane.");
  const herdr = env.HERDR_BIN_PATH || "herdr";
  const context = parseContext(env);
  const target = paneID || context.focused_pane_id || env.HERDR_PANE_ID;
  requireValue(text(target), "NO_PANE_ID", "Cannot determine the invoking pane ID.");
  const readPane = () => {
    const response = jsonCommand(run, herdr, ["pane", "get", target], env);
    const pane = response?.result?.pane;
    requireValue(pane?.pane_id === target, "PANE_UNAVAILABLE",
      "Cannot read the invoking pane from Herdr.");
    return pane;
  };
  const pane = readPane();

  // Keep the invocation snapshot, including remote/mirror placement hints.
  const invocation = { ...context };
  if (paneID || !context.focused_pane_id) {
    Object.assign(invocation, {
      focused_pane_id: target,
      focused_pane_cwd: pane.cwd,
      focused_pane_agent: pane.agent,
      workspace_id: pane.workspace_id,
      workspace_cwd: pane.cwd,
    });
    delete invocation.clicked_url;
  } else {
    requireValue((context.focused_pane_agent || undefined) === (pane.agent || undefined),
      "AGENT_CHANGED", "The pane's agent changed during the lookup. Run it again.");
  }

  let directory;
  let id;
  if (pane.agent === "opencode") {
    id = sessionID(pane);
    const [program, ...prefix] = settings.opencodeApi ?? ["opencode", "api"];
    const response = jsonCommand(run, program,
      [...prefix, "get", `/api/session/${encodeURIComponent(id)}`], env);
    // `opencode api` wraps successful HTTP bodies in `data`.
    const session = response?.data;
    requireValue(session?.id === id, "SESSION_UNAVAILABLE",
      "Cannot read the OpenCode session. Check the configured API command and server.");
    directory = session.location?.directory;
    requireValue(text(directory) && path.isAbsolute(directory) && isDirectory(directory),
      "DIRECTORY_UNAVAILABLE",
      "The OpenCode session directory is missing or not a directory on the machine running Herdr.");
    const latest = readPane();
    requireValue(latest.agent === "opencode" && sessionID(latest) === id,
      "SESSION_CHANGED", "The OpenCode session changed during the lookup. Run it again.");
    // Explicit paths outrank pane cwd and clicked URLs in the original launcher.
    invocation.focused_pane_cwd = directory;
    invocation.workspace_cwd = directory;
  }

  const plugins = jsonCommand(run, herdr,
    ["plugin", "list", "--plugin", "annotate", "--json"], env)?.result?.plugins;
  const annotate = Array.isArray(plugins)
    ? plugins.find((plugin) => plugin.plugin_id === "annotate" && plugin.enabled)
    : undefined;
  const action = annotate?.actions?.find((item) => item.id === "open");
  requireValue(text(annotate?.plugin_root) && Array.isArray(action?.command) &&
    action.command.length > 0 && action.command.every(text),
    "ANNOTATE_NOT_FOUND",
    "No enabled annotate plugin with an 'open' action was found. Install the annotate plugin first.");
  const [command, ...args] = action.command;
  const program = resolveLauncher(annotate.plugin_root, command, env, isExecutable);
  if (directory) args.push(directory, "--deliver-to", target);

  return {
    program,
    args,
    paneID: target,
    sessionID: id,
    directory,
    env: {
      ...env,
      HERDR_PLUGIN_ID: "annotate",
      HERDR_PLUGIN_ROOT: annotate.plugin_root,
      HERDR_PLUGIN_ACTION_ID: "open",
      HERDR_PANE_ID: target,
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify(invocation),
    },
  };
}

export function launchReview(plan, run = runCommand) {
  const herdr = plan.env.HERDR_BIN_PATH || "herdr";
  // Overlay launches use the active pane; do not open over a newly focused pane.
  const active = jsonCommand(run, herdr, ["pane", "get", plan.paneID], plan.env)?.result?.pane;
  requireValue(active?.pane_id === plan.paneID && active.focused === true,
    "FOCUS_MOVED",
    "The focused pane changed during the lookup. Run it again from the target pane.");
  if (plan.sessionID) {
    requireValue(active.agent === "opencode" && sessionID(active) === plan.sessionID,
      "SESSION_CHANGED", "The OpenCode session changed during the lookup. Run it again.");
  }
  return run(plan.program, plan.args, plan.env);
}

function options(args) {
  const result = { dryRun: false, help: false };
  while (args.length) {
    const arg = args.shift();
    if (arg === "--help" || arg === "-h") result.help = true;
    else if (arg === "--dry-run") result.dryRun = true;
    else if (arg === "--pane") {
      requireValue(text(args[0]) && !args[0].startsWith("-"), "USAGE", USAGE);
      result.paneID = args.shift();
    } else fail("USAGE", USAGE);
  }
  return result;
}

function main() {
  let args;
  try {
    args = options(process.argv.slice(2));
  } catch (error) {
    console.error(`${TITLE}: ${error.message}`);
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    console.log(USAGE);
    console.log("");
    console.log("  --dry-run         Print the resolved pane, session and directory without opening.");
    console.log("  --pane <pane-id>  Diagnose a specific pane instead of the invoking one.");
    console.log("  --help, -h        Show this help.");
    return;
  }
  try {
    const plan = prepareReview({ settings: loadSettings(process.env), paneID: args.paneID });
    if (args.dryRun) {
      // Deliberately omit environment variables and API command arguments.
      console.log(JSON.stringify({
        paneID: plan.paneID,
        sessionID: plan.sessionID,
        directory: plan.directory,
        mode: plan.directory ? "opencode-session" : "original-annotate",
        launcher: plan.program,
      }, null, 2));
    } else {
      process.stdout.write(launchReview(plan));
    }
  } catch (error) {
    console.error(`${TITLE}: ${error.message}`);
    if (process.env.HERDR_ENV === "1") {
      try {
        runCommand(process.env.HERDR_BIN_PATH || "herdr", [
          "notification", "show", TITLE, "--body", error.message, "--sound", "none",
        ], process.env);
      } catch {
        // The original error remains available in Herdr's plugin log.
      }
    }
    process.exitCode = error.code === "USAGE" ? 2 : 1;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
