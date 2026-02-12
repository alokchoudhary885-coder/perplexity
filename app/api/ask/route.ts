import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const { query, fileData, mimeType } = await req.json();

    // Replace the hardcoded API key with an environment variable
    const apiKey = process.env.API_KEY || "";

    let messages = [];
    
    // ✅ Text Model: Llama 3.3 (Ye active hai)
    let model = "llama-3.3-70b-versatile"; 

    // ✅ Vision Model: Llama 4 Scout (Ye naya active model hai)
    if (fileData) {
      model = "meta-llama/llama-4-scout-17b-16e-instruct"; // 📸 NEW MODEL
      messages = [
        {
          role: "user",
          content: [
            { type: "text", text: query },
            {
              type: "image_url",
              image_url: {
                url: `data:${mimeType};base64,${fileData}`,
              },
            },
          ],
        },
      ];
    } else {
      // Sirf Text
      messages = [
        {
          role: "user",
          content: query,
        },
      ];
    }

    // Call Groq API
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: messages,
        model: model,
        temperature: 0.7,
        max_tokens: 1024,
      }),
    });

    const data = await response.json();

    // Error Handling
    if (!response.ok) {
      console.error("Groq API Error:", data);
      return NextResponse.json({ answer: `API Error: ${data.error?.message || "Check Server Logs"}` }, { status: 500 });
    }

    const answer = data.choices[0]?.message?.content || "No answer received.";

    return NextResponse.json({ answer });

  } catch (error) {
    console.error("Server Error:", error);
    return NextResponse.json({ answer: "Internal Server Error." }, { status: 500 });
  }
}