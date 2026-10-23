require('dotenv').config();
const { randomInt, randomUUID } = require('crypto');
const pool = require('../config/database');
const { conTransaccionPrueba } = require('./helpers/dbTransaccion');
const { resolverAlta, crearReporte, cambiarEstadoReporte } = require('../services/reportService');
const { cargarConfiguracionJwt } = require('../config/jwt');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const app = require('../app');

const jwtSecretAnterior = process.env.JWT_SECRET;
const jwtExpiracionAnterior = process.env.JWT_EXPIRACION_HORAS;

beforeAll(() => {
  process.env.JWT_SECRET = 'secreto-de-prueba-para-integracion-de-reportes';
  process.env.JWT_EXPIRACION_HORAS = '24';
});

afterAll(() => {
  if (jwtSecretAnterior === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = jwtSecretAnterior;
  if (jwtExpiracionAnterior === undefined) delete process.env.JWT_EXPIRACION_HORAS;
  else process.env.JWT_EXPIRACION_HORAS = jwtExpiracionAnterior;
  return pool.end();
});

// IDs generados, no IDs de semillas ni nextval: el rollback tampoco avanza
// secuencias que seed.sql (todavía pendiente) pueda presuponer vírgenes.
async function prepararDatos(client) {
  const marca = `t3-${randomUUID()}`;
  const id = () => randomInt(1000000000, 2000000000);
  const usuario = (await client.query(
    'INSERT INTO usuarios (id, nombre, correo) VALUES ($1, $2, $3) RETURNING id',
    [id(), marca, `${marca}@example.invalid`],
  )).rows[0].id;
  const admin = (await client.query(
    'INSERT INTO administradores (id, nombre, correo, contrasena, rol) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [id(), marca, `${marca}@example.invalid`, 'no-es-una-credencial', 'personal_servicios'],
  )).rows[0].id;
  const categorias = (await client.query(
    'INSERT INTO categorias (id, nombre, activo) VALUES ($1, $2, TRUE), ($3, $4, FALSE) RETURNING id, activo',
    [id(), marca, id(), `${marca}-inactiva`],
  )).rows;
  const ubicaciones = (await client.query(
    'INSERT INTO ubicaciones (id, nombre, campus, activo) VALUES ($1, $2, $3, TRUE), ($4, $5, $3, FALSE), ($6, $2, $7, TRUE) RETURNING id, nombre, campus, activo',
    [id(), marca, marca, id(), `${marca}-inactiva`, id(), `${marca}-otro`],
  )).rows;
  return {
    marca, usuario, admin,
    categoria: categorias.find((fila) => fila.activo).id,
    inactiva: categorias.find((fila) => !fila.activo).id,
    ubicacion: ubicaciones.find((fila) => fila.activo && fila.campus === marca),
    ubicacionInactiva: ubicaciones.find((fila) => !fila.activo),
  };
}

async function conDatos(comprobar, nuevosReportes = 0) {
  let datos;
  const queryOriginal = pool.query;
  const connectOriginal = pool.connect;
  try {
    return await conTransaccionPrueba(async (client) => {
      datos = await prepararDatos(client);
      const antes = (await client.query('SELECT COUNT(*) AS count FROM reportes')).rows[0].count;
      await comprobar(datos, client);
      expect(Number((await client.query('SELECT COUNT(*) AS count FROM reportes')).rows[0].count)).toBe(Number(antes) + nuevosReportes);
    });
  } finally {
    expect(pool.query).toBe(queryOriginal);
    expect(pool.connect).toBe(connectOriginal);
    if (datos) {
      expect((await pool.query('SELECT id FROM reportes WHERE usuario_id = $1 OR administrador_id = $2', [datos.usuario, datos.admin])).rows).toEqual([]);
      expect((await pool.query('SELECT id FROM reportes WHERE categoria_id = $1', [datos.categoria])).rows).toEqual([]);
      expect((await pool.query('SELECT id FROM usuarios WHERE nombre = $1', [`${datos.marca}-otro`])).rows).toEqual([]);
      expect((await pool.query('SELECT id FROM historial WHERE realizado_por = $1 OR realizado_por = $2', [datos.usuario, datos.admin])).rows).toEqual([]);
      for (const [tabla, campo, valor] of [
        ['usuarios', 'id', datos.usuario], ['administradores', 'id', datos.admin],
        ['categorias', 'nombre', datos.marca], ['categorias', 'nombre', `${datos.marca}-inactiva`],
        ['ubicaciones', 'campus', datos.marca], ['ubicaciones', 'campus', `${datos.marca}-otro`],
      ]) {
        expect((await pool.query(`SELECT id FROM ${tabla} WHERE ${campo} = $1`, [valor])).rows).toEqual([]);
      }
    }
  }
}

function alta(fila) {
  return {
    autor: { tipo: 'usuario', id: fila.usuario },
    datos: {
      titulo: ' Objeto ', descripcion: ' Descripción ', contacto: ' Contacto ',
      tipo_reporte: 'perdido', categoria_id: fila.categoria, fecha_incidente: '2026-01-01',
      campus: fila.marca, ubicacion_id: fila.ubicacion.id,
    },
    imagenPath: 'foto-temporal.jpg',
  };
}

function tokenEstudiante(usuarioId) {
  const configuracion = cargarConfiguracionJwt();
  return jwt.sign(
    { sub: String(usuarioId), ambito: 'estudiante' },
    configuracion.secret,
    { algorithm: 'HS256', issuer: configuracion.emisor, expiresIn: '1h' },
  );
}
const opciones = { hoy: '2026-10-22' };

describe('T3 correctiva: validación previa al INSERT según schema.sql', () => {
  test.each(['usuario', 'admin'])('INTEGER máximo permitido en autor %s, categoría y ubicación', (tipo) => conDatos(async (fila, client) => {
    const maximo = 2147483647;
    await client.query('UPDATE categorias SET id = $1 WHERE id = $2', [maximo, fila.categoria]);
    fila.categoria = maximo;
    await client.query('UPDATE ubicaciones SET id = $1 WHERE id = $2', [maximo, fila.ubicacion.id]);
    fila.ubicacion.id = maximo;
    const tabla = tipo === 'usuario' ? 'usuarios' : 'administradores';
    const clave = tipo === 'usuario' ? 'usuario' : 'admin';
    await client.query(`UPDATE ${tabla} SET id = $1 WHERE id = $2`, [maximo, fila[clave]]);
    fila[clave] = maximo;
    const entrada = alta(fila);
    if (tipo === 'admin') {
      entrada.autor = { tipo, id: String(maximo) };
      entrada.datos.tipo_reporte = 'encontrado';
    }
    const { id } = await crearReporte(entrada, opciones);
    expect((await client.query(`SELECT ${tipo === 'usuario' ? 'usuario_id' : 'administrador_id'} AS autor,
      categoria_id, ubicacion_id FROM reportes WHERE id = $1`, [id])).rows[0])
      .toEqual({ autor: maximo, categoria_id: maximo, ubicacion_id: maximo });
  }, 1));
  const limites = [['titulo', 255], ['contacto', 255], ['campus', 50], ['ubicacion_otro', 255]];
  function conCampo(fila, campo, texto) {
    const entrada = alta(fila);
    if (['campus', 'ubicacion_otro'].includes(campo)) {
      delete entrada.datos.ubicacion_id;
      entrada.datos.ubicacion_otro = 'Patio';
    }
    entrada.datos[campo] = texto;
    return entrada;
  }
  test.each(limites.flatMap(([campo, max]) => ['á', '😀'].map((caracter) => [campo, max, caracter])))
  ('%s mayor que %i caracteres (%s) → 400 comprensible antes de conectar para INSERT', (campo, max, caracter) => conDatos(async (fila) => {
    const conectar = jest.spyOn(pool, 'connect');
    try {
      await expect(crearReporte(conCampo(fila, campo, caracter.repeat(max + 1)), opciones)).rejects.toMatchObject({
        status: 400, message: expect.stringMatching(new RegExp(`${campo}.*${max}.*caracteres`)),
      });
      expect(conectar).not.toHaveBeenCalled();
    } finally { conectar.mockRestore(); }
  }));
  test.each(limites.flatMap(([campo, max]) => ['á', '😀'].map((caracter) => [campo, max, caracter])))
  ('%s permite exactamente %i caracteres (%s) y persiste sin truncar', (campo, max, caracter) => conDatos(async (fila, client) => {
    const texto = caracter.repeat(max);
    const { id } = await crearReporte(conCampo(fila, campo, ` ${texto} `), opciones);
    const guardado = (await client.query(`SELECT ${campo} AS texto, char_length(${campo}) AS caracteres FROM reportes WHERE id = $1`, [id])).rows[0];
    expect(guardado).toEqual({ texto, caracteres: max });
  }, 1));
  test.each(['categoria_id', 'ubicacion_id', 'autor.usuario', 'autor.admin'].flatMap((campo) =>
    [2147483648, '2147483648'].map((valor) => [campo, valor])))
  ('%s=%p fuera de INTEGER → 400 antes de consultar/conectar', (campo, valor) => conDatos(async (fila) => {
    const entrada = alta(fila);
    let nombre = campo;
    if (campo.startsWith('autor.')) {
      entrada.autor = { tipo: campo.split('.')[1], id: valor };
      entrada.datos.tipo_reporte = 'encontrado';
      nombre = 'autor.id';
    } else {
      entrada.datos[campo] = valor;
    }
    const consultar = jest.spyOn(pool, 'query');
    const conectar = jest.spyOn(pool, 'connect');
    try {
      await expect(crearReporte(entrada, opciones)).rejects.toMatchObject({
        status: 400, message: expect.stringContaining(nombre),
      });
      expect(consultar).not.toHaveBeenCalled();
      expect(conectar).not.toHaveBeenCalled();
    } finally { consultar.mockRestore(); conectar.mockRestore(); }
  }));
});

describe('T8: estadísticas HTTP con PostgreSQL real', () => {
  async function esperadoDesdeFilas(client) {
    // Oráculo independiente: filas sin agregar, incluidos datos ajenos intactos.
    const filas = (await client.query(`SELECT r.estado, r.activo, r.campus,
      TO_CHAR(r.fecha_creacion, 'YYYY-MM-DD') AS fecha, u.nombre AS ubicacion
      FROM reportes r LEFT JOIN ubicaciones u ON u.id = r.ubicacion_id
      ORDER BY r.campus, u.nombre`)).rows;
    const etiquetas = { perdido: 'Perdido', encontrado: 'Encontrado', en_servicios: 'En servicios', devuelto: 'Devuelto', donado: 'Donado' };
    const resultado = { total: filas.length, activos: 0, inactivos: 0,
      porEstado: { Perdido: 0, Encontrado: 0, 'En servicios': 0, Devuelto: 0, Donado: 0 },
      seriesFechas: [], seriesUbicaciones: [] };
    const fechas = new Map();
    const ubicaciones = new Map();
    for (const fila of filas) {
      if (fila.activo === true) resultado.activos++;
      if (fila.activo === false) resultado.inactivos++;
      resultado.porEstado[etiquetas[fila.estado]]++;
      if (fila.fecha !== null) fechas.set(fila.fecha, (fechas.get(fila.fecha) || 0) + 1);
      if (fila.ubicacion !== null) {
        const clave = JSON.stringify([fila.campus, fila.ubicacion]);
        if (!ubicaciones.has(clave)) ubicaciones.set(clave, { campus: fila.campus, ubicacion: fila.ubicacion, count: 0 });
        ubicaciones.get(clave).count++;
      }
    }
    resultado.seriesFechas = [...fechas].sort(([a], [b]) => a.localeCompare(b)).map(([fecha, count]) => ({ fecha, count }));
    resultado.seriesUbicaciones = [...ubicaciones.values()];
    return resultado;
  }

  test('contrato exacto, cinco estados, archivados, campus y catálogo histórico sin texto libre', () => conDatos(async (fila, client) => {
    const antes = await esperadoDesdeFilas(client);
    const estados = ['perdido', 'encontrado', 'en_servicios', 'devuelto', 'donado', 'perdido'];
    for (let i = 0; i < estados.length; i++) {
      const entrada = alta(fila);
      entrada.datos.tipo_reporte = i === 0 || i === 5 ? 'perdido' : 'encontrado';
      if (i === 1) entrada.datos.campus = `${fila.marca}-otro`;
      if (i === 1) entrada.datos.ubicacion_id = (await client.query('SELECT id FROM ubicaciones WHERE campus = $1', [entrada.datos.campus])).rows[0].id;
      if (i === 5) {
        delete entrada.datos.ubicacion_id;
        entrada.datos.ubicacion_otro = fila.ubicacion.nombre;
      }
      const { id } = await crearReporte(entrada, opciones);
      if (i >= 2 && i <= 4) {
        await cambiarEstadoReporte({ reporteId: id, estado: 'en_servicios', administradorId: fila.admin });
        if (i >= 3) await cambiarEstadoReporte({ reporteId: id, estado: estados[i], administradorId: fila.admin });
      }
      await client.query("UPDATE reportes SET activo = $1, fecha_creacion = '2020-02-03 12:00:00' WHERE id = $2", [i % 2 === 0, id]);
    }
    // La inactividad actual del catálogo no borra sus estadísticas históricas.
    await client.query('UPDATE ubicaciones SET activo = FALSE WHERE id = $1', [fila.ubicacion.id]);
    const esperado = await esperadoDesdeFilas(client);
    const respuesta = (await request(app).get('/reportes/stats').expect(200)).body;
    expect(respuesta).toEqual(esperado);
    expect(respuesta.total - antes.total).toBe(6);
    expect(respuesta.activos - antes.activos).toBe(3);
    expect(respuesta.inactivos - antes.inactivos).toBe(3);
    expect(respuesta.seriesUbicaciones.filter((r) => r.ubicacion === fila.ubicacion.nombre)).toEqual([
      { campus: fila.marca, ubicacion: fila.ubicacion.nombre, count: 4 },
      { campus: `${fila.marca}-otro`, ubicacion: fila.ubicacion.nombre, count: 1 },
    ]);
  }, 6));

  test('series completas: más de 30 fechas y 10 ubicaciones, sin truncamiento', () => conDatos(async (fila, client) => {
    for (let i = 0; i < 32; i++) {
      const ubicacionId = randomInt(1000000000, 2000000000);
      await client.query('INSERT INTO ubicaciones (id, nombre, campus) VALUES ($1, $2, $3)', [ubicacionId, `${fila.marca}-${i}`, fila.marca]);
      const entrada = alta(fila);
      entrada.datos.ubicacion_id = ubicacionId;
      const { id } = await crearReporte(entrada, opciones);
      await client.query("UPDATE reportes SET fecha_creacion = TIMESTAMP '2019-01-01 12:00:00' + $1 * INTERVAL '1 day', activo = $2 WHERE id = $3", [i, i % 2 === 0, id]);
    }
    const respuesta = (await request(app).get('/reportes/stats').expect(200)).body;
    expect(respuesta).toEqual(await esperadoDesdeFilas(client));
    expect(respuesta.seriesFechas.length).toBeGreaterThanOrEqual(32);
    expect(respuesta.seriesUbicaciones.filter((r) => r.campus === fila.marca)).toHaveLength(32);
  }, 32));
});

describe('T7: transiciones internas e historial atómico con PostgreSQL real', () => {
  async function reporteEn(fila, client, tipo, estado) {
    const entrada = alta(fila);
    entrada.datos.tipo_reporte = tipo;
    const { id } = await crearReporte(entrada, opciones);
    if (tipo === 'perdido' && estado === 'devuelto') {
      await client.query("UPDATE reportes SET estado = 'devuelto' WHERE id = $1", [id]);
    }
    if (tipo === 'encontrado' && estado !== 'encontrado') {
      await client.query("UPDATE reportes SET estado = 'en_servicios' WHERE id = $1", [id]);
      if (estado !== 'en_servicios') await client.query('UPDATE reportes SET estado = $1 WHERE id = $2', [estado, id]);
    }
    return id;
  }

  function observarConexion() {
    const conectar = pool.connect;
    const consultas = [];
    const liberar = jest.fn();
    pool.connect = async () => {
      const conexion = await conectar();
      return {
        async query(sql, valores) { consultas.push([sql, valores]); return conexion.query(sql, valores); },
        release() { liberar(); conexion.release(); },
      };
    };
    return { consultas, liberar, restaurar() { pool.connect = conectar; } };
  }

  const aristas = ['perdido:perdido:devuelto', 'encontrado:encontrado:en_servicios', 'encontrado:en_servicios:devuelto', 'encontrado:en_servicios:donado'];
  const etiquetas = { perdido: 'Perdido', encontrado: 'Encontrado', en_servicios: 'En servicios', devuelto: 'Devuelto', donado: 'Donado' };
  const casos = [];
  for (const [tipo, estados] of [['perdido', ['perdido', 'devuelto']], ['encontrado', ['encontrado', 'en_servicios', 'devuelto', 'donado']]]) {
    for (const actual of estados) for (const nuevo of [...Object.keys(etiquetas), 'entregado']) casos.push([tipo, actual, nuevo]);
  }
  test.each(casos)('%s: %s → %s respeta matriz, bloqueo y auditoría', (tipo, actual, nuevo) => conDatos(async (fila, client) => {
    const id = await reporteEn(fila, client, tipo, actual);
    const antes = (await client.query('SELECT * FROM reportes WHERE id = $1', [id])).rows[0];
    const historialAntes = (await client.query('SELECT * FROM historial WHERE reporte_id = $1 ORDER BY id', [id])).rows;
    const observador = observarConexion();
    const valida = aristas.includes(`${tipo}:${actual}:${nuevo}`);
    try {
      const operacion = cambiarEstadoReporte({ reporteId: id, estado: nuevo, administradorId: fila.admin });
      if (nuevo === actual) await expect(operacion).resolves.toEqual({ cambiado: false, estado: etiquetas[actual] });
      else if (valida) await expect(operacion).resolves.toEqual({ cambiado: true, id, estado: etiquetas[nuevo] });
      else await expect(operacion).rejects.toMatchObject({ status: 400 });
      const bloqueo = observador.consultas.findIndex(([sql]) => /SELECT[\s\S]+FROM reportes[\s\S]+FOR UPDATE/i.test(sql));
      expect(bloqueo).toBeGreaterThanOrEqual(0);
      const escrituras = observador.consultas.filter(([sql]) => /UPDATE\s+reportes|INSERT\s+INTO\s+historial/i.test(sql));
      expect(escrituras).toHaveLength(valida ? 2 : 0);
      if (valida) expect(observador.consultas.indexOf(escrituras[0])).toBeGreaterThan(bloqueo);
      expect(observador.liberar).toHaveBeenCalledTimes(1);
      const despues = (await client.query('SELECT * FROM reportes WHERE id = $1', [id])).rows[0];
      const historial = (await client.query('SELECT * FROM historial WHERE reporte_id = $1 ORDER BY id', [id])).rows;
      if (valida) {
        expect(despues).toMatchObject({ estado: nuevo, tipo_reporte: tipo });
        expect(historial.slice(0, -1)).toEqual(historialAntes);
        expect(historial).toHaveLength(historialAntes.length + 1);
        expect(historial.at(-1)).toMatchObject({ accion: 'cambio_estado', valor_anterior: actual, valor_nuevo: nuevo, realizado_por: fila.admin, tipo_realizado_por: 'admin' });
      } else {
        expect(despues).toEqual(antes);
        expect(historial).toEqual(historialAntes);
      }
    } finally { observador.restaurar(); }
  }, 1));

  test.each(['ausente', 'inexistente', 'admin', 'superadmin'])('actor %s → 403 sin mutación', (caso) => conDatos(async (fila, client) => {
    const { id } = await crearReporte(alta(fila), opciones);
    let administradorId = fila.admin;
    if (caso === 'ausente') administradorId = undefined;
    else if (caso === 'inexistente') administradorId = (await client.query('SELECT MAX(id) + 1 AS id FROM administradores')).rows[0].id;
    else await client.query('UPDATE administradores SET rol = $1 WHERE id = $2', [caso, fila.admin]);
    const antes = (await client.query('SELECT * FROM reportes WHERE id = $1', [id])).rows;
    const historial = (await client.query('SELECT * FROM historial WHERE reporte_id = $1', [id])).rows;
    await expect(cambiarEstadoReporte({ reporteId: id, estado: 'devuelto', administradorId })).rejects.toMatchObject({ status: 403 });
    expect((await client.query('SELECT * FROM reportes WHERE id = $1', [id])).rows).toEqual(antes);
    expect((await client.query('SELECT * FROM historial WHERE reporte_id = $1', [id])).rows).toEqual(historial);
  }, 1));

  test('reporte inexistente → 404', () => conDatos(async (fila, client) => {
    const id = (await client.query('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM reportes')).rows[0].id;
    await expect(cambiarEstadoReporte({ reporteId: id, estado: 'devuelto', administradorId: fila.admin })).rejects.toMatchObject({ status: 404 });
  }));

  test('fallo real del historial revierte UPDATE y libera la conexión', () => conDatos(async (fila, client) => {
    const { id } = await crearReporte(alta(fila), opciones);
    const antes = (await client.query('SELECT * FROM reportes WHERE id = $1', [id])).rows;
    const historial = (await client.query('SELECT * FROM historial WHERE reporte_id = $1', [id])).rows;
    const conectar = pool.connect;
    let estadoAntesDelFallo;
    const liberar = jest.fn();
    pool.connect = async () => {
      const conexion = await conectar();
      return {
        async query(sql, valores) {
          if (/INSERT\s+INTO\s+historial/i.test(sql)) {
            estadoAntesDelFallo = (await conexion.query('SELECT estado FROM reportes WHERE id = $1', [id])).rows[0].estado;
            return conexion.query('INSERT INTO historial (reporte_id, accion) VALUES ($1, NULL)', [id]);
          }
          return conexion.query(sql, valores);
        },
        release() { liberar(); conexion.release(); },
      };
    };
    try {
      await expect(cambiarEstadoReporte({ reporteId: id, estado: 'devuelto', administradorId: fila.admin })).rejects.toMatchObject({ code: '23502' });
      expect(estadoAntesDelFallo).toBe('devuelto');
      expect(liberar).toHaveBeenCalledTimes(1);
      expect((await client.query('SELECT * FROM reportes WHERE id = $1', [id])).rows).toEqual(antes);
      expect((await client.query('SELECT * FROM historial WHERE reporte_id = $1', [id])).rows).toEqual(historial);
    } finally { pool.connect = conectar; }
  }, 1));
});

describe('T6: lecturas HTTP con PostgreSQL real', () => {
  test('presenta TIMESTAMPTZ en la zona institucional America/La_Paz', async () => {
    const { rows } = await pool.query(
      "SELECT current_setting('TimeZone') AS zona, TO_CHAR(TIMESTAMPTZ '2026-10-23 05:19:15+00', 'YYYY-MM-DD HH24:MI') AS fecha"
    );
    expect(rows[0]).toEqual({
      zona: 'America/La_Paz',
      fecha: '2026-10-23 01:19',
    });
  });

  test.each([
    ['listado', 'usuario', false], ['detalle', 'usuario', false], ['perfil', 'usuario', false],
    ['listado', 'admin', true], ['detalle', 'admin', true], ['perfil', 'usuario', true],
  ])('%s devuelve contrato completo: %s, texto libre=%s', (consulta, tipo, libre) => conDatos(async (fila, client) => {
    const entrada = alta(fila);
    if (libre) {
      delete entrada.datos.ubicacion_id;
      entrada.datos.ubicacion_otro = 'Patio fuera del catálogo';
    }
    if (tipo === 'admin') {
      entrada.autor = { tipo, id: fila.admin };
      entrada.datos.tipo_reporte = 'encontrado';
    }
    const { id } = await crearReporte(entrada, opciones);
    const fecha = (await client.query("SELECT TO_CHAR(fecha_creacion AT TIME ZONE 'America/La_Paz', 'YYYY-MM-DD HH24:MI') AS fecha FROM reportes WHERE id = $1", [id])).rows[0].fecha;
    const ruta = consulta === 'listado' ? '/reportes' : consulta === 'perfil' ? `/reportes/usuario/${fila.usuario}` : `/reportes/${id}`;
    let solicitud = request(app).get(ruta).set('Host', 'findu.example');
    if (consulta === 'perfil') solicitud = solicitud.set('Authorization', `Bearer ${tokenEstudiante(fila.usuario)}`);
    const respuesta = await solicitud.expect(200);
    const reporte = consulta === 'detalle' ? respuesta.body : (consulta === 'perfil' ? respuesta.body.reports : respuesta.body).find((r) => r.id === id);
    expect(reporte).toEqual({
      id, usuario_id: tipo === 'usuario' ? fila.usuario : null,
      administrador_id: tipo === 'admin' ? fila.admin : null, tipo_autor: tipo,
      usuario_nombre: tipo === 'usuario' ? fila.marca : null,
      usuario_correo: tipo === 'usuario' ? `${fila.marca}@example.invalid` : null,
      administrador_nombre: tipo === 'admin' ? fila.marca : null,
      titulo: 'Objeto', descripcion: 'Descripción', contacto: 'Contacto',
      categoria_id: fila.categoria, categoria_nombre: fila.marca,
      fecha_incidente: '2026-01-01', fecha, campus: fila.marca,
      ubicacion_id: libre ? null : fila.ubicacion.id,
      ubicacion_nombre: libre ? null : fila.ubicacion.nombre,
      ubicacion_otro: libre ? 'Patio fuera del catálogo' : null,
      imagen: 'foto-temporal.jpg', imageUrl: 'http://findu.example/uploads/foto-temporal.jpg',
      tipo_reporte: tipo === 'admin' ? 'encontrado' : 'perdido',
      estado: tipo === 'admin' ? 'En servicios' : 'Perdido', activo: true,
    });
  }, 1));

  test('público solo TRUE; perfil incluye archivados y no incluye otros autores', () => conDatos(async (fila, client) => {
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push((await crearReporte(alta(fila), opciones)).id);
    await client.query('UPDATE reportes SET activo = FALSE WHERE id = $1', [ids[1]]);
    await client.query('UPDATE reportes SET activo = NULL WHERE id = $1', [ids[2]]);
    // Otro usuario temporal sin añadir fixtures persistentes ni depender de semillas.
    const otro = randomInt(1000000000, 2000000000);
    await client.query('INSERT INTO usuarios (id, nombre, correo) VALUES ($1, $2, $3)', [otro, `${fila.marca}-otro`, `${fila.marca}-otro@example.invalid`]);
    await client.query('UPDATE reportes SET usuario_id = $1 WHERE id = $2', [otro, ids[3]]);
    const publico = (await request(app).get('/reportes').expect(200)).body;
    expect(publico.every((r) => r.activo === true)).toBe(true);
    expect(publico.filter((r) => ids.includes(r.id)).map((r) => r.id).sort()).toEqual([ids[0], ids[3]].sort());
    const perfil = (await request(app)
      .get(`/reportes/usuario/${fila.usuario}`)
      .set('Authorization', `Bearer ${tokenEstudiante(fila.usuario)}`)
      .expect(200)).body;
    expect(perfil.reports.map((r) => r.id).sort()).toEqual(ids.slice(0, 3).sort());
    expect(perfil.reports.find((r) => r.id === ids[1]).activo).toBe(false);
    expect(perfil.reports.every((r) => r.usuario_id === fila.usuario)).toBe(true);
    const detalle = (await request(app).get(`/reportes/${ids[1]}`).expect(200)).body;
    expect(detalle.activo).toBe(false);
  }, 4));

  test('perfil vacío conserva el sobre y detalle ausente devuelve 404', () => conDatos(async (fila, client) => {
    expect((await request(app)
      .get(`/reportes/usuario/${fila.usuario}`)
      .set('Authorization', `Bearer ${tokenEstudiante(fila.usuario)}`)
      .expect(200)).body).toEqual({ reports: [] });
    const ausente = (await client.query('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM reportes')).rows[0].id;
    expect((await request(app).get(`/reportes/${ausente}`).expect(404)).body).toEqual({ message: 'Reporte no encontrado' });
    await request(app).get('/reportes/no-entero').expect(404);
  }));
});

describe('T4: creación e historial atómicos', () => {
  test.each([
    ['perdido', 'encontrado'],
    ['encontrado', 'perdido'],
  ])('tipo_reporte inmutable: %s → %s rechazado por trigger real', (original, nuevo) => conDatos(async (fila, client) => {
    const entrada = alta(fila);
    entrada.datos.tipo_reporte = original;
    const { id } = await crearReporte(entrada, opciones);
    const antes = (await client.query('SELECT * FROM reportes WHERE id = $1', [id])).rows;
    const historialAntes = (await client.query('SELECT * FROM historial WHERE reporte_id = $1 ORDER BY id', [id])).rows;
    expect(antes).toHaveLength(1);
    expect(antes[0].tipo_reporte).toBe(original);
    expect(historialAntes).toHaveLength(1);

    // El error de PostgreSQL aborta la subtransacción. Recuperarla permite
    // comprobar la fila antes del ROLLBACK exterior, sin tocar el trigger.
    await client.query('SAVEPOINT cambio_tipo_t4');
    let error;
    try {
      await client.query('UPDATE reportes SET tipo_reporte = $1 WHERE id = $2', [nuevo, id]);
    } catch (rechazo) {
      error = rechazo;
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT cambio_tipo_t4');
      await client.query('RELEASE SAVEPOINT cambio_tipo_t4');
    }
    // Un CHECK de coherencia tipo/estado no sustituye la garantía del trigger.
    expect(error).toMatchObject({
      code: 'P0001',
      message: `tipo_reporte es inmutable (reporte ${id})`,
      where: expect.stringContaining('prohibir_cambio_tipo_reporte()'),
    });
    expect((await client.query('SELECT * FROM reportes WHERE id = $1', [id])).rows).toEqual(antes);
    expect((await client.query('SELECT * FROM historial WHERE reporte_id = $1 ORDER BY id', [id])).rows).toEqual(historialAntes);
  }, 1));

  test.each([
    ['usuario', 'perdido', 'perdido'],
    ['usuario', 'encontrado', 'encontrado'],
    ['admin', 'encontrado', 'en_servicios'],
  ])('%s/%s persiste estado %s e historial del autor', (tipo, tipoReporte, estado) => conDatos(async (fila, client) => {
    const entrada = alta(fila);
    entrada.datos.tipo_reporte = tipoReporte;
    const autorId = tipo === 'admin' ? fila.admin : fila.usuario;
    if (tipo === 'admin') {
      entrada.autor = { tipo, id: autorId };
    }
    const resultado = await crearReporte(entrada, opciones);
    expect(resultado).toEqual({ id: expect.any(Number), imagen: entrada.imagenPath });
    const reporte = (await client.query("SELECT *, TO_CHAR(fecha_incidente, 'YYYY-MM-DD') AS fecha_civil FROM reportes WHERE id = $1", [resultado.id])).rows[0];
    expect(reporte).toMatchObject({
      usuario_id: tipo === 'usuario' ? autorId : null,
      administrador_id: tipo === 'admin' ? autorId : null,
      titulo: 'Objeto', descripcion: 'Descripción', contacto: 'Contacto',
      categoria_id: fila.categoria, campus: fila.marca, ubicacion_id: fila.ubicacion.id,
      ubicacion_otro: null, tipo_reporte: tipoReporte, estado, imagen: entrada.imagenPath,
      fecha_civil: '2026-01-01', activo: true,
    });
    const historial = (await client.query('SELECT accion, valor_anterior, valor_nuevo, realizado_por, tipo_realizado_por FROM historial WHERE reporte_id = $1', [resultado.id])).rows;
    expect(historial).toEqual([{ accion: 'creacion', valor_anterior: null, valor_nuevo: estado, realizado_por: autorId, tipo_realizado_por: tipo }]);
  }, 1));

  test.each(['perdido', 'encontrado'])('sin fotografía rechaza %s antes de insertar', (tipo) => conDatos(async (fila, client) => {
    const entrada = alta(fila);
    entrada.datos.tipo_reporte = tipo;
    delete entrada.imagenPath;
    const historialAntes = (await client.query('SELECT COUNT(*) AS count FROM historial')).rows[0].count;
    await expect(crearReporte(entrada, opciones)).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/fotografía/) });
    expect((await client.query('SELECT COUNT(*) AS count FROM historial')).rows[0].count).toBe(historialAntes);
  }));

  test.each(['usuario', 'admin'])('fallo real de INSERT historial revierte reporte de %s y libera conexión', (tipo) => conDatos(async (fila, client) => {
    const entrada = alta(fila);
    if (tipo === 'admin') {
      delete entrada.datos.usuario_id;
      entrada.autor = { tipo, id: fila.admin };
      entrada.datos.tipo_reporte = 'encontrado';
    }
    const conectar = pool.connect;
    let reporteInsertado;
    let falloHistorial = false;
    const liberar = jest.fn();
    const historialAntes = (await client.query('SELECT COUNT(*) AS count FROM historial')).rows[0].count;
    pool.connect = async () => {
      const conexion = await conectar();
      return {
        async query(sql, valores) {
          if (/INSERT\s+INTO\s+historial/i.test(sql)) {
            falloHistorial = true;
            // Viola NOT NULL sin alterar esquema/triggers: aborta la transacción real.
            return conexion.query('INSERT INTO historial (reporte_id, accion) VALUES ($1, NULL)', [reporteInsertado]);
          }
          const resultado = await conexion.query(sql, valores);
          if (/INSERT\s+INTO\s+reportes/i.test(sql)) reporteInsertado = resultado.rows[0].id;
          return resultado;
        },
        release() { liberar(); conexion.release(); },
      };
    };
    try {
      await expect(crearReporte(entrada, opciones)).rejects.toMatchObject({ code: '23502' });
      expect(falloHistorial).toBe(true);
      expect(reporteInsertado).toEqual(expect.any(Number));
      expect(liberar).toHaveBeenCalledTimes(1);
      expect((await client.query('SELECT id FROM reportes WHERE id = $1', [reporteInsertado])).rows).toEqual([]);
      expect((await client.query('SELECT COUNT(*) AS count FROM historial')).rows[0].count).toBe(historialAntes);
      expect((await client.query('SELECT id FROM usuarios WHERE id = $1', [fila.usuario])).rows).toHaveLength(1);
    } finally { pool.connect = conectar; }
  }));
});

