import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ===== CONFIG =====
const PORT = process.env.ONLINE_PORT || 5175;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123'; // TROCAR EM PRODUÇÃO
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const DB_FILE = join(__dirname, 'data', 'online-db.json');

// ===== DATABASE (JSON file) =====
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

// Ensure data directory exists
import { mkdirSync } from 'fs';
try { mkdirSync(join(__dirname, 'data'), { recursive: true }); } catch {}

let db = loadDB();

// Auto-save every 30s
setInterval(() => saveDB(db), 30000);

// ===== CRYPTO HELPERS =====
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const attempt = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(attempt, 'hex'));
}

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
    // Token expires in 7 days
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

// Register
app.post('/api/auth/register', (req, res) => {
  try {
    const { name, phone, password } = req.body;

    // Validation
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
    if (password.length < 4) {
      return res.status(400).json({ error: 'Senha deve ter no mínimo 4 caracteres' });
    }

    // Check if phone already exists
    const existing = db.users.find(u => u.phone === cleanPhone);
    if (existing) {
      return res.status(409).json({ error: 'Este telefone já está cadastrado. Faça login.' });
    }

    // Create user
    const user = {
      id: crypto.randomUUID(),
      name: name.trim(),
      phone: cleanPhone,
      passwordHash: hashPassword(password),
      registeredAt: new Date().toISOString()
    };

    db.users.push(user);
    saveDB(db);

    const token = createToken({ userId: user.id, name: user.name });

    res.json({
      token,
      user: { id: user.id, name: user.name, phone: user.phone }
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Login
app.post('/api/auth/login', (req, res) => {
  try {
    const { phone, password } = req.body;

    if (!phone || !password) {
      return res.status(400).json({ error: 'Telefone e senha são obrigatórios' });
    }

    const cleanPhone = String(phone).replace(/\D/g, '');
    const user = db.users.find(u => u.phone === cleanPhone);

    if (!user) {
      return res.status(401).json({ error: 'Telefone ou senha incorretos' });
    }

    if (!verifyPassword(password, user.passwordHash)) {
      return res.status(401).json({ error: 'Telefone ou senha incorretos' });
    }

    const token = createToken({ userId: user.id, name: user.name });

    res.json({
      token,
      user: { id: user.id, name: user.name, phone: user.phone }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// ===== ANALYTICS ROUTES =====

// Save watch data (advanced tracking)
app.post('/api/analytics/watch', authMiddleware, (req, res) => {
  try {
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
      // Merge segment data: keep max per segment
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

// Watch beacon (for sendBeacon on page unload)
app.post('/api/analytics/watch-beacon', (req, res) => {
  try {
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

// Get my watch data
app.get('/api/analytics/my-watch', authMiddleware, (req, res) => {
  const data = db.watchData.find(w => w.userId === req.userId);
  res.json(data || { totalWatchedSeconds: 0, percentWatched: 0 });
});

// ===== ADMIN ROUTES =====

// Admin login
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Senha incorreta' });
  }
  const token = createToken({ admin: true });
  res.json({ token });
});

// Dashboard data
app.get('/api/admin/dashboard', adminMiddleware, (req, res) => {
  try {
    // Merge users with their watch data
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

    // Stats
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

    res.json({
      stats: {
        totalUsers,
        totalWatchers,
        totalCompleted,
        avgWatchTimeSeconds,
        avgPercent
      },
      users
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).json({ error: 'Erro ao gerar dashboard' });
  }
});

// ===== HEALTH =====
app.get('/health', (req, res) => {
  res.json({ ok: true, users: db.users.length, watchRecords: db.watchData.length });
});

// ===== START =====
app.listen(PORT, '127.0.0.1', () => {
  console.log(`🚀 Servidor Online rodando em http://localhost:${PORT}`);
  console.log(`📊 Dashboard: http://localhost:5173/dashboard.html`);
  console.log(`🔑 Senha admin padrão: ${ADMIN_PASSWORD}`);
  console.log(`👥 Usuários cadastrados: ${db.users.length}`);
});
