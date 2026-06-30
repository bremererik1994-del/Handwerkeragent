import dotenv from 'dotenv';
dotenv.config();

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

export const config = {
  port: parseInt(process.env.PORT ?? '3001'),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  databaseUrl: required('DATABASE_URL'),

  jwtSecret: process.env.JWT_SECRET ?? 'change-me-in-production',
  jwtExpiresIn: '7d',

  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',

  whatsapp: {
    provider: process.env.WA_PROVIDER ?? 'meta', // 'meta' | 'twilio' | 'mock'
    meta: {
      accessToken: process.env.WA_META_ACCESS_TOKEN ?? '',
      phoneNumberId: process.env.WA_META_PHONE_NUMBER_ID ?? '',
      webhookVerifyToken: process.env.WA_WEBHOOK_VERIFY_TOKEN ?? 'zeitpilot-verify',
      businessAccountId: process.env.WA_META_BUSINESS_ACCOUNT_ID ?? '',
    },
  },

  frontendUrl: process.env.FRONTEND_URL ?? 'http://localhost:5173',
  mediaStoragePath: process.env.MEDIA_STORAGE_PATH ?? './uploads',
};
