import type { WhatsAppProvider, OutboundMessage } from './provider.interface';

// Used in development / test – logs messages to console, does not call Meta
export class MockWhatsAppProvider implements WhatsAppProvider {
  async sendMessage(msg: OutboundMessage): Promise<string> {
    const id = `mock-${Date.now()}`;
    console.log('[MockWA] OUTBOUND →', msg.to, msg.text ?? msg.template?.name ?? 'interactive');
    return id;
  }

  async getMediaUrl(_mediaId: string): Promise<string> {
    return 'https://placekitten.com/400/300'; // placeholder for dev
  }

  async markRead(waMessageId: string): Promise<void> {
    console.log('[MockWA] markRead', waMessageId);
  }
}
