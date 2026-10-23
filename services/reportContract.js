// Contrato puro: sin Express, consultas ni mutaciones de la entrada.
const CLAVES_ALTA = new Set([
  'tipo_reporte', 'titulo', 'descripcion', 'contacto',
  'categoria_id', 'fecha_incidente', 'campus', 'ubicacion_id', 'ubicacion_otro',
  'estado',
]);
const CLAVES_RETIRADAS = new Set([
  'usuario_id', 'user_id', 'administrador_id', 'ubicacion',
]);

const ESTADOS_PRESENTADOS = new Map([
  ['perdido', 'Perdido'],
  ['encontrado', 'Encontrado'],
  ['en_servicios', 'En servicios'],
  ['devuelto', 'Devuelto'],
  ['donado', 'Donado'],
]);

const tiene = (datos, clave) => Object.prototype.hasOwnProperty.call(datos, clave);
const textoCanonico = (valor) => typeof valor === 'string' ? valor.trim().toLowerCase() : '';

function rechazar(message) {
  const error = new Error(message);
  error.status = 400;
  throw error;
}

function validarObjeto(datos) {
  if (!datos || typeof datos !== 'object' || Array.isArray(datos)) {
    rechazar('Los datos del reporte deben ser un objeto');
  }
}

function validarIdAlta(valor, campo) {
  if ((typeof valor !== 'number' && typeof valor !== 'string') ||
      !/^\d+$/.test(String(valor)) || !Number.isInteger(Number(valor)) || Number(valor) <= 0) {
    rechazar(`${campo} debe ser un entero positivo`);
  }
  if (Number(valor) > 2147483647) rechazar(`${campo} debe ser un entero positivo de hasta 2147483647`);
  return Number(valor);
}

// La ausencia de autor se valida en la resolución completa del alta (T3).
function normalizarEntrada(datos) {
  validarObjeto(datos);
  for (const clave of Object.keys(datos)) {
    if (CLAVES_RETIRADAS.has(clave)) {
      rechazar(`Campo retirado del alta: ${clave}`);
    }
    if (!CLAVES_ALTA.has(clave)) {
      rechazar(`Campo no admitido: ${clave}`);
    }
  }
  return { ...datos };
}

// Solo resuelve altas. La inmutabilidad persistente de tipo_reporte corresponde
// a trg_tipo_reporte_inmutable; aquí no existe ninguna operación de edición.
// autor procede del servicio (usuario o admin interno), no acredita identidad.
function resolverTipoEstado(datos, autor) {
  validarObjeto(datos);
  if (!autor || !['usuario', 'admin'].includes(autor.tipo)) {
    rechazar('Se requiere un tipo de autor válido');
  }
  const tieneTipo = tiene(datos, 'tipo_reporte');
  const tipo = textoCanonico(tieneTipo ? datos.tipo_reporte : datos.estado);
  if (!['perdido', 'encontrado'].includes(tipo)) {
    rechazar('tipo_reporte debe ser perdido o encontrado');
  }
  if (autor.tipo === 'admin' && tipo !== 'encontrado') {
    rechazar('Un administrador solo puede originar reportes encontrados');
  }
  const estado = autor.tipo === 'admin' ? 'en_servicios' : tipo;
  // Sin tipo explícito, estado perdido/encontrado actúa únicamente como tipo
  // legado. Con tipo explícito, solo se tolera el estado inicial derivado.
  if (tieneTipo && tiene(datos, 'estado') && textoCanonico(datos.estado) !== estado) {
    rechazar('estado no coincide con el estado inicial derivado');
  }
  return { tipo_reporte: tipo, estado };
}

