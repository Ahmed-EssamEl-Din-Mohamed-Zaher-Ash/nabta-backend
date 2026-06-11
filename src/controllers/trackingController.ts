import { Response, Request } from 'express';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import { AuthenticatedRequest } from '../middlewares/auth.js';

const prisma = new PrismaClient();

// Polling-based REST tracking (replaces the old Supabase realtime bridge).
// Flow:
//  - the driver app POSTs /api/tracking/ping {orderId, lat, lng, ...} every N seconds;
//    the first ping auto-creates an active TrackingSession for the order.
//  - the ops map GETs /api/tracking/active every N seconds for all live positions.
//  - POST /api/tracking/end {orderId} closes the session (delivery finished).
//  - GET /api/tracking/public/:topic is unauthenticated: customers follow their
//    order through the unguessable publicTopic UUID only.

const STALE_AFTER_MS = 90 * 1000; // latest ping older than this → 'stale'

function locationState(recordedAt: Date): 'live' | 'stale' {
  return Date.now() - new Date(recordedAt).getTime() > STALE_AFTER_MS ? 'stale' : 'live';
}

export async function ping(req: AuthenticatedRequest, res: Response) {
  const { orderId, lat, lng, accuracy, speed, heading } = req.body;

  const latNum = Number(lat);
  const lngNum = Number(lng);
  if (!orderId || Number.isNaN(latNum) || Number.isNaN(lngNum)) {
    return res.status(400).json({ error: 'orderId و lat و lng حقول مطلوبة.' });
  }
  if (latNum < -90 || latNum > 90 || lngNum < -180 || lngNum > 180) {
    return res.status(400).json({ error: 'إحداثيات غير صالحة.' });
  }

  try {
    const order = await prisma.order.findUnique({ where: { id: String(orderId) } });
    if (!order) {
      return res.status(404).json({ error: 'الطلب غير موجود.' });
    }
    if (order.status !== 'out') {
      return res.status(400).json({ error: 'التتبع متاح فقط للطلبات التي في الطريق.' });
    }

    const driverRef = order.driverId || req.user?.driverId || req.user?.id || 'unknown';

    // Drivers may only ping orders assigned to their linked Driver record.
    // Unassigned orders stay pingable by any driver (matches legacy behavior).
    if (
      req.user?.role === 'driver' &&
      order.driverId &&
      order.driverId !== req.user.driverId
    ) {
      return res.status(403).json({ error: 'هذا الطلب غير مخصص لك.' });
    }

    // Find or create the active session for this order
    let session = await prisma.trackingSession.findFirst({
      where: { orderRef: order.id, status: 'active' },
    });

    if (!session) {
      session = await prisma.trackingSession.create({
        data: {
          orderRef: order.id,
          orderNumber: order.orderNumber,
          driverRef,
          vehicleRef: order.vehicleId,
          status: 'active',
          publicTopic: randomUUID(),
          startedAt: new Date(),
        },
      });
    }

    const recordedAt = new Date();
    const pingData = {
      driverRef: session.driverRef,
      vehicleRef: session.vehicleRef,
      lat: latNum,
      lng: lngNum,
      accuracy: accuracy != null ? Number(accuracy) : null,
      speed: speed != null ? Number(speed) : null,
      heading: heading != null ? Number(heading) : null,
      recordedAt,
    };

    const [, latest] = await Promise.all([
      prisma.vehicleLocationPing.create({
        data: { ...pingData, sessionId: session.id },
      }),
      prisma.vehicleLatestLocation.upsert({
        where: { sessionId: session.id },
        create: { ...pingData, sessionId: session.id },
        update: pingData,
      }),
    ]);

    return res.json({
      session: {
        id: session.id,
        orderRef: session.orderRef,
        orderNumber: session.orderNumber,
        publicTopic: session.publicTopic,
      },
      latest,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'حدث خطأ أثناء تسجيل الموقع.' });
  }
}

export async function endTracking(req: AuthenticatedRequest, res: Response) {
  const { orderId } = req.body;
  if (!orderId) {
    return res.status(400).json({ error: 'orderId مطلوب.' });
  }

  try {
    const result = await prisma.trackingSession.updateMany({
      where: { orderRef: String(orderId), status: 'active' },
      data: { status: 'ended', endedAt: new Date() },
    });
    return res.json({ ended: result.count });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'حدث خطأ أثناء إنهاء جلسة التتبع.' });
  }
}

export async function getActiveSessions(req: AuthenticatedRequest, res: Response) {
  try {
    const sessions = await prisma.trackingSession.findMany({
      where: { status: 'active' },
      include: { latest: true },
      orderBy: { createdAt: 'desc' },
    });

    // Enrich with order/driver context for popups on the ops map
    const orderIds = sessions.map((s: any) => s.orderRef);
    const orders = orderIds.length
      ? await prisma.order.findMany({
          where: { id: { in: orderIds } },
          include: { customer: true, driver: true, vehicle: true },
        })
      : [];
    const orderById = new Map(orders.map((o: any) => [o.id, o]));

    const result = sessions
      .filter((s: any) => s.latest)
      .map((s: any) => {
        const order: any = orderById.get(s.orderRef);
        return {
          sessionId: s.id,
          orderId: s.orderRef,
          orderNumber: s.orderNumber || order?.orderNumber || null,
          customerName: order?.customer?.name || null,
          driverName: order?.driver?.name || null,
          vehiclePlate: order?.vehicle?.plate || null,
          lat: s.latest.lat,
          lng: s.latest.lng,
          speed: s.latest.speed,
          heading: s.latest.heading,
          recordedAt: s.latest.recordedAt,
          state: locationState(s.latest.recordedAt),
        };
      });

    return res.json({ locations: result });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'حدث خطأ أثناء جلب مواقع المركبات.' });
  }
}

// Public endpoint — NO auth. The unguessable topic UUID is the credential.
// Exposes only what the customer needs: where is my order right now.
export async function getPublicLocation(req: Request, res: Response) {
  const { topic } = req.params;
  if (!topic || !/^[a-zA-Z0-9_-]{8,64}$/.test(topic)) {
    return res.status(400).json({ error: 'رابط تتبع غير صالح.' });
  }

  try {
    const session = await prisma.trackingSession.findUnique({
      where: { publicTopic: topic },
      include: { latest: true },
    });

    if (!session) {
      return res.status(404).json({ error: 'جلسة التتبع غير موجودة.' });
    }

    return res.json({
      orderNumber: session.orderNumber,
      status: session.status,
      latest: session.latest
        ? {
            lat: session.latest.lat,
            lng: session.latest.lng,
            recordedAt: session.latest.recordedAt,
            state: locationState(session.latest.recordedAt),
          }
        : null,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'حدث خطأ أثناء جلب موقع الطلب.' });
  }
}
