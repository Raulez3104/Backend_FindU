const {
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
} = require('../services/reportContract');

const esperar400 = (ejecutar) => {
  expect(ejecutar).toThrow();
  try {
    ejecutar();
  } catch (error) {
    expect(error.status).toBe(400);
    expect(error.message).toEqual(expect.any(String));
    expect(error.message.length).toBeGreaterThan(0);
  }
};

describe('T3 correctiva: límites PostgreSQL del contrato', () => {
  test.each(['usuario_id', 'autor.id', 'categoria_id', 'ubicacion_id'])('%s usa extremos INTEGER sin limitar a safeInteger', (campo) => {
    for (const valor of [1, '1', 2147483647, '2147483647']) expect(validarIdAlta(valor, campo)).toBe(Number(valor));
    for (const valor of [0, -1, 2147483648, '2147483648', Number.MAX_SAFE_INTEGER]) esperar400(() => validarIdAlta(valor, campo));
  });
  test('no cuenta grafemas: los caracteres combinantes cuentan por separado como en PostgreSQL', () => {
    const texto = 'e\u0301'.repeat(127) + 'e';
    expect(textoObligatorio(texto, 'titulo', 255)).toBe(texto);
    esperar400(() => textoObligatorio(texto + '\u0301', 'titulo', 255));
  });
  test.each([2147483648, '2147483648', Number.MAX_SAFE_INTEGER])('rechaza ID fuera de INTEGER: %p', (valor) => {
    esperar400(() => resolverFormaUbicacion({ campus: 'principal', ubicacion_id: valor }));
  });
  test.each([1, '2147483647'])('ubicacion_id admite extremo %p', (valor) => {
    expect(resolverFormaUbicacion({ campus: 'principal', ubicacion_id: valor }).ubicacion_id).toBe(Number(valor));
  });
  test.each(['á', '😀'])('longitudes por caracteres, no bytes ni UTF-16: %s', (caracter) => {
    expect(resolverFormaUbicacion({ campus: caracter.repeat(50), ubicacion_otro: caracter.repeat(255) }))
      .toMatchObject({ campus: caracter.repeat(50), ubicacion_otro: caracter.repeat(255) });
    esperar400(() => resolverFormaUbicacion({ campus: caracter.repeat(51), ubicacion_otro: 'Patio' }));
    esperar400(() => resolverFormaUbicacion({ campus: 'principal', ubicacion_otro: caracter.repeat(256) }));
    esperar400(() => resolverUbicacionPorNombre(caracter.repeat(256), []));
    expect(resolverUbicacionPorNombre(caracter.repeat(255), []).ubicacion_otro).toBe(caracter.repeat(255));
  });
});

describe('Contrato canónico del alta autenticada (RF-9, RF-10)', () => {
  test('conserva las claves españolas autorizadas sin modificar la entrada', () => {
    const datos = Object.freeze({
      tipo_reporte: 'perdido', titulo: 'Carnet',
      descripcion: 'Azul', contacto: 'Contacto de prueba', categoria_id: '2',
      fecha_incidente: '2026-10-22', campus: 'principal', ubicacion_id: '3',
      ubicacion_otro: 'Patio', estado: 'perdido',
    });
    // T1 solo valida las claves; la exclusividad de ubicación corresponde a T2.
    expect(normalizarEntrada(datos)).toEqual({ ...datos });
    expect(datos.titulo).toBe('Carnet');
  });

  test.each(['usuario_id', 'user_id', 'administrador_id', 'ubicacion'])(
    'rechaza la clave retirada %s con un mensaje específico',
    (clave) => {
      expect(() => normalizarEntrada({ [clave]: '7' })).toThrow(`Campo retirado del alta: ${clave}`);
      esperar400(() => normalizarEntrada({ [clave]: '7' }));
    },
  );

  test('no acepta ubicación por nombre ni siquiera junto con una forma vigente', () => {
    esperar400(() => normalizarEntrada({ ubicacion_id: '3', ubicacion: 'Biblioteca' }));
  });

  test.each([
    'title', 'description', 'location', 'contact', 'status', 'category_id',
    'incident_date', 'report_type', 'is_active', 'desconocido',
    'image', 'constructor',
  ])('rechaza la clave no autorizada %s incluso acompañada de la canónica', (clave) => {
    esperar400(() => normalizarEntrada({ titulo: 'Carnet', [clave]: 'valor' }));
  });

  test.each([null, [], 'texto', 7])('rechaza un cuerpo no objeto: %p', (datos) => {
    esperar400(() => normalizarEntrada(datos));
  });

});

