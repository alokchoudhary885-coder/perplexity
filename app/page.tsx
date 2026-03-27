"use client";
import { useState, useEffect, useRef } from "react";
import {
  Message,
  Conversation,
  ChatState,
  SavedConversation,
  ResponseMetadata,
  generateUUID,
  getSessionId,
  generateConversationTitle,
  estimateTokens,
  migrateHistoryToMessages,
} from "@/lib/types";
import * as db from "@/lib/db";
import {
  createStreamBatcher,
  createStreamTimeout,
  parseStreamChunk,
  estimateReadingTime,
  estimateProgressPercentage,
  StreamManager,
} from "@/lib/streaming";
import { ChatBubble, ChatContainer } from "@/components/ChatBubble";

// Legacy HistoryItem for migration
type HistoryItem = {
  query: string;
  answer: string;
};

// Suggested Question Type
type SuggestedQuestion = {
  text: string;
};

export default function Home() {
  // 🔴 Chat State (replaces old query + answer + history)
  const [chatState, setChatState] = useState<ChatState>({
    currentConversationId: null,
    messages: [],
    currentResponse: "",
    isLoading: false,
    pagination: {
      offset: 0,
      totalMessages: 0,
      isLoadingOlder: false,
      hasMore: false,
    },
  });

  // 📋 Conversations List (for sidebar)
  const [conversations, setConversations] = useState<SavedConversation[]>([]);

  // 🎤 Voice & Speech
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);

  // 📁 File attachment
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileType, setFileType] = useState<string>("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 💭 Input field & suggestions
  const [query, setQuery] = useState("");
  const [suggestedQuestions, setSuggestedQuestions] =
    useState<SuggestedQuestion[]>([]);

  // 📱 Mobile sidebar
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  // 🔧 Refs
  const abortControllerRef = useRef<AbortController | null>(null);

  // ==================== LIFECYCLE ====================

  /**
   * Initialize session and load conversations on mount
   */
  useEffect(() => {
    const initializeSession = async () => {
      const sessionId = getSessionId();

      // Load conversations from Supabase (or empty if not configured)
      try {
        if (db.isSupabaseConfigured()) {
          const convs = await db.getSessionConversations(sessionId);
          setConversations(convs);
        }
      } catch (error) {
        console.warn("Could not load conversations from Supabase:", error);
      }

      // Migrate old localStorage history if it exists
      const oldHistory = localStorage.getItem("chatHistory");
      if (oldHistory) {
        try {
          const parsed: HistoryItem[] = JSON.parse(oldHistory);
          const conversationId = generateUUID();
          const messages = migrateHistoryToMessages(
            parsed,
            conversationId
          );

          // Save migrated conversation
          try {
            await db.saveConversation(sessionId, conversationId, "Migrated Chats");
            await db.saveMessages(conversationId, messages);
          } catch {
            // Supabase not configured, just use localStorage
            localStorage.setItem(
              `conv_${conversationId}`,
              JSON.stringify(messages)
            );
          }

          localStorage.removeItem("chatHistory"); // Clean up old format
        } catch (error) {
          console.error("Migration failed:", error);
        }
      }
    };

    initializeSession();
  }, []);

  /**
   * Stop speech synthesis on unmount
   */
  useEffect(() => {
    return () => {
      window.speechSynthesis.cancel();
    };
  }, []);

  // ==================== CONVERSATION MANAGEMENT ====================

  /**
   * Start a new conversation
   */
  const startNewChat = () => {
    setQuery("");
    setChatState({
      currentConversationId: null,
      messages: [],
      currentResponse: "",
      isLoading: false,
      pagination: {
        offset: 0,
        totalMessages: 0,
        isLoadingOlder: false,
        hasMore: false,
      },
    });
    setSelectedFile(null);
    setSuggestedQuestions([]);
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    window.speechSynthesis.cancel();
    setIsSpeaking(false);
    setIsSidebarOpen(false);
  };

  /**
   * Load a saved conversation with pagination support
   */
  const loadConversation = async (conversationId: string, isLoadingOlder = false) => {
    try {
      const currentOffset = isLoadingOlder ? (chatState.pagination?.offset || 0) + 50 : 0;

      // Load messages with pagination
      const messages = await db.getFullConversation(conversationId, 50, currentOffset);

      // Get total message count for pagination state
      const totalCount = await db.getTotalMessageCount(conversationId);

      const hasMore = currentOffset + 50 < totalCount;

      if (isLoadingOlder) {
        // Prepend older messages
        setChatState((prev) => ({
          ...prev,
          messages: [...messages, ...prev.messages],
          pagination: {
            offset: currentOffset,
            totalMessages: totalCount,
            isLoadingOlder: false,
            hasMore,
          },
        }));
      } else {
        // Initial load - set all messages
        setChatState({
          currentConversationId: conversationId,
          messages,
          currentResponse: "",
          isLoading: false,
          pagination: {
            offset: currentOffset,
            totalMessages: totalCount,
            isLoadingOlder: false,
            hasMore,
          },
        });
      }
      setIsSidebarOpen(false);
    } catch (error) {
      console.error("Failed to load conversation:", error);
    }
  };

  /**
   * Load older messages (infinite scroll up)
   */
  const loadOlderMessages = async () => {
    if (
      !chatState.currentConversationId ||
      chatState.pagination?.isLoadingOlder ||
      !chatState.pagination?.hasMore
    ) {
      return;
    }

    setChatState((prev) => ({
      ...prev,
      pagination: {
        ...prev.pagination!,
        isLoadingOlder: true,
      },
    }));

    await loadConversation(chatState.currentConversationId, true);
  };

  /**
   * Delete a conversation
   */
  const deleteConversation = async (
    e: React.MouseEvent,
    conversationId: string
  ) => {
    e.stopPropagation();
    try {
      await db.deleteConversation(conversationId);
      setConversations((prev) =>
        prev.filter((conv) => conv.id !== conversationId)
      );
      if (chatState.currentConversationId === conversationId) {
        startNewChat();
      }
    } catch (error) {
      console.error("Failed to delete conversation:", error);
    }
  };

  /**
   * Reload conversations list from database
   */
  const reloadConversations = async () => {
    try {
      const sessionId = getSessionId();
      const convs = await db.getSessionConversations(sessionId);
      setConversations(convs);
    } catch (error) {
      console.warn("Could not reload conversations:", error);
    }
  };

  // ==================== FILE & VOICE HANDLING ====================

  /**
   * Handle file selection for image attachment
   */
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64String = reader.result as string;
        const base64Data = base64String.split(",")[1];
        setSelectedFile(base64Data);
        setFileType(file.type);
      };
      reader.readAsDataURL(file);
    }
  };

  /**
   * Start voice input with Speech Recognition API
   */
  const startListening = () => {
    if ("webkitSpeechRecognition" in window || "SpeechRecognition" in window) {
      const SpeechRecognition = (window as any).webkitSpeechRecognition ||
        (window as any).SpeechRecognition;
      const recognition = new SpeechRecognition();
      recognition.lang = "en-US";
      recognition.interimResults = false;
      setIsListening(true);
      recognition.start();

      recognition.onresult = (event: any) => {
        const transcript = event.results[0][0].transcript;
        setQuery(transcript);
        setIsListening(false);
        handleSearch(transcript);
      };

      recognition.onerror = () => setIsListening(false);
      recognition.onend = () => setIsListening(false);
    } else {
      alert("Browser does not support voice search!");
    }
  };

  /**
   * Text-to-speech for answer
   */
  const handleSpeak = () => {
    if (!chatState.currentResponse && chatState.messages.length === 0) return;

    const textToSpeak =
      chatState.currentResponse ||
      chatState.messages[chatState.messages.length - 1]?.content ||
      "";

    if (isSpeaking) {
      window.speechSynthesis.cancel();
      setIsSpeaking(false);
    } else {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(textToSpeak);
      utterance.rate = 1;
      utterance.onend = () => setIsSpeaking(false);
      window.speechSynthesis.speak(utterance);
      setIsSpeaking(true);
    }
  };

  // ==================== SEARCH & STREAMING ====================

  /**
   * Main search function with optimized streaming and debounced updates
   */
  const handleSearch = async (manualQuery?: string) => {
    const searchQuery = manualQuery || query;
    if (!searchQuery.trim()) return;

    // Abort previous request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    window.speechSynthesis.cancel();
    setIsSpeaking(false);

    try {
      // Create abort signal with 30-second timeout
      abortControllerRef.current = new AbortController();
      const timeoutSignal = createStreamTimeout(30000);

      // Race between user abort and timeout
      const abortSignal = AbortSignal.any([
        abortControllerRef.current.signal,
        timeoutSignal,
      ]);

      // Create or get conversation
      let conversationId = chatState.currentConversationId;
      if (!conversationId) {
        conversationId = generateUUID();
        const title = generateConversationTitle(searchQuery);

        try {
          await db.saveConversation(getSessionId(), conversationId, title);
        } catch (error) {
          console.warn("Could not save conversation to Supabase:", error);
          localStorage.setItem(`conv_${conversationId}`, JSON.stringify([]));
        }
      }

      // Create user message optimistically
      const userMessage: Message = {
        id: generateUUID(),
        role: "user",
        content: searchQuery,
        timestamp: Date.now(),
        metadata: { model: selectedFile ? "vision" : "text" },
      };

      const updatedMessages = [...chatState.messages, userMessage];
      setChatState((prev) => ({
        ...prev,
        messages: updatedMessages,
        currentResponse: "",
        isLoading: true,
        currentConversationId: conversationId,
      }));

      // Build conversation history (last 5 messages for context)
      const conversationHistory = updatedMessages
        .slice(-5)
        .map((m) => ({
          role: m.role,
          content: m.content,
        }));

      // Fetch response from API
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: searchQuery,
          fileData: selectedFile,
          mimeType: fileType,
          conversationHistory,
          conversationId,
        }),
        signal: abortSignal,
      });

      if (!res.ok || !res.body) {
        throw new Error(`API error: ${res.status}`);
      }

      // ✅ Setup debounced updates to prevent excessive re-renders
      const batcher = createStreamBatcher(
        (text) => {
          setChatState((prev) => ({
            ...prev,
            currentResponse: text,
          }));
        },
        { maxChars: 500, delayMs: 100 }
      );

      // Parse streaming response with metadata
      let metadata: ResponseMetadata = {
        model: selectedFile ? "vision" : "text",
        responseTime: 0,
        tokensUsed: 0,
        isComplete: false,
      };
      let fullAnswer = "";
      let firstLine = true;
      const responseStart = Date.now();
      const streamManager = new StreamManager();
      let streamedBytes = 0;
      let isStreamAborted = false;

      // ✅ Use StreamManager for better error handling
      const { success, error } = await streamManager.readStream(
        res,
        (chunk) => {
          try {
            if (firstLine && chunk.includes("\n")) {
              const lines = chunk.split("\n");
              try {
                // Parse metadata from first line
                const parsed = JSON.parse(lines[0]);
                metadata = { ...metadata, ...parsed };
                fullAnswer = lines.slice(1).join("\n");
              } catch {
                fullAnswer = chunk;
              }
              firstLine = false;
            } else {
              fullAnswer += chunk;
            }

            streamedBytes += chunk.length;
            // Use debatcher for batched updates
            batcher.add(chunk);
          } catch (err) {
            console.error("Chunk processing error:", err);
            isStreamAborted = true;
          }
        },
        (err) => {
          console.error("Stream error:", err);
          isStreamAborted = true;
        }
      );

      // ✅ Mark as complete
      metadata.isComplete = success && !isStreamAborted;
      metadata.streamDuration = Date.now() - responseStart;
      metadata.charsReceived = streamedBytes;

      // Flush any remaining buffered text
      batcher.flush();

      // Extract suggested questions
      const suggested = extractSuggestedQuestions(fullAnswer);
      setSuggestedQuestions(suggested);

      // ✅ Create assistant message with complete metadata
      const assistantMessage: Message = {
        id: generateUUID(),
        role: "assistant",
        content: fullAnswer,
        timestamp: Date.now(),
        metadata: {
          model: metadata.model,
          responseTime: metadata.streamDuration || Date.now() - responseStart,
          tokensUsed: estimateTokens(fullAnswer),
        },
      };

      // Save to database
      try {
        await db.saveMessages(conversationId, [
          userMessage,
          assistantMessage,
        ]);
      } catch (error) {
        console.warn("Could not save to Supabase:", error);
        const conv = localStorage.getItem(`conv_${conversationId}`);
        const existing = conv ? JSON.parse(conv) : [];
        localStorage.setItem(
          `conv_${conversationId}`,
          JSON.stringify([...existing, userMessage, assistantMessage])
        );
      }

      // If stream was incomplete, add error indicator
      if (!metadata.isComplete && fullAnswer.length > 0) {
        console.warn("Stream incomplete - response may be truncated");
        // Response will still be saved but marked as incomplete
      }

      // Update state
      setChatState((prev) => ({
        ...prev,
        messages: [...prev.messages, assistantMessage],
        currentResponse: "",
        isLoading: false,
      }));

      // Reload conversations list
      await reloadConversations();
      setQuery("");
      setSelectedFile(null);
    } catch (error: any) {
      const isAbort = error.name === "AbortError";
      const isTimeout = error.message?.includes("The operation was aborted");

      if (isAbort || isTimeout) {
        console.warn("Request cancelled or timed out");
        setChatState((prev) => ({
          ...prev,
          isLoading: false,
          currentResponse: prev.currentResponse +
            (prev.currentResponse ? "\n\n" : "") +
            "⏱️ **Request timed out** - Stream took longer than 30 seconds. Please try again.",
        }));
      } else {
        console.error("Search error:", error);
        setChatState((prev) => ({
          ...prev,
          isLoading: false,
          currentResponse: prev.currentResponse +
            (prev.currentResponse ? "\n\n" : "") +
            `❌ **Error**: ${error.message || "Failed to fetch response"}`,
        }));
      }
    }
  };

  /**
   * Extract suggested questions from response
   */
  const extractSuggestedQuestions = (text: string): SuggestedQuestion[] => {
    const questions =
      text.match(
        /\b(?:What|How|Why|When|Where|Which|Who|Can|Does|Is|Would|Could|Should|Will|Have|Do)[^?]*\?/g
      ) || [];
    const uniqueQuestions = Array.from(new Set(questions))
      .filter((q) => q.length > 20 && q.length < 150)
      .slice(-3);
    return uniqueQuestions.map((q) => ({ text: q.trim() }));
  };

  // ==================== COPY MESSAGE HANDLER ====================

  const handleCopyMessage = (message: Message) => {
    let text = message.content;
    if (message.metadata && message.role === "assistant") {
      text += `\n\n---\nModel: ${message.metadata.model}\nTime: ${message.metadata.responseTime}ms`;
    }
    navigator.clipboard.writeText(text);
    alert("Copied to clipboard!");
  };

  // ==================== RENDER ====================

  const loading = chatState.isLoading;
  const answer = chatState.currentResponse;

  return (
    <div className="flex h-screen bg-gray-950 text-gray-200 font-sans overflow-hidden selection:bg-blue-500/30">
      {/* 📱 Mobile Overlay */}
      {isSidebarOpen && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 md:hidden"
          onClick={() => setIsSidebarOpen(false)}
        />
      )}

      {/* 🟢 SIDEBAR */}
      <div
        className={`
        fixed md:relative z-50 h-full w-72 bg-gradient-to-b from-gray-900 via-gray-950 to-gray-950 md:bg-gray-900/50 backdrop-blur-xl border-r border-white/10
        transition-transform duration-300 md:translate-x-0 ease-out
        ${isSidebarOpen ? "translate-x-0" : "-translate-x-full md:flex"}
        flex flex-col shadow-2xl md:shadow-none
      `}
      >
        <div className="p-6 border-b border-white/5 flex justify-between items-center bg-gradient-to-r from-gray-900/50 to-transparent">
          <h1 className="text-xl font-bold tracking-tight text-white flex items-center gap-2 group cursor-default">
            <span className="text-blue-500 text-2xl group-hover:scale-110 transition-transform duration-300">
              ⚡
            </span>{" "}
            Perplexity
          </h1>
          <button
            onClick={() => setIsSidebarOpen(false)}
            className="md:hidden text-gray-400 hover:text-white hover:bg-gray-800/50 rounded-lg p-1.5 transition-all duration-300"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        <div className="p-4">
          <button
            onClick={startNewChat}
            className="w-full bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-500 hover:to-blue-400 text-white py-3 px-4 rounded-xl flex items-center justify-center gap-2 transition-all shadow-lg hover:shadow-blue-500/50 font-medium group active:scale-95"
          >
            <span className="group-hover:rotate-90 transition-transform duration-300">
              ➕
            </span>{" "}
            New Thread
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-2 scrollbar-thin scrollbar-thumb-gray-800">
          <h3 className="text-[10px] font-bold text-gray-500 uppercase px-4 mb-4 tracking-[0.2em]">
            Library
          </h3>
          <div className="space-y-2">
            {conversations.length > 0 ? (
              conversations.map((conv) => (
                <div
                  key={conv.id}
                  onClick={() => loadConversation(conv.id)}
                  className="group flex items-center gap-3 px-4 py-3 hover:bg-white/5 rounded-xl cursor-pointer transition-all duration-300 border border-transparent hover:border-white/10 hover:shadow-lg hover:shadow-blue-500/5 relative"
                >
                  <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-600/20 to-purple-600/20 flex items-center justify-center text-xs group-hover:from-blue-600/40 group-hover:to-purple-600/40 group-hover:text-blue-300 transition-all duration-300">
                    💬
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="truncate text-xs font-medium text-gray-400 group-hover:text-white transition-colors">
                      {conv.title}
                    </p>
                    <p className="truncate text-xs text-gray-600 group-hover:text-gray-500 mt-1">
                      {conv.messageCount} messages
                    </p>
                  </div>
                  <button
                    onClick={(e) => deleteConversation(e, conv.id)}
                    className="opacity-0 group-hover:opacity-100 p-1 hover:text-red-400 hover:bg-red-500/10 rounded text-gray-500 transition-all duration-200"
                  >
                    🗑️
                  </button>
                </div>
              ))
            ) : (
              <p className="px-4 text-xs text-gray-600 italic">
                No chats yet...
              </p>
            )}
          </div>
        </div>

        <div className="p-4 border-t border-white/5 bg-gradient-to-t from-gray-900/50 to-transparent">
          <div className="flex items-center gap-3 bg-gradient-to-r from-gray-800/50 to-gray-800/30 hover:from-gray-800/70 hover:to-gray-800/50 p-3 rounded-xl border border-white/5 transition-all duration-300 cursor-pointer group">
            <div className="w-10 h-10 bg-gradient-to-tr from-blue-500 via-blue-600 to-purple-500 rounded-full flex items-center justify-center text-xs font-bold text-white shadow-lg group-hover:shadow-blue-500/50 group-hover:scale-105 transition-all duration-300">
              AC
            </div>
            <div>
              <p className="text-xs text-gray-400">Developed by</p>
              <div className="text-sm font-bold text-white">Aalok C.</div>
            </div>
          </div>
        </div>
      </div>

      {/* 🔵 MAIN CONTENT AREA */}
      <div className="flex-1 flex flex-col items-center relative overflow-hidden w-full">
        {/* Mobile Navbar Toggle */}
        <div className="w-full p-4 flex md:hidden items-center justify-between z-30 bg-gradient-to-b from-gray-950/80 to-transparent backdrop-blur-sm">
          <button
            onClick={() => setIsSidebarOpen(true)}
            className="p-2 bg-gray-800/50 hover:bg-gray-700/50 rounded-lg text-white transition-all duration-300 hover:scale-105 active:scale-95"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          <span className="font-bold text-sm text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-blue-500">
            ⚡ Perplexity
          </span>
          <div className="w-10"></div>
        </div>

        <div className="absolute top-0 left-0 w-full h-full bg-gradient-to-b from-gray-900 to-black -z-10"></div>

        <div className="flex-1 w-full max-w-3xl flex flex-col p-4 md:p-6 overflow-y-auto z-10 scrollbar-hide">
          {/* Welcome State */}
          {chatState.messages.length === 0 && !loading && (
            <div className="flex-1 flex flex-col items-center justify-center text-center">
              <div className="mb-8 relative">
                <div className="absolute inset-0 bg-gradient-to-r from-blue-500 via-purple-500 to-blue-500 rounded-full blur-3xl opacity-20 animate-pulse"></div>
                <h1 className="relative text-5xl md:text-7xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-white via-gray-300 to-gray-500 mb-4 pb-2 leading-tight">
                  Where knowledge <br /> begins.
                </h1>
              </div>
              <p className="text-gray-400 text-sm md:text-base max-w-md mb-8">
                Ask anything and get instant, well-sourced answers powered by AI.
              </p>
            </div>
          )}

          {/* Input Area */}
          <div
            className={`w-full transition-all duration-500 ${
              chatState.messages.length === 0 && !loading
                ? "mb-auto"
                : "sticky top-0 pt-2 pb-4 bg-gray-950/80 backdrop-blur-xl z-50"
            }`}
          >
            {selectedFile && (
              <div className="mb-3 relative w-fit animate-in fade-in zoom-in duration-300">
                <div className="bg-gradient-to-r from-blue-600/30 to-purple-600/30 backdrop-blur-sm border border-blue-500/50 px-3 py-1.5 rounded-lg flex items-center gap-2 shadow-lg shadow-blue-500/10">
                  <span className="text-lg">🖼️</span>
                  <span className="text-[10px] text-blue-300 font-bold uppercase tracking-tight">
                    Image Attached
                  </span>
                  <button
                    onClick={() => setSelectedFile(null)}
                    className="text-gray-300 hover:text-red-400 transition ml-1 hover:scale-125"
                  >
                    ✕
                  </button>
                </div>
              </div>
            )}

            <div className="relative group">
              <div className="absolute -inset-0.5 bg-gradient-to-r from-blue-500 via-purple-500 to-blue-500 rounded-full opacity-20 group-focus-within:opacity-100 transition duration-500 blur group-hover:opacity-75"></div>

              <div className="relative flex items-center bg-gradient-to-br from-[#1e1e1e] to-[#0a0a0a] border border-gray-700/50 group-focus-within:border-blue-500/50 rounded-full px-3 md:px-4 py-2.5 md:py-4 shadow-2xl transition-all duration-300 group-hover:shadow-blue-500/10">
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={handleFileChange}
                  className="hidden"
                  accept="image/*"
                />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="p-2 text-gray-400 hover:text-blue-400 transition-all duration-300 hover:scale-125 hover:bg-gray-800/30 rounded-lg"
                  title="Attach image"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                  </svg>
                </button>

                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Ask anything..."
                  className="w-full bg-transparent text-white px-2 outline-none placeholder-gray-600 text-sm md:text-lg font-medium transition-colors duration-300 focus:placeholder-gray-500"
                  onKeyDown={(e) =>
                    e.key === "Enter" && !loading && handleSearch()
                  }
                />

                {loading && (
                  <div className="flex gap-1 mr-2">
                    <span className="w-1 h-1 bg-blue-400 rounded-full animate-pulse"></span>
                    <span className="w-1 h-1 bg-blue-400 rounded-full animate-pulse animation-delay-100"></span>
                    <span className="w-1 h-1 bg-blue-400 rounded-full animate-pulse animation-delay-200"></span>
                  </div>
                )}

                <button
                  onClick={startListening}
                  className={`p-2 rounded-lg transition-all duration-300 hover:scale-125 hover:bg-gray-800/30 ${
                    isListening
                      ? "text-red-400 bg-red-500/20 animate-pulse"
                      : "text-gray-400 hover:text-blue-400"
                  }`}
                  title={isListening ? "Listening..." : "Voice input"}
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                    <line x1="12" x2="12" y1="19" y2="22" />
                  </svg>
                </button>

                <button
                  onClick={() => handleSearch()}
                  disabled={loading || !query.trim()}
                  className="bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-500 hover:to-blue-400 disabled:from-gray-600 disabled:to-gray-500 disabled:cursor-not-allowed text-white p-2.5 rounded-full transition-all duration-300 shadow-lg hover:shadow-blue-500/50 hover:scale-110 disabled:scale-100 active:scale-95"
                  title="Send query"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M5 12h14" />
                    <path d="m12 5 7 7-7 7" />
                  </svg>
                </button>
              </div>
            </div>
          </div>

          {/* Result Area */}
          <div className="w-full mt-4 pb-10">
            {loading && (
              <div className="space-y-4 max-w-2xl mx-auto mt-6 animate-in fade-in">
                <div className="flex items-center gap-3 text-blue-400">
                  <div className="flex gap-1">
                    <span className="w-2 h-2 bg-blue-400 rounded-full animate-pulse"></span>
                    <span className="w-2 h-2 bg-blue-400 rounded-full animate-pulse animation-delay-100"></span>
                    <span className="w-2 h-2 bg-blue-400 rounded-full animate-pulse animation-delay-200"></span>
                  </div>
                  <span className="font-medium text-sm">Thinking...</span>
                </div>
                <div className="space-y-3">
                  <div className="h-4 bg-gradient-to-r from-gray-800 via-gray-700 to-gray-800 rounded-lg animate-pulse w-3/4"></div>
                  <div className="h-4 bg-gradient-to-r from-gray-800 via-gray-700 to-gray-800 rounded-lg animate-pulse w-full"></div>
                  <div className="h-4 bg-gradient-to-r from-gray-800 via-gray-700 to-gray-800 rounded-lg animate-pulse w-5/6"></div>
                </div>
              </div>
            )}

            {/* Chat bubbles for history (excluding current) */}
            {chatState.messages.length > 0 && (
              <div className="max-w-3xl mx-auto mb-4">
                <ChatContainer
                  messages={chatState.messages.filter(
                    (m) => m.role !== "assistant" || m.content
                  )}
                  onCopy={handleCopyMessage}
                />
              </div>
            )}

            {/* Loading / Streaming Response Card */}
            {loading && answer && (
              <div className="max-w-3xl mx-auto pb-4 animate-in fade-in duration-300">
                <div className="bg-gradient-to-br from-blue-900/30 to-gray-950/50 backdrop-blur-xl p-5 md:p-8 rounded-2xl border border-blue-500/20 shadow-2xl relative overflow-hidden">
                  <div className="absolute inset-0 bg-gradient-to-br from-blue-500/10 via-transparent to-purple-500/5"></div>
                  <div className="relative z-10">
                    <div className="flex items-center gap-2 mb-4">
                      <div className="flex gap-1">
                        <span className="w-2 h-2 bg-blue-400 rounded-full animate-pulse" />
                        <span className="w-2 h-2 bg-blue-400 rounded-full animate-pulse" style={{ animationDelay: "0.2s" }} />
                        <span className="w-2 h-2 bg-blue-400 rounded-full animate-pulse" style={{ animationDelay: "0.4s" }} />
                      </div>
                      <span className="text-sm text-blue-300 font-medium">Streaming response...</span>
                    </div>
                    <p className="text-gray-200 leading-relaxed text-sm md:text-base whitespace-pre-wrap font-light">
                      {answer}
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Current Response Card */}
            {!loading && answer && (
              <div className="max-w-3xl mx-auto pb-4 animate-in fade-in duration-500">
                <div className="bg-gradient-to-br from-gray-900/50 to-gray-950/50 backdrop-blur-xl p-5 md:p-8 rounded-2xl border border-blue-500/10 shadow-2xl relative overflow-hidden group">
                  {/* Background glow effect */}
                  <div className="absolute inset-0 bg-gradient-to-br from-blue-500/5 via-transparent to-purple-500/5 opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>

                  {/* Header with controls */}
                  <div className="flex items-center justify-between mb-5 border-b border-gray-700/30 pb-4 relative z-10">
                    <div className="flex items-center gap-3">
                      <div className="bg-blue-600/20 p-2 rounded-lg text-blue-400 backdrop-blur-sm">
                        <svg
                          className="w-5 h-5"
                          fill="currentColor"
                          viewBox="0 0 20 20"
                        >
                          <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                        </svg>
                      </div>
                      <div>
                        <h2 className="text-sm font-semibold text-white">
                          Answer
                        </h2>
                        <p className="text-xs text-gray-400 mt-1">
                          {chatState.messages.at(-1)?.metadata?.model ===
                          "vision"
                            ? "🖼️ Vision"
                            : "📝 Text"}{" "}
                          •{" "}
                          {chatState.messages.at(-1)?.metadata?.responseTime}ms
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 relative z-10">
                      <button
                        onClick={() => {
                          const msg = chatState.messages.at(-1);
                          if (msg) handleCopyMessage(msg);
                        }}
                        className="p-2.5 rounded-lg hover:bg-gray-800/80 text-gray-400 hover:text-blue-400 transition-all duration-300 hover:scale-110"
                        title="Copy answer"
                      >
                        <svg
                          className="w-5 h-5"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                          />
                        </svg>
                      </button>
                      <button
                        onClick={() => handleSearch(query)}
                        className="p-2.5 rounded-lg hover:bg-gray-800/80 text-gray-400 hover:text-blue-400 transition-all duration-300 hover:scale-110"
                        title="Regenerate answer"
                      >
                        <svg
                          className="w-5 h-5"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                          />
                        </svg>
                      </button>
                      <button
                        onClick={handleSpeak}
                        className={`p-2.5 rounded-lg transition-all duration-300 hover:scale-110 ${
                          isSpeaking
                            ? "bg-blue-500/20 text-blue-400"
                            : "hover:bg-gray-800/80 text-gray-400 hover:text-blue-400"
                        }`}
                        title={isSpeaking ? "Pause" : "Speak"}
                      >
                        {isSpeaking ? "⏸️" : "🔊"}
                      </button>
                    </div>
                  </div>

                  {/* Answer text */}
                  <p className="text-gray-200 leading-relaxed text-sm md:text-base whitespace-pre-wrap font-light relative z-10">
                    {answer}
                  </p>

                  {/* Word count */}
                  <p className="text-xs text-gray-500 mt-4 relative z-10">
                    {answer.split(/\s+/).length} words •{" "}
                    {Math.ceil(answer.split(/\s+/).length / 200)} min read
                  </p>
                </div>

                {/* Suggested Questions */}
                {suggestedQuestions.length > 0 && (
                  <div className="mt-8 max-w-3xl mx-auto animate-in fade-in slide-in-from-bottom-4 duration-500">
                    <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3">
                      Related Questions
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {suggestedQuestions.map((q, idx) => (
                        <button
                          key={idx}
                          onClick={() => handleSearch(q.text)}
                          className="text-left p-3 rounded-lg bg-gray-900/50 hover:bg-gray-800/70 border border-gray-700/50 hover:border-blue-500/30 text-sm text-gray-300 hover:text-white transition-all duration-300 hover:shadow-lg hover:shadow-blue-500/10"
                        >
                          {q.text}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
