import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ===== CONFIG =====
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || 'admin123'; // Senha compartilhada de acesso à aula
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123'; // Senha do painel admin
const JWT_SECRET = process.env.JWT_SECRET || 'vercel-default-secret-change-me';
const DB_FILE = join('/tmp', 'online-db.json');

// ===== DATABASE (JSON file in /tmp — NOT persistent on Vercel!) =====
// WARNING: /tmp is ephemeral on Vercel. Data will be lost between cold starts.
// For production, use a real database (e.g., Vercel KV, Supabase, PlanetScale).
function loadDB() {
  try {
    if (existsSync(DB_FILE)) {
      return JSON.parse(readFileSync(DB_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error('Erro ao ler DB:', e.message);
  }
  return { users: [], watchData: [] };
}

function saveDB(db) {
  writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf-8');
}

let db = loadDB();

// ===== CRYPTO HELPERS =====
function createToken(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ ...payload, iat: Date.now() })).toString('base64url');
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

function verifyToken(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${parts[0]}.${parts[1]}`).digest('base64url');
    if (sig !== parts[2]) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (Date.now() - payload.iat > 7 * 24 * 60 * 60 * 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

// ===== MIDDLEWARE =====
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  const payload = verifyToken(token);
  if (!payload || !payload.userId) {
    return res.status(401).json({ error: 'Token inválido ou expirado' });
  }
  req.userId = payload.userId;
  req.userName = payload.name;
  next();
}

function adminMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  const payload = verifyToken(token);
  if (!payload || !payload.admin) {
    return res.status(403).json({ error: 'Acesso negado' });
  }
  next();
}

// ===== EXPRESS APP =====
const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ===== AUTH ROUTES =====

// Access (single shared password — identifies user by name + phone)
app.post('/api/auth/access', (req, res) => {
  try {
    db = loadDB();
    const { name, phone, password } = req.body;

    if (!name || !phone || !password) {
      return res.status(400).json({ error: 'Nome, telefone e senha são obrigatórios' });
    }
    if (name.trim().split(/\s+/).length < 2) {
      return res.status(400).json({ error: 'Informe nome e sobrenome' });
    }
    const cleanPhone = String(phone).replace(/\D/g, '');
    if (cleanPhone.length < 10 || cleanPhone.length > 11) {
      return res.status(400).json({ error: 'Telefone inválido' });
    }

    // Check shared access password
    if (password !== ACCESS_PASSWORD) {
      return res.status(401).json({ error: 'Senha de acesso incorreta' });
    }

    // Find or create user by phone
    let user = db.users.find(u => u.phone === cleanPhone);
    if (!user) {
      user = {
        id: crypto.randomUUID(),
        name: name.trim(),
        phone: cleanPhone,
        registeredAt: new Date().toISOString()
      };
      db.users.push(user);
      saveDB(db);
    } else {
      if (user.name !== name.trim()) {
        user.name = name.trim();
        saveDB(db);
      }
    }

    const token = createToken({ userId: user.id, name: user.name });
    res.json({ token, user: { id: user.id, name: user.name, phone: user.phone } });
  } catch (err) {
    console.error('Access error:', err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// ===== ANALYTICS ROUTES =====

app.post('/api/analytics/watch', authMiddleware, (req, res) => {
  try {
    db = loadDB();
    const b = req.body;
    let existing = db.watchData.find(w => w.userId === req.userId);

    if (existing) {
      existing.totalWatchedSeconds = Math.max(existing.totalWatchedSeconds || 0, b.totalWatchedSeconds || 0);
      existing.percentWatched = Math.max(existing.percentWatched || 0, b.percentWatched || 0);
      existing.currentTime = b.currentTime ?? existing.currentTime;
      existing.duration = b.duration || existing.duration;
      existing.completed = existing.completed || !!b.completed;
      existing.lastWatchedAt = new Date().toISOString();
      existing.farthestPoint = Math.max(existing.farthestPoint || 0, b.farthestPoint || 0);
      existing.forwardSkips = Math.max(existing.forwardSkips || 0, b.forwardSkips || 0);
      existing.rewatchCount = Math.max(existing.rewatchCount || 0, b.rewatchCount || 0);
      existing.playbackSpeed = b.playbackSpeed || existing.playbackSpeed || 1;
      existing.focusPercent = b.focusPercent ?? existing.focusPercent ?? 100;
      if (Array.isArray(b.segmentData) && b.segmentData.length > 0) {
        if (!existing.segmentData || existing.segmentData.length !== b.segmentData.length) {
          existing.segmentData = b.segmentData;
        } else {
          for (let i = 0; i < b.segmentData.length; i++) {
            existing.segmentData[i] = Math.max(existing.segmentData[i] || 0, b.segmentData[i] || 0);
          }
        }
      }
    } else {
      db.watchData.push({
        userId: req.userId,
        totalWatchedSeconds: b.totalWatchedSeconds || 0,
        currentTime: b.currentTime || 0,
        duration: b.duration || 0,
        percentWatched: b.percentWatched || 0,
        completed: !!b.completed,
        lastWatchedAt: new Date().toISOString(),
        sessions: 1,
        farthestPoint: b.farthestPoint || 0,
        forwardSkips: b.forwardSkips || 0,
        rewatchCount: b.rewatchCount || 0,
        playbackSpeed: b.playbackSpeed || 1,
        focusPercent: b.focusPercent ?? 100,
        segmentData: Array.isArray(b.segmentData) ? b.segmentData : []
      });
    }

    saveDB(db);
    res.json({ ok: true });
  } catch (err) {
    console.error('Watch analytics error:', err);
    res.status(500).json({ error: 'Erro ao salvar analytics' });
  }
});

app.post('/api/analytics/watch-beacon', (req, res) => {
  try {
    db = loadDB();
    const token = req.query.token;
    const payload = verifyToken(token);
    if (!payload || !payload.userId) {
      return res.status(401).json({ error: 'Token inválido' });
    }

    const b = req.body;
    let existing = db.watchData.find(w => w.userId === payload.userId);

    if (existing) {
      existing.totalWatchedSeconds = Math.max(existing.totalWatchedSeconds || 0, b.totalWatchedSeconds || 0);
      existing.percentWatched = Math.max(existing.percentWatched || 0, b.percentWatched || 0);
      existing.currentTime = b.currentTime ?? existing.currentTime;
      existing.duration = b.duration || existing.duration;
      existing.completed = existing.completed || !!b.completed;
      existing.lastWatchedAt = new Date().toISOString();
      existing.farthestPoint = Math.max(existing.farthestPoint || 0, b.farthestPoint || 0);
      existing.forwardSkips = Math.max(existing.forwardSkips || 0, b.forwardSkips || 0);
      existing.rewatchCount = Math.max(existing.rewatchCount || 0, b.rewatchCount || 0);
      existing.playbackSpeed = b.playbackSpeed || existing.playbackSpeed || 1;
      existing.focusPercent = b.focusPercent ?? existing.focusPercent ?? 100;
      if (Array.isArray(b.segmentData) && b.segmentData.length > 0) {
        if (!existing.segmentData || existing.segmentData.length !== b.segmentData.length) {
          existing.segmentData = b.segmentData;
        } else {
          for (let i = 0; i < b.segmentData.length; i++) {
            existing.segmentData[i] = Math.max(existing.segmentData[i] || 0, b.segmentData[i] || 0);
          }
        }
      }
    } else {
      db.watchData.push({
        userId: payload.userId,
        totalWatchedSeconds: b.totalWatchedSeconds || 0,
        currentTime: b.currentTime || 0,
        duration: b.duration || 0,
        percentWatched: b.percentWatched || 0,
        completed: !!b.completed,
        lastWatchedAt: new Date().toISOString(),
        sessions: 1,
        farthestPoint: b.farthestPoint || 0,
        forwardSkips: b.forwardSkips || 0,
        rewatchCount: b.rewatchCount || 0,
        playbackSpeed: b.playbackSpeed || 1,
        focusPercent: b.focusPercent ?? 100,
        segmentData: Array.isArray(b.segmentData) ? b.segmentData : []
      });
    }

    saveDB(db);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro' });
  }
});

app.get('/api/analytics/my-watch', authMiddleware, (req, res) => {
  db = loadDB();
  const data = db.watchData.find(w => w.userId === req.userId);
  res.json(data || { totalWatchedSeconds: 0, percentWatched: 0 });
});

// ===== ADMIN ROUTES =====

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Senha incorreta' });
  }
  const token = createToken({ admin: true });
  res.json({ token });
});

app.get('/api/admin/dashboard', adminMiddleware, (req, res) => {
  try {
    db = loadDB();
    const users = db.users.map(u => {
      const watch = db.watchData.find(w => w.userId === u.id) || {};
      return {
        id: u.id,
        name: u.name,
        phone: u.phone,
        registeredAt: u.registeredAt,
        totalWatchedSeconds: watch.totalWatchedSeconds || 0,
        percentWatched: watch.percentWatched || 0,
        completed: watch.completed || false,
        lastWatchedAt: watch.lastWatchedAt || null,
        sessions: watch.sessions || 0,
        farthestPoint: watch.farthestPoint || 0,
        forwardSkips: watch.forwardSkips || 0,
        rewatchCount: watch.rewatchCount || 0,
        playbackSpeed: watch.playbackSpeed || 1,
        focusPercent: watch.focusPercent ?? 100,
        segmentData: watch.segmentData || []
      };
    });

    const totalUsers = users.length;
    const watchers = users.filter(u => u.totalWatchedSeconds > 0);
    const totalWatchers = watchers.length;
    const totalCompleted = users.filter(u => u.completed || u.percentWatched >= 90).length;
    const avgWatchTimeSeconds = totalWatchers > 0
      ? Math.round(watchers.reduce((sum, u) => sum + u.totalWatchedSeconds, 0) / totalWatchers)
      : 0;
    const avgPercent = totalWatchers > 0
      ? Math.round(watchers.reduce((sum, u) => sum + u.percentWatched, 0) / totalWatchers)
      : 0;

    res.json({ stats: { totalUsers, totalWatchers, totalCompleted, avgWatchTimeSeconds, avgPercent }, users });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).json({ error: 'Erro ao gerar dashboard' });
  }
});

// ===== HEALTH =====
app.get('/api/health', (req, res) => {
  db = loadDB();
  res.json({ ok: true, users: db.users.length, watchRecords: db.watchData.length });
});

// Export for Vercel
export default app;
