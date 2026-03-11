import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import pg from 'pg';

const { Pool } = pg;

// ===== CONFIG =====
const PORT = process.env.ONLINE_PORT || 5175;
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || 'admin123';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const DATABASE_URL = (process.env.DATABASE_URL || '').replace(/[?&]sslmode=[^&]*/g, '');

// ===== DATABASE (PostgreSQL — Aiven) =====
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS online_users (
        id UUID PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        phone VARCHAR(20) UNIQUE NOT NULL,
        registered_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS online_watch_data (
        user_id UUID PRIMARY KEY REFERENCES online_users(id),
        total_watched_seconds REAL DEFAULT 0,
        percent_watched REAL DEFAULT 0,
        current_position REAL DEFAULT 0,
        duration REAL DEFAULT 0,
        completed BOOLEAN DEFAULT FALSE,
        last_watched_at TIMESTAMPTZ DEFAULT NOW(),
        sessions INTEGER DEFAULT 1,
        farthest_point REAL DEFAULT 0,
        forward_skips INTEGER DEFAULT 0,
        rewatch_count INTEGER DEFAULT 0,
        playback_speed REAL DEFAULT 1,
        focus_percent REAL DEFAULT 100,
        segment_data JSONB DEFAULT '[]'
      );
    `);
    console.log('Tabelas PostgreSQL criadas/verificadas com sucesso');
  } finally {
    client.release();
  }
}

initDB().catch(err => console.error('Erro ao inicializar DB:', err));

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
app.post('/api/auth/access', async (req, res) => {
  try {
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
    if (password !== ACCESS_PASSWORD) {
      return res.status(401).json({ error: 'Senha de acesso incorreta' });
    }

    let result = await pool.query('SELECT id, name, phone FROM online_users WHERE phone = $1', [cleanPhone]);
    let user;

    if (result.rows.length === 0) {
      const id = crypto.randomUUID();
      await pool.query(
        'INSERT INTO online_users (id, name, phone, registered_at) VALUES ($1, $2, $3, NOW())',
        [id, name.trim(), cleanPhone]
      );
      user = { id, name: name.trim(), phone: cleanPhone };
    } else {
      user = result.rows[0];
      if (user.name !== name.trim()) {
        await pool.query('UPDATE online_users SET name = $1 WHERE id = $2', [name.trim(), user.id]);
        user.name = name.trim();
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

async function upsertWatchData(userId, b) {
  const result = await pool.query('SELECT * FROM online_watch_data WHERE user_id = $1', [userId]);

  if (result.rows.length > 0) {
    const e = result.rows[0];
    const totalWatchedSeconds = Math.max(e.total_watched_seconds || 0, b.totalWatchedSeconds || 0);
    const percentWatched = Math.max(e.percent_watched || 0, b.percentWatched || 0);
    const currentTime = b.currentTime ?? e.current_position;
    const duration = b.duration || e.duration;
    const completed = e.completed || !!b.completed;
    const farthestPoint = Math.max(e.farthest_point || 0, b.farthestPoint || 0);
    const forwardSkips = Math.max(e.forward_skips || 0, b.forwardSkips || 0);
    const rewatchCount = Math.max(e.rewatch_count || 0, b.rewatchCount || 0);
    const playbackSpeed = b.playbackSpeed || e.playback_speed || 1;
    const focusPercent = b.focusPercent ?? e.focus_percent ?? 100;

    let segmentData = e.segment_data || [];
    if (Array.isArray(b.segmentData) && b.segmentData.length > 0) {
      if (!Array.isArray(segmentData) || segmentData.length !== b.segmentData.length) {
        segmentData = b.segmentData;
      } else {
        for (let i = 0; i < b.segmentData.length; i++) {
          segmentData[i] = Math.max(segmentData[i] || 0, b.segmentData[i] || 0);
        }
      }
    }

    await pool.query(`
      UPDATE online_watch_data SET
        total_watched_seconds = $1, percent_watched = $2, current_position = $3,
        duration = $4, completed = $5, last_watched_at = NOW(),
        farthest_point = $6, forward_skips = $7, rewatch_count = $8,
        playback_speed = $9, focus_percent = $10, segment_data = $11
      WHERE user_id = $12
    `, [totalWatchedSeconds, percentWatched, currentTime, duration, completed,
        farthestPoint, forwardSkips, rewatchCount, playbackSpeed, focusPercent,
        JSON.stringify(segmentData), userId]);
  } else {
    await pool.query(`
      INSERT INTO online_watch_data
        (user_id, total_watched_seconds, percent_watched, current_position, duration,
         completed, last_watched_at, sessions, farthest_point, forward_skips,
         rewatch_count, playback_speed, focus_percent, segment_data)
      VALUES ($1,$2,$3,$4,$5,$6,NOW(),$7,$8,$9,$10,$11,$12,$13)
    `, [userId, b.totalWatchedSeconds || 0, b.percentWatched || 0,
        b.currentTime || 0, b.duration || 0, !!b.completed, 1,
        b.farthestPoint || 0, b.forwardSkips || 0, b.rewatchCount || 0,
        b.playbackSpeed || 1, b.focusPercent ?? 100,
        JSON.stringify(Array.isArray(b.segmentData) ? b.segmentData : [])]);
  }
}

app.post('/api/analytics/watch', authMiddleware, async (req, res) => {
  try {
    await upsertWatchData(req.userId, req.body);
    res.json({ ok: true });
  } catch (err) {
    console.error('Watch analytics error:', err);
    res.status(500).json({ error: 'Erro ao salvar analytics' });
  }
});

app.post('/api/analytics/watch-beacon', async (req, res) => {
  try {
    const token = req.query.token;
    const payload = verifyToken(token);
    if (!payload || !payload.userId) {
      return res.status(401).json({ error: 'Token inválido' });
    }
    await upsertWatchData(payload.userId, req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro' });
  }
});

app.get('/api/analytics/my-watch', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM online_watch_data WHERE user_id = $1', [req.userId]);
    if (result.rows.length > 0) {
      const w = result.rows[0];
      res.json({
        userId: w.user_id,
        totalWatchedSeconds: w.total_watched_seconds,
        percentWatched: w.percent_watched,
        currentTime: w.current_position,
        duration: w.duration,
        completed: w.completed,
        lastWatchedAt: w.last_watched_at,
        sessions: w.sessions,
        farthestPoint: w.farthest_point,
        forwardSkips: w.forward_skips,
        rewatchCount: w.rewatch_count,
        playbackSpeed: w.playback_speed,
        focusPercent: w.focus_percent,
        segmentData: w.segment_data || []
      });
    } else {
      res.json({ totalWatchedSeconds: 0, percentWatched: 0 });
    }
  } catch (err) {
    console.error('My watch error:', err);
    res.status(500).json({ error: 'Erro ao buscar dados' });
  }
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

app.get('/api/admin/dashboard', adminMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.id, u.name, u.phone, u.registered_at,
             w.total_watched_seconds, w.percent_watched, w.completed,
             w.last_watched_at, w.sessions, w.farthest_point,
             w.forward_skips, w.rewatch_count, w.playback_speed,
             w.focus_percent, w.segment_data
      FROM online_users u
      LEFT JOIN online_watch_data w ON w.user_id = u.id
      ORDER BY u.registered_at DESC
    `);

    const users = result.rows.map(r => ({
      id: r.id,
      name: r.name,
      phone: r.phone,
      registeredAt: r.registered_at,
      totalWatchedSeconds: r.total_watched_seconds || 0,
      percentWatched: r.percent_watched || 0,
      completed: r.completed || false,
      lastWatchedAt: r.last_watched_at || null,
      sessions: r.sessions || 0,
      farthestPoint: r.farthest_point || 0,
      forwardSkips: r.forward_skips || 0,
      rewatchCount: r.rewatch_count || 0,
      playbackSpeed: r.playback_speed || 1,
      focusPercent: r.focus_percent ?? 100,
      segmentData: r.segment_data || []
    }));

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

