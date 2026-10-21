import express from 'express';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { db } from '../data/store.js';
import { generateToken, protect } from '../middleware/auth.js';
import { User, Customer } from '../models/index.js';

const router = express.Router();

const generateRefreshToken = (userId) => {
  const token = `rt_${Date.now()}_${crypto.randomBytes(32).toString('hex')}`;
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  db.refreshTokens.add({
    token,
    userId,
    expiresAt,
    revoked: false,
    createdAt: new Date().toISOString()
  });
  return token;
};

// POST /api/v1/auth/register
router.post('/register', async (req, res) => {
  try {
    const { name, email, password, role = 'advisor', phone = '', specialty = '' } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Full name is required' });
    }
    if (!email || !email.trim()) {
      return res.status(400).json({ success: false, message: 'Email address is required' });
    }
    if (!password || password.length < 4) {
      return res.status(400).json({ success: false, message: 'Password must be at least 4 characters long' });
    }

    const cleanEmail = email.toLowerCase().trim();
    const cleanName = name.trim();
    const validRoles = ['advisor', 'technician', 'manager', 'customer', 'parts', 'accounting', 'admin'];
    const userRole = validRoles.includes(role?.toLowerCase()) ? role.toLowerCase() : 'advisor';

    // Check if user already exists
    let existingUser = db.users.findOne(u => u.email.toLowerCase() === cleanEmail);
    if (!existingUser && mongoose.connection.readyState === 1) {
      try {
        existingUser = await User.findOne({ email: cleanEmail });
      } catch (err) {
        console.warn('MongoDB duplicate check warning:', err.message);
      }
    }

    if (existingUser) {
      return res.status(409).json({ success: false, message: 'An account with this email already exists. Please sign in.' });
    }

    const userId = `usr_${userRole}_${Date.now()}`;
    const newUser = {
      id: userId,
      name: cleanName,
      email: cleanEmail,
      password: password,
      role: userRole,
      phone: phone ? phone.trim() : '',
      specialty: specialty ? specialty.trim() : (userRole === 'technician' ? 'Master Diagnostics' : ''),
      avatar: '',
      mfaEnabled: false,
      createdAt: new Date().toISOString()
    };

    db.users.create(newUser);

    if (mongoose.connection.readyState === 1) {
      try {
        await User.create({
          id: newUser.id,
          name: newUser.name,
          email: newUser.email,
          password: newUser.password,
          role: newUser.role,
          phone: newUser.phone,
          specialty: newUser.specialty,
          avatar: newUser.avatar,
          mfaEnabled: false
        });
      } catch (mongoErr) {
        console.warn('MongoDB user insertion warning:', mongoErr.message);
      }
    }

    if (userRole === 'customer') {
      const customerId = `cust_${Date.now()}`;
      const newCustomer = {
        id: customerId,
        userId: newUser.id,
        name: newUser.name,
        email: newUser.email,
        phone: newUser.phone || '555-0100',
        address: '',
        consent: { marketingSms: true, telematicsDataCollection: true },
        membership: {
          tier: 'Standard',
          status: 'active',
          number: `MBR-${Math.floor(10000 + Math.random() * 90000)}`,
          renewDate: '2027-01-01',
          benefits: ['Digital Multi-Point Inspection', 'Direct Technician Messaging']
        },
        vehicles: []
      };

      db.customers.create(newCustomer);

      if (mongoose.connection.readyState === 1) {
        try {
          await Customer.create(newCustomer);
        } catch (e) {
          console.warn('MongoDB customer insertion warning:', e.message);
        }
      }
    }

    const token = generateToken(newUser);
    const refreshToken = generateRefreshToken(newUser.id);

    db.audit.create({
      eventType: 'USER_REGISTERED',
      entityType: 'User',
      entityId: newUser.id,
      actorId: newUser.id,
      actorRole: newUser.role,
      action: `User ${newUser.name} registered successfully with role ${newUser.role} (${newUser.email})`
    });

    res.status(201).json({
      success: true,
      message: 'Account created successfully',
      token,
      refreshToken,
      user: {
        id: newUser.id,
        name: newUser.name,
        email: newUser.email,
        role: newUser.role,
        phone: newUser.phone,
        specialty: newUser.specialty,
        avatar: newUser.avatar,
        mfaEnabled: false
      }
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ success: false, message: 'Server error during registration: ' + error.message });
  }
});

