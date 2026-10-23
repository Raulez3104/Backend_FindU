function esDominioValido(dominio) {
  if (dominio.length > 253 || !dominio.includes('.')) {
    return false;
  }

  return dominio.split('.').every((parte) =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(parte),
  );
}

function cargarConfiguracionGoogle(entorno = process.env) {
  const audiencias = [
    ...new Set(
      String(entorno.GOOGLE_CLIENT_IDS || '')
        .split(',')
        .map((clientId) => clientId.trim())
        .filter(Boolean),
    ),
  ];
  const dominioInstitucional = String(entorno.DOMINIO_INSTITUCIONAL || '')
    .trim()
    .toLowerCase();

  if (
    audiencias.length === 0 ||
    audiencias.some((clientId) => /\s/.test(clientId)) ||
    !esDominioValido(dominioInstitucional)
  ) {
    throw new Error('Configuración de Google inválida');
  }

  return Object.freeze({
    audiencias: Object.freeze(audiencias),
    dominioInstitucional,
  });
}

module.exports = { cargarConfiguracionGoogle };
