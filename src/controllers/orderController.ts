import { Response } from 'express';
import { PrismaClient, Prisma } from '@prisma/client';
import { AuthenticatedRequest } from '../middlewares/auth.js';

const prisma = new PrismaClient();

// Definition of valid status flows and authorization roles for transitions
interface StatusTransition {
  next: string | null;
  roles: string[];
}

const STATUS_FLOW: Record<string, StatusTransition> = {
  new: { next: 'confirmed', roles: ['sales', 'admin'] },
  confirmed: { next: 'preparing', roles: ['account', 'admin'] },
  preparing: { next: 'ready', roles: ['account', 'admin'] },
  ready: { next: 'out', roles: ['ops', 'admin'] },
  out: { next: 'delivered', roles: ['ops', 'admin'] }, // can also go to 'failed' handled explicitly
  delivered: { next: 'paid', roles: ['finance', 'admin'] },
  paid: { next: null, roles: [] }
};

export async function getOrders(req: AuthenticatedRequest, res: Response) {
  const { status, vendorId, driverId, search, page = '1', limit = '20' } = req.query;

  const pageNum = parseInt(page as string, 10);
  const limitNum = parseInt(limit as string, 10);
  const skip = (pageNum - 1) * limitNum;

  // Build filters dynamically
  const where: any = {};

  if (status) where.status = status as string;
  if (vendorId) where.vendorId = vendorId as string;
  if (driverId) where.driverId = driverId as string;

  if (search) {
    where.OR = [
      { orderNumber: { contains: search as string, mode: 'insensitive' } },
      { deliveryAddress: { contains: search as string, mode: 'insensitive' } },
      { customer: { name: { contains: search as string, mode: 'insensitive' } } }
    ];
  }

  // Role-based scoping of visible orders.
  // Driver only sees orders assigned to their linked Driver record
  // (Profile.driverId); an unlinked driver profile sees nothing.
  if (req.user?.role === 'driver') {
    where.driverId = req.user.driverId || req.user.id;
  }
  // Sales only sees their created/updated orders if required (or all orders for now, depending on rules)
  // Let's keep it as all orders for other staff, but filtered by role permissions in the app

  try {
    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        include: {
          customer: true,
          vendor: true,
          driver: true,
          vehicle: true,
          route: true,
          items: {
            include: {
              product: true
            }
          }
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limitNum
      }),
      prisma.order.count({ where })
    ]);

    return res.json({
      orders,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum)
      }
    });
  } catch (error: any) {
    console.error(error);
    return res.status(500).json({ error: 'حدث خطأ أثناء جلب الطلبات.' });
  }
}

export async function getOrderById(req: AuthenticatedRequest, res: Response) {
  const { id } = req.params;

  try {
    const order = await prisma.order.findUnique({
      where: { id },
      include: {
        customer: true,
        vendor: true,
        driver: true,
        vehicle: true,
        route: true,
        items: {
          include: {
            product: true
          }
        }
      }
    });

    if (!order) {
      return res.status(404).json({ error: 'الطلب غير موجود.' });
    }

    // Drivers may only view orders assigned to their linked Driver record
    // (same scoping rule as getOrders above).
    if (req.user?.role === 'driver' && order.driverId !== (req.user.driverId || req.user.id)) {
      return res.status(403).json({ error: 'ليس لديك صلاحية لعرض هذا الطلب.' });
    }

    return res.json({ order });
  } catch (error) {
    return res.status(500).json({ error: 'حدث خطأ أثناء جلب تفاصيل الطلب.' });
  }
}

export async function createOrder(req: AuthenticatedRequest, res: Response) {
  const {
    customerId,
    vendorId,
    products, // array of { productId, qty }
    deliveryAddress,
    location,
    deliveryFee = 0,
    taxRate = 5,
    notes
  } = req.body;

  if (!customerId || !vendorId || !products || !Array.isArray(products) || products.length === 0) {
    return res.status(400).json({ error: 'البيانات المدخلة للطلب غير مكتملة.' });
  }

  try {
    // Generate unique order number (e.g. ORD-YYYYMMDD-XXXX)
    const count = await prisma.order.count();
    const orderNumber = `ORD-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${(count + 1).toString().padStart(4, '0')}`;

    // Execute in a transaction to guarantee stock consistency
    const newOrder = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // 1. Validate and fetch product prices
      const itemsToCreate = [];

      for (const item of products) {
        const prod = await tx.product.findUnique({
          where: { id: item.productId }
        });

        if (!prod) {
          throw new Error(`المنتج ذو المعرف ${item.productId} غير موجود.`);
        }

        if (prod.stock < item.qty) {
          throw new Error(`الكمية المطلوبة من "${prod.nameAr}" غير متوفرة في المخزن (المتوفر: ${prod.stock}).`);
        }

        // Deduct stock
        await tx.product.update({
          where: { id: prod.id },
          data: { stock: prod.stock - item.qty }
        });

        itemsToCreate.push({
          productId: prod.id,
          qty: item.qty,
          price: prod.price // Save historical price
        });
      }

      // 2. Create the order
      const order = await tx.order.create({
        data: {
          orderNumber,
          date: new Date().toISOString().slice(0, 10),
          status: 'new',
          deliveryAddress,
          location,
          deliveryFee,
          taxRate,
          notes,
          customerId,
          vendorId,
          updatedById: req.user?.id || null,
          items: {
            create: itemsToCreate
          }
        },
        include: {
          items: true
        }
      });

      return order;
    });

    return res.status(201).json({ order: newOrder });
  } catch (error: any) {
    console.error(error);
    return res.status(400).json({ error: error.message || 'فشلت عملية إنشاء الطلب.' });
  }
}

