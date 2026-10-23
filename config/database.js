const { Pool } = require('pg');

// TIMESTAMPTZ guarda un instante; TO_CHAR debe presentarlo en la zona
// institucional. PostgreSQL arranca en GMT en esta instalación.
const ZONA_HORARIA = process.env.DB_TIMEZONE || 'America/La_Paz';

const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 5432,
  options: `-c timezone=${ZONA_HORARIA}`,
});

pool.connect((err, client, release) => {
  if (err) {
    console.error('Error al conectar a PostgreSQL:', err);
    process.exit(1);
  } else {
    console.log('Conectado a PostgreSQL - Base de datos:', process.env.DB_NAME);
    release();
  }
});

module.exports = pool;
