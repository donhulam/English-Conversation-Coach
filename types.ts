export type MessageRole = 'user' | 'ai';

export interface Message {
  role: MessageRole;
  content: string;
}

export interface ConversationSession {
  id: number;
  date: string;
  level: string;
  topic: string;
  messages: Message[];
  notes?: {
    general: string;
  }
}