describe('Ubicación exclusiva y decisión sin consultas (RF-5)', () => {
  test.each([
    [{ ubicacion_id: '3' }, { forma: 'id', ubicacion_id: 3 }],
    [{ ubicacion_otro: ' Patio ' }, { forma: 'otro', ubicacion_otro: 'Patio' }],
  ])('resuelve la estrategia y conserva el campus: %p', (ubicacion, esperado) => {
    const datos = Object.freeze({ campus: ' principal ', ...ubicacion });
    expect(resolverFormaUbicacion(datos)).toEqual({ campus: 'principal', ...esperado });
    expect(datos.campus).toBe(' principal ');
  });

  test('otro admite campus desconocido sin consultar un catálogo cerrado', () => {
    expect(resolverFormaUbicacion({ campus: 'nuevo', ubicacion_otro: 'Patio' }))
      .toEqual({ campus: 'nuevo', forma: 'otro', ubicacion_otro: 'Patio' });
  });

  test.each([
    {}, { ubicacion_id: 3, ubicacion: 'Biblioteca' }, { ubicacion: 'Biblioteca' },
    { ubicacion_id: 3, ubicacion_otro: 'Patio' },
    { ubicacion: 'Biblioteca', ubicacion_otro: 'Patio' },
    { ubicacion_id: 3, ubicacion: 'Biblioteca', ubicacion_otro: 'Patio' },
    { ubicacion_id: 3, ubicacion_otro: '' },
  ])('rechaza ninguna o varias formas: %p', (ubicacion) => {
    esperar400(() => resolverFormaUbicacion({ campus: 'principal', ...ubicacion }));
  });

  test.each([undefined, null, '', ' ', 7, []])('exige campus no vacío: %p', (campus) => {
    esperar400(() => resolverFormaUbicacion({ campus, ubicacion_id: 3 }));
  });

  test.each([null, '', ' ', 0, -1, 1.5, 'abc', true, [], {}])
  ('rechaza ID inválido: %p', (ubicacion_id) => {
    esperar400(() => resolverFormaUbicacion({ campus: 'principal', ubicacion_id }));
  });

  test.each(['ubicacion', 'ubicacion_otro'])('exige texto no vacío para %s', (campo) => {
    for (const valor of [null, '', '  ', 3, [], {}]) {
      esperar400(() => resolverFormaUbicacion({ campus: 'principal', [campo]: valor }));
    }
  });

  test('coincidencia activa ya filtrada por nombre/campus se convierte en ID', () => {
    const coincidencias = Object.freeze([Object.freeze({ id: 8, activo: true })]);
    expect(resolverUbicacionPorNombre(' biblioteca ', coincidencias))
      .toEqual({ ubicacion_id: 8, ubicacion_otro: null });
  });

  test.each([false, null])('coincidencia no activa (%p) nunca cae a texto libre', (activo) => {
    esperar400(() => resolverUbicacionPorNombre('Biblioteca', [{ id: 8, activo }]));
  });

  test('sin coincidencias conserva el nombre recortado como otro, sin crear ubicación', () => {
    expect(resolverUbicacionPorNombre(' Patio nuevo ', Object.freeze([])))
      .toEqual({ ubicacion_id: null, ubicacion_otro: 'Patio nuevo' });
  });
});

