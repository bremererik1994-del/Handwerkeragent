export interface OutboundMessage {
  to: string; // E.164 phone number
  text?: string;
  template?: {
    name: string;
    language: string;
    components?: TemplateComponent[];
  };
  interactive?: InteractiveMessage;
}

export interface TemplateComponent {
  type: 'header' | 'body' | 'button';
  parameters?: Array<{ type: string; text?: string }>;
}

export interface InteractiveMessage {
  type: 'button' | 'list';
  body: { text: string };
  action: {
    buttons?: Array<{ type: 'reply'; reply: { id: string; title: string } }>;
  };
}

export interface InboundMessage {
  waMessageId: string;
  from: string; // E.164
  text?: string;
  mediaId?: string;
  mediaType?: string;
  mediaUrl?: string;
  timestamp: Date;
  buttonReply?: { id: string; title: string };
}

export interface WhatsAppProvider {
  sendMessage(msg: OutboundMessage): Promise<string>; // returns waMessageId
  getMediaUrl(mediaId: string): Promise<string>;
  markRead(waMessageId: string): Promise<void>;
}
