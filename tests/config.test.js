describe('configuración de autenticación', () => {
  describe('JWT', () => {
    const { cargarConfiguracionJwt } = require('../config/jwt');

    test('normaliza la expiración y usa 24 horas por defecto', () => {
      expect(cargarConfiguracionJwt({ JWT_SECRET: 'secreto-de-prueba' })).toEqual({
        secret: 'secreto-de-prueba',
        expiracionHoras: 24,
        emisor: 'FindU',
      });

      expect(
        cargarConfiguracionJwt({
          JWT_SECRET: 'secreto-de-prueba',
          JWT_EXPIRACION_HORAS: ' 12 ',
        }),
      ).toEqual({
        secret: 'secreto-de-prueba',
        expiracionHoras: 12,
        emisor: 'FindU',
      });
    });

    test.each([
      [{}, 'secreto ausente'],
      [{ JWT_SECRET: '   ' }, 'secreto vacío'],
      [
        { JWT_SECRET: 'secreto-de-prueba', JWT_EXPIRACION_HORAS: '0' },
        'expiración cero',
      ],
      [
        { JWT_SECRET: 'secreto-de-prueba', JWT_EXPIRACION_HORAS: '1.5' },
        'expiración no entera',
      ],
    ])('falla de forma cerrada con %s (%s)', (entorno) => {
      expect(() => cargarConfiguracionJwt(entorno)).toThrow(
        'Configuración JWT inválida',
      );
    });
  });

  describe('Google', () => {
    const { cargarConfiguracionGoogle } = require('../config/google');

    test('normaliza y elimina audiencias duplicadas y normaliza el dominio', () => {
      expect(
        cargarConfiguracionGoogle({
          GOOGLE_CLIENT_IDS: ' cliente-web ,cliente-android, cliente-web ',
          DOMINIO_INSTITUCIONAL: ' Universidad.Example ',
        }),
      ).toEqual({
        audiencias: ['cliente-web', 'cliente-android'],
        dominioInstitucional: 'universidad.example',
      });
    });

    test.each([
      [{ DOMINIO_INSTITUCIONAL: 'universidad.example' }, 'audiencias ausentes'],
      [{ GOOGLE_CLIENT_IDS: ' , ' }, 'audiencias vacías'],
      [{ GOOGLE_CLIENT_IDS: 'cliente-web' }, 'dominio ausente'],
      [
        {
          GOOGLE_CLIENT_IDS: 'cliente-web',
          DOMINIO_INSTITUCIONAL: 'https://universidad.example',
        },
        'dominio inválido',
      ],
    ])('falla de forma cerrada con %s (%s)', (entorno) => {
      expect(() => cargarConfiguracionGoogle(entorno)).toThrow(
        'Configuración de Google inválida',
      );
    });
  });
});