describe('Matriz pura de transiciones (RF-8)', () => {
  const estados = ['perdido', 'encontrado', 'en_servicios', 'devuelto', 'donado'];
  const permitidas = new Set([
    'perdido:perdido:devuelto',
    'encontrado:encontrado:en_servicios',
    'encontrado:en_servicios:devuelto',
    'encontrado:en_servicios:donado',
  ]);
  const casos = ['perdido', 'encontrado'].flatMap((tipo) =>
    estados.flatMap((actual) => estados.map((nuevo) => [tipo, actual, nuevo])));

  test.each(casos)('%s: %s → %s', (tipo, actual, nuevo) => {
    expect(esTransicionValida(tipo, actual, nuevo))
      .toBe(permitidas.has(`${tipo}:${actual}:${nuevo}`));
  });

  test.each([undefined, null, '', 'entregado', 'En servicios', 'otro'])
  ('valores fuera del enum no autorizan transiciones: %p', (valor) => {
    expect(esTransicionValida(valor, 'perdido', 'devuelto')).toBe(false);
    expect(esTransicionValida('perdido', valor, 'devuelto')).toBe(false);
    expect(esTransicionValida('encontrado', 'en_servicios', valor)).toBe(false);
  });

  test.each(estados)('mismo estado %s no representa una mutación válida', (estado) => {
    expect(esTransicionValida('perdido', estado, estado)).toBe(false);
    expect(esTransicionValida('encontrado', estado, estado)).toBe(false);
    // T7 tratará la igualdad antes de validar: sin UPDATE ni historial.
  });
});

describe('Forma pura de estadísticas (RF-10)', () => {
  const vacias = {
    total: 0, activos: 0, inactivos: 0,
    porEstado: { Perdido: 0, Encontrado: 0, 'En servicios': 0, Devuelto: 0, Donado: 0 },
    seriesFechas: [], seriesUbicaciones: [],
  };

  test.each([undefined, {}, { totales: null, porEstado: null, seriesFechas: null, seriesUbicaciones: null }])
  ('sin datos devuelve ceros y listas vacías: %p', (datos) => {
    expect(formatearEstadisticas(datos)).toEqual(vacias);
  });

  test('forma exacta, conteos pg numéricos, cinco etiquetas y series con campus', () => {
    const datos = Object.freeze({
      totales: Object.freeze({ total: '9', activos: '6', inactivos: '3', entregados: 99 }),
      porEstado: Object.freeze([
        Object.freeze({ estado: 'perdido', count: '2' }),
        { estado: 'encontrado', count: '1' }, { estado: 'en_servicios', count: '3' },
        { estado: 'devuelto', count: '2' }, { estado: 'donado', count: '1' },
        { estado: 'entregado', count: '99' },
      ]),
      seriesFechas: Object.freeze([Object.freeze({ fecha: '2026-10-22', count: '9' })]),
      seriesUbicaciones: Object.freeze([
        Object.freeze({ campus: 'principal', ubicacion: 'Biblioteca', count: '4' }),
        { campus: 'nuevo', ubicacion: 'Biblioteca', count: '2' },
      ]),
    });
    expect(formatearEstadisticas(datos)).toEqual({
      total: 9, activos: 6, inactivos: 3,
      porEstado: { Perdido: 2, Encontrado: 1, 'En servicios': 3, Devuelto: 2, Donado: 1 },
      seriesFechas: [{ fecha: '2026-10-22', count: 9 }],
      seriesUbicaciones: [
        { campus: 'principal', ubicacion: 'Biblioteca', count: 4 },
        { campus: 'nuevo', ubicacion: 'Biblioteca', count: 2 },
      ],
    });
    expect(datos.totales.total).toBe('9');
    expect(datos.seriesFechas[0].count).toBe('9');
  });

  test('no propaga null ni crea grupos desde ubicacion_otro', () => {
    expect(formatearEstadisticas({
      totales: { total: null, activos: null, inactivos: null },
      porEstado: [null, { estado: null, count: '3' }, { estado: 'perdido', count: null }],
      seriesFechas: [null, { fecha: null, count: '2' }],
      seriesUbicaciones: [null, { campus: 'principal', ubicacion: null, ubicacion_otro: 'Patio', count: '2' }],
    })).toEqual(vacias);
  });

  test('respuestas sucesivas no comparten objetos ni arreglos mutables', () => {
    const primera = formatearEstadisticas();
    primera.porEstado.Perdido = 8;
    primera.seriesFechas.push({ fecha: '2026-10-22', count: 8 });
    expect(formatearEstadisticas()).toEqual(vacias);
  });
});

