
export type MessageRole = 'user' | 'ai';

export interface Message {
  role: MessageRole;
  content: string;
}