describe('T3: aislamiento real BEGIN/ROLLBACK', () => {
  test('dato visible por pool.query y pool.connect desaparece al terminar', () => conDatos(async (fila) => {
    expect((await pool.query('SELECT id FROM usuarios WHERE id = $1', [fila.usuario])).rows).toHaveLength(1);
    const client = await pool.connect();
    expect((await client.query('SELECT id FROM usuarios WHERE id = $1', [fila.usuario])).rows).toHaveLength(1);
    client.release();
  }));

  test('restaura el pool y revierte también si falla el callback', async () => {
    const error = new Error('fallo de prueba');
    await expect(conDatos(async () => { throw error; })).rejects.toBe(error);
  });

  test.each(['COMMIT', 'ROLLBACK'])('una transacción interna con %s no cierra la envolvente', (fin) => conDatos(async (fila) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE categorias SET descripcion = $1 WHERE id = $2', ['interior', fila.categoria]);
      await client.query(fin);
      expect((await pool.query('SELECT descripcion FROM categorias WHERE id = $1', [fila.categoria])).rows[0].descripcion)
        .toBe(fin === 'COMMIT' ? 'interior' : null);
      expect((await pool.query('SELECT id FROM usuarios WHERE id = $1', [fila.usuario])).rows).toHaveLength(1);
    } finally { client.release(); }
  }));
});

