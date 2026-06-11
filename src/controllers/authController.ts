import { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { AuthenticatedRequest } from '../middlewares/auth.js';

const prisma = new PrismaClient();

const DEV_FALLBACK_USERS = [
  { email: 'admin@example.com', password: 'password123', name: 'Admin', role: 'admin' },
  { email: 'sales@example.com', password: 'password123', name: 'Sales', role: 'sales' },
  { email: 'account@example.com', password: 'password123', name: 'Account', role: 'account' },
  { email: 'ops@example.com', password: 'password123', name: 'Ops', role: 'ops' },
  { email: 'finance@example.com', password: 'password123', name: 'Finance', role: 'finance' },
  { email: 'driver@example.com', password: 'password123', name: 'Driver', role: 'driver' }
];

export async function login(req: AuthenticatedRequest, res: Response) {
  const jwtSecret = process.env.JWT_SECRET;
  const enableDevAuthFallback =
    process.env.ENABLE_DEV_AUTH_FALLBACK === 'true' && process.env.NODE_ENV !== 'production';

  if (!jwtSecret) {
    return res.status(500).json({ error: 'JWT_SECRET is not configured on the backend.' });
  }

  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  try {
    const profile = await prisma.profile.findUnique({
      where: { email }
    });

    let isValid = false;
    let userRole = '';
    let userName = '';
    let userId = '';
    let userDriverId: string | null = null;

    // 1. Real password auth: profiles created via /api/users carry a bcrypt hash
    if (profile?.passwordHash) {
      const matches = await bcrypt.compare(String(password), profile.passwordHash);
      if (matches) {
        if (!profile.active) {
          return res.status(403).json({ error: 'هذا الحساب غير مفعل. تواصل مع مدير النظام.' });
        }
        isValid = true;
        userRole = profile.role;
        userName = profile.name;
        userId = profile.id;
        userDriverId = profile.driverId ?? null;
      }
    }

    // 2. Dev fallback — ONLY for profiles without a hash, and never in production
    if (!isValid && profile && !profile.passwordHash && enableDevAuthFallback && password === 'password123') {
      if (!profile.active) {
        return res.status(403).json({ error: 'هذا الحساب غير مفعل. تواصل مع مدير النظام.' });
      }
      isValid = true;
      userRole = profile.role;
      userName = profile.name;
      userId = profile.id;
      userDriverId = profile.driverId ?? null;
    }

    if (!isValid && !profile && enableDevAuthFallback) {
      const fallback = DEV_FALLBACK_USERS.find((user) => user.email === email);
      if (fallback && password === fallback.password) {
        isValid = true;
        userRole = fallback.role;
        userName = fallback.name;
        userId = `dev-fallback-${fallback.role}`;
      }
    }

    if (!isValid) {
      return res.status(401).json({ error: 'البريد الإلكتروني أو كلمة المرور غير صحيحة.' });
    }

    const token = jwt.sign(
      { id: userId, email, role: userRole, name: userName, driverId: userDriverId },
      jwtSecret,
      { expiresIn: '24h' }
    );

    return res.json({
      token,
      user: {
        id: userId,
        email,
        name: userName,
        role: userRole,
        driverId: userDriverId
      }
    });
  } catch (error: any) {
    console.error(error);
    return res.status(500).json({ error: 'Backend login failed.' });
  }
}

export async function getMe(req: AuthenticatedRequest, res: Response) {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }
  return res.json({ user: req.user });
}
