/**
 * The script that actually installs an update. "Update Ask Claude" writes it to the extension's
 * support folder and starts it with Node as its own background process, because Raycast restarts
 * the command as soon as the new build loads (which would cut off anything running inside it).
 * Running separately, it always finishes the job and always stops the development build, even if
 * the window is closed. It reports progress through a JSON state file and a plain log file.
 *
 * Plain CommonJS on purpose (no imports, no template strings) so it runs on any Node version as is.
 */
export const RUNNER_SOURCE = String.raw`"use strict";
const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");

const stateFile = process.argv[2];
const BUILD_OK = /built extension successfully/i;
let state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
const cfg = state.config;
const env = Object.assign({}, process.env, { PATH: cfg.path, GIT_TERMINAL_PROMPT: "0", FORCE_COLOR: "0", NO_COLOR: "1" });
let buildGroup = 0;
let finished = false;

function save(patch) {
  state = Object.assign({}, state, patch, { updatedAt: Date.now() });
  const tmp = stateFile + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, stateFile);
}
function step(key, status, note) {
  save({
    steps: state.steps.map(function (s) {
      return s.key === key ? Object.assign({}, s, { status: status }, note ? { note: note } : {}) : s;
    }),
  });
}
function clean(text) {
  return String(text).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r\n?/g, "\n");
}
function log(text) {
  const lines = clean(text).split("\n").filter(function (l) { return l.trim(); });
  if (lines.length) fs.appendFileSync(state.logFile, lines.join("\n") + "\n");
}
function tail(text, n) {
  return clean(text).trim().split("\n").slice(-n).join("\n");
}
function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}
function fail(message, details) {
  const err = new Error(message);
  err.details = details || "";
  return err;
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}
function groupAlive(pgid) {
  try { process.kill(-pgid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}
function signalGroup(pgid, sig) {
  try { process.kill(-pgid, sig); } catch (e) { /* already gone */ }
}

function exec(cmd, args, opts) {
  opts = opts || {};
  const timeoutMs = opts.timeoutMs || 120000;
  return new Promise(function (resolve) {
    let out = "";
    let child;
    try {
      child = childProcess.spawn(cmd, args, { cwd: cfg.folder, env: env });
    } catch (err) {
      resolve({ code: null, out: String(err.message) });
      return;
    }
    const timer = setTimeout(function () {
      out += "\nTimed out after " + Math.round(timeoutMs / 1000) + "s";
      child.kill("SIGTERM");
    }, timeoutMs);
    function onData(d) {
      out += String(d);
      if (opts.stream) log(d);
    }
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", function (err) { clearTimeout(timer); resolve({ code: null, out: out + String(err.message) }); });
    child.on("close", function (code) { clearTimeout(timer); resolve({ code: code, out: out }); });
  });
}

async function git(args, opts) {
  opts = opts || {};
  if (!opts.quiet) log("$ git " + args.join(" "));
  const r = await exec(cfg.git, args, { timeoutMs: 120000 });
  if (r.code !== 0) {
    const details = tail(r.out, 20);
    if (args[0] === "fetch" && /resolve host|unable to access|Could not read|timed out|network/i.test(r.out)) {
      throw fail("Couldn't reach GitHub. Check your internet connection, then try again.", details);
    }
    if (/would be overwritten|not possible to fast-forward|diverging/i.test(r.out)) {
      throw fail("Some files in the extension folder were changed by hand, so the update stopped to keep them safe.", details);
    }
    throw fail("git " + args[0] + " failed.", details);
  }
  if (!opts.quiet && r.out.trim()) log(tail(r.out, 6));
  return r.out.trim();
}

// A development build of this folder that is still running (for example one left over by an
// older version of this command) would rebuild on its own and fight with ours, so stop it first.
async function stopOtherDevBuilds() {
  const r = await exec("ps", ["-A", "-ww", "-o", "pid=,ppid=,command="], { timeoutMs: 10000 });
  if (r.code !== 0) return;
  const cli = path.join(cfg.folder, "node_modules", ".bin", "ray");
  const procs = r.out
    .split("\n")
    .map(function (line) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      return m ? { pid: Number(m[1]), ppid: Number(m[2]), command: m[3] } : null;
    })
    .filter(Boolean);
  const builds = procs
    .filter(function (p) { return p.pid !== process.pid && p.command.indexOf(cli) !== -1 && /\sdevelop(\s|$)/.test(p.command); })
    .map(function (p) { return p.pid; });
  if (!builds.length) return;
  // Include everything those builds started (bundler helpers), found before they're stopped.
  const all = builds.slice();
  for (let i = 0; i < all.length; i++) {
    procs.forEach(function (p) { if (p.ppid === all[i] && all.indexOf(p.pid) === -1) all.push(p.pid); });
  }
  log("Stopping a development build of this folder that was already running (pid " + builds.join(", ") + ")");
  builds.forEach(function (pid) { try { process.kill(pid, "SIGINT"); } catch (e) { /* gone */ } });
  for (let i = 0; i < 30 && all.some(alive); i++) await sleep(100);
  all.filter(alive).forEach(function (pid) { try { process.kill(pid, "SIGKILL"); } catch (e) { /* gone */ } });
}

// Same as "npm run dev" in Terminal, then Ctrl+C once Raycast has the new build.
function build() {
  log("$ npm run dev");
  return new Promise(function (resolve, reject) {
    let out = "";
    let built = false;
    let settled = false;
    const child = childProcess.spawn(cfg.npm, ["run", "dev"], { cwd: cfg.folder, env: env, detached: true });
    buildGroup = child.pid || 0;

    function settle(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    }
    // Interrupts the whole build (npm and the Raycast CLI it started), like Ctrl+C, and makes sure
    // nothing from it is left running.
    async function stopDevMode() {
      const group = buildGroup;
      if (!group) return;
      signalGroup(group, "SIGINT");
      for (let i = 0; i < 50 && groupAlive(group); i++) await sleep(100);
      if (groupAlive(group)) {
        log("Development mode didn't stop on Ctrl+C; stopping it harder.");
        signalGroup(group, "SIGTERM");
        for (let i = 0; i < 30 && groupAlive(group); i++) await sleep(100);
      }
      if (groupAlive(group)) signalGroup(group, "SIGKILL");
      buildGroup = 0;
    }
    let timedOut = false;
    const timer = setTimeout(function () {
      timedOut = true;
      stopDevMode().then(function () {
        settle(fail("The build didn't finish within " + Math.round(cfg.buildTimeoutMs / 1000) + " seconds.", tail(out, 20)));
      });
    }, cfg.buildTimeoutMs);

    function onData(d) {
      const text = clean(d);
      out += text;
      log(text);
      if (!built && BUILD_OK.test(out)) {
        built = true;
        clearTimeout(timer);
        save({ built: true });
        setTimeout(function () {
          stopDevMode().then(function () {
            log("Stopped development mode.");
            settle();
          });
        }, cfg.settleMs);
      }
    }
    if (child.stdout) child.stdout.on("data", onData);
    if (child.stderr) child.stderr.on("data", onData);
    child.on("error", function (err) { settle(fail("Couldn't start the build.", String(err.message))); });
    child.on("close", function (code) {
      if (built || timedOut) return; // those paths finish on their own
      stopDevMode().then(function () {
        settle(fail("The build stopped with an error (exit code " + code + ").", tail(out, 20)));
      });
    });
  });
}

async function main() {
  save({ pid: process.pid, state: "running" });
  log("Update started " + new Date().toString());
  await stopOtherDevBuilds();

  let changed = null; // null: unknown, so reinstall dependencies
  step("download", "running");
  if (cfg.mode === "connect") {
    if (!fs.existsSync(path.join(cfg.folder, ".git"))) await git(["init", "-q", "-b", "main"]);
    const remotes = (await git(["remote"], { quiet: true })).split("\n");
    if (remotes.indexOf("origin") !== -1) await git(["remote", "set-url", "origin", cfg.repoUrl]);
    else await git(["remote", "add", "origin", cfg.repoUrl]);
    await git(["fetch", "--quiet", "origin", "main"]);
    await git(["reset", "--hard", "origin/main"]);
    await git(["branch", "--set-upstream-to=origin/main", "main"]);
    step("download", "done", "Connected to GitHub");
  } else {
    const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], { quiet: true });
    const before = await git(["rev-parse", "HEAD"], { quiet: true });
    await git(["fetch", "--quiet", "origin", branch]);
    await git(["merge", "--ff-only", "origin/" + branch]);
    const after = await git(["rev-parse", "HEAD"], { quiet: true });
    if (before === after) {
      changed = [];
      step("download", "done", "Latest version already downloaded");
    } else {
      changed = (await git(["diff", "--name-only", before, after], { quiet: true })).split("\n").filter(Boolean);
      const n = Number(await git(["rev-list", "--count", before + ".." + after], { quiet: true })) || 0;
      step("download", "done", "Downloaded " + n + (n === 1 ? " update" : " updates"));
    }
  }

  const needInstall =
    cfg.forceInstall ||
    changed === null ||
    !fs.existsSync(path.join(cfg.folder, "node_modules")) ||
    changed.some(function (f) { return f === "package.json" || f === "package-lock.json"; });
  if (needInstall) {
    step("install", "running");
    log("$ npm install");
    const r = await exec(cfg.npm, ["install", "--no-audit", "--no-fund"], { timeoutMs: 5 * 60000, stream: true });
    if (r.code !== 0) {
      if (/EACCES/.test(r.out)) {
        throw fail("npm couldn't write to its cache folder. Run this in Terminal, then try again:  sudo chown -R $(id -u):$(id -g) ~/.npm", tail(r.out, 20));
      }
      throw fail("npm install failed.", tail(r.out, 20));
    }
    step("install", "done", "Installed dependencies");
  } else {
    step("install", "skipped", "Dependencies already up to date");
  }

  step("build", "running");
  await build();
  step("build", "done", "Rebuilt the extension");
  const to = await git(["rev-parse", "--short", "HEAD"], { quiet: true });
  save({ state: "done", to: to, finishedAt: Date.now() });
  log("Update finished.");
}

function finishWithError(message, details) {
  if (finished) return;
  finished = true;
  if (buildGroup) signalGroup(buildGroup, "SIGKILL");
  try {
    save({
      state: "failed",
      error: message,
      details: details || "",
      finishedAt: Date.now(),
      steps: state.steps.map(function (s) { return s.status === "running" ? Object.assign({}, s, { status: "failed" }) : s; }),
    });
    log("Update failed: " + message);
  } catch (e) { /* nothing more we can do */ }
}

["SIGTERM", "SIGINT", "SIGHUP"].forEach(function (sig) {
  process.on(sig, function () {
    finishWithError("The update was stopped before it finished.");
    process.exit(1);
  });
});
process.on("uncaughtException", function (err) {
  finishWithError("The updater ran into a problem.", String((err && err.stack) || err));
  process.exit(1);
});
setTimeout(function () {
  finishWithError("The update took too long and was stopped.");
  process.exit(1);
}, cfg.maxRunMs).unref();

main().then(
  function () { finished = true; process.exit(0); },
  function (err) { finishWithError(err.message, err.details); process.exit(1); },
);
`;
