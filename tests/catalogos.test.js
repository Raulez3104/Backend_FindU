require('dotenv').config();
const { randomInt, randomUUID } = require('crypto');
const request = require('supertest');
const pool = require('../config/database');
const app = require('../app');
const { conTransaccionPrueba } = require('./helpers/dbTransaccion');

afterAll(() => pool.end());

async function estadoCatalogos(client) {
  return {
    categorias: (await client.query('SELECT * FROM categorias ORDER BY id')).rows,
    ubicaciones: (await client.query('SELECT * FROM ubicaciones ORDER BY id')).rows,
  };
}

async function conCatalogos(comprobar) {
  const marca = `t9-${randomUUID()}`;
  const categorias = Array.from({ length: 5 }, () => randomInt(1000000000, 2000000000));
  const ubicaciones = Array.from({ length: 11 }, () => randomInt(1000000000, 2000000000));
  const queryOriginal = pool.query;
  const connectOriginal = pool.connect;
  try {
    await conTransaccionPrueba(async (client) => {
      const nombres = ['zeta', 'Alfa', 'beta', 'Inactiva', 'Nula'];
      const activos = [true, true, true, false, null];
      for (let i = 0; i < categorias.length; i++) {
        await client.query('INSERT INTO categorias (id, nombre, descripcion, icono, activo) VALUES ($1,$2,$3,$4,$5)',
          [categorias[i], `${marca}-${nombres[i]}`, i === 1 ? null : 'Descripción temporal', i === 1 ? null : 'objeto', activos[i]]);
      }
      for (let i = 0; i < ubicaciones.length; i++) {
        const indice = i % 5;
        await client.query('INSERT INTO ubicaciones (id, nombre, campus, piso, descripcion, activo) VALUES ($1,$2,$3,$4,$5,$6)',
          [ubicaciones[i], `${marca}-${nombres[indice]}`, i < 5 ? 'principal' : i < 10 ? marca : `${marca}-otro`,
            indice === 1 ? null : indice, indice === 1 ? null : 'Área temporal', i === 10 ? false : activos[indice]]);
      }
      const antes = await estadoCatalogos(client);
      await comprobar({ marca, categorias, ubicaciones }, client);
      expect(await estadoCatalogos(client)).toEqual(antes);
    });
  } finally {
    expect(pool.query).toBe(queryOriginal);
    expect(pool.connect).toBe(connectOriginal);
    // También se comprueba el aislamiento cuando falla la aserción HTTP.
    expect((await pool.query('SELECT id FROM categorias WHERE id = ANY($1::int[])', [categorias])).rows).toEqual([]);
    expect((await pool.query('SELECT id FROM ubicaciones WHERE id = ANY($1::int[])', [ubicaciones])).rows).toEqual([]);
  }
}

describe('T9: catálogos HTTP de solo lectura con PostgreSQL real', () => {
  test('categorías: campos exactos, solo TRUE y orden sin distinguir mayúsculas', () => conCatalogos(async (datos, client) => {
    const filas = (await client.query('SELECT * FROM categorias ORDER BY LOWER(nombre)')).rows;
    const esperado = filas.filter((fila) => fila.activo === true)
      .map(({ id, nombre, descripcion, icono }) => ({ id, nombre, descripcion, icono }));
    const respuesta = (await request(app).get('/categorias').expect(200)).body;
    expect(respuesta).toEqual(esperado);
    expect(respuesta.filter((fila) => datos.categorias.includes(fila.id)).map((fila) => fila.id))
      .toEqual([datos.categorias[1], datos.categorias[2], datos.categorias[0]]);
  }));

  test.each(['', '?campus=', '?campus=%20%20', '?campus=principal', '?campus=%20principal%20'])
  ('ubicaciones %s: principal por defecto, campos exactos, activos y orden', (consulta) => conCatalogos(async (datos, client) => {
    const filas = (await client.query('SELECT * FROM ubicaciones ORDER BY LOWER(campus), LOWER(nombre)')).rows;
    const esperado = filas.filter((fila) => fila.activo === true && fila.campus === 'principal')
      .map(({ id, nombre, campus, piso, descripcion }) => ({ id, nombre, campus, piso, descripcion }));
    const respuesta = (await request(app).get(`/ubicaciones${consulta}`).expect(200)).body;
    expect(respuesta).toEqual(esperado);
    expect(respuesta.filter((fila) => datos.ubicaciones.includes(fila.id)).map((fila) => fila.id))
      .toEqual([datos.ubicaciones[1], datos.ubicaciones[2], datos.ubicaciones[0]]);
  }));

  test('campus nuevo sin catálogo cerrado: filtro, trim, orden y sin mezclar nombres repetidos', () => conCatalogos(async (datos) => {
    const respuesta = (await request(app).get('/ubicaciones').query({ campus: ` ${datos.marca} ` }).expect(200)).body;
    expect(respuesta).toEqual([
      { id: datos.ubicaciones[6], nombre: `${datos.marca}-Alfa`, campus: datos.marca, piso: null, descripcion: null },
      { id: datos.ubicaciones[7], nombre: `${datos.marca}-beta`, campus: datos.marca, piso: 2, descripcion: 'Área temporal' },
      { id: datos.ubicaciones[5], nombre: `${datos.marca}-zeta`, campus: datos.marca, piso: 0, descripcion: 'Área temporal' },
    ]);
  }));

  test.each(['desconocido', 'sin-activas'])('%s devuelve 200 y []', (caso) => conCatalogos(async (datos) => {
    const campus = `${datos.marca}-${caso === 'sin-activas' ? 'otro' : caso}`;
    await request(app).get('/ubicaciones').query({ campus }).expect(200, []);
  }));

  const escrituras = [];
  for (const ruta of ['/categorias', '/ubicaciones']) {
    for (const metodo of ['post', 'put', 'delete']) {
      for (const detalle of [false, true]) escrituras.push([metodo, ruta, detalle]);
    }
  }
  test.each(escrituras)('%s %s (detalle=%s): 404 sin mutaciones', (metodo, ruta, detalle) => conCatalogos(async (datos) => {
    const id = ruta === '/categorias' ? datos.categorias[0] : datos.ubicaciones[0];
    await request(app)[metodo](`${ruta}${detalle ? `/${id}` : ''}`)
      .send({ nombre: 'No persistir', campus: datos.marca, activo: false }).expect(404);
  }));
});