function esFechaReal(fecha) {
  if (typeof fecha !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return false;
  const [anio, mes, dia] = fecha.split('-').map(Number);
  if (anio === 0 || mes < 1 || mes > 12 || dia < 1) return false;
  const bisiesto = anio % 4 === 0 && (anio % 100 !== 0 || anio % 400 === 0);
  const diasPorMes = [31, bisiesto ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return dia <= diasPorMes[mes - 1];
}

function fechaActual() {
  const ahora = new Date();
  return `${ahora.getFullYear()}-${String(ahora.getMonth() + 1).padStart(2, '0')}-${String(ahora.getDate()).padStart(2, '0')}`;
}

// DATE se compara como fecha civil, sin convertirla en un instante UTC.
function validarFechaIncidente(fecha, { hoy = fechaActual() } = {}) {
  if (!esFechaReal(hoy)) throw new Error('hoy debe ser una fecha válida YYYY-MM-DD');
  if (!esFechaReal(fecha) || fecha > hoy) {
    rechazar('fecha_incidente debe ser una fecha válida YYYY-MM-DD no futura');
  }
  return fecha;
}

function presentarEstado(estado) {
  return ESTADOS_PRESENTADOS.get(estado);
}

function textoObligatorio(valor, campo, maximo) {
  if (typeof valor !== 'string' || !valor.trim()) {
    rechazar(`${campo} debe ser un texto no vacío`);
  }
  const texto = valor.trim();
  // PostgreSQL char_length cuenta puntos de código, no bytes ni unidades UTF-16.
  if (maximo !== undefined && [...texto].length > maximo) {
    rechazar(`${campo} admite como máximo ${maximo} caracteres`);
  }
  return texto;
}

// Valida la forma; existencia, activo y pertenencia al campus se consultan en T3.
function resolverFormaUbicacion(datos) {
  validarObjeto(datos);
  if (tiene(datos, 'ubicacion')) rechazar('Campo retirado del alta: ubicacion');
  const campus = textoObligatorio(datos.campus, 'campus', 50);
  const formas = ['ubicacion_id', 'ubicacion_otro'].filter((clave) => tiene(datos, clave));
  if (formas.length !== 1) rechazar('Debe indicar exactamente una forma de ubicación');
  const campo = formas[0];
  if (campo === 'ubicacion_id') {
    return { campus, forma: 'id', ubicacion_id: validarIdAlta(datos[campo], campo) };
  }
  return { campus, forma: 'otro', ubicacion_otro: textoObligatorio(datos[campo], campo, 255) };
}

// Recibe las filas YA consultadas por LOWER(nombre) y campus, sin filtrar activo.
// El índice único del catálogo garantiza como máximo una coincidencia.
function resolverUbicacionPorNombre(nombre, coincidencias) {
  const texto = textoObligatorio(nombre, 'ubicacion');
  if (coincidencias.length === 0) return { ubicacion_id: null, ubicacion_otro: textoObligatorio(texto, 'ubicacion', 255) };
  const ubicacion = coincidencias[0];
  if (ubicacion.activo !== true) rechazar('La ubicación está inactiva');
  return { ubicacion_id: ubicacion.id, ubicacion_otro: null };
}

// Solo autoriza cambios reales. El servicio tratará la igualdad antes de llamar
// a esta regla: devuelve cambiado:false sin UPDATE ni historial (T7).
function esTransicionValida(tipo, actual, nuevo) {
  if (tipo === 'perdido') return actual === 'perdido' && nuevo === 'devuelto';
  if (tipo !== 'encontrado') return false;
  return (actual === 'encontrado' && nuevo === 'en_servicios') ||
    (actual === 'en_servicios' && (nuevo === 'devuelto' || nuevo === 'donado'));
}

const conteo = (valor) => Number(valor ?? 0);

// Recibe agregados del servicio, no reportes: no consulta, agrupa ni filtra
// activos. T8 agrupará fechas YYYY-MM-DD y catálogo por campus, sin texto libre.
function formatearEstadisticas({ totales, porEstado, seriesFechas, seriesUbicaciones } = {}) {
  const estados = Object.fromEntries([...ESTADOS_PRESENTADOS.values()].map((etiqueta) => [etiqueta, 0]));
  for (const fila of porEstado ?? []) {
    const etiqueta = presentarEstado(fila?.estado);
    if (etiqueta) estados[etiqueta] = conteo(fila.count);
  }
  return {
    total: conteo(totales?.total),
    activos: conteo(totales?.activos),
    inactivos: conteo(totales?.inactivos),
    porEstado: estados,
    seriesFechas: (seriesFechas ?? []).filter((fila) => fila?.fecha != null)
      .map((fila) => ({ fecha: fila.fecha, count: conteo(fila.count) })),
    seriesUbicaciones: (seriesUbicaciones ?? [])
      .filter((fila) => fila?.campus != null && fila.ubicacion != null)
      .map((fila) => ({ campus: fila.campus, ubicacion: fila.ubicacion, count: conteo(fila.count) })),
  };
}

module.exports = {
  validarIdAlta,
  textoObligatorio,
  normalizarEntrada,
  resolverTipoEstado,
  validarFechaIncidente,
  presentarEstado,
  resolverFormaUbicacion,
  resolverUbicacionPorNombre,
  esTransicionValida,
  formatearEstadisticas,
};
