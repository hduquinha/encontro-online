import pg from 'pg';

const DATABASE_URL = (process.env.DATABASE_URL || '').replace(/[?&]sslmode=[^&]*/g, '');
const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

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
  console.log('TABELAS CRIADAS COM SUCESSO!');

  const r = await client.query(`
    SELECT table_name FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_name LIKE 'online_%'
  `);
  console.log('Tabelas encontradas:', r.rows.map(row => row.table_name));

  // Listar TODAS as tabelas do banco
  const all = await client.query(`
    SELECT table_name FROM information_schema.tables 
    WHERE table_schema = 'public' ORDER BY table_name
  `);
  console.log('TODAS as tabelas no banco:', all.rows.map(row => row.table_name));

  // Verificar permissões
  const perms = await client.query(`
    SELECT grantee, table_name, privilege_type 
    FROM information_schema.table_privileges 
    WHERE table_name IN ('online_users', 'online_watch_data')
    ORDER BY table_name, grantee
  `);
  console.log('Permissões:', perms.rows);

} finally {
  client.release();
  await pool.end();
}