// ===== ATTENDANCE REPORT (para integração com dashboard externo) =====
app.get('/api/admin/attendance-report', adminMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.id, u.name, u.phone, u.registered_at,
             w.total_watched_seconds, w.percent_watched, w.completed,
             w.last_watched_at, w.sessions, w.farthest_point, w.duration,
             w.forward_skips, w.rewatch_count, w.playback_speed,
             w.focus_percent, w.segment_data
      FROM online_users u
      LEFT JOIN online_watch_data w ON w.user_id = u.id
      ORDER BY u.registered_at DESC
    `);

    const participants = [];
    const attendance = [];
    const engagement = [];

    for (const r of result.rows) {
      participants.push({
        id: r.id,
        name: r.name,
        phone: r.phone,
        registeredAt: r.registered_at
      });

      let status = 'nao_assistiu';
      if (r.total_watched_seconds > 0 || r.percent_watched > 0 || r.completed) {
        if (r.completed || (r.percent_watched || 0) >= 90) status = 'concluido';
        else if ((r.percent_watched || 0) > 0) status = 'assistindo';
        else if (r.total_watched_seconds > 0) status = 'iniciou';
      }

      attendance.push({
        userId: r.id,
        phone: r.phone,
        status,
        percentWatched: r.percent_watched || 0,
        totalWatchedSeconds: r.total_watched_seconds || 0,
        completed: r.completed || false,
        firstAccessAt: r.registered_at,
        lastAccessAt: r.last_watched_at || null
      });

      engagement.push({
        userId: r.id,
        phone: r.phone,
        sessions: r.sessions || 0,
        farthestPoint: r.farthest_point || 0,
        duration: r.duration || 0,
        forwardSkips: r.forward_skips || 0,
        rewatchCount: r.rewatch_count || 0,
        playbackSpeed: r.playback_speed || 1,
        focusPercent: r.focus_percent ?? 100,
        segmentData: r.segment_data || []
      });
    }

    const watchers = attendance.filter(a => a.totalWatchedSeconds > 0);
    const summary = {
      totalRegistered: participants.length,
      totalWatched: watchers.length,
      totalCompleted: attendance.filter(a => a.status === 'concluido').length,
      totalWatching: attendance.filter(a => a.status === 'assistindo').length,
      totalStarted: attendance.filter(a => a.status === 'iniciou').length,
      totalNotWatched: attendance.filter(a => a.status === 'nao_assistiu').length,
      avgPercentWatched: watchers.length > 0
        ? Math.round(watchers.reduce((s, a) => s + a.percentWatched, 0) / watchers.length)
        : 0,
      avgWatchTimeSeconds: watchers.length > 0
        ? Math.round(watchers.reduce((s, a) => s + a.totalWatchedSeconds, 0) / watchers.length)
        : 0,
      avgFocusPercent: watchers.length > 0
        ? Math.round(watchers.reduce((s, a) => {
            const eng = engagement.find(e => e.userId === a.userId);
            return s + (eng ? eng.focusPercent : 0);
          }, 0) / watchers.length)
        : 0,
      generatedAt: new Date().toISOString()
    };

    res.json({
      _meta: {
        description: 'Relatório de presença do Encontro Online — use phone como chave para associar com inscritos',
        linkField: 'phone',
        tables: ['participants', 'attendance', 'engagement', 'summary']
      },
      participants,
      attendance,
      engagement,
      summary
    });
  } catch (err) {
    console.error('Attendance report error:', err);
    res.status(500).json({ error: 'Erro ao gerar relatório de presença' });
  }
});

// ===== HEALTH =====
app.get('/health', async (req, res) => {
  try {
    const users = await pool.query('SELECT COUNT(*) FROM online_users');
    const watch = await pool.query('SELECT COUNT(*) FROM online_watch_data');
    res.json({ ok: true, users: parseInt(users.rows[0].count), watchRecords: parseInt(watch.rows[0].count) });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ===== START =====
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Servidor Online rodando em http://localhost:${PORT}`);
  console.log(`Dashboard: http://localhost:5173/dashboard.html`);
  console.log(`Senha de acesso: ${ACCESS_PASSWORD}`);
  console.log(`Senha admin: ${ADMIN_PASSWORD}`);
  console.log(`DB: PostgreSQL (Aiven)`);
});
