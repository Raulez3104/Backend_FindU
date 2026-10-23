const pool = require('../config/database');

async function obtenerCategoriasActivas() {
  const resultado = await pool.query(`
    SELECT id, nombre, descripcion, icono
    FROM categorias
    WHERE activo = TRUE
    ORDER BY LOWER(nombre)
  `);
  return resultado.rows;
}

async function obtenerUbicacionesActivas(campus) {
  const campusNormalizado = (campus || '').trim() || 'principal';
  const resultado = await pool.query(`
    SELECT id, nombre, campus, piso, descripcion
    FROM ubicaciones
    WHERE activo = TRUE AND campus = $1
    ORDER BY LOWER(campus), LOWER(nombre)
  `, [campusNormalizado]);
  return resultado.rows;
}

module.exports = { obtenerCategoriasActivas, obtenerUbicacionesActivas };
