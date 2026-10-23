const pool = require('../config/database');
const contrato = require('./reportContract');

function errorAlta(message) {
  const error = new Error(message);
  error.status = 400;
  throw error;
}

const enteroAlta = contrato.validarIdAlta;
const textoAlta = contrato.textoObligatorio;

// Preparación de T3: solo valida y consulta; no inserta reportes ni historial.
// El autor interno no es una credencial y no se expone por HTTP.
async function resolverAlta({ autor, datos, imagenPath }, opciones = {}) {
  const entrada = contrato.normalizarEntrada(datos);
  if (!autor || !['usuario', 'admin'].includes(autor.tipo)) {
    errorAlta('Se requiere un actor autenticado válido');
  }
  const autorResuelto = { tipo: autor.tipo, id: enteroAlta(autor.id, 'autor.id') };
  const tipoEstado = contrato.resolverTipoEstado(entrada, autorResuelto);
  const titulo = textoAlta(entrada.titulo, 'titulo', 255);
  const descripcion = textoAlta(entrada.descripcion, 'descripcion');
  const contacto = textoAlta(entrada.contacto, 'contacto', 255);
  const categoriaId = enteroAlta(entrada.categoria_id, 'categoria_id');
  const fecha = contrato.validarFechaIncidente(entrada.fecha_incidente, opciones);
  const imagen = textoAlta(imagenPath, 'fotografía');
  const forma = contrato.resolverFormaUbicacion(entrada);

  const tablaAutor = autorResuelto.tipo === 'admin' ? 'administradores' : 'usuarios';
  const existente = await pool.query(`SELECT id FROM ${tablaAutor} WHERE id = $1`, [autorResuelto.id]);
  if (existente.rows.length === 0) errorAlta('El autor no existe');
  const categoria = await pool.query('SELECT id FROM categorias WHERE id = $1 AND activo = TRUE', [categoriaId]);
  if (categoria.rows.length === 0) errorAlta('La categoría no existe o está inactiva');

  let ubicacion;
  if (forma.forma === 'id') {
    const resultado = await pool.query(
      'SELECT id FROM ubicaciones WHERE id = $1 AND campus = $2 AND activo = TRUE',
      [forma.ubicacion_id, forma.campus],
    );
    if (resultado.rows.length === 0) errorAlta('La ubicación no existe, está inactiva o no pertenece al campus');
    ubicacion = { ubicacion_id: resultado.rows[0].id, ubicacion_otro: null };
  } else {
    ubicacion = { ubicacion_id: null, ubicacion_otro: forma.ubicacion_otro };
  }
  return {
    autor: autorResuelto, titulo, descripcion, contacto, categoria_id: categoriaId,
    fecha_incidente: fecha, campus: forma.campus, ...ubicacion, ...tipoEstado, imagen,
  };
}

function buildImageUrl(req, filename) {
  if (!filename) return null;
  const host = req.get('host');
  const proto = req.protocol || 'http';
  return `${proto}://${host}/uploads/${filename}`;
}

async function conTransaccion(ejecutar) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const resultado = await ejecutar(client);
    await client.query('COMMIT');
    return resultado;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function crearReporte(entrada, opciones = {}) {
  const alta = await resolverAlta(entrada, opciones);
  return conTransaccion(async (client) => {
    const resultado = await client.query(`
      INSERT INTO reportes (usuario_id, administrador_id, titulo, descripcion, categoria_id,
        campus, ubicacion_id, ubicacion_otro, contacto, tipo_reporte, estado, imagen, fecha_incidente)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING id
    `, [
      alta.autor.tipo === 'usuario' ? alta.autor.id : null,
      alta.autor.tipo === 'admin' ? alta.autor.id : null,
      alta.titulo, alta.descripcion, alta.categoria_id, alta.campus,
      alta.ubicacion_id, alta.ubicacion_otro, alta.contacto, alta.tipo_reporte,
      alta.estado, alta.imagen, alta.fecha_incidente,
    ]);
    const id = resultado.rows[0].id;
    await client.query(`
      INSERT INTO historial (reporte_id, accion, valor_anterior, valor_nuevo, realizado_por, tipo_realizado_por)
      VALUES ($1, 'creacion', NULL, $2, $3, $4)
    `, [id, alta.estado, alta.autor.id, alta.autor.tipo]);
    return { id, imagen: alta.imagen };
  });
}

const proyeccionReporte = `
  SELECT r.id, r.usuario_id, r.administrador_id,
    CASE WHEN r.administrador_id IS NOT NULL THEN 'admin' ELSE 'usuario' END AS tipo_autor,
    u.nombre AS usuario_nombre, u.correo AS usuario_correo,
    a.nombre AS administrador_nombre, r.titulo, r.descripcion, r.contacto,
    r.categoria_id, c.nombre AS categoria_nombre,
    TO_CHAR(r.fecha_incidente, 'YYYY-MM-DD') AS fecha_incidente,
    TO_CHAR(r.fecha_creacion, 'YYYY-MM-DD HH24:MI') AS fecha,
    r.campus, r.ubicacion_id, b.nombre AS ubicacion_nombre, r.ubicacion_otro,
    r.imagen, r.tipo_reporte, r.estado, r.activo
  FROM reportes r
  LEFT JOIN usuarios u ON r.usuario_id = u.id
  LEFT JOIN administradores a ON r.administrador_id = a.id
  LEFT JOIN categorias c ON r.categoria_id = c.id
  LEFT JOIN ubicaciones b ON r.ubicacion_id = b.id
`;

async function consultarReportes(filtro, valores = []) {
  const result = await pool.query(`${proyeccionReporte} ${filtro}`, valores);
  return result.rows.map((reporte) => ({
    ...reporte, estado: contrato.presentarEstado(reporte.estado),
  }));
}

