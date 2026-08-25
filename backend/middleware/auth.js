const jwt = require('jsonwebtoken');

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const token = authHeader.split(' ')[1];
      req.user = jwt.verify(token, process.env.JWT_SECRET);
    } catch {}
  }
  next();
}

function adminMiddleware(req, res, next) {
  authMiddleware(req, res, () => {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  });
}


function sellerApprovalMiddleware(req, res, next) {
  authMiddleware(req, res, async () => {
    try {
      if (req.user?.role !== 'seller') return res.status(403).json({ error: 'Seller access required' });
      const { User } = require('../db/database');
      const user = await User.findById(req.user.id).select('seller_approval_status account_status').lean();
      if (!user) return res.status(404).json({ error: 'User not found' });
      if (['suspended','deletion_pending','deleted'].includes(user.account_status)) return res.status(403).json({ code: 'ACCOUNT_UNAVAILABLE', error: user.account_status === 'deletion_pending' ? 'Your account deletion request is awaiting admin approval.' : 'Your account is unavailable.' });
      if (user.seller_approval_status === 'pending') return res.status(403).json({ code: 'SELLER_APPROVAL_PENDING', error: 'Your seller account is awaiting admin approval. Please allow up to 6 hours.' });
      if (user.seller_approval_status === 'rejected') return res.status(403).json({ code: 'SELLER_APPROVAL_REJECTED', error: 'Your seller application was rejected.' });
      next();
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}

module.exports = { authMiddleware, optionalAuth, adminMiddleware, sellerApprovalMiddleware };
