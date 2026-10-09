/**
 * Server "Happy Family" (keluarga.masmik.id)
 *
 * Menyimpan data silsilah di satu file JSON di Google Drive pemilik, supaya
 * seluruh keluarga bisa melihat & mengisi tanpa login Google — cukup kode keluarga.
 *
 * PEMASANGAN (sekali saja, oleh pemilik):
 *  1. script.google.com → Proyek baru → tempel seluruh isi file ini.
 *  2. ⚙ Setelan proyek → Properti skrip → tambahkan:
 *       FILE_ID      ID file silsilah-keluarga.json di Drive
 *       FAMILY_CODE  kode keluarga (min. 8 karakter, campur huruf & angka)
 *  3. Pilih fungsi cekPengaturan → Jalankan → izinkan akses.
 *  4. Terapkan → Deployment baru → Aplikasi web:
 *       Jalankan sebagai: Saya   ·   Yang memiliki akses: Siapa saja
 *     Salin URL yang berakhiran /exec.
 *  Mengubah skrip nanti: Terapkan → Kelola deployment → ✎ → Versi: Baru
 *  (URL tetap sama).
 */

const BACKUP_FOLDER_NAME = 'silsilah-cadangan';
const BACKUP_EVERY_MIN = 30;        // cadangan paling sering tiap 30 menit
const KEEP_BACKUPS = 60;            // simpan 60 cadangan terakhir
const MAX_DELETE_PER_SAVE = 5;      // tolak penyimpanan yang menghapus banyak orang sekaligus
const MAX_BYTES = 2 * 1024 * 1024;
const LOCK_AFTER_FAILS = 30;        // terlalu banyak kode salah dalam 10 menit → kunci sementara

function doGet() {
  return out({ ok: true, app: 'happy-family' });
}

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return out({ ok: false, error: 'bad_request' }); }
  try {
    if (!checkCode(req.code)) return out({ ok: false, error: 'wrong_code' });
    if (req.action === 'load') return out(load(req.known));
    if (req.action === 'save') return out(save(req.rev, req.data));
    return out({ ok: false, error: 'unknown_action' });
  } catch (err) {
    return out({ ok: false, error: 'server', message: String(err && err.message || err) });
  }
}

/* ---------- kode keluarga ---------- */
function checkCode(code) {
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('fails') || 0);
  if (fails >= LOCK_AFTER_FAILS) { Utilities.sleep(2000); return false; }
  const want = String(props().getProperty('FAMILY_CODE') || '').trim().toLowerCase();
  const got = String(code || '').trim().toLowerCase();
  if (want && got === want) return true;
  cache.put('fails', String(fails + 1), 600);
  Utilities.sleep(1500);   // perlambat tebak-tebakan
  return false;
}

/* ---------- baca & simpan ---------- */
function load(known) {
  const rev = currentRev();
  if (known && String(known) === rev) return { ok: true, unchanged: true, rev: rev };
  return { ok: true, rev: rev, data: readData() };
}

function save(rev, data) {
  if (!data || !Array.isArray(data.people) || !Array.isArray(data.unions)) return { ok: false, error: 'bad_data' };
  const text = JSON.stringify(data);
  if (text.length > MAX_BYTES) return { ok: false, error: 'too_big' };
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const cur = currentRev();
    if (String(rev) !== cur) return { ok: false, error: 'conflict', rev: cur, data: readData() };
    const old = readData();
    if (old.people.length - data.people.length > MAX_DELETE_PER_SAVE) return { ok: false, error: 'too_many_deletes' };
    backupIfDue(old);
    file().setContent(text);
    const next = String(Number(cur) + 1);
    props().setProperties({ REV: next, LAST_SAVE: new Date().toISOString() });
    return { ok: true, rev: next };
  } finally {
    lock.releaseLock();
  }
}

/* ---------- cadangan otomatis ---------- */
function backupIfDue(old) {
  const p = props();
  const last = Number(p.getProperty('LAST_BACKUP') || 0);
  if (Date.now() - last < BACKUP_EVERY_MIN * 60 * 1000) return;
  const folder = backupFolder();
  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd_HHmm');
  folder.createFile('silsilah-' + stamp + '.json', JSON.stringify(old), 'application/json');
  p.setProperty('LAST_BACKUP', String(Date.now()));
  const files = [];
  const it = folder.getFiles();
  while (it.hasNext()) files.push(it.next());
  files.sort((a, b) => b.getDateCreated() - a.getDateCreated());
  files.slice(KEEP_BACKUPS).forEach(f => f.setTrashed(true));
}

function backupFolder() {
  const p = props();
  const id = p.getProperty('BACKUP_FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  const parents = file().getParents();
  const parent = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
  const f = parent.createFolder(BACKUP_FOLDER_NAME);
  p.setProperty('BACKUP_FOLDER_ID', f.getId());
  return f;
}

/* ---------- utilitas ---------- */
function props() { return PropertiesService.getScriptProperties(); }
function file() { return DriveApp.getFileById(props().getProperty('FILE_ID')); }
function currentRev() { return String(props().getProperty('REV') || '1'); }
function readData() {
  let d = {};
  try { d = JSON.parse(file().getBlob().getDataAsString() || '{}'); } catch (e) {}
  if (!Array.isArray(d.people)) d.people = [];
  if (!Array.isArray(d.unions)) d.unions = [];
  return d;
}
function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** Jalankan sekali dari editor untuk memeriksa pengaturan & memberi izin akses Drive. */
function cekPengaturan() {
  const code = String(props().getProperty('FAMILY_CODE') || '');
  if (!props().getProperty('FILE_ID')) throw new Error('FILE_ID belum diisi di Properti skrip');
  if (code.length < 8) throw new Error('FAMILY_CODE belum diisi atau kurang dari 8 karakter');
  const d = readData();
  Logger.log('OK: file "' + file().getName() + '" berisi ' + d.people.length + ' orang. Cadangan di folder "' + backupFolder().getName() + '".');
}
