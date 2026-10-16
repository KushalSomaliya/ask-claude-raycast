import {
  Action,
  ActionPanel,
  Alert,
  Detail,
  Icon,
  LaunchType,
  Toast,
  confirmAlert,
  environment,
  getPreferenceValues,
  launchCommand,
  openExtensionPreferences,
  showToast,
} from "@raycast/api";
import { existsSync } from "fs";
import { join } from "path";
import { useEffect, useRef, useState } from "react";
import {
  Commit,
  DEFAULT_FOLDER,
  Run,
  RunMode,
  RunStep,
  Status,
  Tools,
  UpdateError,
  checkForUpdates,
  expandHome,
  findTools,
  isRepo,
  readLog,
  readRun,
  saveRun,
  settleInterrupted,
  shouldShowRun,
  startRun,
} from "./updater";

type Prefs = { sourceFolder?: string };

/** What the check found, shown when no update is running or just finished. */
type Phase =
  | { kind: "checking" }
  | { kind: "missing-folder" }
  | { kind: "not-linked" }
  | { kind: "up-to-date"; status: Status }
  | { kind: "available"; status: Status }
  | { kind: "error"; message: string; details: string };

const supportDir = environment.supportPath;

const fence = (text: string) => {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  const f = "`".repeat(longest + 1);
  return `${f}\n${text}\n${f}`;
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function timeAgo(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${plural(m, "minute")} ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${plural(h, "hour")} ago`;
  return `${plural(Math.round(h / 24), "day")} ago`;
}

const STEP_TEXT: Record<RunStep["key"], { todo: string; doing: string }> = {
  download: { todo: "Download the update", doing: "Downloading the update…" },
  install: { todo: "Install dependencies if needed", doing: "Installing dependencies…" },
  build: { todo: "Rebuild the extension", doing: "Rebuilding the extension…" },
};

function stepLine(step: RunStep, run: Run): string {
  const text =
    step.key === "download" && run.mode === "connect"
      ? { todo: "Connect to GitHub", doing: "Connecting to GitHub…" }
      : STEP_TEXT[step.key];
  switch (step.status) {
    case "done":
    case "skipped":
      return `✓  ${step.note ?? text.todo}`;
    case "running":
      return `**→  ${step.key === "build" && run.built ? "Finishing up…" : text.doing}**`;
    case "failed":
      return `✗  ${text.todo}`;
    default:
      return `○  ${text.todo}`;
  }
}

/** Reads the last run when the command opens, so an update in progress (or just finished) is shown. */
function loadRun(): Run | null {
  const saved = readRun(supportDir);
  if (!saved) return null;
  const run = settleInterrupted(saved);
  if (run !== saved) saveRun(supportDir, run);
  return shouldShowRun(run) ? run : null;
}

export default function Command() {
  const prefs = getPreferenceValues<Prefs>();
  const folder = expandHome(prefs.sourceFolder?.trim() || DEFAULT_FOLDER);

  const [run, setRun] = useState<Run | null>(loadRun);
  const [logLines, setLogLines] = useState<string[]>(() => (run ? readLog(run.logFile, 40) : []));
  const [showLog, setShowLog] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "checking" });
  const [tools, setTools] = useState<Tools | null>(null);
  const toolsRef = useRef<Tools | null>(null);
  const startedRef = useRef(false);
  const lastUpdateRef = useRef<number | undefined>(run?.updatedAt);

  async function getTools(): Promise<Tools> {
    if (toolsRef.current) return toolsRef.current;
    const found = await findTools();
    toolsRef.current = found;
    setTools(found);
    return found;
  }

  async function check() {
    setPhase({ kind: "checking" });
    try {
      const t = await getTools();
      if (!existsSync(join(folder, "package.json"))) return setPhase({ kind: "missing-folder" });
      if (!isRepo(folder)) return setPhase({ kind: "not-linked" });
      const status = await checkForUpdates(folder, t);
      setPhase({ kind: status.commits.length ? "available" : "up-to-date", status });
    } catch (err) {
      setPhase({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
        details: err instanceof UpdateError ? err.details : "",
      });
    }
  }

  async function start(mode: RunMode, info: { branch: string; from: string; commits: Commit[] }, forceInstall = false) {
    try {
      const t = await getTools();
      const started = startRun(supportDir, { folder, mode, tools: t, forceInstall, ...info });
      lastUpdateRef.current = started.updatedAt;
      setLogLines([]);
      setShowLog(false);
      setRun(started);
    } catch (err) {
      await showToast({ style: Toast.Style.Failure, title: "Couldn't start the update", message: err instanceof Error ? err.message : String(err) });
    }
  }

  async function confirmConnect() {
    const ok = await confirmAlert({
      title: "Connect this folder to GitHub?",
      message:
        "The extension's code in this folder will be replaced with the latest version from GitHub, then rebuilt. " +
        "Your chats and API key are stored in Raycast and aren't affected.",
      primaryAction: { title: "Connect and Update", style: Alert.ActionStyle.Default },
    });
    if (ok) start("connect", { branch: "main", from: "", commits: [] }, true);
  }

  /** Leaves a finished or failed run's screen and checks GitHub again. */
  function checkAgain() {
    if (run && run.state !== "running") {
      saveRun(supportDir, { ...run, seen: true, dismissed: true });
      setRun(null);
    }
    check();
  }

  async function openAskClaude() {
    try {
      await launchCommand({ name: "ask-claude", type: LaunchType.UserInitiated });
    } catch (err) {
      await showToast({ style: Toast.Style.Failure, title: "Couldn't open Ask Claude", message: err instanceof Error ? err.message : String(err) });
    }
  }

  // First open: check for updates unless an update is running or just finished.
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    getTools();
    if (!run) check();
  }, []);

  // While an update runs, follow its progress.
  const runningId = run?.state === "running" ? run.id : undefined;
  useEffect(() => {
    if (!runningId) return;
    const timer = setInterval(() => {
      const saved = readRun(supportDir);
      if (!saved || saved.id !== runningId) return;
      const latest = settleInterrupted(saved);
      if (latest !== saved) saveRun(supportDir, latest);
      setLogLines(readLog(latest.logFile, 40));
      if (latest.updatedAt === lastUpdateRef.current && latest === saved) return;
      lastUpdateRef.current = latest.updatedAt;
      setRun(latest);
    }, 400);
    return () => clearInterval(timer);
  }, [runningId]);

  // Remember that a result was shown, so it isn't shown again next time.
  useEffect(() => {
    if (run && run.state !== "running" && !run.seen) saveRun(supportDir, { ...run, seen: true });
  }, [run?.id, run?.state]);

  // ---- content ------------------------------------------------------------

  const fullLog = logLines.length ? `\n\n${fence(logLines.join("\n"))}` : "";
  let markdown = "";
  let title = "Update Ask Claude";

  if (run) {
    const steps = run.steps.map((s) => stepLine(s, run)).join("  \n");
    const whatsNew = run.commits.length ? `\n\n**What's new**\n\n${run.commits.map((c) => `- ${c.subject || c.hash}`).join("\n")}` : "";
    if (run.state === "running") {
      const recent = logLines.length ? `\n\n${fence(logLines.slice(-8).join("\n"))}` : "";
      markdown = `## Updating Ask Claude…\n\n${steps}\n\nYou can close this window. The update keeps going in the background.${showLog ? fullLog : recent}`;
    } else if (run.state === "done") {
      title = "Ask Claude Updated";
      const version =
        run.mode === "connect"
          ? `This copy is now connected to GitHub and on version \`${run.to ?? "?"}\`. From now on, Update Ask Claude can install new versions for you.`
          : `Now on version \`${run.to ?? "?"}\`${run.from ? ` (was \`${run.from}\`)` : ""}.`;
      markdown = `## ✓ Ask Claude is updated\n\n${version}${whatsNew}\n\nPress **Enter** to open Ask Claude.${showLog ? fullLog : ""}`;
    } else {
      const details = run.details ? `\n\n${fence(run.details)}` : "";
      markdown =
        `## Update didn't finish\n\n${run.error ?? "Something went wrong."}${details}\n\n${steps}\n\n` +
        `Press **Enter** to try again. If it keeps failing, press **⌘⇧C** to copy the details.` +
        (logLines.length ? `\n\n**Log**${fullLog}` : "");
    }
  } else {
    switch (phase.kind) {
      case "checking":
        markdown = "## Checking for updates…";
        break;
      case "missing-folder":
        markdown = `## Extension folder not found\n\nThere's no extension at \`${folder}\`.\n\nSet the right folder in the command's preferences (⌘K → Open Extension Preferences).`;
        break;
      case "not-linked":
        markdown =
          "## This copy isn't connected to GitHub yet\n\nIt was probably installed from a zip. Connect it once and you'll be able to update from here from then on.\n\nPress **Enter** to connect and update.";
        break;
      case "up-to-date": {
        const last = readRun(supportDir);
        const lastLine =
          last?.state === "done" && last.finishedAt ? `\n\nLast updated ${timeAgo(last.finishedAt)}${last.from ? ` (from \`${last.from}\`)` : ""}.` : "";
        markdown = `## You're up to date\n\nVersion \`${phase.status.head}\` on \`${phase.status.branch}\`.${lastLine}`;
        break;
      }
      case "available": {
        const n = phase.status.commits.length;
        const list = phase.status.commits.map((c) => `- ${c.subject || c.hash}`).join("\n");
        const dirty = phase.status.dirty.length
          ? `\n\n**Heads up:** files in this folder were changed by hand (${phase.status.dirty.slice(0, 5).join(", ")}${phase.status.dirty.length > 5 ? "…" : ""}). The update may stop to avoid overwriting them.`
          : "";
        markdown = `## ${plural(n, "update")} available\n\n${list}${dirty}\n\nPress **Enter** to install. It takes about 10 seconds.`;
        break;
      }
      case "error":
        markdown = `## Couldn't check for updates\n\n${phase.message}${phase.details ? `\n\n${fence(phase.details)}` : ""}`;
        break;
    }
  }

  const status = !run && "status" in phase ? phase.status : null;
  const branch = run?.branch ?? status?.branch;
  const diagnostics = [
    `Folder: ${folder}`,
    `git: ${tools?.git ?? "not found"}`,
    `node: ${tools?.node ?? "not found"}`,
    `npm: ${tools?.npm ?? "not found"}`,
    `PATH: ${tools?.path ?? "(not resolved yet)"}`,
    ...(status ? [`Branch: ${status.branch}`, `Local: ${status.head}`, `GitHub: ${status.remote}`] : []),
    ...(run
      ? [
          "",
          `Update: ${run.state} (${run.mode}) started ${new Date(run.startedAt).toString()}`,
          `Branch: ${run.branch}`,
          `From: ${run.from || "-"}  To: ${run.to ?? "-"}`,
          ...run.steps.map((s) => `  ${s.key}: ${s.status}${s.note ? ` (${s.note})` : ""}`),
          ...(run.error ? [`Error: ${run.error}`, run.details ?? ""] : []),
          "",
          "Log:",
          ...readLog(run.logFile, 80),
        ]
      : []),
  ].join("\n");

  const running = run?.state === "running";
  const logToggle = run ? (
    <Action
      title={showLog ? "Hide Log" : "Show Log"}
      icon={Icon.Terminal}
      shortcut={{ modifiers: ["cmd"], key: "l" }}
      onAction={() => setShowLog((v) => !v)}
    />
  ) : null;

  return (
    <Detail
      navigationTitle={title}
      isLoading={running || (!run && phase.kind === "checking")}
      markdown={markdown}
      metadata={
        <Detail.Metadata>
          {run?.state === "done" ? (
            <Detail.Metadata.Label title="Version" text={run.to ?? "?"} icon={Icon.CheckCircle} />
          ) : null}
          {run?.state === "done" && run.from ? <Detail.Metadata.Label title="Previous" text={run.from} /> : null}
          {run && run.state !== "done" && run.from ? <Detail.Metadata.Label title="This Mac" text={run.from} /> : null}
          {status ? <Detail.Metadata.Label title="This Mac" text={status.head} /> : null}
          {status ? <Detail.Metadata.Label title="GitHub" text={status.remote} /> : null}
          {branch ? <Detail.Metadata.Label title="Branch" text={branch} /> : null}
          <Detail.Metadata.Label title="Folder" text={folder} />
          <Detail.Metadata.Separator />
          <Detail.Metadata.Label title="git" text={tools ? (tools.git ?? "Not found") : "…"} />
          <Detail.Metadata.Label title="node" text={tools ? (tools.node ?? "Not found") : "…"} />
          <Detail.Metadata.Label title="npm" text={tools ? (tools.npm ?? "Not found") : "…"} />
        </Detail.Metadata>
      }
      actions={
        <ActionPanel>
          <ActionPanel.Section>
            {run?.state === "done" ? <Action title="Open Ask Claude" icon={Icon.SpeechBubble} onAction={openAskClaude} /> : null}
            {run?.state === "failed" ? (
              <Action
                title="Try Again"
                icon={Icon.ArrowClockwise}
                onAction={() => start(run.mode, { branch: run.branch, from: run.from, commits: run.commits }, true)}
              />
            ) : null}
            {!run && phase.kind === "available" ? (
              <Action
                title="Install Update"
                icon={Icon.Download}
                onAction={() => start("update", { branch: phase.status.branch, from: phase.status.head, commits: phase.status.commits })}
              />
            ) : null}
            {!run && phase.kind === "not-linked" ? <Action title="Connect and Update" icon={Icon.Link} onAction={confirmConnect} /> : null}
            {!run && phase.kind === "missing-folder" ? (
              <Action title="Open Extension Preferences" icon={Icon.Gear} onAction={() => openExtensionPreferences()} />
            ) : null}
            {running ? logToggle : null}
            {!running && !(phase.kind === "checking" && !run) ? (
              <Action title="Check Again" icon={Icon.ArrowClockwise} shortcut={{ modifiers: ["cmd"], key: "r" }} onAction={checkAgain} />
            ) : null}
          </ActionPanel.Section>
          <ActionPanel.Section>
            {run && !running ? logToggle : null}
            <Action.CopyToClipboard
              title="Copy Diagnostics"
              icon={Icon.Bug}
              content={diagnostics}
              shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
            />
            {existsSync(folder) ? <Action.ShowInFinder title="Show Folder in Finder" path={folder} /> : null}
            {!(phase.kind === "missing-folder" && !run) ? (
              <Action title="Open Extension Preferences" icon={Icon.Gear} onAction={() => openExtensionPreferences()} />
            ) : null}
          </ActionPanel.Section>
        </ActionPanel>
      }
    />
  );
}
