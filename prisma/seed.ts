import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const BCRYPT_ROUNDS = 10;

const prisma = new PrismaClient();

async function main() {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  const name = process.env.ADMIN_NAME?.trim() || 'Admin';

  if (!email || !password) {
    throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD must be set (e.g. in .env) to seed the admin account.');
  }
  if (password.length < 6) {
    throw new Error('ADMIN_PASSWORD must be at least 6 characters.');
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  const admin = await prisma.profile.upsert({
    where: { email },
    update: { name, role: 'admin', passwordHash, active: true },
    create: { email, name, role: 'admin', passwordHash, active: true },
  });

  console.log(`Seeded admin profile: ${admin.email} (role: ${admin.role}, id: ${admin.id})`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
