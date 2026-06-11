/**
 * migrate-blob-to-prisma.ts — one-time migration of the legacy single-JSON-blob
 * (Supabase `oms_data`, id='main') into the normalized Prisma/Postgres schema.
 *
 * Same DB as Supabase → blob is read directly via Prisma $queryRaw.
 * Re-run safe: WIPE-AND-RELOAD in one transaction (profiles/auth untouched).
 * Orphan line items (productId deleted) are skipped+logged; orders missing a
 * required customer/vendor are skipped+logged.
 *
 *   cd backend
 *   npx tsx scripts/migrate-blob-to-prisma.ts            # execute
 *   npx tsx scripts/migrate-blob-to-prisma.ts --dry-run  # report only
 */
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();
const DRY_RUN = process.argv.includes('--dry-run');

type Blob = {
  vendors?: any[]; products?: any[]; customers?: any[]; drivers?: any[];
  vehicles?: any[]; routes?: any[]; orders?: any[];
};

function toDateOrNull(v: any): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

async function loadBlob(): Promise<Blob> {
  const rows = await prisma.$queryRaw<{ data: Blob }[]>`
    SELECT data FROM public.oms_data WHERE id = 'main' LIMIT 1
  `;
  if (!rows.length) throw new Error('No oms_data row with id=main found.');
  return rows[0].data ?? {};
}

async function wipe(tx: Prisma.TransactionClient) {
  // children → parents; break driver⇄vehicle cycle by nulling cross-refs first
  await tx.orderItem.deleteMany({});
  await tx.order.deleteMany({});
  await tx.route.deleteMany({});
  await tx.driver.updateMany({ data: { vehicleId: null } });
  await tx.vehicle.updateMany({ data: { driverId: null } });
  await tx.vehicle.deleteMany({});
  await tx.driver.deleteMany({});
  await tx.product.deleteMany({});
  await tx.customer.deleteMany({});
  await tx.vendor.deleteMany({});
}

