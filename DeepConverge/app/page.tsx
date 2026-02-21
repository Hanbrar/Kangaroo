"use client";

import { useState, useRef, useEffect, useCallback, type ChangeEvent, type DragEvent } from "react";
import Link from "next/link";
import Image from "next/image";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkMath from "remark-math";
import remarkGfm from "remark-gfm";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { preprocessLaTeX } from "@/lib/latex";
import DebateCanvas from "@/components/DebateCanvas";
import SettingsPanel from "@/components/SettingsPanel";
import { createClient } from "@/lib/supabase/client";
import type { User } from "@supabase/supabase-js";
import {
  createConversation,
  saveMessage as dbSaveMessage,
  loadConversations,
  loadMessages,
  deleteConversation,
  touchConversation,
  type Conversation,
} from "@/lib/supabase/conversations";
import { getProfile } from "@/lib/supabase/profile";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt?: string;
  generatedAt?: string;
  attachment?: {
    kind: "image" | "pdf";
    name: string;
    dataUrl: string;
  };
  status?: string;
  reasoning?: string;
  isStreaming?: boolean;
  isSearchingWeb?: boolean;
  convergent?: {
    status: "idle" | "running" | "converged" | "needs_input";
    score: number;
    round: number;
    maxRounds: number;
    logs: Array<{
      id: string;
      role: "judge" | "debater_a" | "debater_b" | "executor";
      round: number;
      content: string;
    }>;
    clarifyingQuestions: string[];
  };
}

type Mode = "agentic" | "debate";
type DebatePhase = "setup" | "active";
type DebateType = "regular" | "continuous";
type AgenticModel = "nemotron9b" | "nemotron30b";
type PendingAttachment = {
  kind: "image" | "pdf";
  name: string;
  mimeType: string;
  dataUrl: string;
};

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const AGENTIC_MODELS: Record<AgenticModel, { label: string; display: string }> = {
  nemotron9b: {
    label: "NVIDIA: Nemotron Nano 9B V2 (free)",
    display: "Nemotron Nano 9B V2 (free)",
  },
  nemotron30b: {
    label: "NVIDIA: Nemotron 3 Nano 30B A3B",
    display: "Nemotron 3 Nano 30B A3B",
  },
};

const BLOCKED_DEBATE_TOPIC_PATTERNS: RegExp[] = [
  /\b(suicide|self-harm|kill myself|how to die)\b/i,
  /\b(rape|sexual assault|child porn|cp|incest)\b/i,
  /\b(bomb|explosive|terror attack|mass shooting|ethnic cleansing)\b/i,
  /\b(genocide|racial superiority|hate crime)\b/i,
  /\b(how to make meth|hard drug recipe|weapon build)\b/i,
];

function validateDebateTopic(topic: string): { allowed: boolean; message?: string } {
  const trimmed = topic.trim();
  if (trimmed.length < 6) {
    return { allowed: false, message: "Please enter a clearer debate topic." };
  }
  if (trimmed.length > 240) {
    return {
      allowed: false,
      message: "Debate topics must be under 240 characters for now.",
    };
  }
  if (BLOCKED_DEBATE_TOPIC_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return {
      allowed: false,
      message:
        "This topic is blocked for safety. Please choose a neutral, constructive topic.",
    };
  }
  return { allowed: true };
}

const TYPEWRITER_PROMPTS = [
  "Can you help me solve this equation?",
  "Search the web for today's top news",
  "What are the pros and cons of solar energy?",
];

