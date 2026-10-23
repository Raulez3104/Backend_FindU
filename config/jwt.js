const EMISOR_JWT = 'FindU';
const ALGORITMO_JWT = 'HS256';
const EXPIRACION_HORAS_POR_DEFECTO = 24;

function cargarConfiguracionJwt(entorno = process.env) {
  const secret = entorno.JWT_SECRET;
  const expiracionConfigurada = entorno.JWT_EXPIRACION_HORAS;
  const expiracionTexto =
    expiracionConfigurada === undefined
      ? String(EXPIRACION_HORAS_POR_DEFECTO)
      : String(expiracionConfigurada).trim();

  if (
    typeof secret !== 'string' ||
    secret.trim() === '' ||
    !/^\d+$/.test(expiracionTexto)
  ) {
    throw new Error('Configuración JWT inválida');
  }

  const expiracionHoras = Number(expiracionTexto);
  if (!Number.isSafeInteger(expiracionHoras) || expiracionHoras <= 0) {
    throw new Error('Configuración JWT inválida');
  }

  return Object.freeze({
    secret,
    expiracionHoras,
    emisor: EMISOR_JWT,
  });
}

module.exports = { ALGORITMO_JWT, cargarConfiguracionJwt };
