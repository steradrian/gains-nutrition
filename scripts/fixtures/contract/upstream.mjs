// The fake food databases behind /api/proxy (see undici.mjs). Answers in the
// shapes the client reads (src/lib/api.js), from canned data:
//   search.openfoodfacts.org /search            search-a-licious: { hits, count, page, page_size }
//   world.openfoodfacts.org /api/v3/product/<c>  { status: 'success', product } or 404 { status: 'failure' }
//   world.openfoodfacts.org /api/v3.5/product/<c>?fields=nutrition  the "as sold" set
//   api.nal.usda.gov /fdc/v1/foods/search        { foods, totalHits, currentPage, totalPages }
// Every request is recorded (host, path, query) so a test can check the URL
// the client's call shape produces.
import http from 'node:http';
import { readFileSync } from 'node:fs';

const SEARCH_213 = JSON.parse(readFileSync(new URL('../off-search-213.json', import.meta.url), 'utf8'));
export const OFF_SEARCH_QUERY = 'Blue Label Marie Biscuits';

export const OFF_PRODUCT_CODE = '3017620422003';
export const OFF_PRODUCT = {
  code: OFF_PRODUCT_CODE,
  product_name: 'Hazelnut spread',
  product_name_en: 'Hazelnut spread',
  brands: 'Contract Foods, Other Brand',
  brands_tags: ['contract-foods', 'other-brand'],
  image_front_url: 'https://images.openfoodfacts.org/images/products/301/762/042/2003/front_en.jpg',
  serving_size: '15 g',
  serving_quantity: '15',
  serving_quantity_unit: 'g',
  nutrition_data_per: '100g',
  quantity: '400 g',
  completeness: 0.9,
  nutriscore_grade: 'e',
  nova_group: 4,
  nutriments: {
    'energy-kcal_100g': 539, 'energy-kj_100g': 2255, fat_100g: 30.9, 'saturated-fat_100g': 10.6,
    carbohydrates_100g: 57.5, sugars_100g: 56.3, fiber_100g: 0, proteins_100g: 6.3, salt_100g: 0.107, sodium_100g: 0.0428,
  },
};

export const USDA_QUERY = 'banana';
export const USDA_SEARCH = {
  totalHits: 2, currentPage: 1, totalPages: 1,
  foods: [
    {
      fdcId: 1105314, description: 'Bananas, raw', dataType: 'Foundation', foodCategory: 'Fruits and Fruit Juices',
      foodNutrients: [
        { nutrientId: 1008, nutrientName: 'Energy', unitName: 'KCAL', value: 98 },
        { nutrientId: 1003, nutrientName: 'Protein', unitName: 'G', value: 0.74 },
        { nutrientId: 1004, nutrientName: 'Total lipid (fat)', unitName: 'G', value: 0.29 },
        { nutrientId: 1005, nutrientName: 'Carbohydrate, by difference', unitName: 'G', value: 23 },
      ],
    },
    {
      fdcId: 2345678, description: 'BANANA CHIPS', dataType: 'Branded', brandOwner: 'Contract Snacks', gtinUpc: '012345678905',
      servingSize: 28, servingSizeUnit: 'g',
      foodNutrients: [{ nutrientId: 1008, nutrientName: 'Energy', unitName: 'KCAL', value: 536 }],
    },
  ],
};

// A one-pixel PNG, what images.openfoodfacts.org answers with.
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');

export async function startUpstream() {
  const seen = [];
  // The User-Agent of each request, in step with `seen` (kept apart so the shape of a `seen`
  // entry, which tests compare whole, does not change).
  const agents = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://upstream.invalid');
    const host = req.headers['x-contract-host'] || '';
    seen.push({ host, path: url.pathname, query: Object.fromEntries(url.searchParams) });
    agents.push(req.headers['user-agent'] || '');
    if (host === 'images.openfoodfacts.org') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PIXEL); }
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (host === 'search.openfoodfacts.org' && url.pathname === '/search') {
      const q = url.searchParams.get('q') || '';
      const page = Number(url.searchParams.get('page') || 1);
      const pageSize = Number(url.searchParams.get('page_size') || 20);
      const key = Object.keys(SEARCH_213).find(k => k !== '_note' && q.includes(k));
      const all = key ? SEARCH_213[key].hits : [];
      return send(200, { hits: all.slice((page - 1) * pageSize, page * pageSize), count: key ? SEARCH_213[key].count : 0, page, page_size: pageSize });
    }
    const product = url.pathname.match(/^\/api\/v3(\.5)?\/product\/(\d+)$/);
    if (host === 'world.openfoodfacts.org' && product) {
      if (product[2] !== OFF_PRODUCT_CODE) {
        return send(404, { code: product[2], status: 'failure', result: { id: 'product_not_found' }, errors: [{ message: { id: 'not_found' } }] });
      }
      if (product[1]) return send(200, { code: OFF_PRODUCT_CODE, status: 'success', product: { nutriments: OFF_PRODUCT.nutriments } });
      return send(200, { code: OFF_PRODUCT_CODE, status: 'success', result: { id: 'product_found' }, product: OFF_PRODUCT });
    }
    if (host === 'api.nal.usda.gov' && url.pathname === '/fdc/v1/foods/search') {
      if (url.searchParams.get('api_key') === 'BAD') return send(403, { error: { code: 'API_KEY_INVALID' } });
      if (url.searchParams.get('query') === 'notjson') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html>maintenance</html>'); }
      return send(200, USDA_SEARCH);
    }
    if (host === 'world.openfoodfacts.org' && url.pathname === '/boom') return send(500, { error: 'upstream broke' });
    send(404, { error: `fake upstream has no ${host}${url.pathname}` });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    seen,
    agents,
    close: () => new Promise(r => server.close(r)),
  };
}
