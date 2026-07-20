import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { config } from './config';
import routes from './routes/index';
import { scheduleGdprCleanup } from './jobs/gdprCleanup';

const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
const ALLOWED_ORIGINS = new Set(
  [config.frontendUrl, process.env.CORS_EXTRA_ORIGIN].filter(Boolean) as string[],
);

app.use(cors({
  origin: (origin, cb) => {
    // no origin = curl / Postman / same-origin fetch
    if (!origin) return cb(null, true);
    if (config.nodeEnv !== 'production') return cb(null, true); // dev: open
    if (ALLOWED_ORIGINS.has(origin) || origin.startsWith('file://')) return cb(null, true);
    cb(new Error(`CORS: origin '${origin}' not allowed`));
  },
  credentials: true,
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'uploads')));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api', routes);

app.get('/health', (_req, res) => res.json({ status: 'ok', env: config.nodeEnv }));

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: 'Interner Fehler' });
});

app.listen(config.port, () => {
  console.log(`ZeitPilot Backend running on port ${config.port} (${config.nodeEnv})`);
  scheduleGdprCleanup();
});