// POST /api/v1/auth/login
router.post('/login', async (req, res) => {
  const { email, password, role, mfaCode } = req.body;

  let user = null;
  if (email) {
    user = db.users.findOne(u => u.email.toLowerCase() === email.toLowerCase());
    if (!user && mongoose.connection.readyState === 1) {
      try {
        const mongoUser = await User.findOne({ email: email.toLowerCase() });
        if (mongoUser) {
          user = {
            id: mongoUser.id,
            name: mongoUser.name,
            email: mongoUser.email,
            password: mongoUser.password,
            role: mongoUser.role,
            phone: mongoUser.phone,
            specialty: mongoUser.specialty,
            avatar: mongoUser.avatar,
            mfaEnabled: mongoUser.mfaEnabled
          };
          db.users.create(user);
        }
      } catch (e) {
        console.warn('MongoDB user lookup warning:', e.message);
      }
    }

    if (user && password && user.password && user.password !== password) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }
  } else if (role) {
    user = db.users.findOne(u => u.role === role);
  }

  if (!user) {
    return res.status(401).json({ success: false, message: 'Invalid credentials or user not found' });
  }

  // Check MFA for privileged roles (manager, admin)
  if ((user.role === 'manager' || user.role === 'admin') && user.mfaEnabled && !mfaCode) {
    return res.json({
      success: true,
      requiresMfa: true,
      message: 'MFA verification required for privileged role',
      userId: user.id
    });
  }

  const token = generateToken(user);
  const refreshToken = generateRefreshToken(user.id);

  // Record audit log
  db.audit.create({
    eventType: 'USER_LOGIN',
    entityType: 'User',
    entityId: user.id,
    actorId: user.id,
    actorRole: user.role,
    action: `User ${user.name} logged in successfully with role ${user.role}`
  });

  res.json({
    success: true,
    token,
    refreshToken,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      phone: user.phone,
      specialty: user.specialty,
      avatar: user.avatar,
      mfaEnabled: !!user.mfaEnabled
    }
  });
});

// POST /api/v1/auth/refresh (Rotating refresh token)
router.post('/refresh', (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) {
    return res.status(400).json({ success: false, message: 'Refresh token is required' });
  }

  const record = db.refreshTokens.find(refreshToken);
  if (!record || record.revoked || new Date(record.expiresAt) < new Date()) {
    return res.status(401).json({ success: false, message: 'Refresh token invalid or expired' });
  }

  // Revoke old token (rotation)
  db.refreshTokens.revoke(refreshToken);

  const user = db.users.findById(record.userId);
  if (!user) {
    return res.status(401).json({ success: false, message: 'User not found' });
  }

  const newAccessToken = generateToken(user);
  const newRefreshToken = generateRefreshToken(user.id);

  res.json({
    success: true,
    token: newAccessToken,
    refreshToken: newRefreshToken
  });
});

// POST /api/v1/auth/mfa/setup
router.post('/mfa/setup', protect, (req, res) => {
  const secret = crypto.randomBytes(20).toString('hex').toUpperCase();
  const recoveryCodes = Array.from({ length: 6 }, () => crypto.randomBytes(4).toString('hex').toUpperCase());

  req.user.mfaSecret = secret;
  req.user.recoveryCodes = recoveryCodes;
  req.user.mfaEnabled = true;

  db.audit.create({
    eventType: 'MFA_ENABLED',
    entityType: 'User',
    entityId: req.user.id,
    actorId: req.user.id,
    actorRole: req.user.role,
    action: `Enabled MFA two-factor protection for ${req.user.email}`
  });

  res.json({
    success: true,
    secret,
    recoveryCodes,
    message: 'MFA enabled. Store recovery codes in a secure location.'
  });
});

// POST /api/v1/auth/mfa/verify
router.post('/mfa/verify', (req, res) => {
  const { userId, code } = req.body;
  const user = db.users.findById(userId);
  if (!user) {
    return res.status(404).json({ success: false, message: 'User not found' });
  }

  // Verify demo/TOTP code (e.g. valid 6-digit code)
  if (!code || (code !== '123456' && code.length !== 6)) {
    return res.status(401).json({ success: false, message: 'Invalid MFA verification code' });
  }

  const token = generateToken(user);
  const refreshToken = generateRefreshToken(user.id);

  res.json({
    success: true,
    token,
    refreshToken,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      specialty: user.specialty,
      avatar: user.avatar
    }
  });
});

// POST /api/v1/auth/logout
router.post('/logout', (req, res) => {
  const { refreshToken } = req.body;
  if (refreshToken) {
    db.refreshTokens.revoke(refreshToken);
  }
  res.json({ success: true, message: 'Logged out successfully' });
});

// GET /api/v1/auth/me
router.get('/me', protect, (req, res) => {
  res.json({
    success: true,
    user: {
      id: req.user.id,
      name: req.user.name,
      email: req.user.email,
      role: req.user.role,
      phone: req.user.phone,
      specialty: req.user.specialty,
      avatar: req.user.avatar,
      mfaEnabled: !!req.user.mfaEnabled
    }
  });
});

// GET /api/v1/auth/users
router.get('/users', (req, res) => {
  const users = db.users.find().map(u => ({
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    phone: u.phone,
    specialty: u.specialty,
    avatar: u.avatar
  }));
  res.json({ success: true, users });
});

export default router;