async function obtenerTodosLosReportes() {
  return consultarReportes('WHERE r.activo = TRUE ORDER BY r.fecha_creacion DESC');
}

function validarIdUsuarioRuta(valor) {
  if (typeof valor !== 'string' || !/^[1-9]\d*$/.test(valor)) {
    throw Object.assign(new Error('Identificador de usuario inválido'), { status: 400 });
  }
  const id = Number(valor);
  if (!Number.isSafeInteger(id) || id > 2147483647) {
    throw Object.assign(new Error('Identificador de usuario inválido'), { status: 400 });
  }
  return id;
}

async function obtenerReportesPorUsuario(usuarioIdSolicitado, usuarioIdAutenticado) {
  const idSolicitado = validarIdUsuarioRuta(usuarioIdSolicitado);
  if (idSolicitado !== usuarioIdAutenticado) {
    throw Object.assign(
      new Error('No puede consultar reportes de otro usuario'),
      { status: 403 },
    );
  }
  return consultarReportes(
    'WHERE r.usuario_id = $1 ORDER BY r.fecha_creacion DESC',
    [usuarioIdAutenticado],
  );
}

async function obtenerPorId(id) {
  if (!/^\d+$/.test(String(id)) || !Number.isSafeInteger(Number(id)) || Number(id) <= 0) return undefined;
  const reportes = await consultarReportes('WHERE r.id = $1', [id]);
  return reportes[0];
}

async function obtenerEstadisticas() {
  const byEstadoSql = `
    SELECT estado, COUNT(*) AS count
    FROM reportes
    GROUP BY estado
  `;

  const totalesSql = `
    SELECT
      COUNT(*) FILTER (WHERE activo = TRUE) AS activos,
      COUNT(*) FILTER (WHERE activo = FALSE) AS inactivos,
      COUNT(*) AS total
    FROM reportes
  `;

  const porFechaSql = `
    SELECT TO_CHAR(fecha_creacion, 'YYYY-MM-DD') AS fecha, COUNT(*) AS count
    FROM reportes
    GROUP BY TO_CHAR(fecha_creacion, 'YYYY-MM-DD')
    ORDER BY fecha ASC
  `;

  const porUbicacionSql = `
    SELECT r.campus, b.nombre AS ubicacion, COUNT(*) AS count
    FROM reportes r
    JOIN ubicaciones b ON r.ubicacion_id = b.id
    GROUP BY r.campus, b.nombre
    ORDER BY r.campus, b.nombre
  `;

  // Secuenciales: también funcionan sobre un único cliente transaccional.
  const estadoResult = await pool.query(byEstadoSql);
  const totalesResult = await pool.query(totalesSql);
  const fechaResult = await pool.query(porFechaSql);
  const ubicacionResult = await pool.query(porUbicacionSql);
  return contrato.formatearEstadisticas({
    totales: totalesResult.rows[0],
    porEstado: estadoResult.rows,
    seriesFechas: fechaResult.rows,
    seriesUbicaciones: ubicacionResult.rows,
  });
}

// Capacidad interna: el ID recibido no acredita identidad y nunca se toma de HTTP.
async function cambiarEstadoReporte({ reporteId, estado, administradorId } = {}) {
  const denegar = () => { throw Object.assign(new Error('Se requiere personal de servicios'), { status: 403 }); };
  if (!/^\d+$/.test(String(administradorId)) || !Number.isSafeInteger(Number(administradorId)) || Number(administradorId) <= 0) denegar();
  const actor = await pool.query('SELECT id, rol FROM administradores WHERE id = $1', [administradorId]);
  if (actor.rows[0]?.rol !== 'personal_servicios') denegar();
  if (!/^\d+$/.test(String(reporteId)) || !Number.isSafeInteger(Number(reporteId)) || Number(reporteId) <= 0) {
    throw Object.assign(new Error('Reporte no encontrado'), { status: 404 });
  }
  return conTransaccion(async (client) => {
    const resultado = await client.query('SELECT id, tipo_reporte, estado FROM reportes WHERE id = $1 FOR UPDATE', [reporteId]);
    const reporte = resultado.rows[0];
    if (!reporte) throw Object.assign(new Error('Reporte no encontrado'), { status: 404 });
    if (estado === reporte.estado) return { cambiado: false, estado: contrato.presentarEstado(reporte.estado) };
    if (!contrato.esTransicionValida(reporte.tipo_reporte, reporte.estado, estado)) errorAlta('Transición de estado no permitida');
    await client.query('UPDATE reportes SET estado = $1 WHERE id = $2', [estado, reporte.id]);
    await client.query(`
      INSERT INTO historial (reporte_id, accion, valor_anterior, valor_nuevo, realizado_por, tipo_realizado_por)
      VALUES ($1, 'cambio_estado', $2, $3, $4, 'admin')
    `, [reporte.id, reporte.estado, estado, actor.rows[0].id]);
    return { cambiado: true, id: reporte.id, estado: contrato.presentarEstado(estado) };
  });
}

async function actualizarActivoReporte(id, activo) {
  const query = 'UPDATE reportes SET activo = $1 WHERE id = $2 RETURNING id';
  const result = await pool.query(query, [activo, id]);
  if (result.rowCount === 0) throw { notFound: true };
  return { id, activo };
}

module.exports = {
  resolverAlta,
  buildImageUrl,
  crearReporte,
  obtenerTodosLosReportes,
  obtenerReportesPorUsuario,
  obtenerPorId,
  obtenerEstadisticas,
  cambiarEstadoReporte,
  actualizarActivoReporte,
};
