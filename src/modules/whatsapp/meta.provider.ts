import axios from 'axios';
import { config } from '../../config';
import type { WhatsAppProvider, OutboundMessage } from './provider.interface';

const BASE = 'https://graph.facebook.com/v19.0';

export class MetaWhatsAppProvider implements WhatsAppProvider {
  private phoneNumberId = config.whatsapp.meta.phoneNumberId;
  private token = config.whatsapp.meta.accessToken;

  async sendMessage(msg: OutboundMessage): Promise<string> {
    let payload: Record<string, unknown>;

    if (msg.template) {
      payload = {
        messaging_product: 'whatsapp',
        to: msg.to,
        type: 'template',
        template: {
          name: msg.template.name,
          language: { code: msg.template.language },
          components: msg.template.components ?? [],
        },
      };
    } else if (msg.interactive) {
      payload = {
        messaging_product: 'whatsapp',
        to: msg.to,
        type: 'interactive',
        interactive: msg.interactive,
      };
    } else {
      payload = {
        messaging_product: 'whatsapp',
        to: msg.to,
        type: 'text',
        text: { body: msg.text ?? '' },
      };
    }

    const res = await axios.post(
      `${BASE}/${this.phoneNumberId}/messages`,
      payload,
      { headers: { Authorization: `Bearer ${this.token}` } },
    );
    return res.data.messages?.[0]?.id ?? '';
  }

  async getMediaUrl(mediaId: string): Promise<string> {
    const res = await axios.get(`${BASE}/${mediaId}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    return res.data.url as string;
  }

  async markRead(waMessageId: string): Promise<void> {
    await axios.post(
      `${BASE}/${this.phoneNumberId}/messages`,
      { messaging_product: 'whatsapp', status: 'read', message_id: waMessageId },
      { headers: { Authorization: `Bearer ${this.token}` } },
    );
  }
}
