import express from 'express';
import multer from 'multer';
import { spawn } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

const UPLOADS_DIR = process.env.UPLOADS_DIR;
const OUTPUTS_DIR = process.env.OUTPUTS_DIR;
const PUBLIC_DIR = process.env.PUBLIC_DIR;


// Ensure directories exist
for (const d of [UPLOADS_DIR, OUTPUTS_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// Multer storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.pdf';
    cb(null, `${Date.now()}-${uuidv4()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
  fileFilter: (req, file, cb) => {
    if ((file.mimetype || '').includes('pdf') || file.originalname.toLowerCase().endsWith('.pdf')) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'));
    }
  }
});

// In-memory job registry
// jobId -> { status, clients:Set(res), outputPath, pythonPid, createdAt }
const jobs = new Map();

// Serve static front-end and outputs
app.use(express.static(PUBLIC_DIR));
app.use('/download', express.static(OUTPUTS_DIR, {
  setHeaders: (res, filePath) => {
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`);
  }
}));

// --- SSE helper ---
function sseInit(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Content-Encoding', 'none');
  res.flushHeaders?.();
  res.write(': connected\n\n');
}
function sseSend(res, event, data) {
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// --- Upload endpoint: starts the Python job ---
app.post('/upload', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const jobId = uuidv4();
    const inputPath = req.file.path; // uploaded temp file

    // Derive an output path; your Python script should write to this path.
    const outputFilename = `${path.parse(req.file.filename).name}-translated.pdf`;
    const outputPath = path.join(OUTPUTS_DIR, outputFilename);

    // Python config
    const PYTHON_BIN = process.env.PYTHON_BIN || 'python3';
    const PYTHON_SCRIPT = process.env.PYTHON_SCRIPT || path.join(__dirname, 'index.py');

    // Spawn Python process — adjust args to match your script
    const args = [
      PYTHON_SCRIPT,
      '--input', inputPath,
      '--output', outputPath
      // add more flags if your script needs API keys, etc. Prefer ENV vars.
    ];

    const child = spawn(PYTHON_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const job = {
      status: 'running',
      clients: new Set(),
      outputPath,
      pythonPid: child.pid,
      createdAt: Date.now()
    };
    jobs.set(jobId, job);

    const sendToAll = (event, payload) => {
      for (const client of job.clients) {
        try { sseSend(client, event, payload); } catch (_) {}
      }
    };

    child.stdout.on('data', (chunk) => {
      sendToAll('log', { type: 'stdout', message: chunk.toString() });
    });

    child.stderr.on('data', (chunk) => {
      sendToAll('log', { type: 'stderr', message: chunk.toString() });
    });

    child.on('error', (err) => {
      job.status = 'error';
      sendToAll('error', { message: `Failed to start Python: ${err.message}` });
      sendToAll('done', { ok: false });
    });

    child.on('close', (code) => {
      if (job.status !== 'error') {
        job.status = code === 0 ? 'finished' : 'failed';
        const ok = code === 0 && fs.existsSync(outputPath);
        const downloadUrls = ok ? {
            pdf: `/download/${path.basename(outputPath)}`,
            csv: `/download/${path.basename(outputPath.replace('.pdf', '.csv'))}`
          } : null;
        sendToAll('done', { ok, code, downloadUrls });
      }
      // Clean up uploaded temp file
      fs.unlink(inputPath, () => {});
    });

    // Reply to the upload with the jobId the client can stream
    res.json({ jobId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// --- SSE stream for a given job ---
app.get('/stream/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) {
    sseInit(res);
    sseSend(res, 'error', { message: 'Unknown job id' });
    return res.end();
  }

  sseInit(res);
  job.clients.add(res);

  // Send initial state
  sseSend(res, 'status', { status: job.status });

  // Heartbeat to keep the connection open on proxies
  const interval = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) {}
  }, 2000);

  req.on('close', () => {
    clearInterval(interval);
    job.clients.delete(res);
  });
});

// --- (Optional) simple health route ---
app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log('Open http://localhost:3000 in your browser');
});