// Whitelist for PUT /api/orders/:id — status/orderNumber/items only move
// through their dedicated flows, and nothing outside this list is writable.
const ORDER_UPDATE_FIELDS = [
  'customerId', 'vendorId', 'driverId', 'vehicleId', 'routeId',
  'deliveryAddress', 'location', 'deliveryFee', 'taxRate', 'notes'
] as const;

export async function updateOrder(req: AuthenticatedRequest, res: Response) {
  const { id } = req.params;

  try {
    const existing = await prisma.order.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: 'الطلب غير موجود.' });
    }

    const data: any = {};
    for (const field of ORDER_UPDATE_FIELDS) {
      if (req.body[field] === undefined) continue;
      let value = req.body[field];
      if (['driverId', 'vehicleId', 'routeId'].includes(field) && value === '') value = null;
      if (['deliveryFee', 'taxRate'].includes(field)) value = Number(value) || 0;
      data[field] = value;
    }

    const updated = await prisma.order.update({
      where: { id },
      data: {
        ...data,
        updatedById: req.user?.id || null
      }
    });

    return res.json({ order: updated });
  } catch (error) {
    return res.status(500).json({ error: 'حدث خطأ أثناء تعديل الطلب.' });
  }
}

export async function updateOrderStatus(req: AuthenticatedRequest, res: Response) {
  const { id } = req.params;
  const { status, failureReason, paymentProof, driverId, vehicleId, routeId } = req.body;
  const userRole = req.user?.role || '';

  try {
    const order = await prisma.order.findUnique({
      where: { id },
      include: { items: true }
    });

    if (!order) {
      return res.status(404).json({ error: 'الطلب غير موجود.' });
    }

    const currentStatus = order.status;

    // Validate transition
    if (status === 'failed') {
      // Transitioning to 'failed' is allowed from 'out' or 'ready' by ops, driver, or admin
      if (!['out', 'ready'].includes(currentStatus)) {
        return res.status(400).json({ error: 'يمكن فقط تحويل الطلب إلى "فاشل" إذا كان قيد التوصيل أو جاهزاً.' });
      }
      if (!['ops', 'driver', 'admin'].includes(userRole)) {
        return res.status(403).json({ error: 'ليس لديك صلاحية لإفشال هذا الطلب.' });
      }
    } else if (status === 'cancelled') {
      // Transitioning to 'cancelled' is allowed from 'new' by sales or admin
      if (currentStatus !== 'new') {
        return res.status(400).json({ error: 'يمكن إلغاء الطلبات الجديدة فقط.' });
      }
      if (!['sales', 'admin'].includes(userRole)) {
        return res.status(403).json({ error: 'ليس لديك صلاحية لإلغاء هذا الطلب.' });
      }

      // Return items back to stock
      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        for (const item of order.items) {
          await tx.product.update({
            where: { id: item.productId },
            data: { stock: { increment: item.qty } }
          });
        }
      });
    } else {
      // Standard flow check
      const rule = STATUS_FLOW[currentStatus];
      if (!rule || rule.next !== status) {
        return res.status(400).json({
          error: `انتقال غير صالح من حالة ${currentStatus} إلى حالة ${status}.`
        });
      }

      if (!rule.roles.includes(userRole)) {
        return res.status(403).json({
          error: `دورك الوظيفي (${userRole}) لا يسمح لك بترقية حالة الطلب إلى ${status}.`
        });
      }
    }

    // Set transition timestamps
    const updateData: any = {
      status,
      updatedById: req.user?.id || null
    };

    if (status === 'confirmed') {
      updateData.confirmedAt = new Date();
      // Optional auto-assignment could be set here
    } else if (status === 'preparing') {
      updateData.preparedAt = new Date();
    } else if (status === 'ready') {
      updateData.readyAt = new Date();
    } else if (status === 'out') {
      updateData.dispatchedAt = new Date();
    } else if (status === 'delivered') {
      updateData.deliveredAt = new Date();
    } else if (status === 'paid') {
      updateData.paidAt = new Date();
      if (paymentProof) updateData.paymentProof = paymentProof;
    }

    if (status === 'failed' && failureReason) {
      updateData.failureReason = failureReason;
    }

    // Assignment updates if provided during status progression
    if (driverId) updateData.driverId = driverId;
    if (vehicleId) updateData.vehicleId = vehicleId;
    if (routeId) updateData.routeId = routeId;

    const updated = await prisma.order.update({
      where: { id },
      data: updateData
    });

    return res.json({ order: updated });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'حدث خطأ أثناء تحديث حالة الطلب.' });
  }
}
