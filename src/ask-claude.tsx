import {
  Action,
  ActionPanel,
  Alert,
  Icon,
  LaunchProps,
  List,
  LocalStorage,
  Toast,
  confirmAlert,
  environment,
  getPreferenceValues,
  openExtensionPreferences,
  showToast,
} from "@raycast/api";
import { useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

type Prefs = { apiKey: string; webSearch?: boolean; maxSearches?: string; searchCountry?: string; webFetch?: boolean };
type Source = { url: string; title?: string };
type Msg = {
  role: "user" | "assistant";
  content: string;
  error?: boolean;
  searches?: string[]; // web search queries Claude ran for this answer
  fetches?: string[]; // pages Claude opened and read for this answer
  activity?: "search" | "fetch"; // what Claude is doing right now, if anything
  sources?: Source[]; // pages Claude cited or read
};
type Chat = { id: string; title: string; messages: Msg[]; updatedAt: number };
type ModelInfo = { id: string; name: string };

const FALLBACK_MODEL = "claude-haiku-5-5"; // only used until the live model list loads
const MAX_TOKENS = 2048;
const MODELS_TTL_MS = 24 * 60 * 60 * 1000; // refresh the model list once a day
const STORE = { chats: "chats", model: "model", models: "models" };

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const newId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const emptyChat = (): Chat => ({ id: newId(), title: "New chat", messages: [], updatedAt: Date.now() });

function parse<T>(raw: string | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function titleFrom(question: string): string {
  const oneLine = question.replace(/\s+/g, " ").trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 57)}…` : oneLine;
}

function fallbackModelName(id: string): string {
  const [family, ...ver] = id.replace(/^claude-/, "").split("-");
  return `Claude ${family.charAt(0).toUpperCase()}${family.slice(1)} ${ver.join(".")}`.trim();
}

function modelName(id: string, models: ModelInfo[]): string {
  return models.find((m) => m.id === id)?.name ?? fallbackModelName(id);
}

/** Successful question/answer pairs only, so failed or stopped turns never confuse the API. */
export function toApiMessages(messages: Msg[]): { role: "user" | "assistant"; content: string }[] {
  const out: { role: "user" | "assistant"; content: string }[] = [];
  for (let i = 0; i + 1 < messages.length; i += 2) {
    const q = messages[i];
    const a = messages[i + 1];
    if (q.role === "user" && a.role === "assistant" && !a.error && a.content.trim()) {
      out.push({ role: "user", content: q.content }, { role: "assistant", content: a.content });
    }
  }
  return out;
}

/**
 * Your message as gray inline-code chips (one per line). The backtick fence is made longer
 * than any backtick run inside the text, so messages containing ` can't break out of the chip.
 */
export function chip(text: string): string {
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const longest = Math.max(0, ...(line.match(/`+/g) ?? []).map((run) => run.length));
      const fence = "`".repeat(longest + 1);
      return `${fence} ${line.trim()} ${fence}`;
    })
    .join("  \n");
}

/** Characters of recent conversation to show before folding older turns away. */
const RECENT_CHARS = 700;

/**
 * Which turn the pane starts from so the latest answer stays in view: walk back from the
 * newest question/answer pair until about RECENT_CHARS are shown (always at least one pair).
 */
export function firstVisibleIndex(messages: Msg[]): number {
  let start = Math.max(0, messages.length - 2);
  let total = messages.slice(start).reduce((n, m) => n + m.content.length, 0);
  while (start >= 2) {
    const pair = messages[start - 2].content.length + messages[start - 1].content.length;
    if (total + pair > RECENT_CHARS) break;
    total += pair;
    start -= 2;
  }
  return start;
}

/** The conversation as one markdown document: your messages as chips, Claude's as plain text. */
export function transcript(chat: Chat, currentModel: string, markUrl?: string, showAll = false): string {
  if (chat.messages.length === 0) {
    return [
      markUrl ? `![](${markUrl}?raycast-width=64&raycast-height=64)` : "",
      "",
      "# How can I help?",
      "",
      "Ask anything in the bar above and press `Enter`.",
      "",
      "`⌘P` Switch model  ·  `⌘N` New chat  ·  `⌘1–9` Jump to chat",
      "",
      `_${currentModel}_`,
    ].join("\n");
  }
  const start = showAll ? 0 : firstVisibleIndex(chat.messages);
  const hiddenTurns = start / 2;
  const header = hiddenTurns
    ? [`_↑ ${hiddenTurns} earlier ${hiddenTurns === 1 ? "message" : "messages"} · ⌘E to show all_`]
    : [];
  const body = chat.messages.slice(start).map((m) => {
    if (m.role === "user") return chip(m.content);
    if (m.error) return `⚠️ _${m.content}_`;
    return [activityLine(m), m.content || (m.activity ? "" : "_Thinking…_"), sourcesLine(m)]
      .filter(Boolean)
      .join("\n\n");
  });
  return [...header, ...body].join("\n\n");
}

const cleanQuery = (q: string) => q.replace(/[_*`[\]]/g, "").slice(0, 80);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** One compact italic line about web activity, shown above an answer that used the web. */
export function activityLine(m: Msg): string {
  const searches = m.searches ?? [];
  const fetches = m.fetches ?? [];
  if (m.activity === "search") {
    return searches.length ? `_Searching “${cleanQuery(searches[searches.length - 1])}”…_` : "_Searching the web…_";
  }
  if (m.activity === "fetch") {
    return fetches.length ? `_Reading ${domainOf(fetches[fetches.length - 1])}…_` : "_Reading the page…_";
  }
  const parts: string[] = [];
  if (searches.length) parts.push(`Searched the web · ${plural(searches.length, "search", "searches")}`);
  if (fetches.length) parts.push(`${parts.length ? "read" : "Read"} ${plural(fetches.length, "page", "pages")}`);
  return parts.length ? `_${parts.join(" · ")}_` : "";
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** One line of source links under the answer. */
export function sourcesLine(m: Msg): string {
  if (!m.sources?.length) return "";
  const links = m.sources.filter((s) => /^https?:\/\//.test(s.url)).map((s) => `[${domainOf(s.url)}](${s.url})`);
  return links.length ? `**Sources** · ${links.join(" · ")}` : "";
}

export function plainTranscript(chat: Chat): string {
  return toApiMessages(chat.messages)
    .map((m) => `${m.role === "user" ? "You" : "Claude"}: ${m.content}`)
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/**
 * The key lives only in Raycast's password preference (stored securely by Raycast,
 * never in this extension's files) and is only ever sent to api.anthropic.com.
 */
function resolveApiKey(prefs: Prefs): string {
  return (prefs.apiKey ?? "").trim();
}

const headers = (apiKey: string) => ({
  "x-api-key": apiKey,
  "anthropic-version": "2023-06-01",
  "content-type": "application/json",
});

/** Hides anything that looks like an Anthropic key, in case an error ever echoes one. */
export function redact(text: string): string {
  return text.replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-•••");
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function apiError(res: Response): Promise<ApiError> {
  let msg = await res.text();
  try {
    msg = JSON.parse(msg).error.message;
  } catch {
    /* keep raw text */
  }
  msg = redact(msg).slice(0, 300);
  if (res.status === 401) msg = "Invalid API key. Update it in the extension preferences.";
  return new ApiError(res.status, `${res.status}: ${msg}`);
}

async function showKeyProblem(title: string) {
  await showToast({
    style: Toast.Style.Failure,
    title,
    message: "Open the extension preferences to add your Anthropic API key",
    primaryAction: { title: "Open Preferences", onAction: () => openExtensionPreferences() },
  });
}

/** Every model this API key can use, newest first, with Anthropic's display names. */
export async function fetchModels(apiKey: string): Promise<ModelInfo[]> {
  const res = await fetch("https://api.anthropic.com/v1/models?limit=1000", { headers: headers(apiKey) });
  if (!res.ok) throw await apiError(res);
  const json = (await res.json()) as { data?: { id: string; display_name?: string }[] };
  return (json.data ?? []).map((m) => ({ id: m.id, name: m.display_name || fallbackModelName(m.id) }));
}

function systemPrompt(webSearch: boolean): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = new Date().toLocaleString("en-US", { dateStyle: "full", timeStyle: "short", timeZone: tz });
  return [
    "You answer questions typed into a Mac launcher.",
    "Be brief: one to three sentences, or a short list only when it truly helps.",
    "No preamble, no restating the question, no offers of further help.",
    `The user's local time is ${now} (${tz}).`,
    "A time or date given without a timezone is in the user's local time.",
    webSearch
      ? "If you have web tools, use them only when the answer depends on current or recent information (prices, " +
        "news, scores, today's events), on a link the user shared, or on facts you are unsure of; answer stable " +
        "knowledge and conversions directly. When the user shares a URL, read the page before answering about it."
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** Settings for Anthropic's server-side web search tool, or undefined when it's switched off. */
export function webSearchTool(prefs: Prefs) {
  if (prefs.webSearch === false) return undefined;
  const parsed = parseInt(prefs.maxSearches ?? "", 10);
  const maxUses = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 100) : 50;
  const country = (prefs.searchCountry ?? "IN").trim().toUpperCase();
  const rawZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const timezone = rawZone === "Asia/Calcutta" ? "Asia/Kolkata" : rawZone; // macOS still reports the old name
  return {
    type: "web_search_20250305",
    name: "web_search",
    max_uses: maxUses,
    user_location: { type: "approximate", timezone, ...(/^[A-Z]{2}$/.test(country) ? { country } : {}) },
  };
}

/** Anthropic's server-side page reader. Only opens URLs from the user's messages or search results. */
export function webFetchTool(prefs: Prefs) {
  if (prefs.webFetch === false) return undefined;
  return { type: "web_fetch_20250910", name: "web_fetch", max_uses: 10, max_content_tokens: 30000 };
}

export function buildTools(prefs: Prefs): Block[] | undefined {
  const tools = [webSearchTool(prefs), webFetchTool(prefs)].filter(Boolean) as Block[];
  return tools.length ? tools : undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Block = Record<string, any>;
type ApiMessage = { role: "user" | "assistant"; content: string | Block[] };

export type StreamHandlers = {
  onText: (chunk: string) => void;
  onToolStart?: (kind: "search" | "fetch") => void; // a search or page read began
  onSearch?: (query: string) => void;
  onFetch?: (url: string) => void;
  onToolDone?: () => void;
  onFetched?: (source: Source) => void; // a page was read successfully
  onCitation?: (source: Source) => void;
};

/**
 * Streams one Messages API call. Reports text, web searches and citations as they arrive,
 * and returns the raw content blocks plus the stop reason (so a paused search can be resumed).
 */
export async function streamClaude(
  apiKey: string,
  body: Block,
  on: StreamHandlers,
  signal: AbortSignal,
): Promise<{ stopReason: string | null; content: Block[] }> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: headers(apiKey),
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  });
  if (!res.ok || !res.body) throw await apiError(res);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const blocks: Block[] = [];
  const partialJson: Record<number, string> = {};
  let stopReason: string | null = null;
  let buffer = "";

  const handle = (event: Block) => {
    const i: number = event.index;
    switch (event.type) {
      case "content_block_start": {
        const block = structuredClone(event.content_block ?? {});
        blocks[i] = block;
        if (block.type === "server_tool_use") {
          partialJson[i] = "";
          on.onToolStart?.(block.name === "web_fetch" ? "fetch" : "search");
        } else if (block.type === "web_search_tool_result") {
          on.onToolDone?.();
        } else if (block.type === "web_fetch_tool_result") {
          const page = block.content;
          if (page?.type === "web_fetch_result" && typeof page.url === "string") {
            on.onFetched?.({ url: page.url, title: page.content?.title });
          }
          on.onToolDone?.();
        } else if (block.type === "text" && block.text) {
          on.onText(block.text);
        }
        break;
      }
      case "content_block_delta": {
        const d = event.delta ?? {};
        const block = blocks[i] ?? (blocks[i] = { type: "text", text: "" });
        if (d.type === "text_delta" && d.text) {
          block.text = (block.text ?? "") + d.text;
          on.onText(d.text);
        } else if (d.type === "input_json_delta") {
          partialJson[i] = (partialJson[i] ?? "") + (d.partial_json ?? "");
        } else if (d.type === "citations_delta" && d.citation) {
          (block.citations ??= []).push(d.citation);
          if (d.citation.url) on.onCitation?.({ url: d.citation.url, title: d.citation.title });
        }
        break;
      }
      case "content_block_stop": {
        const block = blocks[i];
        if (block?.type === "server_tool_use") {
          try {
            block.input = JSON.parse(partialJson[i] || "{}");
          } catch {
            block.input = {};
          }
          if (block.name === "web_fetch") {
            if (typeof block.input.url === "string") on.onFetch?.(block.input.url);
          } else if (typeof block.input.query === "string") {
            on.onSearch?.(block.input.query);
          }
        }
        break;
      }
      case "message_delta":
        stopReason = event.delta?.stop_reason ?? stopReason;
        break;
      case "error":
        throw new Error(redact(event.error?.message ?? "Stream error"));
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;

      let event: Block;
      try {
        event = JSON.parse(line.slice(5).trim());
      } catch {
        continue;
      }
      handle(event);
    }
  }
  return { stopReason, content: blocks.filter(Boolean) };
}

/**
 * Runs a full answer: streams, and if a long search pauses the turn ("pause_turn"), sends the
 * partial answer back so the API can continue. Falls back to no search if the account or model
 * doesn't allow the web search tool.
 */
export async function runAnswer(
  apiKey: string,
  model: string,
  messages: ApiMessage[],
  initialTools: Block[] | undefined,
  on: StreamHandlers,
  signal: AbortSignal,
): Promise<void> {
  let convo = [...messages];
  let tools = initialTools;
  for (let round = 0; round < 6; round++) {
    const body = {
      model,
      max_tokens: MAX_TOKENS,
      system: systemPrompt(Boolean(tools)),
      messages: convo,
      ...(tools ? { tools } : {}),
    };
    let result: { stopReason: string | null; content: Block[] };
    try {
      result = await streamClaude(apiKey, body, on, signal);
    } catch (err) {
      if (tools && round === 0 && err instanceof ApiError && err.status === 400 && /web.?(search|fetch)|tool/i.test(err.message)) {
        tools = undefined; // web tools not available for this account/model: answer without them
        continue;
      }
      throw err;
    }
    if (result.stopReason !== "pause_turn") return;
    convo = [...convo, { role: "assistant", content: result.content }];
  }
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export default function Command(props: LaunchProps<{ arguments: { prompt?: string } }>) {
  const prefs = getPreferenceValues<Prefs>();

  const [chats, setChats] = useState<Chat[]>([]);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [input, setInput] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null); // chat showing its full history
  const [model, setModel] = useState(FALLBACK_MODEL);
  const [models, setModels] = useState<ModelInfo[]>([]);

  // Refs mirror state so async code always sees the latest values.
  const chatsRef = useRef<Chat[]>([]);
  const selectedRef = useRef<string | undefined>(undefined);
  const modelRef = useRef(FALLBACK_MODEL);
  const busyRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  const initialText = (props.fallbackText ?? props.arguments?.prompt ?? "").trim();
  const launchedRef = useRef(false);
  const echoRef = useRef(initialText);

  // ---- state helpers ------------------------------------------------------

  function commit(update: (prev: Chat[]) => Chat[], save = false) {
    const next = update(chatsRef.current);
    chatsRef.current = next;
    setChats(next);
    if (save) {
      LocalStorage.setItem(STORE.chats, JSON.stringify(next.filter((c) => c.messages.length > 0)));
    }
  }

  function select(id: string | undefined) {
    selectedRef.current = id;
    setSelectedId(id);
  }

  function applyModel(id: string) {
    modelRef.current = id;
    setModel(id);
  }

  // ---- models -------------------------------------------------------------

  async function loadModels(force = false): Promise<ModelInfo[] | undefined> {
    const cached = parse<{ at: number; list: ModelInfo[] } | null>(
      await LocalStorage.getItem<string>(STORE.models),
      null,
    );
    if (cached && !force && Date.now() - cached.at < MODELS_TTL_MS) {
      setModels(cached.list);
      return cached.list;
    }
    const apiKey = resolveApiKey(prefs);
    if (!apiKey) return cached?.list;
    try {
      const list = await fetchModels(apiKey);
      setModels(list);
      await LocalStorage.setItem(STORE.models, JSON.stringify({ at: Date.now(), list }));
      if (force) await showToast({ style: Toast.Style.Success, title: `Found ${list.length} models` });
      return list;
    } catch (err) {
      if (cached) setModels(cached.list);
      if (force) {
        await showToast({
          style: Toast.Style.Failure,
          title: "Couldn't load models",
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return cached?.list;
    }
  }

  async function switchModel(id: string) {
    applyModel(id);
    await LocalStorage.setItem(STORE.model, id);
    await showToast({ style: Toast.Style.Success, title: `Now using ${modelName(id, models)}` });
  }

  // ---- chat actions -------------------------------------------------------

  async function ask(text: string, targetId?: string) {
    const question = text.trim();
    if (!question) return;
    if (busyRef.current) {
      await showToast({ style: Toast.Style.Failure, title: "Claude is still replying", message: "Press ⌘. to stop it" });
      return;
    }
    const apiKey = resolveApiKey(prefs);
    if (!apiKey) {
      await showKeyProblem("No API key");
      return;
    }

    let chat = chatsRef.current.find((c) => c.id === (targetId ?? selectedRef.current));
    if (!chat) {
      const created = emptyChat();
      commit((prev) => [created, ...prev]);
      chat = created;
    }
    const chatId = chat.id;
    const history = toApiMessages(chat.messages);
    const isFirst = chat.messages.length === 0;

    commit((prev) =>
      prev.map((c) =>
        c.id === chatId
          ? {
              ...c,
              title: isFirst ? titleFrom(question) : c.title,
              messages: [...c.messages, { role: "user", content: question }, { role: "assistant", content: "" }],
              updatedAt: Date.now(),
            }
          : c,
      ),
    );
    select(chatId);
    setInput("");
    busyRef.current = true;
    setStreamingId(chatId);
    setExpandedId(null); // a new message jumps back to the latest turns

    const controller = new AbortController();
    abortRef.current = controller;

    const patchLast = (fn: (m: Msg) => Msg) =>
      commit((prev) =>
        prev.map((c) => {
          if (c.id !== chatId) return c;
          const msgs = [...c.messages];
          msgs[msgs.length - 1] = fn(msgs[msgs.length - 1]);
          return { ...c, messages: msgs };
        }),
      );

    // Pages Claude read or cited, once each, at most six, http(s) only.
    const addSource = (source: Source) =>
      patchLast((m) =>
        !/^https?:\/\//.test(source.url) ||
        m.sources?.some((s) => s.url === source.url) ||
        (m.sources?.length ?? 0) >= 6
          ? m
          : { ...m, sources: [...(m.sources ?? []), source] },
      );

    try {
      await runAnswer(
        apiKey,
        modelRef.current,
        [...history, { role: "user", content: question }],
        buildTools(prefs),
        {
          onText: (chunk) => patchLast((m) => ({ ...m, activity: undefined, content: m.content + chunk })),
          onToolStart: (kind) => patchLast((m) => ({ ...m, activity: kind })),
          onSearch: (query) => patchLast((m) => ({ ...m, searches: [...(m.searches ?? []), query] })),
          onFetch: (url) => patchLast((m) => ({ ...m, fetches: [...(m.fetches ?? []), url] })),
          onToolDone: () => patchLast((m) => ({ ...m, activity: undefined })),
          onFetched: addSource,
          onCitation: addSource,
        },
        controller.signal,
      );
      patchLast((m) => ({ ...m, activity: undefined }));
    } catch (err) {
      patchLast((m) => ({ ...m, activity: undefined }));
      if (controller.signal.aborted) {
        patchLast((m) => (m.content ? m : { ...m, content: "Stopped before Claude replied.", error: true }));
      } else {
        const msg = redact(err instanceof Error ? err.message : String(err));
        patchLast((m) => ({ ...m, content: `Couldn't get a response (${msg})`, error: true }));
        if (err instanceof ApiError && err.status === 401) showKeyProblem("Invalid API key");
      }
    } finally {
      busyRef.current = false;
      abortRef.current = null;
      setStreamingId(null);
      commit((prev) => prev, true);
    }
  }

  function newChat() {
    const blank = chatsRef.current.find((c) => c.messages.length === 0);
    if (blank) {
      commit((prev) => prev.map((c) => (c.id === blank.id ? { ...c, updatedAt: Date.now() } : c)));
      select(blank.id);
    } else {
      const created = emptyChat();
      commit((prev) => [created, ...prev]);
      select(created.id);
    }
    setInput("");
  }

  function deleteChat(id: string) {
    if (streamingId === id) abortRef.current?.abort();
    commit((prev) => prev.filter((c) => c.id !== id), true);
    const remaining = [...chatsRef.current].sort((a, b) => b.updatedAt - a.updatedAt);
    if (remaining.length) select(remaining[0].id);
    else newChat();
  }

  async function deleteAll() {
    const ok = await confirmAlert({
      title: "Delete all chats?",
      message: "This can't be undone.",
      primaryAction: { title: "Delete All", style: Alert.ActionStyle.Destructive },
    });
    if (!ok) return;
    abortRef.current?.abort();
    const created = emptyChat();
    commit(() => [created], true);
    select(created.id);
  }

  // ---- launch -------------------------------------------------------------

  useEffect(() => {
    if (launchedRef.current) return; // guards against a double mount in dev mode
    launchedRef.current = true;

    (async () => {
      const [rawChats, savedModel] = await Promise.all([
        LocalStorage.getItem<string>(STORE.chats),
        LocalStorage.getItem<string>(STORE.model),
      ]);
      const saved = parse<Chat[]>(rawChats, []).filter((c) => c.messages?.length);
      const fresh = emptyChat();
      commit(() => [fresh, ...saved]);
      select(fresh.id);
      if (savedModel) applyModel(savedModel);
      setLoaded(true);

      if (initialText) ask(initialText);

      const list = await loadModels();
      if (!savedModel && list?.length) {
        applyModel((list.find((m) => m.id.includes("haiku")) ?? list[0]).id); // newest Haiku by default
      }
    })();
  }, []);

  function onSearchTextChange(text: string) {
    // Raycast may copy the root-search text into this bar on launch; that text was already sent.
    if (echoRef.current && text === echoRef.current) {
      echoRef.current = "";
      setInput(" ");
      setTimeout(() => setInput(""), 0);
      return;
    }
    echoRef.current = "";
    setInput(text);
  }

  // ---- render -------------------------------------------------------------

  const currentModel = modelName(model, models);
  const markUrl = `file://${encodeURI(`${environment.assetsPath}/thread-icon.png`)}`;
  const sorted = [...chats].sort((a, b) => b.updatedAt - a.updatedAt);
  const selected = chats.find((c) => c.id === selectedId);
  const placeholder = selected && selected.messages.length > 0 ? "Reply to Claude…" : "Ask Claude anything…";

  const actionsFor = (chat: Chat) => {
    const lastAnswer = [...chat.messages].reverse().find((m) => m.role === "assistant" && !m.error && m.content);
    const hasMessages = chat.messages.length > 0;
    const isOpen = chat.id === selectedId;

    const copyLastAnswer = lastAnswer ? (
      <Action.CopyToClipboard
        title="Copy Last Answer"
        content={lastAnswer.content}
        shortcut={{ modifiers: ["cmd"], key: "return" }}
      />
    ) : null;

    const modelMenu = (
      <ActionPanel.Submenu title="Change Model" icon={Icon.Stars} shortcut={{ modifiers: ["cmd"], key: "p" }}>
        {models.length > 0 ? (
          models.map((m) => (
            <Action
              key={m.id}
              title={m.name}
              icon={m.id === model ? Icon.CheckCircle : Icon.Circle}
              onAction={() => switchModel(m.id)}
            />
          ))
        ) : (
          <Action title="Load Models" icon={Icon.ArrowClockwise} onAction={() => loadModels(true)} />
        )}
      </ActionPanel.Submenu>
    );

    // The first action is what Enter runs. Raycast's ⌘1–9 first selects (opens) a chat and then
    // runs that same action, so it must never copy or close: on the open chat it is Send, which
    // does nothing while the bar is empty. On any other chat it just opens it.
    const primary: "send" | "open" = input.trim() || isOpen ? "send" : "open";

    return (
      <ActionPanel>
        <ActionPanel.Section>
          {primary === "send" ? (
            <Action
              title={hasMessages ? "Send Reply" : "Send"}
              icon={Icon.ArrowRight}
              onAction={() => ask(input, chat.id)}
            />
          ) : (
            <Action title="Open Chat" icon={Icon.Message} onAction={() => select(chat.id)} />
          )}
          {copyLastAnswer}
          {streamingId && (
            <Action
              title="Stop Response"
              icon={Icon.Stop}
              shortcut={{ modifiers: ["cmd"], key: "." }}
              onAction={() => abortRef.current?.abort()}
            />
          )}
          <Action title="New Chat" icon={Icon.Plus} shortcut={{ modifiers: ["cmd"], key: "n" }} onAction={newChat} />
        </ActionPanel.Section>

        <ActionPanel.Section title={`Model · ${currentModel}`}>
          {modelMenu}
          <Action title="Refresh Model List" icon={Icon.ArrowClockwise} onAction={() => loadModels(true)} />
        </ActionPanel.Section>

        <ActionPanel.Section>
          {(expandedId === chat.id || firstVisibleIndex(chat.messages) > 0) && (
            <Action
              title={expandedId === chat.id ? "Show Latest Only" : "Show Full Conversation"}
              icon={expandedId === chat.id ? Icon.ArrowDown : Icon.ArrowUp}
              shortcut={{ modifiers: ["cmd"], key: "e" }}
              onAction={() => setExpandedId(expandedId === chat.id ? null : chat.id)}
            />
          )}
          {hasMessages && (
            <Action.CopyToClipboard
              title="Copy Conversation"
              content={plainTranscript(chat)}
              shortcut={{ modifiers: ["cmd", "opt"], key: "c" }}
            />
          )}
          {hasMessages && (
            <Action
              title="Delete Chat"
              icon={Icon.Trash}
              style={Action.Style.Destructive}
              shortcut={{ modifiers: ["ctrl"], key: "x" }}
              onAction={() => deleteChat(chat.id)}
            />
          )}
          <Action
            title="Delete All Chats"
            icon={Icon.Trash}
            style={Action.Style.Destructive}
            shortcut={{ modifiers: ["ctrl", "shift"], key: "x" }}
            onAction={deleteAll}
          />
        </ActionPanel.Section>
      </ActionPanel>
    );
  };

  return (
    <List
      isLoading={!loaded || streamingId !== null}
      filtering={false}
      searchText={input}
      onSearchTextChange={onSearchTextChange}
      searchBarPlaceholder={placeholder}
      isShowingDetail
      selectedItemId={selectedId}
      onSelectionChange={(id: string | null) => select(id ?? undefined)}
      navigationTitle={`Ask Claude · ${currentModel}`}
    >
      {sorted.map((chat) => (
        <List.Item
          key={chat.id}
          id={chat.id}
          title={chat.title}
          icon={
            chat.id === streamingId
              ? chat.messages[chat.messages.length - 1]?.activity === "search"
                ? Icon.MagnifyingGlass
                : chat.messages[chat.messages.length - 1]?.activity === "fetch"
                  ? Icon.Globe
                  : Icon.CircleProgress
              : chat.messages.length
                ? Icon.Message
                : Icon.Plus
          }
          detail={<List.Item.Detail markdown={transcript(chat, currentModel, markUrl, expandedId === chat.id)} />}
          actions={actionsFor(chat)}
        />
      ))}
    </List>
  );
}
