import { Router } from 'express';
import db from '../db.js';

const router = Router();

// Auth middleware
function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

// GET /catalog — list available rewards
router.get('/catalog', requireAuth, (req, res) => {
  const rewards = db.prepare(
    'SELECT id, name, description, chesnutCost FROM rewards WHERE active = 1 ORDER BY chesnutCost ASC'
  ).all();

  const user = db.prepare(
    'SELECT chesnutBalance FROM users WHERE id = ?'
  ).get(req.session.userId);

  res.json({ rewards, balance: user.chesnutBalance });
});

// POST /redeem — redeem a reward
router.post('/redeem', requireAuth, (req, res) => {
  const { rewardId } = req.body;

  if (!rewardId) {
    return res.status(400).json({ error: 'rewardId is required' });
  }

  const reward = db.prepare(
    'SELECT * FROM rewards WHERE id = ? AND active = 1'
  ).get(rewardId);

  if (!reward) {
    return res.status(404).json({ error: 'Reward not found' });
  }

  const userId = req.session.userId;

  // Atomic balance check + deduct + create redemption
  const redeem = db.transaction(() => {
    const user = db.prepare('SELECT chesnutBalance FROM users WHERE id = ?').get(userId);

    if (user.chesnutBalance < reward.chesnutCost) {
      return { error: 'Not enough Chesnuts', needed: reward.chesnutCost, have: user.chesnutBalance };
    }

    db.prepare(
      'UPDATE users SET chesnutBalance = chesnutBalance - ? WHERE id = ?'
    ).run(reward.chesnutCost, userId);

    const result = db.prepare(
      'INSERT INTO redemptions (userId, rewardId, chesnutsSpent) VALUES (?, ?, ?)'
    ).run(userId, reward.id, reward.chesnutCost);

    const updatedUser = db.prepare(
      'SELECT id, email, displayName, chesnutBalance, currentStreak, bestStreak FROM users WHERE id = ?'
    ).get(userId);

    return {
      redemption: {
        id: result.lastInsertRowid,
        rewardName: reward.name,
        chesnutsSpent: reward.chesnutCost,
        status: 'pending',
      },
      user: updatedUser,
    };
  });

  const result = redeem();

  if (result.error) {
    return res.status(400).json(result);
  }

  res.json(result);
});

// GET /redemptions — user's redemption history
router.get('/redemptions', requireAuth, (req, res) => {
  const userId = req.session.userId;
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;

  const redemptions = db.prepare(`
    SELECT rd.id, rd.chesnutsSpent, rd.status, rd.createdAt,
           rw.name as rewardName
    FROM redemptions rd
    JOIN rewards rw ON rw.id = rd.rewardId
    WHERE rd.userId = ?
    ORDER BY rd.createdAt DESC
    LIMIT ? OFFSET ?
  `).all(userId, limit, offset);

  const stats = db.prepare(`
    SELECT
      COUNT(*) as totalRedemptions,
      SUM(chesnutsSpent) as totalSpent
    FROM redemptions
    WHERE userId = ?
  `).get(userId);

  res.json({ redemptions, stats });
});

export default router;
