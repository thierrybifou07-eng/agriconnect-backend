import { describe, it, expect } from 'vitest';
import { api } from '../helpers/app.js';

describe('Sante du service', () => {
  it('repond sur /health', async () => {
    const res = await api().get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('repond 404 avec un message sur une route inconnue', async () => {
    const res = await api().get('/api/v2/nexiste-pas');
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('/api/v2/nexiste-pas');
  });

  it('exige une authentification sur une route protegee', async () => {
    const res = await api().get('/api/v2/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Authentification requise');
  });
});
