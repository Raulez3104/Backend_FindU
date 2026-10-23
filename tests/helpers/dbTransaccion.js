const pool = require('../../config/database');

// Solo pruebas secuenciales (--runInBand). Nunca permite que un COMMIT del
// servicio confirme la transacción exterior: sus transacciones son savepoints.
async function conTransaccionPrueba(comprobar) {
  const queryOriginal = pool.query;
  const connectOriginal = pool.connect;
  const client = await connectOriginal.call(pool);
  let iniciada = false;
  let siguiente = 0;
  try {
    await client.query('BEGIN');
    iniciada = true;
    const envoltorio = () => {
      const savepoints = [];
      return {
        async query(sql, valores) {
          const comando = typeof sql === 'string' ? sql.trim().replace(/;$/, '').toUpperCase() : '';
          if (comando === 'BEGIN') {
            const nombre = `prueba_${++siguiente}`;
            await client.query(`SAVEPOINT ${nombre}`);
            savepoints.push(nombre);
            return;
          }
          if (comando === 'COMMIT' || comando === 'ROLLBACK') {
            const nombre = savepoints.pop();
            if (!nombre) throw new Error('Transacción interna sin BEGIN');
            if (comando === 'ROLLBACK') await client.query(`ROLLBACK TO SAVEPOINT ${nombre}`);
            return client.query(`RELEASE SAVEPOINT ${nombre}`);
          }
          return client.query(sql, valores);
        },
        release() {},
      };
    };
    const accesoPool = envoltorio();
    pool.query = accesoPool.query;
    pool.connect = async () => envoltorio();
    // El callback recibe el mismo acceso protegido que las consultas del pool.
    return await comprobar(accesoPool);
  } finally {
    pool.query = queryOriginal;
    pool.connect = connectOriginal;
    try {
      if (iniciada) await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  }
}

module.exports = { conTransaccionPrueba };
