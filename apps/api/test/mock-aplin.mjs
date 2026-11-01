// Servidor que imita la API de APLIN (APLIN OS) según los ejemplos de su documentación en Postman.
// Lo usan las pruebas: la API del ERP debe arrancar con APLINTEST_BASE_URL=http://localhost:<puerto> y APLINTEST_ORG_CODE.
import http from 'node:http';

export function startMockAplin({ port = 4900, code = 'prueba-aplin' } = {}) {
  const state = { code, products: [], orders: [], calls: [], tokens: new Set(), pageCap: 2 };
  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const page = (rows, url) => {
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), state.pageCap);
    const p = Math.max(Number(url.searchParams.get('page') ?? 1), 1);
    const totalPages = Math.max(Math.ceil(rows.length / limit), 1);
    return { data: rows.slice((p - 1) * limit, p * limit), meta: { total: rows.length, totalPages, currentPage: p, pageSize: limit } };
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      state.calls.push(`${req.method} ${url.pathname}`);
      if (req.method === 'POST' && url.pathname === '/org/token') {
        const body = raw ? JSON.parse(raw) : {};
        if (body.code !== state.code) return send(res, 401, { message: 'invalid code', code: 401, error: ['unauthorized'] });
        const token = `tok-${Math.random().toString(36).slice(2)}`;
        state.tokens.add(token);
        return send(res, 200, { message: 'ok', code: 200, data: { token, expiresIn: 30000 }, error: [] });
      }
      const auth = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      if (!state.tokens.has(auth)) return send(res, 401, { message: 'unauthorized' });
      if (req.method === 'GET' && url.pathname.replace(/\/$/, '') === '/products') return send(res, 200, page(state.products, url));
      if (req.method === 'GET' && url.pathname.replace(/\/$/, '') === '/orders') return send(res, 200, page(state.orders, url));
      return send(res, 404, { message: 'not found' });
    });
  });
  return new Promise((resolve) => server.listen(port, () => resolve({ server, state, close: () => new Promise((r) => server.close(r)) })));
}

/** Producto con la forma de GET /products. */
export const product = (id, sku, stock) => ({
  id, name: `Producto ${sku}`, description: null, sku, cost: null, type: 'STOCK', usesBarcode: true, piecesPerBox: 10,
  defaultBarcode: null, barcodes: [], committed: 0, unavailable: 0, available: 0, onHand: 0, booked: 0, ...stock,
});

/** Orden con la forma de GET /orders, con comprador y dirección (el ERP no debe guardarlos). */
export const order = (id, orderNumber, lines, extra = {}) => ({
  id, orderNumber, status: 'PROCESSING', substatus: 'READY_TO_PACK', blockBy: null, source: 'SHOPIFY', type: 'DROPSHIP', price: 0,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), deleted: false, organizationId: 'org_code',
  orderLines: lines.map(([sku, quantity, price], i) => ({ id: id * 10 + i, quantity, price: price ?? 0, bookedQuantity: quantity, packedQuantity: 0, product: { id: 1, name: sku, sku, type: 'STOCK' } })),
  buyer: { id: 1, name: 'Nombre', lastName: 'Apellido', email: 'cliente@example.com', phone: '5555555555' },
  address: { id: 1, city: 'Ciudad', street1: 'Calle 1', zip: '06000', phone: '5555555555' },
  fulfillmentStatus: 'OK',
  ...extra,
});
