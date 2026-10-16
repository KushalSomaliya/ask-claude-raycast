/**
 * Self-update for a development install of this extension. Checking for updates happens here;
 * installing one is handed to a background runner (see update-runner.ts) that pulls the new
 * commits, installs dependencies when they changed, and rebuilds with the same `npm run dev`
 * you'd run in Terminal, stopping it once Raycast has the new build.
 * No Raycast imports, so it can be tested with plain Node.
 */
import { spawn } from "child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { RUNNER_SOURCE } from "./update-runner";

export const REPO_URL = "https://github.com/KushalSomaliya/ask-claude-raycast.git";
export const DEFAULT_FOLDER = "~/raycast-extensions/ask-claude-ext";

const BUILD_TIMEOUT_MS = 3 * 60 * 1000;
/** How long to let Raycast finish loading the new build before stopping development mode. */
const SETTLE_MS = 1500;
/** Hard limit for a whole update; the runner gives up after this. */
export const MAX_RUN_MS = 15 * 60 * 1000;

export const expandHome = (p: string, home = homedir()) => p.trim().replace(/^~(?=$|\/)/, home);

// ---------------------------------------------------------------------------
// Running commands
// ---------------------------------------------------------------------------

export type RunResult = { code: number | null; stdout: string; stderr: string };

