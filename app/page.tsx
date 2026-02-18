"use client";
import { useState, useEffect, useRef } from "react";

// History Item Type
type HistoryItem = {
  query: string;
  answer: string;
};

export default function Home() {
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState("");
  const [loading, setLoading] = useState(false);
  const [sources, setSources] = useState<string[]>([]);
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileType, setFileType] = useState<string>("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // मोबाइल के लिए साइडबार टॉगल
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  // 🔄 Load History
  useEffect(() => {
    const savedHistory = localStorage.getItem("chatHistory");
    if (savedHistory) {
      setHistory(JSON.parse(savedHistory));
    }
  }, []);

  // 🛑 Stop speaking on unmount
  useEffect(() => {
    return () => {
      window.speechSynthesis.cancel();
    };
  }, []);

  // 🆕 New Chat
  const startNewChat = () => {
    setQuery("");
    setAnswer("");
    setSources([]);
    setSelectedFile(null);
    window.speechSynthesis.cancel();
    setIsSidebarOpen(false); // मोबाइल पर बंद करें
  };

  // 📂 Load Old Chat
  const loadChat = (item: HistoryItem) => {
    setQuery(item.query);
    setAnswer(item.answer);
    setSources(["Saved Chat", "Memory"]);
    setIsSidebarOpen(false); // मोबाइल पर बंद करें
  };

  // 🗑️ Delete Chat from Library
  const deleteChat = (e: React.MouseEvent, index: number) => {
    e.stopPropagation(); // लोड चैट को ट्रिगर होने से रोकें
    const updatedHistory = history.filter((_, i) => i !== index);
    setHistory(updatedHistory);
    localStorage.setItem("chatHistory", JSON.stringify(updatedHistory));
  };

  // 📎 Handle File Selection
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

  // 🎤 Voice Input
  const startListening = () => {
    if ("webkitSpeechRecognition" in window || "SpeechRecognition" in window) {
      const SpeechRecognition = (window as any).webkitSpeechRecognition || (window as any).SpeechRecognition;
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

  // 🔊 Text-to-Speech
  const handleSpeak = () => {
    if (!answer) return;
    if (isSpeaking) {
      window.speechSynthesis.cancel();
      setIsSpeaking(false);
    } else {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(answer);
      utterance.rate = 1; 
      utterance.onend = () => setIsSpeaking(false);
      window.speechSynthesis.speak(utterance);
      setIsSpeaking(true);
    }
  };

  // 🔍 Search Function
  const handleSearch = async (manualQuery?: string) => {
    const searchQuery = manualQuery || query;
    if (!searchQuery) return;

    window.speechSynthesis.cancel();
    setIsSpeaking(false);
    setLoading(true);
    setAnswer("");
    setSources([]);

    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
            query: searchQuery,
            fileData: selectedFile,
            mimeType: fileType
        }),
      });
      const data = await res.json();
      
      setAnswer(data.answer);
      setSources(["AI Vision", "Knowledge Base"]);

      const updatedHistory = [{ query: searchQuery, answer: data.answer }, ...history];
      setHistory(updatedHistory);
      localStorage.setItem("chatHistory", JSON.stringify(updatedHistory));
      setSelectedFile(null);

    } catch (error) {
      setAnswer("Kuch gadbad ho gayi. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex h-screen bg-gray-950 text-gray-200 font-sans overflow-hidden selection:bg-blue-500/30">
      
      {/* 📱 Mobile Overlay */}
      {isSidebarOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 md:hidden" onClick={() => setIsSidebarOpen(false)} />
      )}

      {/* 🟢 SIDEBAR (Enhanced Responsive) */}
      <div className={`
        fixed md:relative z-50 h-full w-72 bg-gray-900/95 md:bg-gray-900/50 backdrop-blur-xl border-r border-white/10 
        transition-transform duration-300 md:translate-x-0
        ${isSidebarOpen ? "translate-x-0" : "-translate-x-full md:flex"}
        flex flex-col
      `}>
        <div className="p-6 border-b border-white/5 flex justify-between items-center">
           <h1 className="text-xl font-bold tracking-tight text-white flex items-center gap-2">
             <span className="text-blue-500 text-2xl">⚡</span> Perplexity
           </h1>
           <button onClick={() => setIsSidebarOpen(false)} className="md:hidden text-gray-400 hover:text-white">✕</button>
        </div>
        
        <div className="p-4">
          <button onClick={startNewChat} className="w-full bg-blue-600 hover:bg-blue-500 text-white py-3 px-4 rounded-xl flex items-center justify-center gap-2 transition-all shadow-lg font-medium group">
            <span className="group-hover:rotate-90 transition-transform duration-300">➕</span> New Thread
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-2 scrollbar-thin scrollbar-thumb-gray-800">
          <h3 className="text-[10px] font-bold text-gray-500 uppercase px-4 mb-4 tracking-[0.2em]">Library</h3>
          <div className="space-y-2">
            {history.length > 0 ? (
              history.map((item, index) => (
                <div key={index} onClick={() => loadChat(item)} className="group flex items-center gap-3 px-4 py-3 hover:bg-white/5 rounded-xl cursor-pointer transition-all border border-transparent hover:border-white/10 relative">
                  <div className="w-8 h-8 rounded-lg bg-gray-800 flex items-center justify-center text-xs group-hover:bg-blue-600/20 group-hover:text-blue-400 transition-colors">💬</div>
                  <span className="truncate text-xs font-medium text-gray-400 group-hover:text-white transition-colors flex-1">{item.query}</span>
                  <button onClick={(e) => deleteChat(e, index)} className="opacity-0 group-hover:opacity-100 p-1 hover:text-red-400 text-gray-500 transition-opacity">🗑️</button>
                </div>
              ))
            ) : (
              <p className="px-4 text-xs text-gray-600 italic">No chats yet...</p>
            )}
          </div>
        </div>

        <div className="p-4 border-t border-white/5 bg-gray-900/30">
           <div className="flex items-center gap-3 bg-gray-800/50 p-3 rounded-xl border border-white/5">
             <div className="w-10 h-10 bg-gradient-to-tr from-blue-500 to-purple-500 rounded-full flex items-center justify-center text-xs font-bold text-white shadow-lg">AC</div>
             <div><p className="text-xs text-gray-400">Developed by</p><div className="text-sm font-bold text-white">Aalok Choudhary</div></div>
           </div>
        </div>
      </div>

      {/* 🔵 MAIN CONTENT AREA */}
      <div className="flex-1 flex flex-col items-center relative overflow-hidden w-full">
        {/* Mobile Navbar Toggle */}
        <div className="w-full p-4 flex md:hidden items-center justify-between z-30">
          <button onClick={() => setIsSidebarOpen(true)} className="p-2 bg-gray-800/50 rounded-lg text-white">
             <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
          </button>
          <span className="font-bold text-sm text-blue-500">⚡ Perplexity</span>
          <div className="w-10"></div>
        </div>

        <div className="absolute top-0 left-0 w-full h-full bg-gradient-to-b from-gray-900 to-black -z-10"></div>

        <div className="flex-1 w-full max-w-3xl flex flex-col p-4 md:p-6 overflow-y-auto z-10 scrollbar-hide">
          
          {!answer && !loading && (
            <div className="flex-1 flex flex-col items-center justify-center text-center">
                <h1 className="text-4xl md:text-6xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-white via-gray-400 to-gray-600 mb-6 pb-2">
                  Where knowledge <br/> begins.
                </h1>
            </div>
          )}

          <div className={`w-full transition-all duration-500 ${!answer && !loading ? "mb-auto" : "sticky top-0 pt-2 pb-4 bg-gray-950/80 backdrop-blur-xl z-50"}`}>
            
            {selectedFile && (
                <div className="mb-3 relative w-fit animate-in fade-in zoom-in duration-300">
                  <div className="bg-gray-800 border border-gray-600 px-3 py-1.5 rounded-lg flex items-center gap-2 shadow-lg">
                    <span className="text-lg">🖼️</span>
                    <span className="text-[10px] text-green-400 font-bold uppercase tracking-tight">Image Attached</span>
                    <button onClick={() => setSelectedFile(null)} className="text-gray-400 hover:text-red-400 transition ml-1">✕</button>
                  </div>
                </div>
            )}

            <div className="relative group">
              <div className="absolute -inset-0.5 bg-gradient-to-r from-blue-500 to-purple-600 rounded-full opacity-10 group-focus-within:opacity-100 transition duration-500 blur"></div>
              
              <div className="relative flex items-center bg-[#1e1e1e] border border-gray-700/50 rounded-full px-3 md:px-4 py-2.5 md:py-4 shadow-2xl">
                
                <input type="file" ref={fileInputRef} onChange={handleFileChange} className="hidden" accept="image/*" />
                <button onClick={() => fileInputRef.current?.click()} className="p-2 text-gray-400 hover:text-blue-400 transition">
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
                </button>

                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Ask anything..."
                  className="w-full bg-transparent text-white px-2 outline-none placeholder-gray-500 text-sm md:text-lg font-medium"
                  onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                />
                
                <button onClick={startListening} className={`p-2 rounded-full transition-all ${isListening ? "text-red-500 animate-pulse" : "text-gray-400"}`}>
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>
                </button>

                <button onClick={() => handleSearch()} className="bg-blue-600 hover:bg-blue-500 text-white p-2.5 rounded-full transition-all shadow-lg">
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
                </button>
              </div>
            </div>
          </div>

          {/* Result Area */}
          <div className="w-full mt-4 pb-10">
            {loading && (
              <div className="space-y-4 max-w-2xl mx-auto mt-6">
                <div className="flex items-center gap-3 text-blue-400 animate-pulse">
                  <div className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin"></div>
                  <span className="font-medium text-sm">Thinking...</span>
                </div>
                <div className="h-3 bg-gray-800/50 rounded w-3/4 animate-pulse"></div>
                <div className="h-3 bg-gray-800/50 rounded w-1/2 animate-pulse"></div>
              </div>
            )}

            {!loading && answer && (
              <div className="max-w-3xl mx-auto pb-4">
                <div className="bg-[#1e1e1e]/80 backdrop-blur-sm p-5 md:p-8 rounded-2xl border border-gray-700/30 shadow-2xl relative overflow-hidden">
                  <div className="flex items-center justify-between mb-5 border-b border-gray-700/50 pb-3">
                    <div className="flex items-center gap-2">
                      <div className="bg-blue-600/20 p-1.5 rounded-lg text-blue-400">⚡</div>
                      <h2 className="text-sm font-semibold text-white">Answer</h2>
                    </div>
                    <button onClick={handleSpeak} className={`p-2 rounded-full transition-all ${isSpeaking ? "bg-blue-500/20 text-blue-400" : "bg-gray-800 text-gray-400"}`}>
                      {isSpeaking ? "⏸️" : "🔊"}
                    </button>
                  </div>
                  <p className="text-gray-300 leading-relaxed text-sm md:text-base whitespace-pre-wrap font-light">{answer}</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}