async function main() {
  const blob = await loadBlob();
  const vendors   = blob.vendors   ?? [];
  const products  = blob.products  ?? [];
  const customers = blob.customers ?? [];
  const drivers   = blob.drivers   ?? [];
  const vehicles  = blob.vehicles  ?? [];
  const routes    = blob.routes    ?? [];
  const orders    = blob.orders    ?? [];

  const productIds  = new Set(products.map((p: any) => p.id));
  const customerIds = new Set(customers.map((c: any) => c.id));
  const vendorIds   = new Set(vendors.map((v: any) => v.id));
  const driverIds   = new Set(drivers.map((d: any) => d.id));
  const vehicleIds  = new Set(vehicles.map((v: any) => v.id));
  const routeIds    = new Set(routes.map((r: any) => r.id));

  const skippedItems: { orderNumber: string; productId: string }[] = [];
  const skippedOrders: { orderNumber: string; reason: string }[] = [];

  console.log('Parsed blob:', {
    vendors: vendors.length, products: products.length, customers: customers.length,
    drivers: drivers.length, vehicles: vehicles.length, routes: routes.length,
    orders: orders.length,
  });

  if (DRY_RUN) {
    for (const o of orders) {
      if (!customerIds.has(o.customerId)) skippedOrders.push({ orderNumber: o.orderNumber, reason: `missing customer ${o.customerId}` });
      else if (!vendorIds.has(o.vendorId)) skippedOrders.push({ orderNumber: o.orderNumber, reason: `missing vendor ${o.vendorId}` });
      for (const li of (o.products ?? [])) if (!productIds.has(li.productId)) skippedItems.push({ orderNumber: o.orderNumber, productId: li.productId });
    }
    console.log(`DRY RUN — would skip ${skippedOrders.length} orders, ${skippedItems.length} orphan line items`);
    console.table(skippedOrders); console.table(skippedItems);
    return;
  }

  await prisma.$transaction(async (tx) => {
    await wipe(tx);

    // 1) Vendors  (blob vendor.location dropped — no column)
    for (const v of vendors) {
      await tx.vendor.create({ data: {
        id: v.id, name: v.name, nameAr: v.nameAr, phone: v.phone, email: v.email,
        address: v.address, bankName: v.bankName, iban: v.iban,
        accountNumber: v.accountNumber, accountHolder: v.accountHolder,
        payoutTerms: Number(v.payoutTerms ?? 0), notes: v.notes ?? null,
      }});
    }

    // 2) Products (FK vendorId)
    for (const p of products) {
      await tx.product.create({ data: {
        id: p.id, name: p.name, nameAr: p.nameAr, category: p.category,
        price: Number(p.price ?? 0), unit: p.unit, stock: Number(p.stock ?? 0),
        description: p.description ?? null, vendorId: p.vendorId,
      }});
    }

    // 3) Customers (location + address required)
    for (const c of customers) {
      await tx.customer.create({ data: {
        id: c.id, name: c.name, phone: c.phone, email: c.email,
        address: c.address ?? '', location: c.location ?? {}, notes: c.notes ?? null,
      }});
    }

    // 4) Drivers — WITHOUT vehicleId (break cycle)
    for (const d of drivers) {
      await tx.driver.create({ data: {
        id: d.id, name: d.name, phone: d.phone,
        status: d.status ?? 'active', notes: d.notes ?? null,
      }});
    }

    // 5) Vehicles — WITH driverId (null if dangling)
    for (const ve of vehicles) {
      await tx.vehicle.create({ data: {
        id: ve.id, plate: ve.plate, type: ve.type, model: ve.model, color: ve.color,
        status: ve.status ?? 'active', notes: ve.notes ?? null,
        driverId: ve.driverId && driverIds.has(ve.driverId) ? ve.driverId : null,
      }});
    }

    // 6) Back-fill driver.vehicleId (unique 1:1)
    for (const d of drivers) {
      if (d.vehicleId && vehicleIds.has(d.vehicleId)) {
        await tx.driver.update({ where: { id: d.id }, data: { vehicleId: d.vehicleId } });
      }
    }

    // 7) Routes (FK driverId)
    for (const r of routes) {
      await tx.route.create({ data: {
        id: r.id, name: r.name, area: r.area,
        description: r.description ?? null, notes: r.notes ?? null,
        driverId: r.driverId && driverIds.has(r.driverId) ? r.driverId : null,
      }});
    }

    // 8) Orders + nested OrderItems
    for (const o of orders) {
      if (!customerIds.has(o.customerId)) { skippedOrders.push({ orderNumber: o.orderNumber, reason: `missing customer ${o.customerId}` }); continue; }
      if (!vendorIds.has(o.vendorId))     { skippedOrders.push({ orderNumber: o.orderNumber, reason: `missing vendor ${o.vendorId}` }); continue; }

      const items = (o.products ?? [])
        .filter((li: any) => {
          const ok = productIds.has(li.productId);
          if (!ok) skippedItems.push({ orderNumber: o.orderNumber, productId: li.productId });
          return ok;
        })
        .map((li: any) => ({ qty: Number(li.qty ?? 0), price: Number(li.price ?? 0), productId: li.productId }));

      await tx.order.create({ data: {
        id: o.id,
        orderNumber: o.orderNumber,
        date: o.date ?? o.orderDate ?? new Date().toISOString().slice(0, 10),
        status: o.status ?? 'new',
        deliveryAddress: o.deliveryAddress ?? '',
        location: o.location ?? {},
        deliveryFee: Number(o.deliveryFee ?? 0),
        taxRate: Number(o.taxRate ?? 5),
        notes: o.notes ?? null,
        paymentProof: o.paymentProof ?? null,
        failureReason: o.failureReason ?? null,
        confirmedAt: toDateOrNull(o.confirmedAt),
        preparedAt: toDateOrNull(o.preparedAt),
        deliveredAt: toDateOrNull(o.deliveredAt),
        paidAt: toDateOrNull(o.paidAt),
        customerId: o.customerId,
        vendorId: o.vendorId,
        driverId: o.driverId && driverIds.has(o.driverId) ? o.driverId : null,
        vehicleId: o.vehicleId && vehicleIds.has(o.vehicleId) ? o.vehicleId : null,
        routeId: o.routeId && routeIds.has(o.routeId) ? o.routeId : null,
        updatedById: null, // blob has no updatedBy; FK → profiles
        items: { create: items },
      }});
    }
  }, { timeout: 120_000 });

  console.log(`Migration complete. Skipped ${skippedOrders.length} orders, ${skippedItems.length} orphan line items.`);
  if (skippedOrders.length) console.table(skippedOrders);
  if (skippedItems.length)  console.table(skippedItems);
}

main()
  .catch((e) => { console.error('Migration failed:', e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
