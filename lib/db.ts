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
 * Used to populate sidebar conversation list with pagination
 */
export async function getSessionConversations(
  sessionId: string,
  limit: number = 20,
  offset: number = 0
): Promise<SavedConversation[]> {
  const supabase = getSupabaseClient();
  if (!supabase) return [];

  // Try to query the materialized view first, fall back to direct table query
  let result = await supabase
    .from("conversation_summaries")
    .select("*")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  // If view doesn't exist or fails, query conversations table directly
  if (result.error?.code === "PGRST116" || result.error?.code === "42P01") {
    console.warn(
      "conversation_summaries view not found, querying conversations table directly"
    );
    result = await supabase
      .from("conversations")
      .select(
        `
        id,
        session_id,
        title,
        message_count,
        created_at,
        updated_at
      `
      )
      .eq("session_id", sessionId)
      .order("updated_at", { ascending: false })
      .range(offset, offset + limit - 1);
  }

  if (result.error) {
    console.error("Error fetching conversations:", result.error);
    return [];
  }

  return (result.data || []).map((row: any) => ({
    id: row.id,
    title: row.title,
    preview: row.last_message_preview || "No messages",
    lastMessage: {
      id: "",
      role: "assistant",
      content: row.last_message_preview || "",
      timestamp: row.created_at || row.updated_at,
    },
    messageCount: row.message_count || 0,
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

  // ✅ FIX: Increment message_count instead of setting it
  // First, get current message count to increment
  const { data: currentConv, error: fetchError } = await supabase
    .from("conversations")
    .select("message_count")
    .eq("id", conversationId)
    .single();

  if (fetchError) {
    console.error("Error fetching conversation:", fetchError);
  }

  const currentCount = currentConv?.message_count || 0;
  const newCount = currentCount + messagesToInsert.length;

  // Update conversation's updated_at and message_count (incremented)
  const { error: updateError } = await supabase
    .from("conversations")
    .update({
      updated_at: Date.now(),
      message_count: newCount,
    })
    .eq("id", conversationId);

  if (updateError) {
    console.error("Error updating conversation metadata:", updateError);
    // Don't throw - messages were saved, just metadata update failed
  }
}

/**
 * Get conversation history with pagination support
 * Used to load messages when user opens a conversation (first page)
 */
export async function getConversationHistory(
  conversationId: string,
  limit: number = 50,
  offset: number = 0
): Promise<Message[]> {
  const supabase = getSupabaseClient();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })  // Oldest first
    .range(offset, offset + limit - 1);

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
 * Get total message count for a conversation
 * Used for infinite scroll pagination and progress indication
 */
export async function getTotalMessageCount(
  conversationId: string
): Promise<number> {
  const supabase = getSupabaseClient();
  if (!supabase) return 0;

  const { count, error } = await supabase
    .from("messages")
    .select("*", { count: "exact", head: true })
    .eq("conversation_id", conversationId);

  if (error) {
    console.error("Error fetching message count:", error);
    return 0;
  }

  return count || 0;
}

/**
 * Get ALL messages in a conversation with pagination
 * Default: First 50 messages, can load older with offset
 * Enables infinite scroll without memory overhead
 */
export async function getFullConversation(
  conversationId: string,
  limit: number = 50,
  offset: number = 0
): Promise<Message[]> {
  const supabase = getSupabaseClient();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })  // Oldest first
    .range(offset, offset + limit - 1);

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

/**
 * Update conversation timestamp without fetching all messages
 * Used to refresh "updated_at" after new messages
 */
export async function updateConversationTimestamp(
  conversationId: string
): Promise<void> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error("Supabase not configured");

  const { error } = await supabase
    .from("conversations")
    .update({
      updated_at: Date.now(),
    })
    .eq("id", conversationId);

  if (error) {
    console.error("Error updating conversation timestamp:", error);
    throw error;
  }
}

// ==================== SUPABASE HEALTH CHECK ====================

/**
 * Check database schema for required tables
 * Logs warnings if tables are missing or misconfigured
 */
export async function checkDatabaseSchema(): Promise<boolean> {
  if (!isSupabaseConfigured()) {
    console.warn("Supabase not configured");
    return false;
  }

  try {
    const supabase = getSupabaseClient();
    if (!supabase) return false;

    // Check if required tables exist
    const requiredTables = ["conversations", "messages"];
    const results = await Promise.all(
      requiredTables.map(async (table) => {
        const { error } = await supabase.from(table).select("count").limit(1);
        if (error) {
          console.warn(`Table "${table}" not found or inaccessible:`, error.message);
          return false;
        }
        return true;
      })
    );

    // Check for conversation_summaries view (optional, will fall back to direct table query)
    const { error: viewError } = await supabase
      .from("conversation_summaries")
      .select("count")
      .limit(1);

    if (viewError?.code === "PGRST116" || viewError?.code === "42P01") {
      console.warn(
        "conversation_summaries view not found - using direct table query as fallback"
      );
    } else if (viewError) {
      console.warn("Error checking conversation_summaries view:", viewError.message);
    } else {
      console.info("✓ conversation_summaries view exists");
    }

    const allTablesExist = results.every((result) => result);
    if (allTablesExist) {
      console.info("✓ All required database tables exist");
    }

    return allTablesExist;
  } catch (error) {
    console.error("Database schema check failed:", error);
    return false;
  }
}

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