describe('T3: resolución del alta sin persistencia', () => {
  test('resuelve usuario, categoría y ubicación por ID + campus', () => conDatos(async (fila) => {
    const resultado = await resolverAlta(alta(fila), opciones);
    expect(resultado).toMatchObject({
      autor: { tipo: 'usuario', id: fila.usuario }, titulo: 'Objeto', descripcion: 'Descripción',
      contacto: 'Contacto', categoria_id: fila.categoria, fecha_incidente: '2026-01-01',
      campus: fila.marca, ubicacion_id: fila.ubicacion.id, ubicacion_otro: null,
      tipo_reporte: 'perdido', estado: 'perdido', imagen: 'foto-temporal.jpg',
    });
  }));

  test('resuelve administrador interno encontrado y estado derivado', () => conDatos(async (fila) => {
    const entrada = alta(fila);
    entrada.autor = { tipo: 'admin', id: fila.admin };
    entrada.datos.tipo_reporte = 'encontrado';
    expect(await resolverAlta(entrada, opciones)).toMatchObject({ autor: entrada.autor, estado: 'en_servicios' });
  }));

  test('ubicación por nombre retirada se rechaza antes de consultar el catálogo', () => conDatos(async (fila) => {
    const entrada = alta(fila);
    delete entrada.datos.ubicacion_id;
    entrada.datos.ubicacion = ` ${fila.ubicacion.nombre.toUpperCase()} `;
    await expect(resolverAlta(entrada, opciones)).rejects.toMatchObject({
      status: 400, message: 'Campo retirado del alta: ubicacion',
    });
  }));

  test('ubicacion_otro no crea catálogo', () => conDatos(async (fila, client) => {
    const entrada = alta(fila);
    delete entrada.datos.ubicacion_id;
    const texto = fila.marca;
    entrada.datos.ubicacion_otro = ` ${texto} `;
    entrada.datos.campus = `nuevo-${fila.marca}`;
    const antes = (await client.query('SELECT COUNT(*) AS count FROM ubicaciones')).rows[0].count;
    expect(await resolverAlta(entrada, opciones)).toMatchObject({ ubicacion_id: null, ubicacion_otro: texto });
    expect((await client.query('SELECT COUNT(*) AS count FROM ubicaciones')).rows[0].count).toBe(antes);
  }));

  const rechazos = [
    ['actor ausente', (e) => { delete e.autor; }],
    ['actor usuario inexistente', (e, f) => { e.autor.id = f.ausenteUsuario; }],
    ['admin inexistente', (e, f) => { e.autor = { tipo: 'admin', id: f.ausenteAdmin }; e.datos.tipo_reporte = 'encontrado'; }],
    ['autor en el cuerpo retirado', (e, f) => { e.datos.usuario_id = f.usuario; }],
    ['admin perdido', (e, f) => { e.autor = { tipo: 'admin', id: f.admin }; }],
    ['categoría inactiva', (e, f) => { e.datos.categoria_id = f.inactiva; }],
    ['categoría inexistente', (e, f) => { e.datos.categoria_id = f.ausenteCategoria; }],
    ['categoría ausente', (e) => { delete e.datos.categoria_id; }],
    ['fecha futura', (e) => { e.datos.fecha_incidente = '2026-10-23'; }],
    ['fecha inválida', (e) => { e.datos.fecha_incidente = '2026-02-30'; }],
    ['campus ausente', (e) => { delete e.datos.campus; }],
    ['campus distinto', (e, f) => { e.datos.campus = `${f.marca}-otro`; }],
    ['ubicación inexistente', (e, f) => { e.datos.ubicacion_id = f.ausenteUbicacion; }],
    ['ubicación ID inactiva', (e, f) => { e.datos.ubicacion_id = f.ubicacionInactiva.id; }],
    ['ubicación nombre inactiva', (e, f) => { delete e.datos.ubicacion_id; e.datos.ubicacion = f.ubicacionInactiva.nombre.toUpperCase(); }],
    ['doble ubicación', (e) => { e.datos.ubicacion_otro = 'Otro'; }],
    ['ninguna ubicación', (e) => { delete e.datos.ubicacion_id; }],
    ['foto ausente', (e) => { delete e.imagenPath; }],
    ...['titulo', 'descripcion', 'contacto'].map((campo) => [campo + ' vacío', (e) => { e.datos[campo] = ' '; }]),
  ];
  test.each(rechazos)('rechaza con 400: %s, sin crear reporte', (caso, modificar) => conDatos(async (fila, client) => {
    // IDs ausentes calculados de las tablas reales, no IDs supuestos de seeds.
    for (const [tabla, campo] of [['usuarios', 'ausenteUsuario'], ['administradores', 'ausenteAdmin'], ['categorias', 'ausenteCategoria'], ['ubicaciones', 'ausenteUbicacion']]) {
      fila[campo] = (await client.query(`SELECT COALESCE(MAX(id), 0) + 1 AS id FROM ${tabla}`)).rows[0].id;
    }
    const entrada = alta(fila);
    modificar(entrada, fila);
    await expect(resolverAlta(entrada, opciones)).rejects.toMatchObject({ status: 400, message: expect.any(String) });
  }));
});
