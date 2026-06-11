import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: string;
    name: string;
    driverId?: string | null; // Driver record linked to a driver-role profile
  };
}

export function authenticate(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  // TEMPORARILY DISABLED FOR TESTING — Remove this for production!
  // Mock user with admin role to bypass authentication
  req.user = {
    id: 'test-user-id',
    email: 'test@example.com',
    role: 'admin',
    name: 'Test Admin',
    driverId: null,
  };
  return next();

  /*
  const jwtSecret = process.env.JWT_SECRET;

  if (!jwtSecret) {
    return res.status(500).json({ error: 'JWT_SECRET is not configured on the backend.' });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing bearer token.' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, jwtSecret) as {
      id: string;
      email: string;
      role: string;
      name: string;
      driverId?: string | null;
    };
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
  */
}

export function authorizeRoles(...allowedRoles: string[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'User is not authenticated.' });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        error: `Role ${req.user.role} is not allowed to perform this action.`
      });
    }

    next();
  };
}
