// ✅ Core Message Type - Used throughout the app
export interface Message {
  id: string;  // UUID for deduplication
  role: "user" | "assistant" | "system";
  content: string;  // Normalized text content
  timestamp: number;  // ms since epoch
  metadata?: {
    model: "text" | "vision";  // Which model generated response
    responseTime?: number;      // ms to generate
    tokensUsed?: number;        // Approx token count
  };
}

// ✅ Conversation - Groups related messages
export interface Conversation {
  id: string;  // UUID - conversation identifier
  sessionId: string;  // Device session identifier
  title: string;  // Auto-generated from first message
  messages: Message[];
  createdAt: number;
  updatedAt: number;
}

// ✅ Frontend Chat State - Manager for current conversation
export interface ChatState {
  currentConversationId: string | null;
  messages: Message[];  // All messages in current conversation
  currentResponse: string;  // Being streamed
  isLoading: boolean;
}

// ✅ Sidebar Display - Conversation summary for list
export interface SavedConversation {
  id: string;
  title: string;
  preview: string;  // First message preview
  lastMessage: Message;
  messageCount: number;
  createdAt: number;
}

// ✅ Response Metadata from API
export interface ResponseMetadata {
  model: "text" | "vision";
  responseTime: number;
  tokensUsed: number;
  isComplete?: boolean;  // Whether stream finished successfully
  protocolVersion?: string;  // For future compatibility
  streamDuration?: number;  // Actual streaming duration in ms
  charsReceived?: number;  // Characters received in stream
}

// ✅ Old HistoryItem (kept for migration)
export interface HistoryItem {
  query: string;
  answer: string;
}

// ==================== UTILITY FUNCTIONS ====================

/**
 * Extract string from Message content
 * Handles both simple strings and complex content arrays
 */
export function messageToString(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c?.type === "text")
      .map((c: any) => c?.text || "")
      .join(" ");
  }
  return "";
}

/**
 * Generate UUID v4
 */
export function generateUUID(): string {
  return crypto.randomUUID();
}

/**
 * Get or create session ID (stored in localStorage)
 * Acts as device identifier when authentication is not available
 */
export function getSessionId(): string {
  let sessionId = localStorage.getItem("__sessionId");
  if (!sessionId) {
    sessionId = generateUUID();
    localStorage.setItem("__sessionId", sessionId);
  }
  return sessionId;
}

/**
 * Generate conversation title from first message
 * Truncates long messages to 50 characters
 */
export function generateConversationTitle(firstMessage: string): string {
  const maxLength = 50;
  let title = firstMessage.split("\n")[0].trim();
  if (title.length > maxLength) {
    title = title.substring(0, maxLength) + "...";
  }
  return title || "New Conversation";
}

/**
 * Estimate token count from text
 * Groq models typically use ~4 characters per token
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Format timestamp for display
 */
export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Migrate old HistoryItem format to new Message format
 * Used when loading legacy localStorage data
 */
export function migrateHistoryToMessages(
  oldHistory: HistoryItem[],
  conversationId: string
): Message[] {
  const messages: Message[] = [];
  const now = Date.now();

  // Reverse to maintain chronological order
  oldHistory.reverse().forEach((item, index) => {
    // User message
    messages.push({
      id: generateUUID(),
      role: "user",
      content: item.query,
      timestamp: now + index * 1000,  // Stagger timestamps
      metadata: { model: "text" },
    });

    // Assistant message
    messages.push({
      id: generateUUID(),
      role: "assistant",
      content: item.answer,
      timestamp: now + index * 1000 + 500,
      metadata: { model: "text" },
    });
  });

  return messages;
}