export default function Home() {
  // Core mode state
  const [mode, setMode] = useState<Mode>("agentic");
  const [debatePhase, setDebatePhase] = useState<DebatePhase>("setup");

  // Chat/agentic state
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [convergentEnabled, setConvergentEnabled] = useState(false);
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const [expandedConvergent, setExpandedConvergent] = useState<Record<string, boolean>>({});
  const [animatedConvergence, setAnimatedConvergence] = useState<Record<string, number>>({});
  const [copiedCodeKey, setCopiedCodeKey] = useState<string | null>(null);
  const [attachedFile, setAttachedFile] = useState<PendingAttachment | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [isDragActive, setIsDragActive] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const agenticPanelRef = useRef<HTMLDivElement>(null);
  const debatePanelRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeAssistantIdRef = useRef<string | null>(null);
  const manualStopRef = useRef(false);
  const [modePanelHeight, setModePanelHeight] = useState<number>(0);

  // Debate state
  const [debateQuestion, setDebateQuestion] = useState("");
  const [debateType, setDebateType] = useState<DebateType>("regular");
  const [continuousRounds, setContinuousRounds] = useState(3);
  const [debateGuardError, setDebateGuardError] = useState<string | null>(null);
  const [debateReplayMessages, setDebateReplayMessages] = useState<{ speaker: string; content: string }[] | null>(null);

  // Sidebar state
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // Auth state
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  // Conversation history state
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [isExportingPdf, setIsExportingPdf] = useState(false);

  // API key + settings state
  const [openrouterApiKey, setOpenrouterApiKey] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [profileDisplayName, setProfileDisplayName] = useState<string | null>(null);

  // Auth initialization
  useEffect(() => {
    const supabase = createClient();
    supabase.auth
      .getUser()
      .then(({ data, error }) => {
        if (error) console.warn("Auth check:", error.message);
        setUser(data.user);
        setAuthLoading(false);
      })
      .catch(() => {
        setAuthLoading(false);
      });
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });
    return () => subscription.unsubscribe();
  }, []);

  // Load conversations when user changes
  useEffect(() => {
    if (!user) {
      setConversations([]);
      return;
    }
    const supabase = createClient();
    loadConversations(supabase, user.id).then(setConversations);
    getProfile(supabase, user.id).then((profile) => {
      if (profile?.openrouter_api_key) {
        setOpenrouterApiKey(profile.openrouter_api_key);
      }
      if (profile?.display_name) {
        setProfileDisplayName(profile.display_name);
      }
    });

    // Check for pending query from landing page
    const pendingQuery = localStorage.getItem("deepconverge_pending_query");
    if (pendingQuery) {
      localStorage.removeItem("deepconverge_pending_query");
      setInput(pendingQuery);
    }
  }, [user]);

  const refreshConversations = useCallback(() => {
    if (!user) return;
    const supabase = createClient();
    loadConversations(supabase, user.id).then(setConversations);
  }, [user]);

  // Typewriter animation for landing page
  const [typewriterText, setTypewriterText] = useState("");
  const [typewriterActive, setTypewriterActive] = useState(true);
  const [landingInputFocused, setLandingInputFocused] = useState(false);
  const [landingInput, setLandingInput] = useState("");

  useEffect(() => {
    if (!typewriterActive || landingInputFocused || user) return;

    let promptIndex = 0;
    let charIndex = 0;
    let isDeleting = false;
    let timeoutId: ReturnType<typeof setTimeout>;

    const tick = () => {
      const currentPrompt = TYPEWRITER_PROMPTS[promptIndex];

      if (!isDeleting) {
        charIndex++;
        setTypewriterText(currentPrompt.slice(0, charIndex));

        if (charIndex >= currentPrompt.length) {
          // Pause at end of prompt
          timeoutId = setTimeout(() => {
            isDeleting = true;
            tick();
          }, 2000);
          return;
        }
        timeoutId = setTimeout(tick, 70);
      } else {
        charIndex--;
        setTypewriterText(currentPrompt.slice(0, charIndex));

        if (charIndex <= 0) {
          isDeleting = false;
          promptIndex = (promptIndex + 1) % TYPEWRITER_PROMPTS.length;
          timeoutId = setTimeout(tick, 400);
          return;
        }
        timeoutId = setTimeout(tick, 35);
      }
    };

    timeoutId = setTimeout(tick, 500);
    return () => clearTimeout(timeoutId);
  }, [typewriterActive, landingInputFocused, user]);

  const handleSignOut = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    setUser(null);
    setMessages([]);
    setConversations([]);
    setActiveConversationId(null);
  };

  const handleLoadConversation = async (conv: Conversation) => {
    const supabase = createClient();
    const dbMessages = await loadMessages(supabase, conv.id);

    if (conv.mode === "debate") {
      // Map debate roles back to DebateCanvas speaker format
      const roleMap: Record<string, string> = {
        debater_blue: "blue",
        debater_red: "red",
        moderator: "moderator",
      };
      const replay = dbMessages
        .filter((m) => roleMap[m.role])
        .map((m) => ({
          speaker: roleMap[m.role],
          content: m.content,
        }));
      setDebateReplayMessages(replay);
      setDebateQuestion(conv.title);
      setActiveConversationId(conv.id);
      setMessages([]);
      setMode("debate");
      setDebatePhase("active");
      return;
    }

    const loaded: Message[] = dbMessages.map((m) => ({
      id: m.id,
      role: m.role as "user" | "assistant",
      content: m.content,
      reasoning: m.reasoning || undefined,
      createdAt: m.created_at,
      generatedAt: m.role === "assistant" ? m.created_at : undefined,
    }));
    setMessages(loaded);
    setActiveConversationId(conv.id);
    setMode("agentic");
    setDebatePhase("setup");
  };

  const handleDeleteConversation = async (convId: string) => {
    const supabase = createClient();
    await deleteConversation(supabase, convId);
    if (activeConversationId === convId) {
      setMessages([]);
      setActiveConversationId(null);
    }
    refreshConversations();
  };

  const handleExportPdf = async () => {
    if (isExportingPdf) return;
    setIsExportingPdf(true);
    try {
      const response = await fetch("/api/export-pdf");
      if (!response.ok) throw new Error("Export failed");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `DeepConverge_Conversations_${new Date().toISOString().slice(0, 10)}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("PDF export error:", err);
    } finally {
      setIsExportingPdf(false);
    }
  };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    const timer = setInterval(() => {
      setAnimatedConvergence((prev) => {
        let changed = false;
        const next = { ...prev };

        for (const msg of messages) {
          if (msg.role !== "assistant" || !msg.convergent) continue;
          const target = Math.max(0, Math.min(100, msg.convergent.score));
          const current = next[msg.id] ?? target;
          const delta = target - current;

          if (Math.abs(delta) > 0.2) {
            next[msg.id] = current + delta * 0.18;
            changed = true;
          } else if (current !== target) {
            next[msg.id] = target;
            changed = true;
          }
        }

        return changed ? next : prev;
      });
    }, 32);

    return () => clearInterval(timer);
  }, [messages]);

  const getConvergencePhase = (score: number) => {
    if (score < 40) return "Diverging";
    if (score < 75) return "Balanced";
    return "Converging";
  };

  const syncModePanelHeight = () => {
    const activePanel = mode === "agentic" ? agenticPanelRef.current : debatePanelRef.current;
    if (!activePanel) return;
    setModePanelHeight(activePanel.offsetHeight);
  };

  useEffect(() => {
    syncModePanelHeight();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, debateType]);

  useEffect(() => {
    const handleResize = () => syncModePanelHeight();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, debateType]);

  // Keyboard shortcuts: Ctrl/Cmd+K for New Chat, Ctrl/Cmd+Alt+D for New Debate
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        handleNewChat();
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === "d") {
        e.preventDefault();
        handleNewDebate();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleNewChat = () => {
    setMessages([]);
    setExpandedConvergent({});
    setAnimatedConvergence({});
    setInput("");
    setDebatePhase("setup");
    setMode("agentic");
    setActiveConversationId(null);
  };

  const handleNewDebate = () => {
    setMode("debate");
    setDebatePhase("setup");
    setDebateQuestion("");
    setDebateGuardError(null);
    setInput("");
  };

  const handleModeChange = (nextMode: Mode) => {
    if (nextMode === mode) return;
    setMode(nextMode);
  };

  const activeModel: AgenticModel = "nemotron30b";

  const formatGeneratedAt = (iso: string | undefined) => {
    if (!iso) return "";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours24 = date.getHours();
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const ampm = hours24 >= 12 ? "PM" : "AM";
    const hours12 = hours24 % 12 || 12;
    return `Answer generated at ${year}-${month}-${day} ${hours12}:${minutes} ${ampm}`;
  };

  const handleConvergentToggle = (enabled: boolean) => {
    setConvergentEnabled(enabled);
  };

  const markdownComponents: Components = {
    code({ className, children, ...props }) {
      const languageMatch = /language-([\w-]+)/.exec(className || "");
      const codeText = String(children || "").replace(/\n$/, "");

      if (!languageMatch) {
        return (
          <code className={`${className || ""} bg-[#f3f4f6] px-1 py-0.5 rounded`} {...props}>
            {children}
          </code>
        );
      }

      const language = languageMatch[1].toLowerCase();
      const codeKey = `${language}-${codeText.slice(0, 80)}`;
      const copied = copiedCodeKey === codeKey;

      return (
        <div className="not-prose my-3 overflow-hidden rounded-xl border border-[#d1d5db] bg-[#0f172a]">
          <div className="flex items-center justify-between px-3 py-1.5 text-[11px] bg-[#111827] border-b border-[#1f2937]">
            <span className="font-semibold uppercase tracking-wide text-[#9ca3af]">
              {language}
            </span>
            <button
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(codeText);
                  setCopiedCodeKey(codeKey);
                  setTimeout(() => {
                    setCopiedCodeKey((prev) => (prev === codeKey ? null : prev));
                  }, 1200);
                } catch {
                  // Clipboard may be unavailable in some browsers.
                }
              }}
              className="rounded-md border border-[#374151] px-2 py-0.5 text-[#d1d5db] hover:bg-[#1f2937] transition-colors"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <pre className="m-0 overflow-x-auto p-3 text-sm text-[#e5e7eb]">
            <code className={className} {...props}>
              {codeText}
            </code>
          </pre>
        </div>
      );
    },
  };

  const renderMarkdown = (content: string) => (
    <ReactMarkdown
      remarkPlugins={[remarkMath, remarkGfm]}
      rehypePlugins={[rehypeKatex]}
      components={markdownComponents}
    >
      {preprocessLaTeX(content)}
    </ReactMarkdown>
  );

  const stopGeneration = () => {
    if (!isLoading) return;
    manualStopRef.current = true;
    try {
      abortControllerRef.current?.abort();
    } catch {
      // Ignore abort races (already aborted/cleaned up).
    }
  };

  const handleAttachClick = () => {
    if (isLoading) return;
    setAttachmentError(null);
    imageInputRef.current?.click();
  };

  const fileToDataUrl = async (file: File) => {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
      reader.onerror = () => reject(new Error("Failed to read file"));
      reader.readAsDataURL(file);
    }).catch(() => "");
    return dataUrl;
  };

  const toPendingAttachment = async (file: File): Promise<PendingAttachment | null> => {
    const isImage = file.type.startsWith("image/");
    const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
    if (!isImage && !isPdf) return null;
    if (file.size > MAX_UPLOAD_BYTES) return null;

    const dataUrl = await fileToDataUrl(file);
    if (!dataUrl) return null;

    return {
      kind: isImage ? "image" : "pdf",
      name: file.name,
      mimeType: file.type || (isPdf ? "application/pdf" : "image/*"),
      dataUrl,
    };
  };

  const attachFromFile = async (file: File) => {
    const attachment = await toPendingAttachment(file);
    if (!attachment) {
      setAttachmentError("Only image or PDF files up to 10MB are supported.");
      return;
    }
    setAttachmentError(null);
    setAttachedFile(attachment);
  };

  const handleImageFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      event.target.value = "";
      return;
    }
    await attachFromFile(file);
    event.target.value = "";
  };

  const hasFileDataInClipboard = (items: DataTransferItemList | undefined | null) => {
    if (!items) return false;
    return Array.from(items).some((item) => {
      const type = item.type || "";
      return type.startsWith("image/") || type === "application/pdf";
    });
  };

  const findSupportedFile = (files: FileList | null | undefined) => {
    if (!files) return null;
    return (
      Array.from(files).find((file) => {
        const type = file.type || "";
        return type.startsWith("image/") || type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
      }) || null
    );
  };

  useEffect(() => {
    const onPaste = async (event: ClipboardEvent) => {
      if (isLoading) return;

      const clipboardItems = event.clipboardData?.items;
      let file = findSupportedFile(event.clipboardData?.files);
      if (!file && hasFileDataInClipboard(clipboardItems)) {
        const fileItem = clipboardItems
          ? Array.from(clipboardItems).find((item) => {
              const type = item.type || "";
              return type.startsWith("image/") || type === "application/pdf";
            })
          : null;
        file = fileItem?.getAsFile() || null;
      }
      if (!file) return;

      event.preventDefault();
      await attachFromFile(file);
    };

    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading]);

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer?.types?.includes("Files")) return;
    event.preventDefault();
    if (!isDragActive) setIsDragActive(true);
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node)) return;
    if (isDragActive) setIsDragActive(false);
  };

  const handleDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragActive(false);
    if (isLoading) return;

    const file = findSupportedFile(event.dataTransfer?.files);
    if (!file) return;
    await attachFromFile(file);
  };

  // ── Chat logic (unchanged) ───────────────────────────────────────────
  const sendMessage = async () => {
    if (!openrouterApiKey) {
      setSettingsOpen(true);
      return;
    }
    const trimmedInput = input.trim();
    const fileToSend = attachedFile;
    if ((!trimmedInput && !fileToSend) || isLoading) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      role: "user",
      content: trimmedInput || (fileToSend?.kind === "pdf" ? "Analyze this PDF." : "Analyze this image."),
      createdAt: new Date().toISOString(),
      attachment: fileToSend
        ? {
            kind: fileToSend.kind,
            name: fileToSend.name,
            dataUrl: fileToSend.dataUrl,
          }
        : undefined,
    };

    const assistantMessage: Message = {
      id: (Date.now() + 1).toString(),
      role: "assistant",
      content: "",
      createdAt: new Date().toISOString(),
      status: fileToSend
        ? fileToSend.kind === "pdf"
          ? "Analyzing PDF."
          : "Analyzing image with the Nemotron Nano 12B V2 model."
        : undefined,
      reasoning: "",
      isStreaming: true,
      convergent: convergentEnabled
        ? {
            status: "idle",
            score: 0,
            round: 0,
            maxRounds: 0,
            logs: [],
            clarifyingQuestions: [],
          }
        : undefined,
    };

    setMessages((prev) => [...prev, userMessage, assistantMessage]);
    setInput("");
    setAttachedFile(null);
    setAttachmentError(null);
    setIsLoading(true);

    // Save user message to DB
    let activeConvId = activeConversationId;
    if (user) {
      const supabase = createClient();
      if (!activeConvId) {
        const title = trimmedInput.slice(0, 50) || "New Chat";
        activeConvId = await createConversation(supabase, user.id, "chat", title);
        if (activeConvId) setActiveConversationId(activeConvId);
      }
      if (activeConvId) {
        await dbSaveMessage(supabase, activeConvId, "user", userMessage.content);
      }
    }

    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    manualStopRef.current = false;
    activeAssistantIdRef.current = assistantMessage.id;
    timeoutRef.current = setTimeout(() => abortController.abort(), 300000);

    let finalContent = "";
    let finalReasoning = "";

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmedInput,
          model: activeModel,
          thinking: convergentEnabled,
          convergentThinking: convergentEnabled,
          webSearch: webSearchEnabled,
          imageDataUrl: fileToSend?.kind === "image" ? fileToSend.dataUrl : undefined,
          pdfDataUrl: fileToSend?.kind === "pdf" ? fileToSend.dataUrl : undefined,
          apiKey: openrouterApiKey,
        }),
        signal: abortController.signal,
      });

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6));

              if (data.type === "reasoning") {
                finalReasoning = typeof data.content === "string" ? data.content : "";
                setMessages((prev) =>
                  prev.map((msg) =>
                    msg.id === assistantMessage.id
                      ? { ...msg, reasoning: data.content, status: undefined }
                      : msg
                  )
                );
              } else if (data.type === "status") {
                setMessages((prev) =>
                  prev.map((msg) =>
                    msg.id === assistantMessage.id
                      ? {
                          ...msg,
                          status: typeof data.content === "string" ? data.content : msg.status,
                        }
                      : msg
                  )
                );
              } else if (data.type === "web-search-start") {
                setMessages((prev) =>
                  prev.map((msg) =>
                    msg.id === assistantMessage.id
                      ? { ...msg, isSearchingWeb: true, status: undefined }
                      : msg
                  )
                );
              } else if (data.type === "web-search-done") {
                setMessages((prev) =>
                  prev.map((msg) =>
                    msg.id === assistantMessage.id
                      ? { ...msg, isSearchingWeb: false }
                      : msg
                  )
                );
              } else if (data.type === "convergent_start") {
                setMessages((prev) =>
                  prev.map((msg) =>
                    msg.id === assistantMessage.id
                      ? {
                          ...msg,
                          convergent: {
                            status: "running",
                            score: typeof data.score === "number" ? data.score : 0,
                            round: typeof data.round === "number" ? data.round : 0,
                            maxRounds: typeof data.maxRounds === "number" ? data.maxRounds : 0,
                            logs: msg.convergent?.logs || [],
                            clarifyingQuestions: msg.convergent?.clarifyingQuestions || [],
                          },
                        }
                      : msg
                  )
                );
              } else if (data.type === "convergent_log") {
                setMessages((prev) =>
                  prev.map((msg) => {
                    if (msg.id !== assistantMessage.id) return msg;
                    const log = {
                      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                      role: data.role as "judge" | "debater_a" | "debater_b" | "executor",
                      round: typeof data.round === "number" ? data.round : 0,
                      content: typeof data.content === "string" ? data.content : "",
                    };
                    return {
                      ...msg,
                      convergent: {
                        status: msg.convergent?.status || "running",
                        score: msg.convergent?.score ?? 0,
                        round: msg.convergent?.round ?? 0,
                        maxRounds: msg.convergent?.maxRounds ?? 0,
                        logs: [...(msg.convergent?.logs || []), log],
                        clarifyingQuestions: msg.convergent?.clarifyingQuestions || [],
                      },
                    };
                  })
                );
              } else if (data.type === "convergence_state") {
                setMessages((prev) =>
                  prev.map((msg) =>
                    msg.id === assistantMessage.id
                      ? {
                          ...msg,
                          convergent: {
                            status:
                              data.status === "converged"
                                ? "converged"
                                : data.status === "needs_input"
                                ? "needs_input"
                                : "running",
                            score:
                              typeof data.score === "number"
                                ? data.score
                                : msg.convergent?.score ?? 0,
                            round:
                              typeof data.round === "number"
                                ? data.round
                                : msg.convergent?.round ?? 0,
                            maxRounds:
                              typeof data.maxRounds === "number"
                                ? data.maxRounds
                                : msg.convergent?.maxRounds ?? 0,
                            logs: msg.convergent?.logs || [],
                            clarifyingQuestions: msg.convergent?.clarifyingQuestions || [],
                          },
                        }
                      : msg
                  )
                );
              } else if (data.type === "clarifying_questions") {
                setMessages((prev) =>
                  prev.map((msg) =>
                    msg.id === assistantMessage.id
                      ? {
                          ...msg,
                          convergent: {
                            status: "needs_input",
                            score: msg.convergent?.score ?? 0,
                            round: msg.convergent?.round ?? 0,
                            maxRounds: msg.convergent?.maxRounds ?? 0,
                            logs: msg.convergent?.logs || [],
                            clarifyingQuestions: Array.isArray(data.questions)
                              ? data.questions
                              : [],
                          },
                        }
                      : msg
                  )
                );
              } else if (data.type === "content") {
                finalContent = typeof data.content === "string" ? data.content : "";
                setMessages((prev) =>
                  prev.map((msg) =>
                    msg.id === assistantMessage.id
                      ? { ...msg, content: data.content, status: undefined }
                      : msg
                  )
                );
              } else if (data.type === "done") {
                const generatedAt = new Date().toISOString();
                setMessages((prev) =>
                  prev.map((msg) =>
                    msg.id === assistantMessage.id
                      ? {
                          ...msg,
                          isStreaming: false,
                          status: undefined,
                          convergent: msg.convergent
                            ? {
                                ...msg.convergent,
                                status:
                                  msg.convergent.status === "running"
                                    ? "converged"
                                    : msg.convergent.status,
                              }
                            : undefined,
                          generatedAt,
                        }
                      : msg
                  )
                );
              }
            } catch {
              // Skip invalid JSON
            }
          }
        }
      }
    } catch (error) {
      const isAbortError =
        (error instanceof DOMException && error.name === "AbortError") ||
        (error instanceof Error && error.name === "AbortError");
      if (!isAbortError) {
        console.error("Error:", error);
      }
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantMessage.id
            ? {
                ...msg,
                content:
                  isAbortError && manualStopRef.current
                    ? (msg.content.trim() ? msg.content : "Generation stopped.")
                    : isAbortError
                    ? "The request took too long. The reasoning above shows the progress made. Please try a simpler question or try again."
                    : "Sorry, there was an error. Please try again.",
                status: undefined,
                isStreaming: false,
                generatedAt: new Date().toISOString(),
              }
            : msg
        )
      );
    } finally {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      abortControllerRef.current = null;
      activeAssistantIdRef.current = null;
      manualStopRef.current = false;
      setIsLoading(false);

      // Save assistant message to DB
      if (user && activeConvId && finalContent) {
        const supabase = createClient();
        await dbSaveMessage(supabase, activeConvId, "assistant", finalContent, finalReasoning || undefined);
        await touchConversation(supabase, activeConvId);
        refreshConversations();
      }
    }
  };

  // ── Debate helpers ───────────────────────────────────────────────────
  const startDebate = async () => {
    if (!openrouterApiKey) {
      setSettingsOpen(true);
      return;
    }
    if (!debateQuestion.trim()) return;
    const check = validateDebateTopic(debateQuestion);
    if (!check.allowed) {
      setDebateGuardError(check.message || "This debate topic is not allowed.");
      return;
    }
    setDebateGuardError(null);
    setDebateReplayMessages(null); // Clear replay — this is a live debate
    setDebatePhase("active");

    // Create debate conversation in DB
    if (user) {
      const supabase = createClient();
      const convId = await createConversation(
        supabase,
        user.id,
        "debate",
        debateQuestion.slice(0, 50)
      );
      if (convId) setActiveConversationId(convId);
    }
  };

  const handleDebateFinished = async (
    debateMessages: { speaker: string; content: string }[]
  ) => {
    if (!user || !activeConversationId) return;
    const supabase = createClient();
    for (const msg of debateMessages) {
      const role =
        msg.speaker === "blue"
          ? "debater_blue"
          : msg.speaker === "red"
          ? "debater_red"
          : "moderator";
      await dbSaveMessage(supabase, activeConversationId, role, msg.content);
    }
    await touchConversation(supabase, activeConversationId);
    refreshConversations();
  };

  const debateRounds = 2;
  // ── Derived values ───────────────────────────────────────────────────
  const sidebarWidth = sidebarOpen ? 240 : 56;
  const isAgenticMode = mode === "agentic";
  const isDebateActive = mode === "debate" && debatePhase === "active";
  const isLanding = messages.length === 0;

  // ── AUTH LOADING ─────────────────────────────────────────────────────
  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#fffaf3]">
        <div className="flex flex-col items-center gap-4">
          <div className="w-8 h-8 border-2 border-[#2d2d2d] border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-[#6b7280]">Loading...</p>
        </div>
      </div>
    );
  }

  // ── LANDING PAGE (UNAUTHENTICATED) ────────────────────────────────────
  if (!user) {
    return (
      <div className="min-h-screen flex flex-col bg-[#fffaf3]">
        {/* Top bar */}
        <header className="relative z-10 flex items-center justify-between px-8 py-5">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-[#2d2d2d] text-xl">DeepConverge</span>
            <Image
              src="/bestlogo.png"
              alt="DeepConverge logo"
              width={42}
              height={42}
              className="object-contain -ml-2"
              priority
            />
            <span className="px-2 py-0.5 rounded-full bg-[#7c6bf5] text-white text-[10px] font-bold uppercase tracking-wide">
              BETA
            </span>
            <span className="mx-2 h-5 w-px bg-[#d1d5db]" />
            <div className="flex items-center gap-1.5">
              <Image
                src="/nvidia_logo.png"
                alt="NVIDIA"
                width={18}
                height={18}
                className="object-contain"
              />
              <span className="text-xs font-medium text-[#76b900]">
                NVIDIA GTC 2026 Submission
              </span>
            </div>
          </div>
          <Link
            href="/auth/signin"
            className="px-5 py-2 rounded-full bg-[#2d2d2d] text-white text-sm font-medium hover:bg-[#1f2937] transition-colors"
          >
            Sign In
          </Link>
        </header>

        {/* Hero */}
        <main className="flex-1 flex flex-col items-center px-4 pt-16 pb-8">
          <Image
            src="/bestlogo.png"
            alt="DeepConverge logo"
            width={120}
            height={120}
            className="object-contain mb-6"
            priority
          />
          <h1 className="text-5xl font-bold text-[#2d2d2d] mb-4 text-center flex items-center justify-center gap-3">
            DeepConverge
            <span className="px-3 py-1 rounded-full bg-[#7c6bf5] text-white text-sm font-bold uppercase tracking-wide">
              BETA
            </span>
          </h1>
          <p className="text-lg text-[#6b7280] mb-10 text-center max-w-xl leading-relaxed">
            Answer your questions by watching LLMs debate and find the best solution for you. Sit back and relax.
          </p>

          {/* Search bar with typewriter */}
          <div className="w-full max-w-xl">
            <div className="relative">
              <input
                type="text"
                value={landingInput}
                onChange={(e) => setLandingInput(e.target.value)}
                onFocus={() => {
                  setLandingInputFocused(true);
                  setTypewriterActive(false);
                }}
                onBlur={() => {
                  if (!landingInput.trim()) {
                    setLandingInputFocused(false);
                    setTypewriterActive(true);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const val = landingInput.trim();
                    if (val) {
                      localStorage.setItem("deepconverge_pending_query", val);
                    }
                    window.location.href = "/auth/signin";
                  }
                }}
                className="w-full bg-white rounded-2xl px-6 py-4 border border-[#e5e7eb] shadow-sm outline-none focus:ring-2 focus:ring-[#7c6bf5]/30 focus:border-[#7c6bf5] text-[#2d2d2d] text-base"
              />
              {/* Typewriter overlay — shown when input not focused */}
              {!landingInputFocused && (
                <div className="absolute inset-0 flex items-center px-6 pointer-events-none">
                  <span className="text-[#9ca3af] text-base">
                    {typewriterText}
                    <span className="inline-block w-[2px] h-5 bg-[#9ca3af] ml-0.5 align-middle animate-pulse" />
                  </span>
                </div>
              )}
              {landingInputFocused && !landingInput && (
                <div className="absolute inset-0 flex items-center px-6 pointer-events-none">
                  <span className="text-[#9ca3af] text-base">
                    What can we help you with today?
                  </span>
                </div>
              )}
              <div className="absolute right-4 top-1/2 -translate-y-1/2">
                <svg className="w-5 h-5 text-[#9ca3af]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
                </svg>
              </div>
            </div>
            <p className="text-xs text-[#9ca3af] text-center mt-3">
              Press Enter to sign in and start chatting
            </p>
          </div>

          {/* Watch Demo pill */}
          <a
            href="https://www.youtube.com/watch?v=LRk8n8DcOlQ"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-full border border-[#e5e7eb] bg-white text-sm text-[#2d2d2d] hover:border-[#ff0000]/40 hover:bg-[#fff5f5] transition-colors shadow-sm"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="#ff0000">
              <path d="M23.5 6.2a3 3 0 00-2.1-2.1C19.5 3.5 12 3.5 12 3.5s-7.5 0-9.4.6A3 3 0 00.5 6.2C0 8.1 0 12 0 12s0 3.9.5 5.8a3 3 0 002.1 2.1C4.5 20.5 12 20.5 12 20.5s7.5 0 9.4-.6a3 3 0 002.1-2.1C24 15.9 24 12 24 12s0-3.9-.5-5.8zM9.8 15.5V8.5l6.4 3.5-6.4 3.5z"/>
            </svg>
            Watch Demo
          </a>

          {/* Feature Showcase */}
          <div className="w-full max-w-3xl mt-8 space-y-4">
            {[
              {
                title: "Timestamps",
                description:
                  "No other AI model has timestamps. See exactly when each message was generated.",
                icon: (
                  <svg className="w-5 h-5 text-[#7c6bf5]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                ),
              },
              {
                title: "PDF Export",
                description:
                  "Export all your conversations as a PDF. Give it to other LLMs to seamlessly move between AI providers.",
                icon: (
                  <svg className="w-5 h-5 text-[#7c6bf5]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                  </svg>
                ),
              },
              {
                title: "MAD Intelligence",
                description:
                  "Multi-Agent Debate: Watch AI agents argue, challenge, and synthesize smarter answers together.",
                icon: (
                  <svg className="w-5 h-5 text-[#7c6bf5]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                ),
              },
              {
                title: "User Data Control",
                description:
                  "You own your data. Export, delete, and manage everything.",
                icon: (
                  <svg className="w-5 h-5 text-[#7c6bf5]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                  </svg>
                ),
              },
            ].map((feature) => (
              <div
                key={feature.title}
                className="flex items-start gap-4 bg-white rounded-xl border border-[#e5e7eb] p-5 shadow-sm"
              >
                <div className="w-10 h-10 rounded-lg bg-[#f3f0ff] flex items-center justify-center flex-shrink-0">
                  {feature.icon}
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-[#2d2d2d] mb-1">
                    {feature.title}
                  </h3>
                  <p className="text-xs text-[#6b7280] leading-relaxed">
                    {feature.description}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </main>

        {/* Footer */}
        <footer className="py-8 px-8">
          <div className="max-w-3xl mx-auto flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Image
                src="/bestlogo.png"
                alt="DeepConverge logo"
                width={28}
                height={28}
                className="object-contain"
              />
              <span className="text-xs text-[#9ca3af]">
                &copy; 2026 DeepConverge &middot; Made by Hanryck Brar
              </span>
            </div>
            <div className="flex items-center gap-4">
              <a
                href="mailto:deepconvergeai@gmail.com"
                className="text-[#9ca3af] hover:text-[#6b7280] transition-colors"
                aria-label="Email"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
              </a>
              <a
                href="https://x.com/ItsHB17"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[#9ca3af] hover:text-[#6b7280] transition-colors"
                aria-label="Twitter/X"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                </svg>
              </a>
              <a
                href="https://github.com/Hanbrar/DeepConverge"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[#9ca3af] hover:text-[#6b7280] transition-colors"
                aria-label="GitHub"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
                </svg>
              </a>
            </div>
          </div>
        </footer>
      </div>
    );
  }

  // ── SINGLE-PAGE SHELL (AUTHENTICATED) ─────────────────────────────────
  return (
    <div
      className="min-h-screen flex bg-[#fffaf3]"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*,application/pdf,.pdf"
        className="hidden"
        onChange={handleImageFileChange}
      />
      {isDragActive && (
        <div className="fixed inset-0 z-50 bg-[#111827]/35 backdrop-blur-[1px] flex items-center justify-center pointer-events-none">
          <div className="rounded-2xl border border-white/30 bg-[#0f172a]/80 px-6 py-4 text-white text-sm font-medium shadow-xl">
            Drop image or PDF to attach
          </div>
        </div>
      )}
      {/* ── Left Sidebar ──────────────────────────────────────────────── */}
      <aside
        className="fixed top-0 left-0 bottom-0 z-40 flex flex-col bg-[#fffaf2] border-r border-[#ebebeb] transition-all duration-200"
        style={{ width: sidebarWidth }}
      >
        {/* Logo + collapse toggle */}
        <div className="flex items-center justify-between px-3 py-4">
          <div className="flex items-center gap-2 overflow-hidden">
            {sidebarOpen && (
              <span className="font-semibold text-[#2d2d2d] text-lg whitespace-nowrap flex items-center gap-1">
                <span>DeepConverge</span>
                <Image
                  src="/bestlogo.png"
                  alt="DeepConverge logo"
                  width={42}
                  height={42}
                  className="object-contain -ml-2"
                  priority
                />
              </span>
            )}
          </div>
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="p-1.5 rounded-md hover:bg-[#f3f4f6] transition-colors flex-shrink-0"
            title={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
          >
            <svg className="w-4 h-4 text-[#9ca3af]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              {sidebarOpen ? (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7M5 5l7 7-7 7" />
              )}
            </svg>
          </button>
        </div>

        {/* New Chat button */}
        <div className="px-3 mb-2 space-y-1">
          <button
            onClick={handleNewChat}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-[#f3f4f6] transition-colors text-sm text-[#4b5563]"
          >
            <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            {sidebarOpen && (
              <>
                <span className="flex-1 text-left">New Chat</span>
                <span className="text-[10px] text-[#9ca3af] font-medium">Ctrl K</span>
              </>
            )}
          </button>
        </div>

        {/* Divider */}
        <div className="mx-3 border-t border-[#ebebeb]" />

        {/* User info — click to open Settings */}
        {sidebarOpen && user && (
          <div className="px-3 py-2 border-b border-[#ebebeb]">
            <button
              onClick={() => setSettingsOpen(true)}
              className="w-full flex items-center gap-2 rounded-lg hover:bg-[#f3f4f6] transition-colors p-1"
            >
              {user.user_metadata?.avatar_url ? (
                <Image
                  src={user.user_metadata.avatar_url}
                  alt="Avatar"
                  width={24}
                  height={24}
                  className="rounded-full"
                  unoptimized
                />
              ) : (
                <div className="w-6 h-6 rounded-full bg-[#7c6bf5] flex items-center justify-center text-white text-xs font-bold">
                  {(user.user_metadata?.full_name || user.email || "U")[0].toUpperCase()}
                </div>
              )}
              <span className="text-xs text-[#4b5563] truncate flex-1 text-left">
                {profileDisplayName || user.user_metadata?.full_name || user.email || "User"}
              </span>
              <svg className="w-3.5 h-3.5 text-[#9ca3af] flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </button>
          </div>
        )}

        {/* Chat History */}
        <div className="px-3 pt-3 flex-1 overflow-y-auto">
          {sidebarOpen && (
            <>
              <h3 className="text-[10px] font-semibold uppercase tracking-widest text-[#9ca3af] mb-2 px-1">
                Chat History
              </h3>
              {conversations.filter((c) => c.mode === "chat").length === 0 ? (
                <div className="text-xs text-[#9ca3af] py-2 px-1">
                  No sessions yet
                </div>
              ) : (
                <div className="space-y-0.5">
                  {conversations
                    .filter((c) => c.mode === "chat")
                    .map((conv) => (
                      <div
                        key={conv.id}
                        className={`group flex items-center gap-1 rounded-lg px-2 py-1.5 cursor-pointer transition-colors ${
                          activeConversationId === conv.id
                            ? "bg-[#e5e7eb]"
                            : "hover:bg-[#f3f4f6]"
                        }`}
                      >
                        <button
                          onClick={() => handleLoadConversation(conv)}
                          className="flex-1 text-left min-w-0"
                        >
                          <p className="text-xs text-[#4b5563] truncate">
                            {conv.title}
                          </p>
                          <p className="text-[10px] text-[#9ca3af]">
                            {new Date(conv.updated_at).toLocaleDateString()}
                          </p>
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteConversation(conv.id);
                          }}
                          className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-[#e5e7eb] transition-all text-[#9ca3af] hover:text-[#ef4444]"
                          title="Delete"
                        >
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    ))}
                </div>
              )}

              <div className="mt-4 mb-2 border-t border-[#ebebeb]" />

              <h3 className="text-[10px] font-semibold uppercase tracking-widest text-[#9ca3af] mb-2 px-1 mt-3">
                Debate History
              </h3>
              {conversations.filter((c) => c.mode === "debate").length === 0 ? (
                <div className="text-xs text-[#9ca3af] py-2 px-1">
                  No sessions yet
                </div>
              ) : (
                <div className="space-y-0.5">
                  {conversations
                    .filter((c) => c.mode === "debate")
                    .map((conv) => (
                      <div
                        key={conv.id}
                        className={`group flex items-center gap-1 rounded-lg px-2 py-1.5 cursor-pointer transition-colors ${
                          activeConversationId === conv.id
                            ? "bg-[#e5e7eb]"
                            : "hover:bg-[#f3f4f6]"
                        }`}
                      >
                        <button
                          onClick={() => handleLoadConversation(conv)}
                          className="flex-1 text-left min-w-0"
                        >
                          <p className="text-xs text-[#4b5563] truncate">
                            {conv.title}
                          </p>
                          <p className="text-[10px] text-[#9ca3af]">
                            {new Date(conv.updated_at).toLocaleDateString()}
                          </p>
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteConversation(conv.id);
                          }}
                          className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-[#e5e7eb] transition-all text-[#9ca3af] hover:text-[#ef4444]"
                          title="Delete"
                        >
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* Bottom actions */}
        {sidebarOpen && (
          <div className="px-3 py-3 border-t border-[#ebebeb] space-y-1">
            <button
              onClick={handleExportPdf}
              disabled={isExportingPdf || conversations.length === 0}
              className="w-full flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-[#f3f4f6] transition-colors text-xs text-[#4b5563] disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              {isExportingPdf ? "Exporting..." : "Download All as PDF"}
            </button>
            <button
              onClick={handleSignOut}
              className="w-full flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-[#fee2e2] transition-colors text-xs text-[#6b7280] hover:text-[#dc2626]"
            >
              <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
              Sign Out
            </button>
          </div>
        )}
      </aside>

      {/* ── Main Content ──────────────────────────────────────────────── */}
      <div
        className="flex-1 flex flex-col min-h-screen transition-all duration-200"
        style={{ marginLeft: sidebarWidth }}
      >
        {isAgenticMode && (
          <div className="fixed top-4 right-4 z-30">
            <div className="rounded-xl border border-[#e5e7eb] bg-[#fffaf2]/95 backdrop-blur-sm shadow-sm px-3 py-2">
              <div className="flex items-center gap-1.5 mb-1">
                <span className="w-3.5 h-3.5 rounded overflow-hidden border border-[#d1d5db] bg-white flex items-center justify-center">
                  <Image
                    src="/nvidia_logo.png"
                    alt="NVIDIA logo"
                    width={14}
                    height={14}
                    className="object-contain"
                  />
                </span>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-[#9ca3af]">
                  Active Model
                </p>
              </div>
              <p className="text-xs font-semibold text-[#2d2d2d]">
                {AGENTIC_MODELS[activeModel].display}
              </p>
              <p className="text-[11px] text-[#6b7280]">
                ConvergentThinking {convergentEnabled ? "On" : "Off"}
              </p>
              <p className="text-[11px] text-[#6b7280]">
                Web Search {webSearchEnabled ? "On" : "Off"}
              </p>
            </div>
          </div>
        )}

        {isDebateActive ? (
          <div className="flex-1 min-h-0">
            <DebateCanvas
              key={activeConversationId || "live"}
              question={debateQuestion}
              rounds={debateRounds}
              apiKey={openrouterApiKey || ""}
              onDebateFinished={handleDebateFinished}
              replayMessages={debateReplayMessages || undefined}
            />
          </div>
        ) : isLanding ? (
          /* ── LANDING VIEW: Title + Converging Arrows + Content ──── */
          <main className="flex-1 flex flex-col items-center justify-center px-4">
            {/* Title */}
            <h1 className="text-4xl font-bold text-[#2d2d2d] mb-8 flex items-center justify-center gap-0">
              <span>DeepConverge</span>
              <Image
                src="/bestlogo.png"
                alt="DeepConverge logo"
                width={84}
                height={84}
                className="object-contain -ml-3"
                priority
              />
            </h1>

            {/* API key warning */}
            {!openrouterApiKey && (
              <div className="w-full max-w-md mb-6 bg-[#fffbeb] border border-[#fde68a] rounded-xl px-4 py-3 text-center">
                <p className="text-sm text-[#92400e] font-medium mb-1">
                  API Key Required
                </p>
                <p className="text-xs text-[#b45309] mb-2">
                  Add your OpenRouter API key in Settings to start chatting.
                </p>
                <button
                  onClick={() => setSettingsOpen(true)}
                  className="text-xs font-medium text-[#7c6bf5] hover:underline"
                >
                  Open Settings
                </button>
              </div>
            )}

            {/* Mode tabs */}
            <div className="flex items-center gap-16 mb-0">
              <button
                onClick={() => handleModeChange("agentic")}
                className={`text-base px-1 pb-1 transition-all duration-300 ${
                  isAgenticMode
                    ? "text-[#2d2d2d] font-semibold"
                    : "text-[#c0c0c0] hover:text-[#9ca3af]"
                }`}
              >
                Agentic Mode
              </button>
              <button
                onClick={() => handleModeChange("debate")}
                className={`text-base px-1 pb-1 transition-all duration-300 ${
                  !isAgenticMode
                    ? "text-[#2d2d2d] font-semibold"
                    : "text-[#c0c0c0] hover:text-[#9ca3af]"
                }`}
              >
                Debate Mode
              </button>
            </div>

            {/* L-shaped converging arrows SVG */}
            <svg viewBox="0 0 320 70" className="w-80 h-[70px] mb-6" aria-hidden="true">
              {isAgenticMode ? (
                <>
                  {/* Inactive branch first */}
                  <path
                    d="M240 0 L240 18 Q240 25, 233 25 L167 25 Q160 25, 160 32"
                    fill="none"
                    stroke="#e0e0e0"
                    strokeWidth={1.5}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="transition-all duration-500 ease-in-out"
                  />
                  {/* Active branch on top */}
                  <path
                    d="M80 0 L80 18 Q80 25, 87 25 L153 25 Q160 25, 160 32"
                    fill="none"
                    stroke="#2d2d2d"
                    strokeWidth={2.5}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="transition-all duration-500 ease-in-out"
                  />
                </>
              ) : (
                <>
                  {/* Inactive branch first */}
                  <path
                    d="M80 0 L80 18 Q80 25, 87 25 L153 25 Q160 25, 160 32"
                    fill="none"
                    stroke="#e0e0e0"
                    strokeWidth={1.5}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="transition-all duration-500 ease-in-out"
                  />
                  {/* Active branch on top */}
                  <path
                    d="M240 0 L240 18 Q240 25, 233 25 L167 25 Q160 25, 160 32"
                    fill="none"
                    stroke="#2d2d2d"
                    strokeWidth={2.5}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="transition-all duration-500 ease-in-out"
                  />
                </>
              )}
              {/* Shared vertical trunk (kept solid in both modes) */}
              <path
                d="M160 32 L160 58"
                fill="none"
                stroke="#2d2d2d"
                strokeWidth={2.5}
                strokeLinecap="round"
                strokeLinejoin="round"
                className="transition-all duration-500 ease-in-out"
              />
              {/* Arrowhead at bottom */}
              <path
                d="M155 55 L160 65 L165 55"
                fill="none"
                stroke="#2d2d2d"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>

            {/* Content area — crossfade between agentic input and debate settings */}
            <div
              className="relative w-full max-w-2xl transition-[height] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]"
              style={{ height: modePanelHeight || undefined }}
            >
              {/* Agentic: Chat textarea */}
              <div
                ref={agenticPanelRef}
                className={`absolute inset-x-0 top-0 transition-[opacity,transform,filter] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[opacity,transform] ${
                isAgenticMode
                  ? "opacity-100 translate-y-0 blur-0 pointer-events-auto"
                  : "opacity-0 -translate-y-1 blur-[2px] pointer-events-none"
                }`}
                aria-hidden={!isAgenticMode}
              >
                <div className="bg-[#fffaf2] rounded-2xl border border-[#e5e7eb] shadow-sm overflow-hidden">
                  {attachedFile && (
                    <div className="px-4 pt-3">
                      <div className="flex items-center gap-3 rounded-xl border border-[#e5e7eb] bg-[#f8fafc] px-3 py-2">
                        {attachedFile.kind === "image" ? (
                          <Image
                            src={attachedFile.dataUrl}
                            alt={attachedFile.name}
                            width={48}
                            height={48}
                            unoptimized
                            className="h-12 w-12 rounded-md object-cover border border-[#d1d5db]"
                          />
                        ) : (
                          <div className="h-12 w-12 rounded-md border border-[#d1d5db] bg-white flex items-center justify-center text-[#dc2626]">
                            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 3h7l5 5v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z" />
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 3v6h6" />
                            </svg>
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-medium text-[#2d2d2d] truncate">
                            {attachedFile.name}
                          </p>
                          <p className="text-[11px] text-[#64748b]">
                            {attachedFile.kind === "pdf" ? "Analyzing PDF." : "Analyzing image."}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setAttachedFile(null);
                            setAttachmentError(null);
                          }}
                          className="text-[#9ca3af] hover:text-[#6b7280] transition-colors"
                          aria-label="Remove attachment"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  )}
                  {attachmentError && (
                    <div className="px-4 pt-3">
                      <p className="text-xs text-[#b45309] bg-[#fffbeb] border border-[#fde68a] rounded-lg px-3 py-2">
                        {attachmentError}
                      </p>
                    </div>
                  )}
                  <textarea
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        sendMessage();
                      }
                    }}
                    placeholder="Ask Anything..."
                    className="w-full bg-transparent outline-none text-[#2d2d2d] placeholder-[#9ca3af] px-5 pt-4 pb-2 resize-none text-[15px]"
                    rows={2}
                    disabled={isLoading}
                    tabIndex={isAgenticMode ? 0 : -1}
                  />
                  <div className="flex items-center justify-between gap-3 px-4 pb-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      <button
                        type="button"
                        onClick={handleAttachClick}
                        className="p-1.5 rounded-md hover:bg-[#f3f4f6] transition-colors text-[#9ca3af]"
                        tabIndex={isAgenticMode ? 0 : -1}
                      >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4.5 4.5 0 016.36 6.36l-9.2 9.19a3 3 0 01-4.24-4.24l8.49-8.48" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleConvergentToggle(!convergentEnabled)}
                        disabled={isLoading}
                        tabIndex={isAgenticMode ? 0 : -1}
                        className={`h-8 px-3 rounded-lg border text-xs font-medium transition-colors ${
                          convergentEnabled
                            ? "bg-[#2d2d2d] border-[#2d2d2d] text-white"
                            : "bg-[#fffaf2] border-[#e5e7eb] text-[#6b7280] hover:bg-[#f3f4f6]"
                        } disabled:opacity-60`}
                      >
                        ConvergentThinking {convergentEnabled ? "On" : "Off"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setWebSearchEnabled((prev) => !prev)}
                        disabled={isLoading}
                        tabIndex={isAgenticMode ? 0 : -1}
                        className={`h-8 px-3 rounded-lg border text-xs font-medium transition-colors ${
                          webSearchEnabled
                            ? "bg-[#1f2937] border-[#1f2937] text-white"
                            : "bg-[#fffaf2] border-[#e5e7eb] text-[#6b7280] hover:bg-[#f3f4f6]"
                        } disabled:opacity-60`}
                      >
                        Web Search {webSearchEnabled ? "On" : "Off"}
                      </button>
                      <span className="text-[11px] text-[#6b7280]">
                        Active: {convergentEnabled ? "30B" : "9B"}
                      </span>
                    </div>
                    <button
                      onClick={isLoading ? stopGeneration : sendMessage}
                      disabled={!isLoading && !input.trim() && !attachedFile}
                      className="w-8 h-8 rounded-full bg-[#7c6bf5] text-white flex items-center justify-center hover:bg-[#6c5ce7] transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                      tabIndex={isAgenticMode ? 0 : -1}
                      title={isLoading ? "Stop generation" : "Send message"}
                    >
                      {isLoading ? (
                        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none">
                          <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" />
                        </svg>
                      ) : (
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
                        </svg>
                      )}
                    </button>
                  </div>
                </div>
              </div>

              {/* Debate: Settings */}
              <div
                ref={debatePanelRef}
                className={`absolute inset-x-0 top-0 transition-[opacity,transform,filter] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[opacity,transform] ${
                !isAgenticMode
                  ? "opacity-100 translate-y-0 blur-0 pointer-events-auto"
                  : "opacity-0 translate-y-1 blur-[2px] pointer-events-none"
                }`}
                aria-hidden={isAgenticMode}
              >
                <div className="space-y-6">
                  <p className="text-center text-[#6b7280] text-sm">
                    Watch two AI debaters go head-to-head with a moderator
                  </p>
                  <p className="text-center text-[#b0b5be] text-xs -mt-4">
                    Powered by NVIDIA Nemotron via OpenRouter
                  </p>

                  {/* Debate topic input */}
                  <div>
                    <label className="block text-sm font-medium text-[#2d2d2d] mb-2">
                      Debate Topic
                    </label>
                    <input
                      type="text"
                      value={debateQuestion}
                      onChange={(e) => {
                        setDebateQuestion(e.target.value);
                        if (debateGuardError) setDebateGuardError(null);
                      }}
                      onKeyDown={(e) => e.key === "Enter" && startDebate()}
                      placeholder="e.g., Is AI going to replace programmers?"
                      className="w-full bg-[#fffaf2] rounded-xl px-4 py-3 border border-[#e5e7eb] outline-none focus:ring-2 focus:ring-[#7c6bf5]/30 focus:border-[#7c6bf5] text-[#2d2d2d] placeholder-[#9ca3af]"
                      tabIndex={!isAgenticMode ? 0 : -1}
                    />
                    <p className="mt-2 text-xs text-[#6b7280]">
                      Debate agents can make mistakes and may not have current information. Verify important facts.
                    </p>
                    {debateGuardError && (
                      <p className="mt-2 text-xs text-[#b45309] bg-[#fffbeb] border border-[#fde68a] rounded-lg px-3 py-2">
                        {debateGuardError}
                      </p>
                    )}
                  </div>

                  {/* Debate type */}
                  <div>
                    <label className="block text-sm font-medium text-[#2d2d2d] mb-3">
                      Debate Type
                    </label>
                    <div className="grid grid-cols-2 gap-3">
                      <button
                        onClick={() => setDebateType("regular")}
                        className={`relative p-4 rounded-xl border-2 transition-all text-left ${
                          debateType === "regular"
                            ? "border-[#000000] bg-[#6b7280]/10 shadow-sm"
                            : "border-[#e5e7eb] bg-[#fffaf2] hover:border-[#d1d5db]"
                        }`}
                        tabIndex={!isAgenticMode ? 0 : -1}
                      >
                        <div className="text-2xl mb-2">&#9889;</div>
                        <div className="font-medium text-[#2d2d2d] text-sm">Regular</div>
                        <div className="text-xs text-[#6b7280] mt-1">
                          2 rounds (4 exchanges) - quick and efficient
                        </div>
                        {debateType === "regular" && (
                          <div className="absolute top-2 right-2 w-5 h-5 bg-[#6b7280] rounded-full flex items-center justify-center">
                            <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                            </svg>
                          </div>
                        )}
                      </button>

                      <button
                        onClick={() => {
                          setDebateType("continuous");
                        }}
                        className={`relative p-4 rounded-xl border-2 transition-all text-left ${
                          debateType === "continuous"
                            ? "border-[#f59e0b] bg-[#fffbeb] shadow-sm"
                            : "border-[#e5e7eb] bg-[#fffaf2] hover:border-[#d1d5db]"
                        }`}
                        tabIndex={!isAgenticMode ? 0 : -1}
                      >
                        <div className="text-2xl mb-2">&#128260;</div>
                        <div className="font-medium text-[#2d2d2d] text-sm">Continuous</div>
                        <div className="text-xs text-[#6b7280] mt-1">
                          Coming Soon
                        </div>
                        {debateType === "continuous" && (
                          <div className="absolute top-2 right-2 w-5 h-5 bg-[#f59e0b] rounded-full flex items-center justify-center">
                            <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                            </svg>
                          </div>
                        )}
                      </button>
                    </div>

                    {debateType === "continuous" && (
                      <p className="mt-4 text-xs text-[#b45309] bg-[#fffbeb] border border-[#fde68a] rounded-lg px-3 py-2">
                        Continuous mode is coming soon. Debate currently runs in regular mode only.
                      </p>
                    )}

                    {/* Round slider for continuous mode */}
                    {false && debateType === "continuous" && (
                      <div className="mt-4 bg-[#fffaf2] rounded-xl p-4 border border-[#e5e7eb]">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-sm text-[#4b5563]">Number of rounds</span>
                          <span className="text-sm font-bold text-[#6b7280]">{continuousRounds}</span>
                        </div>
                        <input
                          type="range"
                          min="1"
                          max="5"
                          value={continuousRounds}
                          onChange={(e) => setContinuousRounds(parseInt(e.target.value))}
                          className="w-full accent-[#6b7280]"
                          tabIndex={!isAgenticMode ? 0 : -1}
                        />
                        <div className="flex justify-between text-xs text-[#9ca3af] mt-1">
                          <span>1</span>
                          <span>3</span>
                          <span>5</span>
                        </div>
                        <p className="text-xs text-[#6b7280] mt-2">
                          {continuousRounds} round{continuousRounds > 1 ? "s" : ""} = {continuousRounds * 2} exchanges (Blue + Red each round)
                        </p>
                      </div>
                    )}
                  </div>

                  {/* Start button */}
                  <button
                    onClick={startDebate}
                    disabled={!debateQuestion.trim() || debateType === "continuous"}
                    className="w-full py-3.5 bg-[#000000] text-white rounded-xl font-medium text-base hover:bg-[#1f2937] transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-lg shadow-[#000000]/20"
                    tabIndex={!isAgenticMode ? 0 : -1}
                  >
                    <span>Start Debate</span>
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
                    </svg>
                  </button>
                </div>
              </div>

              {/* Footer removed — branding is in the debate mode description */}
            </div>
          </main>
        ) : (
          /* ── ACTIVE CHAT VIEW: Messages + Input bar ────────────── */
          <>
            <main className="flex-1 pb-32 px-4">
              <div className="w-full max-w-5xl mx-auto space-y-6 px-2 sm:px-4">
                {/* Current mode label */}
                <div className="flex items-center justify-center pt-6 mb-4">
                  <span className="text-sm pb-1 text-[#2d2d2d] font-semibold border-b-2 border-[#2d2d2d]">
                    {isAgenticMode ? "Agentic Mode" : "Debate Mode"}
                  </span>
                </div>

                {/* Messages */}
                {messages.map((message) => (
                  <div key={message.id}>
                    {message.role === "user" ? (
                      <div className="flex justify-end">
                        <div className="bg-[#6b7280] text-white px-4 py-3 rounded-2xl rounded-br-md max-w-[80%] space-y-2">
                          {message.attachment?.kind === "image" && (
                            <Image
                              src={message.attachment.dataUrl}
                              alt={message.attachment.name || "Uploaded image"}
                              width={320}
                              height={180}
                              unoptimized
                              className="max-h-40 w-auto rounded-lg border border-white/30"
                            />
                          )}
                          {message.attachment?.kind === "pdf" && (
                            <div className="inline-flex items-center gap-2 rounded-lg border border-white/30 bg-black/10 px-2 py-1 text-xs">
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 3h7l5 5v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z" />
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 3v6h6" />
                              </svg>
                              <span className="truncate max-w-48">{message.attachment.name}</span>
                            </div>
                          )}
                          <div>{message.content}</div>
                        </div>
                      </div>
                    ) : (
                      <div className="max-w-3xl rounded-2xl border border-[#e5e7eb] bg-white/90 px-4 py-3 shadow-[0_8px_24px_rgba(15,23,42,0.06)] backdrop-blur-sm space-y-3">
                        <div className="flex items-center gap-2">
                          <span className="w-4 h-4 rounded overflow-hidden border border-[#d1d5db] bg-white flex items-center justify-center">
                            <Image
                              src="/nvidia_logo.png"
                              alt="NVIDIA logo"
                              width={16}
                              height={16}
                              className="object-contain"
                            />
                          </span>
                          <div className="leading-tight">
                            <p className="text-xs font-medium text-[#76b900]">Nemotron</p>
                            {!message.isStreaming && message.generatedAt && (
                              <p className="mt-0.5 text-[10px] text-[#9ca3af]">
                                {formatGeneratedAt(message.generatedAt)}
                              </p>
                            )}
                          </div>
                        </div>

                        {message.isStreaming && message.status && (
                          <div>
                            <div className="inline-flex items-center gap-2 rounded-full border border-[#e5e7eb] bg-[#f8fafc] px-3 py-1 text-xs text-[#64748b]">
                              <span className="w-1.5 h-1.5 rounded-full bg-[#6366f1] animate-pulse" />
                              {message.status}
                            </div>
                          </div>
                        )}

                        {message.isSearchingWeb && (
                          <div>
                            <div className="inline-flex items-center gap-3 rounded-2xl border border-[#e0e7ff] bg-gradient-to-r from-[#f0f4ff] to-[#f8faff] px-4 py-2 text-sm text-[#4338ca] shadow-sm">
                              <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                                <circle cx="11" cy="11" r="8" strokeWidth={2} />
                                <path strokeLinecap="round" strokeWidth={2} d="M21 21l-4.35-4.35" />
                              </svg>
                              <span className="font-medium">Searching the web</span>
                              <div className="relative w-24 h-1.5 rounded-full bg-[#c7d2fe] overflow-hidden">
                                <div className="absolute inset-0 rounded-full bg-gradient-to-r from-[#818cf8] via-[#6366f1] to-[#818cf8] web-search-shimmer" />
                              </div>
                            </div>
                          </div>
                        )}

                        {message.reasoning && (
                          <div className="bg-[#f9fafb] border border-[#e5e7eb] rounded-xl overflow-hidden shadow-sm">
                            <div className="px-4 py-2 border-b border-[#e5e7eb] text-sm font-medium text-[#4b5563] flex items-center gap-2">
                              {message.isStreaming && !message.content ? (
                                <>
                                  <span className="w-2 h-2 bg-amber-500 rounded-full animate-pulse" />
                                  Thinking...
                                </>
                              ) : (
                                <>
                                  <svg className="w-4 h-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                  </svg>
                                  Reasoning
                                </>
                              )}
                            </div>
                            <div className="px-4 py-3">
                              <div className="prose prose-sm max-w-none prose-headings:text-[#2d2d2d] prose-p:text-[#374151] prose-strong:text-[#1f2937] prose-code:bg-[#f3f4f6] prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-pre:bg-[#1f2937] prose-pre:text-gray-100">
                                {renderMarkdown(message.reasoning || "")}
                              </div>
                              {message.isStreaming && !message.content && (
                                <span className="inline-block w-2 h-4 bg-[#4b5563]/50 animate-pulse ml-1 align-middle" />
                              )}
                            </div>
                          </div>
                        )}

                        {message.convergent && (
                          <div className="bg-gradient-to-br from-[#f8fafc] via-[#f8fbff] to-[#f5f7ff] border border-[#d6deea] rounded-2xl overflow-hidden shadow-sm">
                            <div className="px-4 py-2.5 border-b border-[#dbe3ea] bg-gradient-to-r from-[#edf2f8] to-[#eef5ff] flex items-center justify-between gap-3">
                              <div className="flex items-center gap-2">
                                <span className="w-2 h-2 rounded-full bg-[#6366f1]" />
                                <span className="text-sm font-semibold text-[#1f2937]">
                                  Convergent Thinking Mode
                                </span>
                                <span className="text-[11px] px-2 py-0.5 rounded-full bg-white border border-[#dbe3ea] text-[#64748b]">
                                  {message.convergent.status === "needs_input"
                                    ? "Needs Input"
                                    : message.convergent.status === "converged"
                                    ? "Converged"
                                    : "Running"}
                                </span>
                              </div>
                              <button
                                type="button"
                                onClick={() =>
                                  setExpandedConvergent((prev) => ({
                                    ...prev,
                                    [message.id]: !prev[message.id],
                                  }))
                                }
                                className="text-xs font-semibold text-[#475569] hover:text-[#0f172a] transition-colors"
                              >
                                {expandedConvergent[message.id] ? "Collapse" : "Expand"}
                              </button>
                            </div>

                            <div className="px-4 py-3 space-y-3">
                              <div>
                                {(() => {
                                  const meterScoreRaw = animatedConvergence[message.id] ?? message.convergent.score;
                                  const meterScore = Math.max(0, Math.min(100, Math.round(meterScoreRaw)));
                                  const phase = getConvergencePhase(meterScore);
                                  const phaseColor =
                                    phase === "Diverging"
                                      ? "text-red-600"
                                      : phase === "Balanced"
                                      ? "text-amber-600"
                                      : "text-emerald-600";

                                  return (
                                    <>
                                      <div className="flex items-center justify-between text-xs text-[#64748b] mb-1">
                                        <span>
                                          Convergence Meter
                                          {message.convergent.maxRounds > 0 && (
                                            <span>{` · Round ${message.convergent.round}/${message.convergent.maxRounds}`}</span>
                                          )}
                                        </span>
                                        <span className={`font-semibold ${phaseColor}`}>
                                          {phase} · {meterScore}%
                                        </span>
                                      </div>
                                      <div className="relative h-3 rounded-full bg-[#e2e8f0] overflow-hidden">
                                        <div
                                          className={`h-full rounded-full transition-[width] duration-700 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                                            message.convergent.status === "running" ? "animate-pulse" : ""
                                          }`}
                                          style={{
                                            width: `${meterScore}%`,
                                            background:
                                              meterScore < 40
                                                ? "linear-gradient(90deg,#f97316,#ef4444)"
                                                : meterScore < 75
                                                ? "linear-gradient(90deg,#f59e0b,#fbbf24)"
                                                : "linear-gradient(90deg,#10b981,#22c55e)",
                                          }}
                                        />
                                        <div
                                          className={`absolute top-1/2 -translate-y-1/2 w-3.5 h-3.5 rounded-full border-2 border-white shadow transition-[left] duration-700 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                                            message.convergent.status === "running" ? "animate-pulse" : ""
                                          }`}
                                          style={{
                                            left: `calc(${meterScore}% - 7px)`,
                                            background:
                                              meterScore < 40
                                                ? "#ef4444"
                                                : meterScore < 75
                                                ? "#f59e0b"
                                                : "#22c55e",
                                          }}
                                        />
                                      </div>
                                      <div className="mt-1.5 grid grid-cols-3 text-[10px] font-semibold uppercase tracking-wide">
                                        <span
                                          className={`text-left ${
                                            phase === "Diverging" ? "text-red-600" : "text-[#94a3b8]"
                                          }`}
                                        >
                                          Diverging
                                        </span>
                                        <span
                                          className={`text-center ${
                                            phase === "Balanced" ? "text-amber-600" : "text-[#94a3b8]"
                                          }`}
                                        >
                                          Balanced
                                        </span>
                                        <span
                                          className={`text-right ${
                                            phase === "Converging" ? "text-emerald-600" : "text-[#94a3b8]"
                                          }`}
                                        >
                                          Converging
                                        </span>
                                      </div>
                                    </>
                                  );
                                })()}
                              </div>

                              {expandedConvergent[message.id] && (
                                <div className="space-y-2">
                                  {message.convergent.logs.length === 0 && (
                                    <p className="text-xs text-[#64748b]">
                                      Initializing judge and debaters...
                                    </p>
                                  )}

                                  {message.convergent.logs.map((log) => (
                                    <div
                                      key={log.id}
                                      className={`rounded-xl border px-3 py-2 shadow-sm ${
                                        log.role === "judge"
                                          ? "border-[#dbeafe] bg-[#eff6ff]"
                                          : log.role === "debater_a"
                                          ? "border-[#e2e8f0] bg-white"
                                          : log.role === "debater_b"
                                          ? "border-[#fee2e2] bg-[#fff5f5]"
                                          : "border-[#dcfce7] bg-[#f0fdf4]"
                                      }`}
                                    >
                                      <div className="mb-1 flex items-center justify-between text-[11px]">
                                        <span className="font-semibold text-[#475569] uppercase tracking-wide">
                                          {log.role === "judge"
                                            ? "Judge"
                                            : log.role === "debater_a"
                                            ? "Debater A"
                                            : log.role === "debater_b"
                                            ? "Debater B"
                                            : "Executor"}
                                        </span>
                                        <span className="text-[#94a3b8]">
                                          {log.round > 0 ? `Round ${log.round}` : "Init"}
                                        </span>
                                      </div>
                                      <div className="prose prose-sm max-w-none prose-headings:text-[#2d2d2d] prose-p:text-[#334155] prose-strong:text-[#1f2937] prose-code:bg-[#f3f4f6] prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-pre:bg-[#1f2937] prose-pre:text-gray-100">
                                        {renderMarkdown(log.content || "")}
                                      </div>
                                    </div>
                                  ))}

                                  {message.convergent.clarifyingQuestions.length > 0 && (
                                    <div className="rounded-lg border border-[#f59e0b]/30 bg-[#fffbeb] px-3 py-2">
                                      <p className="text-xs font-semibold text-[#92400e] mb-1">
                                        Clarifying Questions from Judge
                                      </p>
                                      <ul className="list-disc pl-4 space-y-0.5 text-sm text-[#78350f]">
                                        {message.convergent.clarifyingQuestions.map((q, idx) => (
                                          <li key={`${message.id}-q-${idx}`}>{q}</li>
                                        ))}
                                      </ul>
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>
                        )}

                        {message.isStreaming &&
                          !message.content &&
                          !message.reasoning &&
                          !message.convergent && (
                            <div>
                              <div className="inline-flex items-center gap-1.5 rounded-full border border-[#e5e7eb] bg-[#f9fafb] px-3 py-1.5 text-[#6b7280]">
                                <span className="h-1.5 w-1.5 rounded-full bg-current animate-bounce" />
                                <span
                                  className="h-1.5 w-1.5 rounded-full bg-current animate-bounce"
                                  style={{ animationDelay: "120ms" }}
                                />
                                <span
                                  className="h-1.5 w-1.5 rounded-full bg-current animate-bounce"
                                  style={{ animationDelay: "240ms" }}
                                />
                              </div>
                            </div>
                          )}

                        {(message.content || (!message.reasoning && !message.isStreaming)) && (
                          <div>
                            <div className="prose prose-sm max-w-none prose-headings:text-[#2d2d2d] prose-p:text-[#334155] prose-p:leading-7 prose-strong:text-[#1f2937] prose-code:bg-[#f3f4f6] prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-pre:bg-[#1f2937] prose-pre:text-gray-100">
                              {renderMarkdown(message.content || "...")}
                              {message.isStreaming && message.content && (
                                <span className="inline-block w-2 h-4 bg-[#2d2d2d]/50 animate-pulse ml-1 align-middle" />
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </div>
            </main>

            {/* Chat input bar */}
            <div className="fixed bottom-0 right-0 p-4 bg-gradient-to-t from-[#fffaf2] to-transparent transition-all duration-200" style={{ left: sidebarWidth }}>
              <div className="w-full max-w-5xl mx-auto px-2 sm:px-4">
                <div className="bg-[#fffaf2] rounded-2xl border border-[#e5e7eb] shadow-sm overflow-hidden">
                  {attachedFile && (
                    <div className="px-4 pt-3">
                      <div className="flex items-center gap-3 rounded-xl border border-[#e5e7eb] bg-[#f8fafc] px-3 py-2">
                        {attachedFile.kind === "image" ? (
                          <Image
                            src={attachedFile.dataUrl}
                            alt={attachedFile.name}
                            width={48}
                            height={48}
                            unoptimized
                            className="h-12 w-12 rounded-md object-cover border border-[#d1d5db]"
                          />
                        ) : (
                          <div className="h-12 w-12 rounded-md border border-[#d1d5db] bg-white flex items-center justify-center text-[#dc2626]">
                            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 3h7l5 5v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z" />
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 3v6h6" />
                            </svg>
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-medium text-[#2d2d2d] truncate">
                            {attachedFile.name}
                          </p>
                          <p className="text-[11px] text-[#64748b]">
                            {attachedFile.kind === "pdf" ? "Analyzing PDF." : "Analyzing image."}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setAttachedFile(null);
                            setAttachmentError(null);
                          }}
                          className="text-[#9ca3af] hover:text-[#6b7280] transition-colors"
                          aria-label="Remove attachment"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  )}
                  {attachmentError && (
                    <div className="px-4 pt-3">
                      <p className="text-xs text-[#b45309] bg-[#fffbeb] border border-[#fde68a] rounded-lg px-3 py-2">
                        {attachmentError}
                      </p>
                    </div>
                  )}
                  <div className="px-4 pt-3 pb-2">
                    <div className="flex items-end gap-3">
                      <textarea
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            sendMessage();
                          }
                        }}
                        placeholder="Ask anything..."
                        className="min-h-[42px] max-h-40 w-full bg-transparent outline-none text-[#2d2d2d] placeholder-[#9ca3af] text-[15px] leading-6 resize-none overflow-y-auto whitespace-pre-wrap break-words"
                        rows={2}
                        disabled={isLoading}
                      />
                      <button
                        onClick={isLoading ? stopGeneration : sendMessage}
                        disabled={!isLoading && !input.trim() && !attachedFile}
                        className="w-8 h-8 mb-1 rounded-full bg-[#7c6bf5] text-white flex items-center justify-center hover:bg-[#6c5ce7] transition-colors disabled:opacity-30 disabled:cursor-not-allowed flex-shrink-0"
                        title={isLoading ? "Stop generation" : "Send message"}
                      >
                        {isLoading ? (
                          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none">
                            <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" />
                          </svg>
                        ) : (
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
                          </svg>
                        )}
                      </button>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 px-4 pb-3">
                    <button
                      type="button"
                      onClick={handleAttachClick}
                      className="p-1 rounded-md hover:bg-[#f3f4f6] transition-colors text-[#9ca3af] flex-shrink-0"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4.5 4.5 0 016.36 6.36l-9.2 9.19a3 3 0 01-4.24-4.24l8.49-8.48" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleConvergentToggle(!convergentEnabled)}
                      disabled={isLoading}
                      className={`h-8 px-3 rounded-lg border text-xs font-medium transition-colors flex-shrink-0 ${
                        convergentEnabled
                          ? "bg-[#2d2d2d] border-[#2d2d2d] text-white"
                          : "bg-[#fffaf2] border-[#e5e7eb] text-[#6b7280] hover:bg-[#f3f4f6]"
                      } disabled:opacity-60`}
                    >
                      ConvergentThinking {convergentEnabled ? "On" : "Off"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setWebSearchEnabled((prev) => !prev)}
                      disabled={isLoading}
                      className={`h-8 px-3 rounded-lg border text-xs font-medium transition-colors flex-shrink-0 ${
                        webSearchEnabled
                          ? "bg-[#1f2937] border-[#1f2937] text-white"
                          : "bg-[#fffaf2] border-[#e5e7eb] text-[#6b7280] hover:bg-[#f3f4f6]"
                      } disabled:opacity-60`}
                    >
                      Web Search {webSearchEnabled ? "On" : "Off"}
                    </button>
                    <span className="text-[11px] text-[#6b7280]">
                      Active: {convergentEnabled ? "30B" : "9B"}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Settings Panel */}
      {user && settingsOpen && (
        <SettingsPanel
          onClose={() => setSettingsOpen(false)}
          user={user}
          apiKey={openrouterApiKey}
          onApiKeyChange={(key) => setOpenrouterApiKey(key)}
          displayName={profileDisplayName}
          onDisplayNameChange={(name) => setProfileDisplayName(name)}
        />
      )}
    </div>
  );
}
