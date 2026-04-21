const { all } = require('./src/database');

async function check() {
    try {
        const info = await all("PRAGMA table_info(profiles)");
        console.log('Profiles Columns:', info.map(c => c.name).join(', '));
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

check();
