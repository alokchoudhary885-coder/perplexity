import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { Message, Conversation, SavedConversation, ResponseMetadata } from "./types";

// ✅ Lazy-initialized Supabase Client
let supabaseInstance: SupabaseClient | null = null;

function getSupabaseClient(): SupabaseClient | null {
  if (supabaseInstance) return supabaseInstance;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    return null;
  }

  supabaseInstance = createClient(url, key);
  return supabaseInstance;
}

// ==================== CONVERSATION OPERATIONS ====================

/**
 * Save new conversation metadata to Supabase
 * Called when user sends their first message in a new conversation
 */
export async function saveConversation(
  sessionId: string,
  conversationId: string,
  title: string
): Promise<void> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error("Supabase not configured");

  const now = Date.now();

  const { error } = await supabase.from("conversations").insert({
    id: conversationId,
    session_id: sessionId,
    title,
    created_at: now,
    updated_at: now,
    message_count: 0,
  });

  if (error) {
    console.error("Error saving conversation:", error);
    throw error;
  }
}

/**
 * Get all conversations for a session (sorted by most recent)
 * Used to populate sidebar conversation list
 */
export async function getSessionConversations(
  sessionId: string
): Promise<SavedConversation[]> {
  const supabase = getSupabaseClient();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("conversation_summaries")
    .select("*")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Error fetching conversations:", error);
    // Return empty array to allow graceful degradation
    return [];
  }

  return (data || []).map((row: any) => ({
    id: row.id,
    title: row.title,
    preview: row.last_message_preview || "No messages",
    lastMessage: {
      id: "",
      role: "assistant",
      content: row.last_message_preview || "",
      timestamp: row.created_at,
    },
    messageCount: row.message_count,
    createdAt: row.created_at,
  }));
}

/**
 * Update conversation title (allows user renaming)
 */
export async function updateConversationTitle(
  conversationId: string,
  newTitle: string
): Promise<void> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error("Supabase not configured");

  const { error } = await supabase
    .from("conversations")
    .update({
      title: newTitle,
      updated_at: Date.now(),
    })
    .eq("id", conversationId);

  if (error) {
    console.error("Error updating conversation title:", error);
    throw error;
  }
}

/**
 * Delete conversation and all its messages
 */
export async function deleteConversation(conversationId: string): Promise<void> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error("Supabase not configured");

  // Messages will cascade delete due to ON DELETE CASCADE in schema
  const { error } = await supabase
    .from("conversations")
    .delete()
    .eq("id", conversationId);

  if (error) {
    console.error("Error deleting conversation:", error);
    throw error;
  }
}

// ==================== MESSAGE OPERATIONS ====================

/**
 * Save messages to a conversation
 * Called after each response to persist user and assistant messages
 */
export async function saveMessages(
  conversationId: string,
  messages: Message[]
): Promise<void> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error("Supabase not configured");

  // Prepare messages for insertion
  const messagesToInsert = messages.map((msg) => ({
    id: msg.id,
    conversation_id: conversationId,
    role: msg.role,
    content: msg.content,
    created_at: msg.timestamp,
    metadata: msg.metadata || {
      model: "text",
      responseTime: 0,
      tokensUsed: 0,
    },
  }));

  const { error } = await supabase
    .from("messages")
    .insert(messagesToInsert);

  if (error) {
    console.error("Error saving messages:", error);
    throw error;
  }

  // Update conversation's updated_at and message_count
  const { error: updateError } = await supabase
    .from("conversations")
    .update({
      updated_at: Date.now(),
      message_count: messagesToInsert.length,
    })
    .eq("id", conversationId);

  if (updateError) {
    console.error("Error updating conversation metadata:", updateError);
    // Don't throw - messages were saved, just metadata update failed
  }
}

/**
 * Get conversation history with specified limit
 * Used to load messages when user opens a conversation
 * Default limit of 5 is for the backend to use for context
 */
export async function getConversationHistory(
  conversationId: string,
  limit: number = 5
): Promise<Message[]> {
  const supabase = getSupabaseClient();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })  // Oldest first
    .limit(limit);

  if (error) {
    console.error("Error fetching conversation history:", error);
    return [];
  }

  return (data || []).map((row: any) => ({
    id: row.id,
    role: row.role,
    content: row.content,
    timestamp: row.created_at,
    metadata: row.metadata,
  }));
}

/**
 * Get ALL messages in a conversation (for loading full chat)
 */
export async function getFullConversation(
  conversationId: string
): Promise<Message[]> {
  const supabase = getSupabaseClient();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });  // Oldest first

  if (error) {
    console.error("Error fetching full conversation:", error);
    return [];
  }

  return (data || []).map((row: any) => ({
    id: row.id,
    role: row.role,
    content: row.content,
    timestamp: row.created_at,
    metadata: row.metadata,
  }));
}

// ==================== SUPABASE HEALTH CHECK ====================

/**
 * Check if Supabase is properly configured
 * Returns false if credentials are missing
 */
export function isSupabaseConfigured(): boolean {
  return !!(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
}

/**
 * Test Supabase connection
 * Useful for debugging configuration issues
 */
export async function testSupabaseConnection(): Promise<boolean> {
  if (!isSupabaseConfigured()) {
    console.warn(
      "Supabase not configured. Add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY to .env.local"
    );
    return false;
  }

  try {
    const supabase = getSupabaseClient();
    if (!supabase) {
      console.warn("Supabase client not initialized");
      return false;
    }
    const { data, error } = await supabase.from("conversations").select("count").limit(1);
    if (error) {
      console.error("Supabase connection test failed:", error);
      return false;
    }
    return true;
  } catch (error) {
    console.error("Supabase connection error:", error);
    return false;
  }
}

// ==================== UTILITY FOR BATCH OPERATIONS ====================

/**
 * Batch save a complete conversation with all messages
 * Used for migration from old format
 */
export async function saveCompleteConversation(
  conversation: Conversation
): Promise<void> {
  // First save conversation metadata
  await saveConversation(
    conversation.sessionId,
    conversation.id,
    conversation.title
  );

  // Then save all messages
  if (conversation.messages.length > 0) {
    await saveMessages(conversation.id, conversation.messages);
  }
}
