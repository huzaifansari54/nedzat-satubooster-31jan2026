const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB_PATH = path.join(__dirname, 'db.sqlite');
console.log('Opening database:', DB_PATH);

const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
    // Check if column exists
    db.all(`PRAGMA table_info(campaigns)`, [], (err, cols) => {
        if (err) {
            console.error('Error checking table:', err);
            process.exit(1);
        }

        console.log('Current campaigns columns:', cols.map(c => c.name).join(', '));

        const hasIsActive = cols.some(c => c.name === 'is_active');

        if (hasIsActive) {
            console.log('✅ Column is_active already exists!');
            db.close();
            process.exit(0);
        } else {
            console.log('Adding is_active column...');
            db.run(`ALTER TABLE campaigns ADD COLUMN is_active INTEGER DEFAULT 1`, (err) => {
                if (err) {
                    console.error('❌ Error adding column:', err.message);
                    process.exit(1);
                }
                console.log('✅ Column is_active added successfully!');
                db.close();
                process.exit(0);
            });
        }
    });
});
