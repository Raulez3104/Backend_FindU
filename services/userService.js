const pool = require('../config/database');

const CAMPOS_CUENTA_ESTUDIANTIL = 'id, nombre, correo, foto, activo';
const ID_MAXIMO = 2147483647;

function crearErrorCuenta(message) {
  return Object.assign(new Error(message), { status: 401 });
}

function normalizarCorreoCuenta(correo) {
  return typeof correo === 'string' ? correo.trim().toLowerCase() : '';
}

function validarIdUsuario(valor) {
  if (typeof valor !== 'string' || !/^[1-9]\d*$/.test(valor)) {
    throw Object.assign(new Error('Identificador de usuario inválido'), {
      status: 400,
    });
  }

  const id = Number(valor);
  if (!Number.isSafeInteger(id) || id > ID_MAXIMO) {
    throw Object.assign(new Error('Identificador de usuario inválido'), {
      status: 400,
    });
  }

  return id;
}

async function buscarCuentaPorCorreoNormalizado(cliente, correo) {
  const query = `
    SELECT ${CAMPOS_CUENTA_ESTUDIANTIL}
    FROM usuarios
    WHERE LOWER(correo) = LOWER($1)
    ORDER BY id ASC
    LIMIT 1
  `;
  const result = await cliente.query(query, [correo]);
  return result.rows[0] || null;
}

function exigirCuentaActiva(cuenta) {
  if (!cuenta) {
    throw crearErrorCuenta('No fue posible resolver la cuenta institucional');
  }
  if (cuenta.activo !== true) {
    throw crearErrorCuenta('La cuenta institucional no está activa');
  }
  return cuenta;
}

function crearResolutorCuentaEstudiantil({ pool: cliente = pool } = {}) {
  return async function resolverCuentaEstudiantil(identidad) {
    const correo = normalizarCorreoCuenta(identidad.correo);
    const existente = await buscarCuentaPorCorreoNormalizado(cliente, correo);

    if (existente) {
      return exigirCuentaActiva(existente);
    }

    await cliente.query(
      `
        INSERT INTO usuarios (nombre, correo, foto, activo)
        VALUES ($1, $2, $3, TRUE)
        ON CONFLICT (correo) DO NOTHING
        RETURNING id
      `,
      [identidad.nombre, correo, identidad.foto],
    );

    const cuentaResuelta = await buscarCuentaPorCorreoNormalizado(
      cliente,
      correo,
    );
    return exigirCuentaActiva(cuentaResuelta);
  };
}

const resolverCuentaEstudiantil = crearResolutorCuentaEstudiantil();

async function buscarPorCorreo(correo) {
  const query = 'SELECT id, nombre, correo, foto, activo FROM usuarios WHERE correo = $1';
  const result = await pool.query(query, [correo]);
  return result.rows;
}

async function crearUsuario(data) {
  const query = 'INSERT INTO usuarios (nombre, correo, foto, activo) VALUES ($1, $2, $3, true) RETURNING id';
  const result = await pool.query(query, [data.nombre || data.name || null, data.correo || data.email, data.foto || data.picture || null]);
  return { id: result.rows[0].id };
}

async function obtenerPorId(id) {
  const query = `SELECT id, nombre, correo, foto, activo, TO_CHAR(fecha_creacion, 'YYYY-MM-DD HH24:MI') AS fecha_creacion FROM usuarios WHERE id = $1`;
  const result = await pool.query(query, [id]);
  return result.rows;
}

async function listarTodos() {
  const query = `SELECT id, nombre, correo, foto, activo, TO_CHAR(fecha_creacion, 'YYYY-MM-DD HH24:MI') AS fecha_creacion FROM usuarios ORDER BY fecha_creacion DESC, id DESC`;
  const result = await pool.query(query);
  return result.rows;
}

async function crear(data) {
  if (!data.nombre && !data.name) {
    throw { message: 'Nombre es requerido' };
  }
  if (!data.correo && !data.email) {
    throw { message: 'Correo es requerido' };
  }

  const nombre = data.nombre || data.name;
  const correo = data.correo || data.email;

  const existing = await pool.query('SELECT id FROM usuarios WHERE correo = $1', [correo]);
  if (existing.rows.length > 0) {
    throw { duplicate: true, id: existing.rows[0].id };
  }

  const query = 'INSERT INTO usuarios (nombre, correo, foto, activo) VALUES ($1, $2, $3, true) RETURNING id';
  const result = await pool.query(query, [nombre, correo, data.foto || data.picture || null]);
  return { id: result.rows[0].id };
}

async function actualizarActivo(id, activo) {
  const result = await pool.query('UPDATE usuarios SET activo = $1 WHERE id = $2 RETURNING id', [activo, id]);
  if (result.rowCount === 0) throw { notFound: true };
  return { id, activo };
}

async function loginGoogle(data) {
  const correo = data.email;
  const results = await buscarPorCorreo(correo);
  if (results.length > 0) {
    return { usuario: results[0], esNuevo: false };
  }
  const result = await crearUsuario(data);
  const usuario = await obtenerPorId(result.id);
  return { usuario: usuario[0], esNuevo: true };
}

module.exports = {
  buscarPorCorreo,
  crearResolutorCuentaEstudiantil,
  crearUsuario,
  obtenerPorId,
  listarTodos,
  crear,
  actualizarActivo,
  loginGoogle,
  resolverCuentaEstudiantil,
  validarIdUsuario,
};
