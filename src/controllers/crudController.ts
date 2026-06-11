import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Helper to handle async route errors. Known Prisma error codes map to
// meaningful client statuses; everything else stays an opaque 500.
const asyncHandler = (fn: Function) => (req: Request, res: Response) => {
  Promise.resolve(fn(req, res)).catch((err) => {
    if (err?.code === 'P2002') {
      return res.status(409).json({ error: 'القيمة مستخدمة بالفعل: يوجد سجل مطابق.' });
    }
    if (err?.code === 'P2003') {
      return res.status(400).json({ error: 'المرجع المرتبط غير صالح أو غير موجود.' });
    }
    if (err?.code === 'P2025') {
      return res.status(404).json({ error: 'السجل غير موجود.' });
    }
    console.error(err);
    res.status(500).json({ error: 'حدث خطأ غير متوقع في قاعدة البيانات.' });
  });
};

// ==========================================
// FIELD WHITELISTING
// Never pass req.body blindly to Prisma: a valid JWT must not be enough to
// write arbitrary columns/relations. Each entity declares its writable fields
// and a coercion (string/number/json/fk). Unknown keys are dropped silently.
// ==========================================
type FieldSpec = { type: 'string' | 'number' | 'int' | 'json' | 'fk'; required?: boolean };
type EntitySpec = Record<string, FieldSpec>;

const VENDOR_FIELDS: EntitySpec = {
  name: { type: 'string', required: true },
  nameAr: { type: 'string', required: true },
  phone: { type: 'string' },
  email: { type: 'string' },
  address: { type: 'string' },
  bankName: { type: 'string' },
  iban: { type: 'string' },
  accountNumber: { type: 'string' },
  accountHolder: { type: 'string' },
  payoutTerms: { type: 'int' },
  notes: { type: 'string' },
};

const PRODUCT_FIELDS: EntitySpec = {
  name: { type: 'string', required: true },
  nameAr: { type: 'string', required: true },
  category: { type: 'string', required: true },
  price: { type: 'number', required: true },
  unit: { type: 'string', required: true },
  stock: { type: 'int' },
  description: { type: 'string' },
  vendorId: { type: 'fk', required: true },
};

const CUSTOMER_FIELDS: EntitySpec = {
  name: { type: 'string', required: true },
  phone: { type: 'string' },
  email: { type: 'string' },
  address: { type: 'string' },
  location: { type: 'json' },
  notes: { type: 'string' },
};

const DRIVER_FIELDS: EntitySpec = {
  name: { type: 'string', required: true },
  phone: { type: 'string' },
  status: { type: 'string' },
  notes: { type: 'string' },
  vehicleId: { type: 'fk' },
};

const VEHICLE_FIELDS: EntitySpec = {
  plate: { type: 'string', required: true },
  type: { type: 'string' },
  model: { type: 'string' },
  color: { type: 'string' },
  status: { type: 'string' },
  notes: { type: 'string' },
  driverId: { type: 'fk' },
};

const ROUTE_FIELDS: EntitySpec = {
  name: { type: 'string', required: true },
  area: { type: 'string' },
  description: { type: 'string' },
  notes: { type: 'string' },
  driverId: { type: 'fk' },
};

/**
 * Builds a Prisma-safe payload from req.body.
 * - `isCreate`: required fields must be present (on update, absent fields are left untouched)
 * - empty-string FKs become null (otherwise Prisma FK constraints blow up)
 * Throws { status, message } on validation failure.
 */
function sanitize(body: any, spec: EntitySpec, isCreate: boolean): Record<string, any> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw { status: 400, message: 'جسم الطلب غير صالح.' };
  }
  const out: Record<string, any> = {};
  for (const [field, def] of Object.entries(spec)) {
    const raw = body[field];

    if (raw === undefined) {
      if (isCreate && def.required) {
        throw { status: 400, message: `الحقل "${field}" مطلوب.` };
      }
      continue;
    }

    switch (def.type) {
      case 'string': {
        const v = raw === null ? null : String(raw);
        if (def.required && (v === null || !v.trim())) {
          throw { status: 400, message: `الحقل "${field}" مطلوب.` };
        }
        out[field] = v;
        break;
      }
      case 'number': {
        const v = Number(raw);
        if (Number.isNaN(v)) throw { status: 400, message: `الحقل "${field}" يجب أن يكون رقماً.` };
        out[field] = v;
        break;
      }
      case 'int': {
        const v = parseInt(String(raw), 10);
        out[field] = Number.isNaN(v) ? 0 : v;
        break;
      }
      case 'json': {
        if (raw !== null && typeof raw !== 'object') {
          throw { status: 400, message: `الحقل "${field}" يجب أن يكون كائن JSON.` };
        }
        out[field] = raw ?? {};
        break;
      }
      case 'fk': {
        const v = raw === null || raw === '' ? null : String(raw);
        if (def.required && !v) throw { status: 400, message: `الحقل "${field}" مطلوب.` };
        out[field] = v;
        break;
      }
    }
  }
  return out;
}

