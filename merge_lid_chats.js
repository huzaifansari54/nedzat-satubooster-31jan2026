const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./db.sqlite');

function promisify(fn) {
  return function(...args) {
    return new Promise((resolve, reject) => {
      fn.call(db, ...args, (err, result) => {
        if (err) reject(err);
        else resolve(result);
      });
    });
  };
}

const run = promisify(db.run);
const all = promisify(db.all);
const get = promisify(db.get);

async function mergeLidChats() {
  console.log('🔍 Поиск LID чатов для объединения...\n');
  
  // Находим все уникальные LID JID
  const lidJids = await all(
    `SELECT DISTINCT jid FROM chats WHERE jid LIKE '%@lid' ORDER BY jid`
  );
  
  console.log(`Найдено ${lidJids.length} уникальных LID чатов\n`);
  
  let merged = 0;
  let skipped = 0;
  
  for (const row of lidJids) {
    const lid = row.jid;
    
    // Ищем связь в lid_mapping
    const mapping = await get(
      `SELECT phone_jid, phone_number FROM lid_mapping WHERE lid = ?`,
      [lid]
    );
    
    if (mapping) {
      const phoneJid = mapping.phone_jid;
      
      // Считаем сколько сообщений будет объединено
      const countResult = await get(
        `SELECT COUNT(*) as cnt FROM chats WHERE jid = ?`,
        [lid]
      );
      const msgCount = countResult.cnt;
      
      console.log(`✅ Объединяю: ${lid}`);
      console.log(`   ↳ В: ${phoneJid} (${mapping.phone_number})`);
      console.log(`   ↳ Сообщений: ${msgCount}`);
      
      // Обновляем все сообщения
      await run(
        `UPDATE chats SET jid = ? WHERE jid = ?`,
        [phoneJid, lid]
      );
      
      // Обновляем профили
      await run(
        `UPDATE profiles SET jid = ? WHERE jid = ?`,
        [phoneJid, lid]
      );
      
      merged++;
      console.log('');
    } else {
      console.log(`⚠️  Пропускаю: ${lid} (нет связи с номером)\n`);
      skipped++;
    }
  }
  
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`✅ Объединено: ${merged} чатов`);
  console.log(`⚠️  Пропущено: ${skipped} чатов (нет номера)`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  
  // Проверка результата
  const remaining = await get(
    `SELECT COUNT(DISTINCT jid) as cnt FROM chats WHERE jid LIKE '%@lid'`
  );
  
  console.log(`Осталось LID чатов: ${remaining.cnt}`);
  
  db.close();
}

mergeLidChats().catch(err => {
  console.error('❌ Ошибка:', err);
  db.close();
  process.exit(1);
});
