import db from './db.js';

// Promote configured admin users. Falls back to the first registered user
// if no admin exists yet, so the system always has someone who can manage
// accounts.
export function seedAdmins() {
  const adminEmails = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);

  for (const email of adminEmails) {
    db.prepare('UPDATE users SET isAdmin = 1 WHERE LOWER(email) = ?').run(email);
  }

  const haveAdmin = db.prepare('SELECT 1 FROM users WHERE isAdmin = 1 LIMIT 1').get();
  if (!haveAdmin) {
    const first = db.prepare('SELECT id, email FROM users ORDER BY id ASC LIMIT 1').get();
    if (first) {
      db.prepare('UPDATE users SET isAdmin = 1 WHERE id = ?').run(first.id);
      console.log(`Promoted ${first.email} to admin (no admin existed)`);
    }
  }
}

export function seedRewards() {
  const existing = db.prepare('SELECT COUNT(*) as count FROM rewards').get();
  if (existing.count > 0) return;

  const rewards = [
    { name: '10 minutes of screen time', description: 'Redeem for 10 minutes of screen time', cost: 10 },
    { name: '$1', description: 'Redeem for one dollar', cost: 20 },
    { name: 'Car ride to a friend\'s house', description: 'Get a ride to visit a friend', cost: 50 },
    { name: 'Day trip', description: 'Earn a fun day trip adventure', cost: 200 },
  ];

  const insert = db.prepare(
    'INSERT INTO rewards (name, description, chesnutCost) VALUES (?, ?, ?)'
  );

  const insertMany = db.transaction((rewards) => {
    for (const r of rewards) insert.run(r.name, r.description, r.cost);
  });

  insertMany(rewards);
  console.log(`Seeded ${rewards.length} rewards`);
}

seedRewards();
seedAdmins();
