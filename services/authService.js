const { OAuth2Client } = require('google-auth-library');
const { cargarConfiguracionGoogle } = require('../config/google');
const jwt = require('jsonwebtoken');
const { ALGORITMO_JWT, cargarConfiguracionJwt } = require('../config/jwt');
const { resolverCuentaEstudiantil } = require('./userService');

const MENSAJE_IDENTIDAD_INVALIDA =
  'No fue posible verificar la identidad institucional';

function crearErrorAutenticacion() {
  return Object.assign(new Error(MENSAJE_IDENTIDAD_INVALIDA), { status: 401 });
}

function normalizarCorreo(correo) {
  return typeof correo === 'string' ? correo.trim().toLowerCase() : '';
}

function perteneceAlDominioInstitucional(correo, dominioInstitucional) {
  const correoNormalizado = normalizarCorreo(correo);
  const dominioNormalizado = String(dominioInstitucional || '')
    .trim()
    .toLowerCase();

  if (!/^[^\s@]+@[^\s@]+$/.test(correoNormalizado)) {
    return false;
  }

  const dominioCorreo = correoNormalizado.slice(
    correoNormalizado.lastIndexOf('@') + 1,
  );
  return dominioCorreo === dominioNormalizado;
}

function validarClaimsGoogle(claims, dominioInstitucional) {
  if (!claims || claims.email_verified !== true) {
    throw crearErrorAutenticacion();
  }

  const correo = normalizarCorreo(claims.email);
  if (!perteneceAlDominioInstitucional(correo, dominioInstitucional)) {
    throw crearErrorAutenticacion();
  }

  const nombre = typeof claims.name === 'string' ? claims.name.trim() : '';
  if (!nombre) {
    throw crearErrorAutenticacion();
  }

  const foto =
    typeof claims.picture === 'string' && claims.picture.trim()
      ? claims.picture.trim()
      : null;

  return Object.freeze({ correo, nombre, foto });
}

function construirPerfil(usuario) {
  return Object.freeze({
    id: usuario.id,
    nombre: usuario.nombre,
    correo: usuario.correo,
    foto: usuario.foto || null,
  });
}

function emitirSesionJwt(
  usuario,
  {
    configuracion,
    reloj = Date.now,
    firmar = jwt.sign,
  },
) {
  const emitidoEn = Math.floor(reloj() / 1000);
  const expiraEnSegundos =
    emitidoEn + configuracion.expiracionHoras * 60 * 60;
  const token = firmar(
    {
      sub: String(usuario.id),
      ambito: 'estudiante',
      iat: emitidoEn,
      exp: expiraEnSegundos,
    },
    configuracion.secret,
    {
      algorithm: ALGORITMO_JWT,
      issuer: configuracion.emisor,
    },
  );

  return Object.freeze({
    token,
    expiraEn: expiraEnSegundos * 1000,
    usuario: construirPerfil(usuario),
  });
}

function crearServicioAutenticacion({
  clienteGoogle = new OAuth2Client(),
  obtenerConfiguracionGoogle = cargarConfiguracionGoogle,
  resolverCuentaEstudiantil: resolverCuenta = resolverCuentaEstudiantil,
  obtenerConfiguracionJwt = cargarConfiguracionJwt,
  reloj = Date.now,
  firmarJwt = jwt.sign,
  continuarAutenticacion,
} = {}) {
  const completarAutenticacion =
    continuarAutenticacion ||
    (async (identidad) => {
      const usuario = await resolverCuenta(identidad);
      return emitirSesionJwt(usuario, {
        configuracion: obtenerConfiguracionJwt(),
        reloj,
        firmar: firmarJwt,
      });
    });

  async function autenticarConGoogle(idToken) {
    if (typeof idToken !== 'string' || idToken.trim() === '') {
      throw crearErrorAutenticacion();
    }

    const configuracion = obtenerConfiguracionGoogle();
    let claims;

    try {
      const ticket = await clienteGoogle.verifyIdToken({
        idToken,
        audience: configuracion.audiencias,
      });
      claims = ticket.getPayload();
    } catch (_errorGoogle) {
      throw crearErrorAutenticacion();
    }

    const identidad = validarClaimsGoogle(
      claims,
      configuracion.dominioInstitucional,
    );
    return completarAutenticacion(identidad);
  }

  return Object.freeze({ autenticarConGoogle });
}

const servicioAutenticacion = crearServicioAutenticacion();

module.exports = {
  autenticarConGoogle: servicioAutenticacion.autenticarConGoogle,
  crearServicioAutenticacion,
  construirPerfil,
  emitirSesionJwt,
  normalizarCorreo,
  perteneceAlDominioInstitucional,
  validarClaimsGoogle,
};
