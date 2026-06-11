import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { authenticate, authorizeRoles } from './middlewares/auth.js';
import * as authController from './controllers/authController.js';
import * as orderController from './controllers/orderController.js';
import * as reportController from './controllers/reportController.js';
import * as crudController from './controllers/crudController.js';
import * as trackingController from './controllers/trackingController.js';
import * as userController from './controllers/userController.js';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 4000;
const isProduction = process.env.NODE_ENV === 'production';

// Behind a reverse proxy (Render/Railway/DO App Platform) so req.ip & secure cookies work
app.set('trust proxy', 1);

// CORS: explicit allowlist from env (comma-separated), permissive only in dev
const allowedOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // Allow non-browser tools (no Origin header) and same-origin requests
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      if (!isProduction && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) {
        return callback(null, true);
      }
      return callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);
app.use(express.json({ limit: '1mb' }));

// Health Check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

// ==========================================
// 1. AUTHENTICATION ROUTES
// ==========================================
app.post('/api/auth/login', authController.login);
app.get('/api/auth/me', authenticate, authController.getMe);

// ==========================================
// 2. ORDER MANAGEMENT ROUTES
// ==========================================
app.get('/api/orders', authenticate, orderController.getOrders);
app.get('/api/orders/:id', authenticate, orderController.getOrderById);
app.post('/api/orders', authenticate, authorizeRoles('sales', 'admin'), orderController.createOrder);
app.put('/api/orders/:id', authenticate, authorizeRoles('sales', 'admin'), orderController.updateOrder);
app.patch('/api/orders/:id/status', authenticate, orderController.updateOrderStatus);

// ==========================================
// 3. VENDORS CRUD
// ==========================================
app.get('/api/vendors', authenticate, crudController.getVendors);
app.post('/api/vendors', authenticate, authorizeRoles('admin'), crudController.createVendor);
app.put('/api/vendors/:id', authenticate, authorizeRoles('admin'), crudController.updateVendor);
app.delete('/api/vendors/:id', authenticate, authorizeRoles('admin'), crudController.deleteVendor);

// ==========================================
// 4. PRODUCTS CRUD
// ==========================================
app.get('/api/products', authenticate, crudController.getProducts);
app.post('/api/products', authenticate, authorizeRoles('admin'), crudController.createProduct);
app.put('/api/products/:id', authenticate, authorizeRoles('admin'), crudController.updateProduct);
app.delete('/api/products/:id', authenticate, authorizeRoles('admin'), crudController.deleteProduct);

// ==========================================
// 5. CUSTOMERS CRUD
// ==========================================
app.get('/api/customers', authenticate, crudController.getCustomers);
app.post('/api/customers', authenticate, authorizeRoles('admin', 'sales'), crudController.createCustomer);
app.put('/api/customers/:id', authenticate, authorizeRoles('admin', 'sales'), crudController.updateCustomer);
app.delete('/api/customers/:id', authenticate, authorizeRoles('admin'), crudController.deleteCustomer);

// ==========================================
// 6. DRIVERS CRUD
// ==========================================
app.get('/api/drivers', authenticate, crudController.getDrivers);
app.post('/api/drivers', authenticate, authorizeRoles('admin', 'ops'), crudController.createDriver);
app.put('/api/drivers/:id', authenticate, authorizeRoles('admin', 'ops'), crudController.updateDriver);
app.delete('/api/drivers/:id', authenticate, authorizeRoles('admin'), crudController.deleteDriver);

// ==========================================
// 7. VEHICLES CRUD
// ==========================================
app.get('/api/vehicles', authenticate, crudController.getVehicles);
app.post('/api/vehicles', authenticate, authorizeRoles('admin', 'ops'), crudController.createVehicle);
app.put('/api/vehicles/:id', authenticate, authorizeRoles('admin', 'ops'), crudController.updateVehicle);
app.delete('/api/vehicles/:id', authenticate, authorizeRoles('admin'), crudController.deleteVehicle);

// ==========================================
// 8. ROUTES CRUD
// ==========================================
app.get('/api/routes', authenticate, crudController.getRoutes);
app.post('/api/routes', authenticate, authorizeRoles('admin', 'ops'), crudController.createRoute);
app.put('/api/routes/:id', authenticate, authorizeRoles('admin', 'ops'), crudController.updateRoute);
app.delete('/api/routes/:id', authenticate, authorizeRoles('admin'), crudController.deleteRoute);

// ==========================================
// 9. ANALYTICS & REPORTS
// ==========================================
app.get('/api/reports/dashboard', authenticate, authorizeRoles('admin', 'finance', 'sales', 'account'), reportController.getDashboardStats);
app.get('/api/reports/analytics', authenticate, authorizeRoles('admin', 'finance', 'sales', 'account'), reportController.getAnalytics);

// ==========================================
// 10. USERS / ROLES MANAGEMENT (admin only)
// ==========================================
app.get('/api/users', authenticate, authorizeRoles('admin'), userController.getUsers);
app.post('/api/users', authenticate, authorizeRoles('admin'), userController.createUser);
app.put('/api/users/:id', authenticate, authorizeRoles('admin'), userController.updateUser);
app.delete('/api/users/:id', authenticate, authorizeRoles('admin'), userController.deleteUser);

// ==========================================
// 11. LIVE TRACKING (polling-based REST)
// ==========================================
app.post('/api/tracking/ping', authenticate, authorizeRoles('driver', 'ops', 'admin'), trackingController.ping);
app.post('/api/tracking/end', authenticate, authorizeRoles('driver', 'ops', 'admin'), trackingController.endTracking);
app.get('/api/tracking/active', authenticate, trackingController.getActiveSessions);
app.get('/api/tracking/public/:topic', trackingController.getPublicLocation);

// 404 for unknown API routes (instead of HTML default)
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'المسار غير موجود.' });
});

// Error Handling Middleware
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err.message?.includes('not allowed by CORS')) {
    return res.status(403).json({ error: 'Origin not allowed.' });
  }
  console.error(err.stack);
  // Never leak stack traces in production
  res.status(500).json({
    error: 'حدث خطأ داخلي في الخادم.',
    ...(isProduction ? {} : { detail: err.message }),
  });
});

// Start Server — bind 0.0.0.0 so the platform's proxy can reach the container
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running in ${isProduction ? 'production' : 'development'} mode on port ${PORT}`);
});
