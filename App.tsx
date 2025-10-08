
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Message, ConversationSession } from './types';
import { LEVELS, TOPICS, COACH_VOICES } from './constants';
import {
  initializeAi,
  connectToLiveSession,
  decode,
  decodeAudioData,
  createPcmBlob
} from './services/geminiService';
import { Settings, X, Menu, Mic, MicOff, Volume2, HelpCircle, Key, History, ClipboardList } from './components/icons';
import { LiveSession, LiveServerMessage, ErrorEvent, CloseEvent, GoogleGenAI } from '@google/genai';

const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;
const SCRIPT_PROCESSOR_BUFFER_SIZE = 4096;

const App: React.FC = () => {
  const [isSettingsOpen, setIsSettingsOpen] = useState(true);
  const [isNotesOpen, setIsNotesOpen] = useState(false);
  const [isHelpModalOpen, setIsHelpModalOpen] = useState(false);
  const [isApiKeyModalOpen, setIsApiKeyModalOpen] = useState(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);

  const [level, setLevel] = useState<string>(LEVELS[0]);
  const [topic, setTopic] = useState<string>(TOPICS[0]);
  const [coachVoice, setCoachVoice] = useState<string>(COACH_VOICES[0]);
  
  const [messages, setMessages] = useState<Message[]>([]);
  const [history, setHistory] = useState<ConversationSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<number | null>(null);
  const [isSessionActive, setIsSessionActive] = useState(false);
  const [statusMessage, setStatusMessage] = useState('Please set your API Key to begin.');
  const [isApiKeySet, setIsApiKeySet] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState('');
  
  const [generalNotes, setGeneralNotes] = useState('');

  const currentUserTranscriptionRef = useRef('');
  const currentTutorTranscriptionRef = useRef('');
  const [displayUserTranscription, setDisplayUserTranscription] = useState('');
  const [displayTutorTranscription, setDisplayTutorTranscription] = useState('');

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const aiRef = useRef<GoogleGenAI | null>(null);
  const sessionPromiseRef = useRef<Promise<LiveSession> | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const mediaStreamSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const nextStartTimeRef = useRef(0);
  const audioPlaybackSources = useRef(new Set<AudioBufferSourceNode>());
  const messagesAtSessionStart = useRef<Message[]>([]);
  
  const isSessionActiveRef = useRef(isSessionActive);
  isSessionActiveRef.current = isSessionActive;
  
  const currentSessionIdRef = useRef(currentSessionId);
  useEffect(() => {
    currentSessionIdRef.current = currentSessionId;
  }, [currentSessionId]);

  const sessionStateRef = useRef({ messages, level, topic, generalNotes });
  useEffect(() => {
    sessionStateRef.current = { messages, level, topic, generalNotes };
  }, [messages, level, topic, generalNotes]);


  useEffect(() => {
    const savedApiKey = localStorage.getItem('googleApiKey');
    if (savedApiKey) {
      try {
        aiRef.current = initializeAi(savedApiKey);
        setIsApiKeySet(true);
        setStatusMessage('API Key loaded. Click the microphone to start.');
      } catch (e) {
        console.error("Failed to initialize with saved API key:", e);
        localStorage.removeItem('googleApiKey');
        setStatusMessage('Invalid API Key found. Please set a new one.');
        setIsApiKeyModalOpen(true);
      }
    } else {
      setIsApiKeyModalOpen(true);
    }
    
    try {
      const savedHistory = localStorage.getItem('conversationHistory');
      if (savedHistory) {
        setHistory(JSON.parse(savedHistory));
      }
    } catch (e) {
      console.error("Failed to load conversation history:", e);
      localStorage.removeItem('conversationHistory');
    }

  }, []);

  useEffect(() => {
    try {
      localStorage.setItem('conversationHistory', JSON.stringify(history));
    } catch (e) {
      console.error("Failed to save conversation history:", e);
    }
  }, [history]);

  const handleSaveApiKey = () => {
    if (apiKeyInput.trim()) {
      try {
        aiRef.current = initializeAi(apiKeyInput);
        localStorage.setItem('googleApiKey', apiKeyInput);
        setIsApiKeySet(true);
        setIsApiKeyModalOpen(false);
        setApiKeyInput('');
        setStatusMessage('API Key set! Ready to start a session.');
      } catch (e) {
        console.error(e);
        alert('Failed to initialize with the provided API Key. Please check the key and try again.');
      }
    } else {
      alert('Please enter a valid API Key.');
    }
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, displayUserTranscription, displayTutorTranscription]);
  
  const getSystemPrompt = useCallback((voiceName: string) => {
    const isContinuation = messages.length > 0;

    let conversationInstructions: string;

    if (isContinuation) {
        const historyText = messages.map(msg => `${msg.role === 'user' ? 'User' : voiceName}: ${msg.content}`).join('\n\n');
        conversationInstructions = `2. **Continue the Conversation:** The user has loaded a previous session. Your task is to seamlessly continue the conversation from where it left off. Here is the conversation history:\n${historyText}\n3. **Your Next Turn:** Based on the last message ("${messages[messages.length - 1].content}"), ask a relevant follow-up question to keep the conversation flowing naturally.`;
    } else {
        conversationInstructions = `2. **Initiate the Conversation:** Start by introducing yourself and asking an engaging, open-ended question related to the selected topic.\n3. **Lead the Dialogue:** Your main role is to guide the conversation. Ask a question, listen carefully to the user's response, and then react.`;
    }

    return `You are ${voiceName}, a friendly and patient AI English conversation coach.

Your primary goal is to help the user practice their English speaking skills through a guided, interactive question-and-answer format.

Current Settings:
- Level: ${level}
- Topic: ${topic}

Your instructions are:
1. **Speak ONLY in English.** Do not use any other language.
${conversationInstructions}
4. **Provide Detailed, Constructive Feedback:** If the user's response contains any grammatical errors, pronunciation issues reflected in the transcript, or unnatural phrasing, you MUST provide a detailed analysis and correction. Follow this specific format for feedback:
    a. **Acknowledge and Encourage:** Start with a positive and encouraging phrase. For example, "Great effort!" or "Thanks for sharing, that was a good attempt."
    b. **Identify the Original Sentence:** Quote the user's incorrect sentence. For example, "You said: 'I enjoy on my free time watching movies.'"
    c. **Provide a Detailed Breakdown:** Analyze the sentence part-by-part. Pinpoint the specific words or phrases that are incorrect or could be improved. Explain *why* they are incorrect (e.g., wrong preposition, incorrect verb tense, awkward word order).
        - Example analysis:
            - "The phrase 'on my free time' is a common mistake. In English, we use the preposition 'in' for periods of time, so the correct phrase is 'in my free time'."
            - "The word order is a little unnatural. It's more common to place the time phrase 'in my free time' at the beginning or end of the sentence."
    d. **Offer the Perfect Sentence:** Provide the fully corrected, natural-sounding sentence. For example, "A more natural and perfect way to say this would be: 'In my free time, I enjoy watching movies.' or 'I enjoy watching movies in my free time.'"
    e. **Check for Understanding:** After giving the correction, briefly check if the user understands before moving on. For example, "Does that make sense?"
5. **Ask Follow-up Questions:** After providing feedback or if the user's answer is good, ask a relevant follow-up question to keep the conversation flowing naturally.
6. **Adapt Your Language:** Adjust your vocabulary, question complexity, and speaking pace to match the user's selected proficiency level.
7. **Maintain a Positive Tone:** Always be supportive, encouraging, and patient.
8. **Be Concise:** Keep your own speaking turns relatively short to maximize the user's practice time.
9. **Stay on Topic:** Strictly adhere to the chosen conversation topic and difficulty level.`;
  }, [level, topic, messages]);
  
  const saveCurrentSession = useCallback(() => {
    const { messages, level, topic, generalNotes } = sessionStateRef.current;
    const sessionId = currentSessionIdRef.current;

    if (sessionId) {
      setHistory(prevHistory =>
        prevHistory.map(session =>
          session.id === sessionId
            ? { ...session, messages, notes: { ...session.notes, general: generalNotes } }
            : session
        )
      );
      return { isNew: false };
    } else {
      const newSessionId = Date.now();
      const newSession: ConversationSession = {
        id: newSessionId,
        date: new Date().toLocaleString(),
        level,
        topic,
        messages,
        notes: { general: generalNotes },
      };
      setHistory(prevHistory => [newSession, ...prevHistory]);
      setCurrentSessionId(newSessionId);
      return { isNew: true };
    }
  }, []);

  const stopSession = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (scriptProcessorRef.current) {
        scriptProcessorRef.current.disconnect();
        scriptProcessorRef.current = null;
    }
    if (mediaStreamSourceRef.current) {
        mediaStreamSourceRef.current.disconnect();
        mediaStreamSourceRef.current = null;
    }
    if (inputAudioContextRef.current && inputAudioContextRef.current.state !== 'closed') {
      inputAudioContextRef.current.close().catch(console.error);
      inputAudioContextRef.current = null;
    }
    sessionPromiseRef.current?.then(session => session.close()).catch(console.error);
    sessionPromiseRef.current = null;

    audioPlaybackSources.current.forEach(source => source.stop());
    audioPlaybackSources.current.clear();
    if (outputAudioContextRef.current && outputAudioContextRef.current.state !== 'closed') {
        outputAudioContextRef.current.close().catch(console.error);
        outputAudioContextRef.current = null;
    }
    nextStartTimeRef.current = 0;
    
    if (isSessionActiveRef.current) {
      const { messages: finalMessages } = sessionStateRef.current;
      if (finalMessages.length > messagesAtSessionStart.current.length) {
        saveCurrentSession();
      }
    }

    setIsSessionActive(false);
    setStatusMessage('Session ended. Click the microphone to practice again.');
  }, [saveCurrentSession]);

  const startOrContinueSession = useCallback(async () => {
    if (isSessionActive) {
      stopSession();
      return;
    }
    if (!aiRef.current) {
      setStatusMessage('API Key not set. Please set it in the settings.');
      setIsApiKeyModalOpen(true);
      return;
    }
    messagesAtSessionStart.current = messages;
    setDisplayUserTranscription('');
    setDisplayTutorTranscription('');
    currentUserTranscriptionRef.current = '';
    currentTutorTranscriptionRef.current = '';
    setStatusMessage('Requesting microphone access...');

    try {
      streamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });

      setStatusMessage('Connecting to tutor...');
      inputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: INPUT_SAMPLE_RATE });
      outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: OUTPUT_SAMPLE_RATE });

      sessionPromiseRef.current = connectToLiveSession(aiRef.current, getSystemPrompt(coachVoice), coachVoice, {
        onopen: () => {
            console.log('Session opened.');
            setIsSessionActive(true);
            setStatusMessage('Connected! Start speaking when you are ready.');
            
            if (!inputAudioContextRef.current || !streamRef.current) {
                console.error('Audio context or media stream is not available in onopen callback.');
                stopSession();
                return;
            }
            
            const source = inputAudioContextRef.current.createMediaStreamSource(streamRef.current);
            mediaStreamSourceRef.current = source;
            const scriptProcessor = inputAudioContextRef.current.createScriptProcessor(SCRIPT_PROCESSOR_BUFFER_SIZE, 1, 1);
            scriptProcessorRef.current = scriptProcessor;

            scriptProcessor.onaudioprocess = (audioProcessingEvent) => {
                const inputData = audioProcessingEvent.inputBuffer.getChannelData(0);
                const pcmBlob = createPcmBlob(inputData);
                sessionPromiseRef.current?.then((session) => {
                    session.sendRealtimeInput({ media: pcmBlob });
                });
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputAudioContextRef.current!.destination);
        },
        onmessage: async (message: LiveServerMessage) => {
            if (message.serverContent?.inputTranscription) {
                currentUserTranscriptionRef.current += message.serverContent.inputTranscription.text;
                setDisplayUserTranscription(currentUserTranscriptionRef.current);
            }
            if (message.serverContent?.outputTranscription) {
                currentTutorTranscriptionRef.current += message.serverContent.outputTranscription.text;
                setDisplayTutorTranscription(currentTutorTranscriptionRef.current);
            }
            if (message.serverContent?.turnComplete) {
                const userText = currentUserTranscriptionRef.current.trim();
                const tutorText = currentTutorTranscriptionRef.current.trim();
                const newMessages: Message[] = [];
                if (userText) newMessages.push({ role: 'user', content: userText });
                if (tutorText) newMessages.push({ role: 'ai', content: tutorText });
                if (newMessages.length > 0) setMessages(prev => [...prev, ...newMessages]);
                
                currentUserTranscriptionRef.current = '';
                currentTutorTranscriptionRef.current = '';
                setDisplayUserTranscription('');
                setDisplayTutorTranscription('');
            }

            const parts = message.serverContent?.modelTurn?.parts;
            if (parts) {
                for (const part of parts) {
                    const base64Audio = part.inlineData?.data;
                    if (base64Audio) {
                        const audioContext = outputAudioContextRef.current!;
                        nextStartTimeRef.current = Math.max(nextStartTimeRef.current, audioContext.currentTime);
        
                        const audioBuffer = await decodeAudioData(decode(base64Audio), audioContext, OUTPUT_SAMPLE_RATE, 1);
                        const source = audioContext.createBufferSource();
                        source.buffer = audioBuffer;
                        source.connect(audioContext.destination);
                        source.onended = () => audioPlaybackSources.current.delete(source);
                        source.start(nextStartTimeRef.current);
                        nextStartTimeRef.current += audioBuffer.duration;
                        audioPlaybackSources.current.add(source);
                    }
                }
            }
            
            if (message.serverContent?.interrupted) {
                audioPlaybackSources.current.forEach(source => source.stop());
                audioPlaybackSources.current.clear();
                nextStartTimeRef.current = 0;
            }
        },
        onerror: (e: ErrorEvent) => {
          console.error('Session error:', e.error);
          setStatusMessage('Connection failed. Please check your API key and network.');
          setIsApiKeyModalOpen(true);
          stopSession();
        },
        onclose: (e: CloseEvent) => {
          console.log('Session closed.');
          stopSession();
        },
      });

    } catch (error) {
      console.error('Failed to start session:', error);
      setStatusMessage('Microphone access denied. Please allow permission and try again.');
      stopSession();
    }
  }, [isSessionActive, getSystemPrompt, stopSession, messages, coachVoice]);
  
  useEffect(() => {
    return () => { stopSession(); };
  }, [stopSession]);
  
  const handleMicButtonClick = () => {
    if (!isApiKeySet) {
      setIsApiKeyModalOpen(true);
      return;
    }
    if (isSessionActive) {
      stopSession();
    } else {
      startOrContinueSession();
    }
  };

  const handleStartFreshSession = useCallback(() => {
    if (isSessionActiveRef.current) {
        stopSession();
    }
    setMessages([]);
    setGeneralNotes('');
    setCurrentSessionId(null);
    setDisplayUserTranscription('');
    setDisplayTutorTranscription('');
    currentUserTranscriptionRef.current = '';
    currentTutorTranscriptionRef.current = '';
    messagesAtSessionStart.current = [];
    setStatusMessage('New session ready. Click the microphone to start.');
  }, [stopSession]);

  const handleLoadSession = (session: ConversationSession) => {
    if (isSessionActive) {
      stopSession();
    }
    setMessages(session.messages);
    setLevel(session.level);
    setTopic(session.topic);
    setGeneralNotes(session.notes?.general || '');
    setCurrentSessionId(session.id);
    messagesAtSessionStart.current = session.messages;
    setStatusMessage('Viewing past session. Click the microphone to continue.');
    setIsHistoryOpen(false);
  };

  const handleDeleteSession = (sessionId: number) => {
    if (window.confirm('Are you sure you want to delete this session?')) {
      setHistory(prev => prev.filter(s => s.id !== sessionId));
    }
  };

  const handleClearHistory = () => {
    if (window.confirm('Are you sure you want to delete all conversation history? This cannot be undone.')) {
        setHistory([]);
    }
  };

  const handleSaveNotes = () => {
    if (!currentSessionId && messages.length === 0) {
      alert("Please say something to your coach to start the conversation before saving.");
      return;
    }
    const { isNew } = saveCurrentSession();
    if (isNew) {
      alert("A new session has been created in your history and your notes have been saved.");
    } else {
      alert("Session progress and notes have been updated!");
    }
  };

  const canSaveNotes = currentSessionId || isSessionActive;

  return (
    <div className="flex flex-col h-screen bg-gradient-to-br from-blue-50 to-indigo-100 font-sans">
      <div className="bg-gradient-to-r from-indigo-600 to-purple-600 text-white p-6 shadow-lg flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold">AI English Conversation Coach</h1>
          <p className="text-indigo-100 mt-1">Practice your fluency and confidence with an AI partner.</p>
        </div>
        <div className="flex items-center gap-4">
           <button onClick={() => setIsNotesOpen(true)} title="Open session notes panel" className="flex items-center gap-2 text-white bg-white/20 hover:bg-white/30 font-medium py-2 px-4 rounded-lg transition-colors">
            <ClipboardList size={20} />
            <span>Session Notes</span>
          </button>
          <button onClick={() => setIsHistoryOpen(true)} title="View past conversation sessions" className="flex items-center gap-2 text-white bg-white/20 hover:bg-white/30 font-medium py-2 px-4 rounded-lg transition-colors">
            <History size={20} />
            <span>View History</span>
          </button>
          <button onClick={() => setIsHelpModalOpen(true)} title="Show help and instructions" className="flex items-center gap-2 text-white bg-white/20 hover:bg-white/30 font-medium py-2 px-4 rounded-lg transition-colors">
            <HelpCircle size={20} />
            <span>Help & Introduction</span>
          </button>
        </div>
      </div>
      
      {isApiKeyModalOpen && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 transition-opacity">
          <div className="bg-white rounded-2xl shadow-2xl p-8 max-w-lg w-full m-4 relative transition-transform transform scale-95">
            <h2 className="text-2xl font-bold text-indigo-700 mb-4">Enter Your Google API Key</h2>
            <p className="text-gray-600 mb-4">To use the AI Coach, you need a Google API key from Google AI Studio.</p>
            <ol className="list-decimal list-inside space-y-2 text-gray-700 bg-gray-50 p-4 rounded-lg border mb-4">
              <li>Go to <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer" className="text-indigo-600 font-semibold hover:underline">Google AI Studio</a>.</li>
              <li>Click "Get API key" and create a new key.</li>
              <li>Copy the key and paste it below.</li>
            </ol>
            <input 
              type="password"
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
              placeholder="Paste your API Key here"
              className="w-full p-3 border border-gray-300 rounded-lg bg-white focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition mb-4"
              />
            <button onClick={handleSaveApiKey} title="Save API Key" className="w-full bg-gradient-to-r from-indigo-600 to-purple-600 text-white py-3 rounded-lg font-semibold hover:from-indigo-700 hover:to-purple-700 transition shadow-md">
              Save and Start
            </button>
          </div>
        </div>
      )}

      {isHistoryOpen && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setIsHistoryOpen(false)}>
            <div className="bg-white rounded-2xl shadow-2xl p-8 max-w-3xl w-full m-4 relative transition-transform transform scale-95 flex flex-col h-[80vh]" onClick={(e) => e.stopPropagation()}>
                <button onClick={() => setIsHistoryOpen(false)} title="Close history panel" className="absolute top-4 right-4 p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-800 rounded-full transition"><X size={20} /></button>
                <h2 className="text-2xl font-bold text-indigo-700 mb-4">Conversation History</h2>
                <div className="flex-1 overflow-y-auto pr-2 -mr-2">
                    {history.length === 0 ? (
                        <div className="text-center text-gray-500 mt-20">
                            <p className="text-lg">No saved conversations yet.</p>
                            <p>Your completed sessions will appear here.</p>
                        </div>
                    ) : (
                        <ul className="space-y-3">
                            {history.map(session => (
                                <li key={session.id} className="bg-gray-50 border border-gray-200 rounded-lg p-4 hover:bg-indigo-50 hover:border-indigo-300 transition group">
                                    <div className="flex justify-between items-center">
                                        <div>
                                            <p className="font-semibold text-indigo-800">{session.topic}</p>
                                            <p className="text-sm text-gray-600">{session.date} &bull; {session.level.split(':')[0]}</p>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <button onClick={() => handleLoadSession(session)} title="Load and view this session" className="bg-indigo-100 text-indigo-700 font-semibold py-2 px-4 rounded-lg hover:bg-indigo-200 transition">View</button>
                                            <button onClick={() => handleDeleteSession(session.id)} title="Delete this session" className="bg-red-100 text-red-700 font-semibold py-2 px-4 rounded-lg hover:bg-red-200 transition">Delete</button>
                                        </div>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
                {history.length > 0 && (
                    <button onClick={handleClearHistory} title="Delete all conversation history" className="mt-6 w-full bg-red-600 text-white py-3 rounded-lg font-semibold hover:bg-red-700 transition shadow-md">
                        Clear All History
                    </button>
                )}
            </div>
        </div>
      )}

      {isHelpModalOpen && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 transition-opacity" onClick={() => setIsHelpModalOpen(false)}>
          <div className="bg-white rounded-2xl shadow-2xl p-8 max-w-2xl w-full m-4 relative transition-transform transform scale-95" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setIsHelpModalOpen(false)} title="Close help panel" className="absolute top-4 right-4 p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-800 rounded-full transition"><X size={20} /></button>
            <h2 className="text-2xl font-bold text-indigo-700 mb-4">How to Use Your AI Coach</h2>
            <p className="text-gray-600 mb-6">Welcome to your personal English Conversation Coach! Here's a quick guide to get started:</p>
            <ol className="space-y-4 text-gray-700">
              <li className="flex items-start gap-3">
                <div className="w-6 h-6 bg-indigo-100 text-indigo-600 font-bold rounded-full flex items-center justify-center flex-shrink-0">1</div>
                <div><span className="font-semibold">Enter API Key:</span> First, set your Google API Key in the settings panel. This is a one-time setup.</div>
              </li>
              <li className="flex items-start gap-3">
                <div className="w-6 h-6 bg-indigo-100 text-indigo-600 font-bold rounded-full flex items-center justify-center flex-shrink-0">2</div>
                <div><span className="font-semibold">Configure Your Session:</span> Use the <span className="font-semibold text-indigo-600">Settings</span> panel to choose your proficiency <span className="font-semibold">Level</span>, a conversation <span className="font-semibold">Topic</span>, and a <span className="font-semibold">Coach Voice</span>. Click <span className="italic">"Start New Session"</span> when ready.</div>
              </li>
               <li className="flex items-start gap-3">
                <div className="w-6 h-6 bg-indigo-100 text-indigo-600 font-bold rounded-full flex items-center justify-center flex-shrink-0">3</div>
                <div><span className="font-semibold">Start Speaking:</span> Click the large <span className="font-semibold text-indigo-600">microphone button</span>. Your AI coach, {coachVoice}, will greet you and start a conversation based on your chosen topic.</div>
              </li>
              <li className="flex items-start gap-3">
                <div className="w-6 h-6 bg-indigo-100 text-indigo-600 font-bold rounded-full flex items-center justify-center flex-shrink-0">4</div>
                <div><span className="font-semibold">Receive Feedback:</span> Your coach will provide instant feedback, gently correcting grammar and suggesting more natural ways to phrase things.</div>
              </li>
              <li className="flex items-start gap-3">
                <div className="w-6 h-6 bg-indigo-100 text-indigo-600 font-bold rounded-full flex items-center justify-center flex-shrink-0">5</div>
                <div><span className="font-semibold">Review Your Progress:</span> After your session, find it saved in the <span className="font-semibold text-indigo-600">"View History"</span> menu to track your improvement over time.</div>
              </li>
            </ol>
             <button onClick={() => setIsHelpModalOpen(false)} className="mt-8 w-full bg-gradient-to-r from-indigo-600 to-purple-600 text-white py-3 rounded-lg font-semibold hover:from-indigo-700 hover:to-purple-700 transition shadow-md">
              Got it, let's practice!
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        {isSettingsOpen && (
          <div className="w-80 bg-white shadow-xl p-6 overflow-y-auto relative border-r border-gray-200 transition-all duration-300">
            <button onClick={() => setIsSettingsOpen(false)} title="Close settings panel" className="absolute top-4 right-4 p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-800 rounded-lg transition"><X size={20} /></button>
            <h2 className="text-xl font-bold mb-6 text-indigo-700 flex items-center gap-2"><Settings size={22} />Settings</h2>
            <div className="mb-6 p-4 bg-gradient-to-r from-purple-50 to-indigo-50 rounded-lg border border-indigo-200">
              <h3 className="font-semibold mb-2 text-indigo-800">👋 Meet Your Coach, {coachVoice}!</h3>
              <p className="text-sm text-gray-700 leading-relaxed">I'll chat with you on different topics to help improve your English fluency and confidence. I'll provide feedback and corrections along the way. Let's get started!</p>
            </div>
            <div className="mb-4">
              <label className="block text-sm font-semibold mb-2 text-gray-700">Level</label>
              <select value={level} onChange={(e) => setLevel(e.target.value)} disabled={!isApiKeySet} className="w-full p-3 border border-gray-300 rounded-lg bg-white focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition disabled:bg-gray-100 disabled:cursor-not-allowed">
                {LEVELS.map((l) => (<option key={l} value={l}>{l}</option>))}
              </select>
            </div>
            <div className="mb-4">
              <label className="block text-sm font-semibold mb-2 text-gray-700">Topic</label>
              <select value={topic} onChange={(e) => setTopic(e.target.value)} disabled={!isApiKeySet} className="w-full p-3 border border-gray-300 rounded-lg bg-white focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition disabled:bg-gray-100 disabled:cursor-not-allowed">
                {TOPICS.map((t) => (<option key={t} value={t}>{t}</option>))}
              </select>
            </div>
             <div className="mb-6">
              <label className="block text-sm font-semibold mb-2 text-gray-700">Coach Voice</label>
              <select value={coachVoice} onChange={(e) => setCoachVoice(e.target.value)} disabled={isSessionActive || !isApiKeySet} className="w-full p-3 border border-gray-300 rounded-lg bg-white focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition disabled:bg-gray-100 disabled:cursor-not-allowed">
                {COACH_VOICES.map((v) => (<option key={v} value={v}>{v}</option>))}
              </select>
            </div>
            <button 
              onClick={() => setIsApiKeyModalOpen(true)} 
              title="Set your Google API Key"
              className="w-full mb-2 bg-white text-indigo-600 border border-indigo-600 py-3 rounded-lg font-semibold hover:bg-indigo-50 transition shadow-sm flex items-center justify-center gap-2 disabled:bg-gray-100 disabled:text-gray-500 disabled:border-gray-300 disabled:cursor-not-allowed"
              disabled={isApiKeySet}
            >
              <Key size={18} /> {isApiKeySet ? 'API Key Set' : 'Set API Key'}
            </button>
            <button onClick={handleStartFreshSession} title="Start a fresh conversation" className="w-full bg-gradient-to-r from-indigo-600 to-purple-600 text-white py-3 rounded-lg font-semibold hover:from-indigo-700 hover:to-purple-700 transition shadow-md disabled:opacity-50 disabled:cursor-not-allowed" disabled={!isApiKeySet}>
              🔄 Start New Session
            </button>
          </div>
        )}

        <div className="flex-1 flex flex-col bg-white/50">
          {!isSettingsOpen && (<button onClick={() => setIsSettingsOpen(true)} title="Open settings panel" className="absolute top-24 left-4 p-3 bg-indigo-600 text-white rounded-full shadow-lg hover:bg-indigo-700 transition z-10"><Menu size={20} /></button>)}
          <div className="flex-1 overflow-y-auto p-6 space-y-4">
            {messages.length === 0 && !isSessionActive && (
              <div className="text-center text-gray-500 mt-20 flex flex-col items-center">
                <Volume2 size={48} className="mx-auto mb-4 text-indigo-400" />
                <p className="text-lg">Your session is ready.</p><p>{isApiKeySet ? 'Press the microphone button to begin your voice conversation.' : 'Please set your API Key in the settings first.'}</p>
              </div>
            )}
            {messages.map((msg, idx) => (
              <div key={idx} className={`flex items-end gap-2 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                {msg.role === 'ai' && <div className="w-8 h-8 rounded-full bg-gradient-to-br from-purple-500 to-indigo-500 flex-shrink-0 text-white font-bold text-sm flex items-center justify-center">{coachVoice.charAt(0)}</div>}
                <div className={`max-w-[80%] p-4 rounded-2xl ${msg.role === 'user' ? 'bg-gradient-to-r from-indigo-500 to-purple-500 text-white rounded-br-none' : 'bg-gray-100 text-gray-800 border border-gray-200 rounded-bl-none'}`}>
                  <p className="whitespace-pre-wrap leading-relaxed">{msg.content}</p>
                </div>
              </div>
            ))}
            {displayUserTranscription && (<div className="flex items-end gap-2 justify-end"><div className="max-w-[80%] p-4 rounded-2xl bg-indigo-200 text-indigo-900 rounded-br-none opacity-70"><p className="whitespace-pre-wrap leading-relaxed">{displayUserTranscription}</p></div></div>)}
            {displayTutorTranscription && (<div className="flex items-end gap-2 justify-start"><div className="w-8 h-8 rounded-full bg-gradient-to-br from-purple-500 to-indigo-500 flex-shrink-0 text-white font-bold text-sm flex items-center justify-center">{coachVoice.charAt(0)}</div><div className="max-w-[80%] p-4 rounded-2xl bg-gray-50 text-gray-700 border border-gray-200 rounded-bl-none opacity-70"><p className="whitespace-pre-wrap leading-relaxed">{displayTutorTranscription}</p></div></div>)}
            <div ref={messagesEndRef} />
          </div>

          <div className="p-6 bg-white/80 backdrop-blur-sm border-t border-gray-200">
            <div className="flex justify-center">
              <button onClick={handleMicButtonClick} disabled={!isApiKeySet} title={isSessionActive ? 'Stop session' : 'Start session'} className={`p-6 rounded-full shadow-2xl transition-all transform hover:scale-110 ${isSessionActive ? 'bg-red-500 hover:bg-red-600 animate-pulse' : 'bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700'} disabled:bg-gray-400 disabled:cursor-not-allowed disabled:scale-100`}>
                {isSessionActive ? <MicOff size={32} className="text-white" /> : <Mic size={32} className="text-white" />}
              </button>
            </div>
            <p className="text-center mt-3 text-sm text-gray-600 h-5">{statusMessage}</p>
          </div>
        </div>
        {isNotesOpen && (
          <div className="w-80 bg-white shadow-xl p-6 overflow-y-auto relative border-l border-gray-200 transition-all duration-300 flex flex-col">
            <button onClick={() => setIsNotesOpen(false)} title="Close notes panel" className="absolute top-4 right-4 p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-800 rounded-lg transition"><X size={20} /></button>
            <h2 className="text-xl font-bold mb-6 text-indigo-700 flex items-center gap-2"><ClipboardList size={22} />Session Notes</h2>
            <div className="flex-1 flex flex-col gap-4">
              <div className="flex flex-col flex-1">
                  <label htmlFor="general-notes" className="block text-sm font-semibold mb-2 text-gray-700">General Notes</label>
                  <textarea 
                    id="general-notes"
                    value={generalNotes}
                    onChange={(e) => setGeneralNotes(e.target.value)}
                    placeholder="Jot down any thoughts, corrections, or feedback from your session..."
                    className="w-full flex-1 p-3 border border-gray-300 rounded-lg bg-white focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition resize-none"
                  />
              </div>
              <button
                onClick={handleSaveNotes}
                disabled={!canSaveNotes}
                title={!canSaveNotes ? "Start or load a session to save notes" : "Save your notes to the current session"}
                className="w-full bg-gradient-to-r from-indigo-600 to-purple-600 text-white py-3 rounded-lg font-semibold hover:from-indigo-700 hover:to-purple-700 transition shadow-md disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Save Notes to Session
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default App;
