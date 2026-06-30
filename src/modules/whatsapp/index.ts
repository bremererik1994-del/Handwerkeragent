import { config } from '../../config';
import { MetaWhatsAppProvider } from './meta.provider';
import { MockWhatsAppProvider } from './mock.provider';
import type { WhatsAppProvider } from './provider.interface';

// Singleton – swap provider via WA_PROVIDER env var without code changes
let _provider: WhatsAppProvider | null = null;

export function getWhatsAppProvider(): WhatsAppProvider {
  if (!_provider) {
    if (config.whatsapp.provider === 'mock' || config.nodeEnv === 'development') {
      _provider = new MockWhatsAppProvider();
    } else {
      _provider = new MetaWhatsAppProvider();
    }
  }
  return _provider;
}

export * from './provider.interface';
