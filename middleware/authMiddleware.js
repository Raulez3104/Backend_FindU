const jwt = require('jsonwebtoken');
const { ALGORITMO_JWT, cargarConfiguracionJwt } = require('../config/jwt');
const userService = require('../services/userService');

const ID_MAXIMO = 2147483647;
const MENSAJE_AUTENTICACION_REQUERIDA = 'Autenticación requerida';
const MENSAJE_SESION_INVALIDA = 'Sesión inválida o expirada';
const MENSAJE_OPERACION_NO_HABILITADA =
  'Operación administrativa no habilitada';

function contarCabecerasAutorizacion(req) {
  if (!Array.isArray(req.rawHeaders)) return 1;

  let cantidad = 0;
  for (let indice = 0; indice < req.rawHeaders.length; indice += 2) {
    if (String(req.rawHeaders[indice]).toLowerCase() === 'authorization') {
      cantidad += 1;
    }
  }
  return cantidad;
}

function extraerTokenBearer(req) {
  const cabecera = req.headers.authorization;
  if (
    contarCabecerasAutorizacion(req) !== 1 ||
    typeof cabecera !== 'string'
  ) {
    return null;
  }

  const coincidencia = /^Bearer ([^\s,]+)$/.exec(cabecera);
  return coincidencia ? coincidencia[1] : null;
}

function convertirSubAId(sub) {
  if (typeof sub === 'number') {
    return Number.isInteger(sub) && sub >= 1 && sub <= ID_MAXIMO
      ? sub
      : null;
  }

  if (typeof sub !== 'string' || !/^[1-9]\d*$/.test(sub)) {
    return null;
  }

  const id = Number(sub);
  return Number.isSafeInteger(id) && id <= ID_MAXIMO ? id : null;
}

async function obtenerUsuarioActivoPorId(id) {
  const filas = await userService.obtenerPorId(id);
  return filas[0] || null;
}

function crearAutenticador({
  obtenerConfiguracionJwt = cargarConfiguracionJwt,
  obtenerUsuarioPorId = obtenerUsuarioActivoPorId,
  verificarJwt = jwt.verify,
} = {}) {
  return async function autenticar(req, res, next) {
    const token = extraerTokenBearer(req);
    if (!token) {
      return res
        .status(401)
        .json({ message: MENSAJE_AUTENTICACION_REQUERIDA });
    }

    const configuracion = obtenerConfiguracionJwt();
    let payload;
    try {
      payload = verificarJwt(token, configuracion.secret, {
        algorithms: [ALGORITMO_JWT],
        issuer: configuracion.emisor,
      });
    } catch (_errorJwt) {
      return res.status(401).json({ message: MENSAJE_SESION_INVALIDA });
    }

    const usuarioId = convertirSubAId(payload && payload.sub);
    if (usuarioId === null || payload.ambito !== 'estudiante') {
      return res.status(401).json({ message: MENSAJE_SESION_INVALIDA });
    }

    let usuario;
    try {
      usuario = await obtenerUsuarioPorId(usuarioId);
    } catch (error) {
      return next(error);
    }

    if (!usuario || usuario.activo !== true) {
      return res.status(401).json({ message: MENSAJE_SESION_INVALIDA });
    }

    req.usuario = Object.freeze({
      id: usuario.id,
      nombre: usuario.nombre,
      correo: usuario.correo,
      foto: usuario.foto || null,
    });
    return next();
  };
}

function bloquearRutaNoEstudiantil(_req, res) {
  return res.status(403).json({ message: MENSAJE_OPERACION_NO_HABILITADA });
}

const autenticar = crearAutenticador();

module.exports = {
  autenticar,
  bloquearRutaNoEstudiantil,
  convertirSubAId,
  crearAutenticador,
  extraerTokenBearer,
};
