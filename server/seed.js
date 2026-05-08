import db from './db.js';

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
