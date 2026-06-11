import { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthenticatedRequest } from '../middlewares/auth.js';

const prisma = new PrismaClient();

// Helper to calculate order total (including tax and delivery fee)
// Order total = sum(item.qty * item.price) * (1 + order.taxRate/100) + order.deliveryFee
function getOrderTotal(order: any): number {
  const itemsSum = order.items.reduce((sum: number, item: any) => sum + (item.qty * item.price), 0);
  return itemsSum * (1 + (order.taxRate / 100)) + order.deliveryFee;
}

export async function getDashboardStats(req: AuthenticatedRequest, res: Response) {
  try {
    // 1. Fetch all orders with items to calculate stats dynamically
    // In a production app, we would write SQL aggregate queries or use Postgres materialized views
    // to prevent fetching all orders. But for low-to-medium volumes, fetching works fine.
    const allOrders = await prisma.order.findMany({
      include: {
        items: true
      }
    });

    const totalOrdersCount = allOrders.length;
    
    // Status counts
    const statusCounts: Record<string, number> = {
      new: 0,
      confirmed: 0,
      preparing: 0,
      ready: 0,
      out: 0,
      delivered: 0,
      paid: 0,
      cancelled: 0,
      failed: 0
    };

    allOrders.forEach((o: any) => {
      if (statusCounts[o.status] !== undefined) {
        statusCounts[o.status]++;
      }
    });

    // Financial calculations
    let totalRevenue = 0; // delivered & paid
    let pendingPayment = 0; // delivered but not paid to vendor yet
    let totalPaid = 0; // actually paid out to vendors

    allOrders.forEach((o: any) => {
      const total = getOrderTotal(o);
      if (['delivered', 'paid'].includes(o.status)) {
        totalRevenue += total;
      }
      if (o.status === 'delivered') {
        pendingPayment += total;
      }
      if (o.status === 'paid') {
        totalPaid += total;
      }
    });

    // Revenue by vendor
    const vendors = await prisma.vendor.findMany();
    const vendorRevenues = vendors.map((v: any) => {
      const vendorOrders = allOrders.filter((o: any) => o.vendorId === v.id && ['delivered', 'paid'].includes(o.status));
      const rev = vendorOrders.reduce((sum: number, o: any) => sum + getOrderTotal(o), 0);
      return {
        id: v.id,
        name: v.name,
        nameAr: v.nameAr,
        revenue: rev
      };
    }).filter((v: any) => v.revenue > 0);

    // Order trends (past 7 days)
    const datesMap: Record<string, number> = {};
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().slice(0, 10);
      datesMap[dateStr] = 0;
    }

    allOrders.forEach((o: any) => {
      if (datesMap[o.date] !== undefined) {
        datesMap[o.date]++;
      }
    });

    const orderTrends = Object.entries(datesMap).map(([date, count]) => ({
      date,
      count
    }));

    return res.json({
      counts: {
        total: totalOrdersCount,
        ...statusCounts
      },
      financials: {
        totalRevenue,
        pendingPayment,
        totalPaid
      },
      vendorRevenues,
      orderTrends
    });
  } catch (error: any) {
    console.error(error);
    return res.status(500).json({ error: 'حدث خطأ في الخادم أثناء حساب إحصائيات لوحة التحكم.' });
  }
}

// Granular data for the analytics screen (charts + vendor summary table).
export async function getAnalytics(req: AuthenticatedRequest, res: Response) {
  try {
    const [allOrders, vendors, vendorCount] = await Promise.all([
      prisma.order.findMany({
        include: { items: { include: { product: true } } }
      }),
      prisma.vendor.findMany(),
      prisma.vendor.count()
    ]);

    const deliveredOrders = allOrders.filter((o: any) => ['delivered', 'paid'].includes(o.status));
    const totalRevenue = deliveredOrders.reduce((s: number, o: any) => s + getOrderTotal(o), 0);
    const pendingPayment = allOrders
      .filter((o: any) => o.status === 'delivered')
      .reduce((s: number, o: any) => s + getOrderTotal(o), 0);

    // 1. Status distribution
    const statusCounts: Record<string, number> = {};
    allOrders.forEach((o: any) => {
      statusCounts[o.status] = (statusCounts[o.status] || 0) + 1;
    });

    // 2. Vendor summary: revenue chart + the summary table in one payload
    const vendorSummary = vendors.map((v: any) => {
      const vOrders = allOrders.filter((o: any) => o.vendorId === v.id);
      const revenue = vOrders
        .filter((o: any) => ['delivered', 'paid'].includes(o.status))
        .reduce((s: number, o: any) => s + getOrderTotal(o), 0);
      const pending = vOrders
        .filter((o: any) => o.status === 'delivered')
        .reduce((s: number, o: any) => s + getOrderTotal(o), 0);
      return {
        id: v.id,
        name: v.name,
        nameAr: v.nameAr,
        ordersCount: vOrders.length,
        revenue,
        pending,
        payoutTerms: v.payoutTerms
      };
    });

    // 3. Top products by ordered quantity (top 6)
    const productQty: Record<string, { name: string; qty: number }> = {};
    allOrders.forEach((o: any) => {
      o.items.forEach((it: any) => {
        const key = it.productId;
        if (!productQty[key]) {
          productQty[key] = { name: it.product?.nameAr || it.product?.name || key, qty: 0 };
        }
        productQty[key].qty += it.qty;
      });
    });
    const topProducts = Object.values(productQty)
      .sort((a, b) => b.qty - a.qty)
      .slice(0, 6);

    // 4. Orders per month (last 8 months present in data)
    const monthCounts: Record<string, number> = {};
    allOrders.forEach((o: any) => {
      const m = (o.date || '').substring(0, 7);
      if (m) monthCounts[m] = (monthCounts[m] || 0) + 1;
    });
    const monthlyOrders = Object.keys(monthCounts)
      .sort()
      .slice(-8)
      .map((month) => ({ month, count: monthCounts[month] }));

    return res.json({
      stats: {
        totalOrders: allOrders.length,
        deliveredOrders: deliveredOrders.length,
        totalRevenue,
        pendingPayment,
        avgOrderValue: deliveredOrders.length > 0 ? totalRevenue / deliveredOrders.length : 0,
        vendorsCount: vendorCount
      },
      statusCounts,
      vendorSummary,
      topProducts,
      monthlyOrders
    });
  } catch (error: any) {
    console.error(error);
    return res.status(500).json({ error: 'حدث خطأ في الخادم أثناء حساب بيانات التحليلات.' });
  }
}
