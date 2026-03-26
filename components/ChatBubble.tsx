"use client";

import { Message, formatTime } from "@/lib/types";

interface ChatBubbleProps {
  message: Message;
  onCopy: (message: Message) => void;
}

/**
 * Chat Bubble Component
 * Renders individual messages as bubbles in the hybrid chat interface
 * - User messages: right-aligned, blue background
 * - Assistant messages: left-aligned, gray background
 */
export function ChatBubble({ message, onCopy }: ChatBubbleProps) {
  const isUser = message.role === "user";

  return (
    <div
      className={`flex mb-4 ${isUser ? "justify-end" : "justify-start"} animate-in fade-in duration-300`}
    >
      <div
        className={`
          max-w-xs lg:max-w-md px-4 py-3 rounded-lg
          transition-all hover:shadow-lg
          ${
            isUser
              ? "bg-blue-600 text-white rounded-br-none shadow-blue-500/50"
              : "bg-gray-800 text-gray-200 rounded-bl-none shadow-gray-900/50"
          }
        `}
      >
        {/* Message Content */}
        <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">
          {message.content}
        </p>

        {/* Timestamp and Copy Button */}
        <div className="flex items-center justify-between mt-2 gap-2 border-t border-opacity-20 pt-2 border-current">
          <span className="text-xs opacity-70">
            {formatTime(message.timestamp)}
          </span>

          <button
            onClick={() => onCopy(message)}
            className={`
              opacity-70 hover:opacity-100 transition cursor-pointer text-xs
              px-2 py-1 rounded hover:bg-opacity-20 hover:bg-white
            `}
            title="Copy message"
            aria-label="Copy message"
          >
            📋 Copy
          </button>
        </div>

        {/* Metadata Display (for assistant messages only) */}
        {!isUser && message.metadata && (
          <div className="mt-2 text-xs opacity-60 border-t border-opacity-20 pt-1 border-current">
            <div className="flex gap-2">
              <span>🤖 {message.metadata.model}</span>
              {message.metadata.responseTime !== undefined && message.metadata.responseTime > 0 && (
                <span>⏱️ {message.metadata.responseTime}ms</span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Chat Container
 * Wrapper for rendering multiple chat bubbles with proper scrolling
 */
interface ChatContainerProps {
  messages: Message[];
  onCopy: (message: Message) => void;
}

export function ChatContainer({ messages, onCopy }: ChatContainerProps) {
  return (
    <div className="flex-1 overflow-y-auto mb-4 px-4 py-3 space-y-2 rounded-lg bg-gradient-to-b from-gray-900 to-gray-950">
      {messages.length === 0 ? (
        <div className="flex items-center justify-center h-32 text-gray-500">
          <p>Start a conversation by asking a question...</p>
        </div>
      ) : (
        messages.map((message) => (
          <ChatBubble
            key={message.id}
            message={message}
            onCopy={onCopy}
          />
        ))
      )}
    </div>
  );
}
