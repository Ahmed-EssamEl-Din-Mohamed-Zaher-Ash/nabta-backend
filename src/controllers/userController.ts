import { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { AuthenticatedRequest } from '../middlewares/auth.js';

const prisma = new PrismaClient();

const STAFF_ROLES = ['admin', 'sales', 'account', 'ops', 'finance', 'driver'];
const BCRYPT_ROUNDS = 10;
const MIN_PASSWORD_LENGTH = 6;

// Never return passwordHash to any client — always select explicitly.
const SAFE_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  active: true,
  driverId: true,
  createdAt: true,
} as const;

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export async function getUsers(req: AuthenticatedRequest, res: Response) {
  try {
    const users = await prisma.profile.findMany({
      select: SAFE_SELECT,
      orderBy: { createdAt: 'desc' },
    });
    return res.json({ users });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'حدث خطأ أثناء جلب المستخدمين.' });
  }
}

export async function createUser(req: AuthenticatedRequest, res: Response) {
  const { name, email, password, role, active } = req.body;

  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'الاسم مطلوب.' });
  }
  if (!email || !isValidEmail(String(email))) {
    return res.status(400).json({ error: 'البريد الإلكتروني غير صالح.' });
  }
  if (!password || String(password).length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `كلمة المرور مطلوبة (${MIN_PASSWORD_LENGTH} أحرف على الأقل).` });
  }
  if (!role || !STAFF_ROLES.includes(role)) {
    return res.status(400).json({ error: 'الدور الوظيفي غير صالح.' });
  }

  try {
    const passwordHash = await bcrypt.hash(String(password), BCRYPT_ROUNDS);
    const user = await prisma.profile.create({
      data: {
        name: String(name).trim(),
        email: String(email).trim().toLowerCase(),
        passwordHash,
        role,
        active: active === undefined ? true : active === true || active === 'true',
      },
      select: SAFE_SELECT,
    });
    return res.status(201).json({ user });
  } catch (error: any) {
    if (error?.code === 'P2002') {
      return res.status(409).json({ error: 'البريد الإلكتروني مستخدم بالفعل.' });
    }
    console.error(error);
    return res.status(500).json({ error: 'حدث خطأ أثناء إنشاء المستخدم.' });
  }
}

export async function updateUser(req: AuthenticatedRequest, res: Response) {
  const { id } = req.params;
  const { name, email, password, role, active } = req.body;

  // An admin must not lock themselves out of administration
  if (id === req.user?.id) {
    if ((role !== undefined && role !== 'admin') || active === false || active === 'false') {
      return res.status(400).json({ error: 'لا يمكنك تعطيل حسابك أو تغيير صلاحياتك الحالية.' });
    }
  }

  const data: any = {};
  if (name !== undefined) {
    if (!String(name).trim()) return res.status(400).json({ error: 'الاسم مطلوب.' });
    data.name = String(name).trim();
  }
  if (email !== undefined) {
    if (!isValidEmail(String(email))) return res.status(400).json({ error: 'البريد الإلكتروني غير صالح.' });
    data.email = String(email).trim().toLowerCase();
  }
  if (role !== undefined) {
    if (!STAFF_ROLES.includes(role)) return res.status(400).json({ error: 'الدور الوظيفي غير صالح.' });
    data.role = role;
  }
  if (active !== undefined) {
    data.active = active === true || active === 'true';
  }
  // Password only changes when explicitly provided — absent/empty keeps the old hash
  if (password !== undefined && String(password).length > 0) {
    if (String(password).length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: `كلمة المرور يجب ألا تقل عن ${MIN_PASSWORD_LENGTH} أحرف.` });
    }
    data.passwordHash = await bcrypt.hash(String(password), BCRYPT_ROUNDS);
  }

  try {
    const user = await prisma.profile.update({
      where: { id },
      data,
      select: SAFE_SELECT,
    });
    return res.json({ user });
  } catch (error: any) {
    if (error?.code === 'P2002') {
      return res.status(409).json({ error: 'البريد الإلكتروني مستخدم بالفعل.' });
    }
    if (error?.code === 'P2025') {
      return res.status(404).json({ error: 'المستخدم غير موجود.' });
    }
    console.error(error);
    return res.status(500).json({ error: 'حدث خطأ أثناء تعديل المستخدم.' });
  }
}

export async function deleteUser(req: AuthenticatedRequest, res: Response) {
  const { id } = req.params;

  if (id === req.user?.id) {
    return res.status(400).json({ error: 'لا يمكنك حذف حسابك الحالي.' });
  }

  try {
    await prisma.profile.delete({ where: { id } });
    return res.json({ message: 'تم حذف المستخدم بنجاح.' });
  } catch (error: any) {
    if (error?.code === 'P2025') {
      return res.status(404).json({ error: 'المستخدم غير موجود.' });
    }
    console.error(error);
    return res.status(500).json({ error: 'حدث خطأ أثناء حذف المستخدم.' });
  }
}
