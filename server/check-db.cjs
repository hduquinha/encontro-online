const pg = require('pg');
const DATABASE_URL = (process.env.DATABASE_URL || '').replace(/[?&]sslmode=[^&]*/g, '');
const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

(async () => {
  try {
    // Listar todas as tabelas
    const tables = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`
    );
    console.log('=== TODAS AS TABELAS ===');
    tables.rows.forEach(r => console.log('  -', r.table_name));

    // online_users
    const users = await pool.query('SELECT * FROM online_users ORDER BY registered_at DESC');
    console.log('\n=== online_users (' + users.rows.length + ' registros) ===');
    users.rows.forEach(r => console.log(JSON.stringify(r)));

    // online_watch_data
    const watch = await pool.query('SELECT * FROM online_watch_data');
    console.log('\n=== online_watch_data (' + watch.rows.length + ' registros) ===');
    watch.rows.forEach(r => console.log(JSON.stringify(r)));

    // anamnese_respostas
    const anam = await pool.query('SELECT COUNT(*) as total FROM anamnese_respostas');
    console.log('\n=== anamnese_respostas: ' + anam.rows[0].total + ' registros ===');

    // Verificar se tem dados na anamnese com telefones que batem
    if (users.rows.length > 0) {
      const phones = users.rows.map(u => u.phone);
      const match = await pool.query(
        `SELECT telefone, nome FROM anamnese_respostas WHERE telefone = ANY($1)`,
        [phones]
      );
      console.log('\n=== MATCH telefone entre anamnese e online_users: ' + match.rows.length + ' ===');
      match.rows.forEach(r => console.log(JSON.stringify(r)));
    }

  } catch (e) {
    console.error('ERRO:', e.message);
  } finally {
    await pool.end();
  }
})();