export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; path?: string; timeoutMs?: number } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.path ? { PATH: opts.path } : {}), GIT_TERMINAL_PROMPT: "0" },
    });
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      stderr += `\nTimed out after ${Math.round((opts.timeoutMs ?? 60000) / 1000)}s`;
      finish(null);
    }, opts.timeoutMs ?? 60000);
    child.stdout?.on("data", (d) => (stdout += String(d)));
    child.stderr?.on("data", (d) => (stderr += String(d)));
    child.on("error", (err) => {
      stderr += String(err.message);
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}

// ---------------------------------------------------------------------------
// Finding git, node and npm
// ---------------------------------------------------------------------------

/** Sorts "v22.1.0"-style folder names newest first. */
export function compareVersionsDesc(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pb[i] || 0) !== (pa[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
  return 0;
}

/** Common places Node and npm live on a Mac, used if the login shell's PATH can't be read. */
export function fallbackPathDirs(home = homedir()): string[] {
  const dirs = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  dirs.push(join(home, ".volta/bin"), join(home, ".local/bin"), join(home, ".asdf/shims"));
  const nvm = join(home, ".nvm/versions/node");
  try {
    const newest = readdirSync(nvm).sort(compareVersionsDesc)[0];
    if (newest) dirs.push(join(nvm, newest, "bin"));
  } catch {
    /* no nvm */
  }
  return dirs;
}

/** Pulls PATH out of the login shell's output, ignoring anything the shell's startup files print. */
export function extractPath(output: string): string {
  return output.match(/__PATH__([\s\S]*?)__END__/)?.[1]?.trim() ?? "";
}

let cachedPath: string | undefined;

/**
 * Raycast starts extensions with a minimal PATH, so git/npm installed by Homebrew or nvm aren't
 * found. Use the user's own login shell PATH (what Terminal sees), plus common fallbacks.
 */
export async function resolvePath(): Promise<string> {
  if (cachedPath) return cachedPath;
  const shell = process.env.SHELL || "/bin/zsh";
  const res = await run(shell, ["-ilc", 'printf "__PATH__%s__END__" "$PATH"'], { timeoutMs: 8000 });
  const parts = [...extractPath(res.stdout).split(":"), ...(process.env.PATH ?? "").split(":"), ...fallbackPathDirs()];
  cachedPath = [...new Set(parts.filter(Boolean))].join(":");
  return cachedPath;
}

export function which(name: string, path: string): string | undefined {
  for (const dir of path.split(":")) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export type Tools = { git?: string; node?: string; npm?: string; path: string };

export async function findTools(): Promise<Tools> {
  const path = await resolvePath();
  return { git: which("git", path), node: which("node", path), npm: which("npm", path), path };
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

export type Commit = { hash: string; subject: string };

/** Parses `git log --format=%h%x09%s` output. */
export function parseCommits(stdout: string): Commit[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf("\t");
      return tab === -1 ? { hash: line, subject: "" } : { hash: line.slice(0, tab), subject: line.slice(tab + 1) };
    });
}

export class UpdateError extends Error {
  constructor(
    message: string,
    public details = "",
  ) {
    super(message);
  }
}

async function git(folder: string, tools: Tools, args: string[], timeoutMs = 60000): Promise<string> {
  if (!tools.git) throw new UpdateError("Git isn't installed. Run `xcode-select --install` in Terminal, then try again.");
  const res = await run(tools.git, args, { cwd: folder, path: tools.path, timeoutMs });
  if (res.code !== 0) throw new UpdateError(`git ${args[0]} failed`, (res.stderr || res.stdout).trim());
  return res.stdout.trim();
}

export type Status = {
  folder: string;
  branch: string;
  head: string;
  remote: string;
  commits: Commit[]; // newest first
  dirty: string[]; // tracked files changed locally (untracked files like package-lock.json are fine)
};

export const isRepo = (folder: string) => existsSync(join(folder, ".git"));

/** Fetches the followed branch and lists commits that aren't on this Mac yet. */
export async function checkForUpdates(folder: string, tools: Tools): Promise<Status> {
  const branch = await git(folder, tools, ["rev-parse", "--abbrev-ref", "HEAD"]);
  await git(folder, tools, ["fetch", "--quiet", "origin", branch], 90000);
  const remoteRef = `origin/${branch}`;
  const [head, remote, log, porcelain] = await Promise.all([
    git(folder, tools, ["rev-parse", "--short", "HEAD"]),
    git(folder, tools, ["rev-parse", "--short", remoteRef]),
    git(folder, tools, ["log", "--format=%h%x09%s", `HEAD..${remoteRef}`]),
    git(folder, tools, ["status", "--porcelain", "--untracked-files=no"]),
  ]);
  const dirty = porcelain
    .split("\n")
    .map((l) => l.replace(/^\s*\S{1,2}\s+/, "").trim()) // "XY path"; the first line may have lost its leading space
    .filter(Boolean);
  return { folder, branch, head, remote, commits: parseCommits(log), dirty };
}

export const tail = (text: string, lines: number) => text.trim().split("\n").slice(-lines).join("\n");

// ---------------------------------------------------------------------------
// Installing: a background run, tracked through files in the support folder
// ---------------------------------------------------------------------------

export type RunMode = "update" | "connect";
export type StepKey = "download" | "install" | "build";
export type StepStatus = "pending" | "running" | "done" | "skipped" | "failed";
export type RunStep = { key: StepKey; status: StepStatus; note?: string };

export type Run = {
  id: string;
  mode: RunMode;
  branch: string;
  from: string; // version before the update ("" when connecting a zip install)
  to?: string; // version after
  commits: Commit[]; // what's new, newest first
  steps: RunStep[];
  state: "running" | "done" | "failed";
  built?: boolean; // Raycast has the new build; only stopping development mode is left
  startedAt: number;
  updatedAt?: number;
  finishedAt?: number;
  pid?: number; // the runner's process
  error?: string;
  details?: string;
  logFile: string;
  seen?: boolean; // the result was shown
  dismissed?: boolean; // the user moved on from a failed run
  config: {
    folder: string;
    mode: RunMode;
    git: string;
    npm: string;
    path: string;
    repoUrl: string;
    forceInstall: boolean;
    buildTimeoutMs: number;
    settleMs: number;
    maxRunMs: number;
  };
};

export const runFiles = (dir: string) => ({
  state: join(dir, "update-run.json"),
  log: join(dir, "update-run.log"),
  runner: join(dir, "update-runner.js"),
});

export function readRun(dir: string): Run | null {
  try {
    const run = JSON.parse(readFileSync(runFiles(dir).state, "utf8")) as Run;
    return run && typeof run === "object" && Array.isArray(run.steps) ? run : null;
  } catch {
    return null;
  }
}

export function saveRun(dir: string, run: Run): void {
  const file = runFiles(dir).state;
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(run, null, 2));
  renameSync(tmp, file);
}

export function readLog(file: string, lines: number): string[] {
  try {
    return readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).slice(-lines);
  } catch {
    return [];
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A run whose runner has gone away without finishing (the Mac restarted, it crashed) is marked failed. */
export function settleInterrupted(run: Run, now = Date.now()): Run {
  if (run.state !== "running") return run;
  const starting = !run.pid && now - run.startedAt < 15000;
  const working = !!run.pid && isProcessAlive(run.pid) && now - run.startedAt < MAX_RUN_MS + 60000;
  if (starting || working) return run;
  return {
    ...run,
    state: "failed",
    error: "The update was interrupted before it finished.",
    finishedAt: now,
    steps: run.steps.map((s) => (s.status === "running" ? { ...s, status: "failed" } : s)),
  };
}

/** Whether to show this run when the command opens, instead of checking for updates. */
export function shouldShowRun(run: Run, now = Date.now()): boolean {
  if (run.state === "running") return true;
  if (run.state === "failed") return !run.dismissed;
  // Raycast restarts this command when the new build loads, so a result that was already on
  // screen a moment ago is shown again rather than replaced by "You're up to date".
  return !run.seen || now - (run.finishedAt ?? 0) < 2 * 60 * 1000;
}

export type StartOptions = {
  folder: string;
  mode: RunMode;
  tools: Tools;
  branch: string;
  from: string;
  commits: Commit[];
  forceInstall?: boolean;
  repoUrl?: string;
  buildTimeoutMs?: number;
  settleMs?: number;
  nodePath?: string;
};

/** Starts the runner as its own background process and returns the run it reports on. */
export function startRun(dir: string, opts: StartOptions): Run {
  const { tools } = opts;
  if (!tools.git) throw new UpdateError("Git isn't installed. Run `xcode-select --install` in Terminal, then try again.");
  if (!tools.npm) throw new UpdateError("npm wasn't found. Install Node.js (for example `brew install node`), then try again.");
  mkdirSync(dir, { recursive: true });
  const files = runFiles(dir);
  writeFileSync(files.runner, RUNNER_SOURCE);
  writeFileSync(files.log, "");

  const run: Run = {
    id: `${Date.now()}`,
    mode: opts.mode,
    branch: opts.branch,
    from: opts.from,
    commits: opts.commits,
    steps: [
      { key: "download", status: "pending" },
      { key: "install", status: "pending" },
      { key: "build", status: "pending" },
    ],
    state: "running",
    startedAt: Date.now(),
    logFile: files.log,
    config: {
      folder: opts.folder,
      mode: opts.mode,
      git: tools.git,
      npm: tools.npm,
      path: tools.path,
      repoUrl: opts.repoUrl ?? REPO_URL,
      forceInstall: !!opts.forceInstall,
      buildTimeoutMs: opts.buildTimeoutMs ?? BUILD_TIMEOUT_MS,
      settleMs: opts.settleMs ?? SETTLE_MS,
      maxRunMs: MAX_RUN_MS,
    },
  };
  saveRun(dir, run);

  const node = opts.nodePath ?? tools.node ?? process.execPath;
  const child = spawn(node, [files.runner, files.state], {
    cwd: opts.folder,
    env: { ...process.env, PATH: tools.path },
    detached: true, // its own process, so it outlives this command being restarted or closed
    stdio: "ignore",
  });
  child.on("error", (err) => {
    const failed: Run = { ...run, state: "failed", error: "Couldn't start the updater.", details: err.message, finishedAt: Date.now() };
    try {
      saveRun(dir, failed);
      appendFileSync(files.log, `Couldn't start ${node}: ${err.message}\n`);
    } catch {
      /* ignore */
    }
  });
  child.unref();
  return run;
}
