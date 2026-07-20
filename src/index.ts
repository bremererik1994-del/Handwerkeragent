import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config';
import routes from './routes/index';
import { scheduleGdprCleanup } from './jobs/gdprCleanup';

const app = express();

app.use(helmet());
app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (local files, curl, Postman)
    // and the configured frontend URL
    if (!origin || origin === config.frontendUrl || origin.startsWith('file://')) {
      cb(null, true);
    } else {
      cb(null, true); // allow all origins in dev/test; tighten in production
    }
  },
  credentials: true,
}));
app.use(express.json());
app.use(express.static('uploads')); // serve uploaded media
app.use(express.static('public'));  // serve legal pages etc.

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