describe('Tipo y estado inicial por autor (RF-4)', () => {
  test.each([
    ['usuario', 'perdido', 'perdido'],
    ['usuario', 'encontrado', 'encontrado'],
    ['admin', 'encontrado', 'en_servicios'],
  ])('%s/%s deriva %s sin mutar el tipo de entrada', (tipo, tipo_reporte, estado) => {
    const datos = Object.freeze({ tipo_reporte });
    expect(resolverTipoEstado(datos, { tipo })).toEqual({ tipo_reporte, estado });
    expect(datos).toEqual({ tipo_reporte });
    expect(resolverTipoEstado({ tipo_reporte, estado }, { tipo }))
      .toEqual({ tipo_reporte, estado });
  });

  test.each(['perdido', 'encontrado'])('acepta estado legado %s sin tipo', (estado) => {
    expect(resolverTipoEstado({ estado }, { tipo: 'usuario' }))
      .toEqual({ tipo_reporte: estado, estado });
  });

  test('el hallazgo legado interno de admin deriva custodia, no estado de cliente', () => {
    expect(resolverTipoEstado({ estado: 'encontrado' }, { tipo: 'admin' }))
      .toEqual({ tipo_reporte: 'encontrado', estado: 'en_servicios' });
  });

  test('normaliza valores de texto heredados de la API', () => {
    expect(resolverTipoEstado({ tipo_reporte: ' Encontrado ', estado: 'Encontrado' }, { tipo: 'usuario' }))
      .toEqual({ tipo_reporte: 'encontrado', estado: 'encontrado' });
  });

  test.each([
    {}, { tipo_reporte: '' }, { tipo_reporte: null },
    { tipo_reporte: 'otro' }, { tipo_reporte: 'devuelto' },
    { tipo_reporte: ['perdido'] }, { tipo_reporte: 'en_servicios' },
    { estado: 'en_servicios' }, { estado: 'devuelto' }, { estado: 'donado' },
    { estado: 'entregado' }, { estado: '' }, { estado: null },
    { tipo_reporte: 'perdido', estado: 'encontrado' },
    { tipo_reporte: 'encontrado', estado: 'perdido' },
    { tipo_reporte: 'encontrado', estado: 'en_servicios' },
    { tipo_reporte: 'perdido', estado: 'devuelto' },
    { tipo_reporte: 'encontrado', estado: 'donado' },
    { tipo_reporte: 'perdido', estado: '' },
    { tipo_reporte: 'perdido', estado: null },
  ])('rechaza ausencia, contradicción o estado no inicial: %p', (datos) => {
    esperar400(() => resolverTipoEstado(datos, { tipo: 'usuario' }));
  });

  test('admin no puede originar perdidos ni contradecir el estado derivado', () => {
    esperar400(() => resolverTipoEstado({ tipo_reporte: 'perdido' }, { tipo: 'admin' }));
    esperar400(() => resolverTipoEstado({ tipo_reporte: 'encontrado', estado: 'encontrado' }, { tipo: 'admin' }));
  });

  test.each([undefined, null, {}, { tipo: 'otro' }])('no presupone un autor válido: %p', (autor) => {
    esperar400(() => resolverTipoEstado({ tipo_reporte: 'perdido' }, autor));
  });
});

describe('Fecha del incidente (RF-2, RNF-07)', () => {
  const opciones = { hoy: '2026-10-22' };

  test.each(['2026-10-22', '2026-10-21', '2024-02-29', '2000-02-29'])
  ('acepta fecha real no futura: %s', (fecha) => {
    expect(validarFechaIncidente(fecha, opciones)).toBe(fecha);
  });

  test.each([
    undefined, null, '', ' ', '22/10/2026', '2026-1-02', '2026-10-22T00:00:00Z',
    '2026-02-29', '2026-04-31', '1900-02-29', '2026-13-01', '2026-00-01',
    '2026-01-00', '0000-01-01', '2026-10-23', 20261022, ['2026-10-22'],
  ])('rechaza fecha inválida o futura: %p', (fecha) => {
    esperar400(() => validarFechaIncidente(fecha, opciones));
  });

  test('hoy inyectado controla el límite sin depender del reloj de la prueba', () => {
    esperar400(() => validarFechaIncidente('2026-10-22', { hoy: '2026-10-21' }));
  });
});

describe('Presentación de estados (RC-IDIOMA)', () => {
  test.each([
    ['perdido', 'Perdido'], ['encontrado', 'Encontrado'],
    ['en_servicios', 'En servicios'], ['devuelto', 'Devuelto'], ['donado', 'Donado'],
  ])('%s se presenta como %s', (estado, etiqueta) => {
    expect(presentarEstado(estado)).toBe(etiqueta);
  });
});
