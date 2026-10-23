const pool = require('../config/database');
const bcrypt = require('bcrypt');

async function login(correo, contrasena) {
  if (!correo || !contrasena) {
    throw { message: 'Correo y contraseña son requeridos' };
  }

  const result = await pool.query('SELECT * FROM administradores WHERE correo = $1', [correo]);
  
  if (result.rows.length === 0) {
    throw { notFound: true, message: 'Administrador no encontrado' };
  }

  const admin = result.rows[0];
  const match = await bcrypt.compare(contrasena, admin.contrasena);
  
  if (!match) {
    throw { unauthorized: true, message: 'Contraseña incorrecta' };
  }

  return {
    id: admin.id,
    nombre: admin.nombre,
    correo: admin.correo,
    rol: admin.rol,
  };
}

module.exports = { login };
