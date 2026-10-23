const userService = require('../services/userService');
const authService = require('../services/authService');

const MENSAJE_IDENTIDAD_INVALIDA =
  'No fue posible verificar la identidad institucional';
const MENSAJE_CUENTA_INACTIVA = 'La cuenta institucional no está activa';

async function iniciarSesionGoogle(req, res, next) {
  const { idToken } = req.body || {};

  if (typeof idToken !== 'string' || idToken.trim() === '') {
    return res.status(401).json({ message: MENSAJE_IDENTIDAD_INVALIDA });
  }

  try {
    const { token, expiraEn, usuario } =
      await authService.autenticarConGoogle(idToken);
    return res.status(200).json({
      token,
      expiraEn,
      usuario: {
        id: usuario.id,
        nombre: usuario.nombre,
        correo: usuario.correo,
        foto: usuario.foto,
      },
    });
  } catch (error) {
    if (error && error.status === 401) {
      const message = error.message === MENSAJE_CUENTA_INACTIVA
        ? MENSAJE_CUENTA_INACTIVA
        : MENSAJE_IDENTIDAD_INVALIDA;
      return res.status(401).json({ message });
    }

    const errorSeguro = Object.assign(
      new Error('No fue posible completar el inicio de sesión'),
      { status: 500 },
    );
    return next(errorSeguro);
  }
}

function listar(req, res) {
  userService.listarTodos()
    .then(usuarios => res.json({ usuarios }))
    .catch(err => res.status(500).json({ message: 'Error al obtener usuarios' }));
}

function crear(req, res) {
  const { name, nombre, email, correo, picture, foto } = req.body;

  userService.crear({ name, nombre, email, correo, picture, foto })
    .then(result => res.status(201).json({ message: 'Usuario creado', id: result.id }))
    .catch(err => {
      if (err.message && (err.message.includes('requerido'))) {
        return res.status(400).json({ message: err.message });
      }
      if (err.duplicate) {
        return res.status(409).json({ message: 'El correo ya existe', id: err.id });
      }
      res.status(500).json({ message: 'Error al crear usuario' });
    });
}

async function obtenerPorId(req, res, next) {
  let id;
  try {
    id = userService.validarIdUsuario(req.params.id);
  } catch (error) {
    if (error && error.status === 400) {
      return res.status(400).json({ message: error.message });
    }
    return next(error);
  }

  if (id !== req.usuario.id) {
    return res.status(403).json({ message: 'No puede consultar otro perfil' });
  }

  try {
    const rows = await userService.obtenerPorId(id);
    if (rows.length === 0) {
      return res.status(401).json({ message: 'Sesión inválida o expirada' });
    }

    const usuario = rows[0];
    return res.json({
      usuario: {
        id: usuario.id,
        nombre: usuario.nombre,
        correo: usuario.correo,
        foto: usuario.foto || null,
        activo: usuario.activo,
        fecha_creacion: usuario.fecha_creacion,
      },
    });
  } catch (error) {
    return next(error);
  }
}

function obtenerPorCorreo(req, res) {
  const { email } = req.params;

  userService.buscarPorCorreo(email)
    .then(rows => {
      if (rows.length === 0) return res.status(404).json({ message: 'Usuario no encontrado' });
      res.json({ usuario: rows[0] });
    })
    .catch(err => res.status(500).json({ message: 'Error al buscar por correo' }));
}

function actualizarActivo(req, res) {
  const { id } = req.params;
  let { is_active, activo } = req.body;
  
  activo = activo !== undefined ? activo : is_active;

  if (!(activo === 0 || activo === 1 || activo === '0' || activo === '1' || activo === true || activo === false)) {
    return res.status(400).json({ message: 'activo debe ser true/false o 0/1' });
  }

  const val = activo === 1 || activo === '1' || activo === true ? 1 : 0;

  userService.actualizarActivo(id, val)
    .then(result => res.json({ message: 'Estado de actividad actualizado', ...result }))
    .catch(err => {
      if (err.notFound) return res.status(404).json({ message: 'Usuario no encontrado' });
      res.status(500).json({ message: 'Error al actualizar estado de actividad' });
    });
}

module.exports = {
  iniciarSesionGoogle,
  listar,
  crear,
  obtenerPorId,
  obtenerPorCorreo,
  actualizarActivo,
};
