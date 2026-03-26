import { NextRequest } from "next/server";

// ✅ Types
interface Message {
  role: "user" | "assistant" | "system";
  content:
    | string   
    | { type: "text"; text: string }[]
    | { type: "text" | "image_url"; text?: string; image_url?: { url: string } }[];
}  


                                                              
interface RequestBody {
  query: string;
  fileData?: string;
  mimeType?: string;
  conversationHistory?: Message[]; // ✅ NEW: Frontend se history aayegi
  conversationId?: string;  // For database operations
}

interface ResponseMetadata {
  model: "text" | "vision";
  responseTime: number;
  tokensUsed: number;
  isComplete?: boolean;
  protocolVersion?: string;
  streamDuration?: number;
  charsReceived?: number;
}

// ✅ Estimate token count (~4 chars per token for Groq models)
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ✅ Retry helper — Groq rate limit handle karta hai
async function fetchWithRetry(
  url: string,               
  options: RequestInit,
  retries = 3,
  delay = 1000
): Promise<Response> {
  for (let i = 0; i < retries; i++) {
    const res = await fetch(url, options);
    // 429 = Rate Limited, 503 = Service Unavailable
    if (res.status === 429 || res.status === 503) {
      if (i < retries - 1) {
        await new Promise((resolve) => setTimeout(resolve, delay * (i + 1))); // exponential backoff
        continue;
      }
    }        
    return res;              
  }
  throw new Error("Max retries reached. Groq API unavailable.");
}

// ✅ System Prompt — AI ko Perplexity jaisa banata hai
const SYSTEM_PROMPT: Message = {
  role: "system",
  content: `You are a highly intelligent AI search assistant, similar to Perplexity AI.
Your job is to give clear, well-structured, and accurate answers.
- Use markdown formatting (headings, bullet points, bold) for clarity.
- If you reference facts, mention that sources should be verified.
- Be concise but thorough. Avoid unnecessary filler text.      
- For follow-up questions, always use context from the conversation history.`
};

export async function POST(req: NextRequest) {
  try {
    const body: RequestBody = await req.json();
    const { query, fileData, mimeType, conversationHistory = [], conversationId } = body;
    const responseStartTime = Date.now();

    // ✅ Input Validation
    if (!query || query.trim().length === 0) {
      return new Response(
        JSON.stringify({ error: "Query cannot be empty." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const apiKey = process.env.GROQ_API_KEY || "";
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: "Server misconfiguration: API key missing." }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    // ✅ Model Selection
    const model = fileData
      ? "meta-llama/llama-4-scout-17b-16e-instruct" // Vision
      : "llama-3.3-70b-versatile"; // Text

    // ✅ Build current user message
    const currentUserMessage: Message = fileData
      ? {
          role: "user",
          content: [
            { type: "text", text: query },
            {
              type: "image_url",
              image_url: { url: `data:${mimeType};base64,${fileData}` },
            },
          ],
        }
      : {
          role: "user",
          content: query,
        };

    // ✅ Full messages array: System + History + Current
    // Note: Vision model ke saath history avoid karo (image context confuse karta hai)
    const messages: Message[] = fileData
      ? [SYSTEM_PROMPT, currentUserMessage]
      : [SYSTEM_PROMPT, ...conversationHistory.slice(-5), currentUserMessage];
      // slice(-5) = last 5 messages only — balance token limit & context awareness

    // ✅ Create abort signal with 30-second timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    // ✅ Call Groq API with STREAMING enabled
    const groqResponse = await fetchWithRetry(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages,
          model,
          temperature: 0.6,        // Balanced for accuracy
          max_tokens: 4096,        // Allow longer responses
          stream: true,            // ✅ Streaming enabled
          top_p: 0.9,
        }),
        signal: controller.signal,
      }
    );

    if (!groqResponse.ok) {
      clearTimeout(timeoutId);
      const errData = await groqResponse.json();
      console.error("Groq API Error:", errData);
      return new Response(
        JSON.stringify({
          error: errData.error?.message || "Groq API failed. Try again.",
        }),
        { status: groqResponse.status, headers: { "Content-Type": "application/json" } }
      );
    }

    // ✅ Stream the response directly to frontend
    // Groq ka stream Next.js ke through seedha browser tak jaata hai
    const stream = new ReadableStream({
      async start(controller) {
        const reader = groqResponse.body?.getReader();
        if (!reader) {
          clearTimeout(timeoutId);
          controller.close();
          return;
        }

        const decoder = new TextDecoder();
        let fullAnswer = "";
        const metadataStart = Date.now();  // Track for response time
        let charsReceived = 0;

        try {
          // First, enqueue metadata as JSON on first line
          const modelType = fileData ? "vision" : "text";
          const metadata: ResponseMetadata = {
            model: modelType,
            responseTime: 0,  // Will update at end
            tokensUsed: 0,    // Will update at end
            isComplete: false,  // Initially incomplete
            protocolVersion: "1.0",
            streamDuration: 0,
            charsReceived: 0,
          };
          controller.enqueue(
            new TextEncoder().encode(JSON.stringify(metadata) + "\n")
          );

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split("\n").filter((line) => line.trim() !== "");

            for (const line of lines) {
              if (line.startsWith("data: ")) {
                const data = line.slice(6);
                if (data === "[DONE]") {
                  // ✅ Stream complete - close the stream
                  controller.close();
                  return;
                }
                try {
                  const parsed = JSON.parse(data);
                  const token = parsed.choices?.[0]?.delta?.content;
                  if (token) {
                    fullAnswer += token;
                    charsReceived += token.length;
                    // Frontend ko raw text tokens bhejo
                    controller.enqueue(new TextEncoder().encode(token));
                  }
                } catch {
                  // Partial JSON chunk — ignore karo
                }
              }
            }
          }
        } catch (streamError) {
          // ✅ Better error handling - send error indicator
          if (streamError instanceof Error && streamError.name === "AbortError") {
            console.warn("Stream timeout - request took longer than 30 seconds");
          } else {
            console.error("Stream reading error:", streamError);
          }
          // Let the stream close naturally or with error
          controller.close();
        } finally {
          try {
            reader.releaseLock();
          } catch {
            // Reader already released
          }
          clearTimeout(timeoutId);
        }
      },
    });

    // ✅ Return stream with proper headers
    return new Response(stream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
        // ✅ CORS headers agar cross-origin chahiye ho
        "Cache-Control": "no-cache",
      },
    });

  } catch (error) {
    console.error("Server Error:", error);
    return new Response(
      JSON.stringify({ error: "Internal Server Error. Please try again." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}