function handleValidation(res: Response, err: any): boolean {
  if (err && typeof err === 'object' && 'status' in err && 'message' in err) {
    res.status(err.status).json({ error: err.message });
    return true;
  }
  return false;
}

// Generic CRUD factory: list/create/update/delete with whitelisting baked in.
function crudHandlers(
  model: any,
  spec: EntitySpec,
  itemKey: string,
  listKey: string,
  listArgs: object,
  deletedMessage: string
) {
  return {
    list: asyncHandler(async (req: Request, res: Response) => {
      const items = await model.findMany(listArgs);
      return res.json({ [listKey]: items });
    }),
    create: asyncHandler(async (req: Request, res: Response) => {
      try {
        const data = sanitize(req.body, spec, true);
        const item = await model.create({ data });
        return res.status(201).json({ [itemKey]: item });
      } catch (err) {
        if (handleValidation(res, err)) return;
        throw err;
      }
    }),
    update: asyncHandler(async (req: Request, res: Response) => {
      try {
        const data = sanitize(req.body, spec, false);
        const item = await model.update({ where: { id: req.params.id }, data });
        return res.json({ [itemKey]: item });
      } catch (err) {
        if (handleValidation(res, err)) return;
        throw err;
      }
    }),
    remove: asyncHandler(async (req: Request, res: Response) => {
      await model.delete({ where: { id: req.params.id } });
      return res.json({ message: deletedMessage });
    }),
  };
}

// ==========================================
// VENDORS
// ==========================================
const vendors = crudHandlers(prisma.vendor, VENDOR_FIELDS, 'vendor', 'vendors', { include: { products: true } }, 'تم حذف المورد بنجاح.');
export const getVendors = vendors.list;
export const createVendor = vendors.create;
export const updateVendor = vendors.update;
export const deleteVendor = vendors.remove;

// ==========================================
// PRODUCTS
// ==========================================
const products = crudHandlers(prisma.product, PRODUCT_FIELDS, 'product', 'products', { include: { vendor: true } }, 'تم حذف المنتج بنجاح.');
export const getProducts = products.list;
export const createProduct = products.create;
export const updateProduct = products.update;
export const deleteProduct = products.remove;

// ==========================================
// CUSTOMERS
// ==========================================
const customers = crudHandlers(prisma.customer, CUSTOMER_FIELDS, 'customer', 'customers', {}, 'تم حذف العميل بنجاح.');
export const getCustomers = customers.list;
export const createCustomer = customers.create;
export const updateCustomer = customers.update;
export const deleteCustomer = customers.remove;

// ==========================================
// DRIVERS
// ==========================================
const drivers = crudHandlers(prisma.driver, DRIVER_FIELDS, 'driver', 'drivers', { include: { vehicle: true, routes: true } }, 'تم حذف السائق بنجاح.');
export const getDrivers = drivers.list;
export const createDriver = drivers.create;
export const updateDriver = drivers.update;
export const deleteDriver = drivers.remove;

// ==========================================
// VEHICLES
// ==========================================
const vehicles = crudHandlers(prisma.vehicle, VEHICLE_FIELDS, 'vehicle', 'vehicles', { include: { driver: true } }, 'تم حذف المركبة بنجاح.');
export const getVehicles = vehicles.list;
export const createVehicle = vehicles.create;
export const updateVehicle = vehicles.update;
export const deleteVehicle = vehicles.remove;

// ==========================================
// ROUTES
// ==========================================
const routes = crudHandlers(prisma.route, ROUTE_FIELDS, 'route', 'routes', { include: { driver: true } }, 'تم حذف المسار بنجاح.');
export const getRoutes = routes.list;
export const createRoute = routes.create;
export const updateRoute = routes.update;
export const deleteRoute = routes.remove;
