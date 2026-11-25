import { supabase } from "../supabaseClient.js";
import { toast, fmtRupiah, fmtJam, fmtDate, dateOnlyISO, roundOvertimeHours, exportXLSX, dayOfWeekFromDateStr, zonedMinutesOfDay, hmToMinutes, getPayrollCutoffDay, payrollPeriodRange, STAFF_ROLES, confirmDialog, escapeHtml } from "../core.js";


// Cetak slip: salin isi slip ke #print-root (langsung di bawah <body>) lalu
// sembunyikan seluruh aplikasi saat print, sehingga hasilnya 1 halaman rapi
// baik di desktop maupun HP.
export function printSlip() {
  const src = document.getElementById("slip-content");
  if (!src) return window.print();
  let root = document.getElementById("print-root");
  if (!root) { root = document.createElement("div"); root.id = "print-root"; document.body.appendChild(root); }
  root.innerHTML = '<div class="slip-print-area">' + src.innerHTML + '</div>';
  document.body.classList.add("printing-slip");
  const cleanup = () => { document.body.classList.remove("printing-slip"); root.innerHTML = ""; window.removeEventListener("afterprint", cleanup); };
  window.addEventListener("afterprint", cleanup);
  setTimeout(() => window.print(), 50);
}

// =======================================================================
// SLIP GAJI — dihitung otomatis dari data yang sudah ada di sistem:
//   - Gaji pokok: Riwayat Upah Harian (x hari hadir) / Riwayat Gaji Bulanan
//   - Uang lembur: Pengajuan Lembur yang disetujui x tarif di Master Level
//   - Tunjangan (Jabatan, Loyalitas, dst): nominal per karyawan yang diatur
//     di menu "Master Tunjangan" (beda-beda tiap orang, bukan per level),
//     otomatis ditambahkan tiap slip selama statusnya aktif.
//   - Denda keterlambatan & pulang cepat: tabel bertingkat berdasarkan
//     menit telat/cepat RELATIF terhadap jadwal kerja masing-masing
//     karyawan (bukan jam dinding tetap), diatur manual di menu "Master
//     Denda Telat" (tabel late_penalty_rules). Tier bertipe % dikalikan
//     "Denda Terlambat & Pulang Cepat" (Rp) di Master Level masing-masing
//     grade/level; tier bertipe nominal tetap tidak tergantung denda
//     level. Rincian per-hari tidak ditampilkan di slip gaji karyawan,
//     hanya totalnya.
//   - BPJS, PPh21, uang dinas: tarif di Master Level
// Komponen yang tidak tercatat otomatis (dinas, tunjangan/potongan lain)
// diisi manual per periode lewat "Edit Tunjangan/Potongan" dan disimpan
// ke tabel payroll_adjustments supaya tidak hilang saat dibuka ulang.
// =======================================================================

// ---------------------------------------------------------------------
// POTONGAN KETERLAMBATAN & PULANG CEPAT
// Aturan (menit_offset & persen/nominal) diambil dari tabel
// late_penalty_rules (di-load ke penaltyRules saat loadData). Sejak
// jadwal kerja karyawan bisa beda-beda (shift pagi/sore/malam), tier-nya
// disimpan RELATIF terhadap jam masuk/pulang sesuai JADWAL MASING-MASING
// KARYAWAN (bukan jam dinding tetap) -- lihat resolveShiftWindow() di
// bawah utk cara mengambil jam masuk/pulang jadwalnya utk satu baris
// absensi tertentu.
// ---------------------------------------------------------------------

// Ambil jam masuk & jam pulang (menit sejak 00:00, sesuai jadwal kerja
// karyawan) yang berlaku untuk SATU baris absensi (ditentukan dari tanggal
// baris itu, bukan tanggal hari ini). Karyawan tanpa jadwal (schedule_id
// kosong, atau harinya libur/tidak ketemu di Master Jadwal Kerja) pakai
// acuan default 08:00-17:00, sama seperti dulu.
function resolveShiftWindow(emp, dow, date) {
  // Tukar shift (SQL 013): pada tanggal tertentu jadwal bisa ditimpa.
  const sid = (date && overrideByKey[`${emp.id}_${date}`]) || emp.schedule_id;
  const day = sid ? scheduleDaysByKey[`${sid}_${dow}`] : null;
  if (day && day.is_working_day && day.start_time && day.end_time) {
    return {
      startMin: hmToMinutes(day.start_time.slice(0, 5)),
      endMin: hmToMinutes(day.end_time.slice(0, 5)),
      crossesMidnight: !!day.crosses_midnight,
      scheduled: true, // jam ini berasal dari jadwal kerja nyata, bukan acuan default
    };
  }
  return { startMin: hmToMinutes("08:00"), endMin: hmToMinutes("17:00"), crossesMidnight: false, scheduled: false };
}

// Keterlambatan: tier diurutkan naik. Yang dipakai adalah tier PALING
// TERAKHIR yang menit-telatnya sudah terlampaui (makin lama telatnya,
// makin besar potongannya).
function hitungDendaTelat(checkInAt, dayOfWeek, dendaDasar, tz, shift) {
  if (!checkInAt) return null;
  // Minggu: hanya didenda bila jadwal karyawan menandai Minggu sebagai hari kerja
  // (memakai tier "weekday"); Minggu di luar jadwal tetap tanpa denda.
  if (dayOfWeek === 0 && !shift.scheduled) return null;
  const dayType = dayOfWeek === 6 ? "saturday" : "weekday";
  const rules = penaltyRules.telat[dayType] || [];
  let mins = zonedMinutesOfDay(checkInAt, tz);
  // Check-in dini hari utk shift lintas tengah malam (mis. shift 22:00,
  // check-in tercatat 00:xx) -- geser +24 jam supaya selisihnya dari jam
  // masuk terhitung benar (bukan malah jadi "lebih awal").
  if (shift.crossesMidnight && mins < shift.endMin) mins += 24 * 60;
  const lateMinutes = mins - shift.startMin;
  let picked = null;
  for (const r of rules) {
    if (lateMinutes > r.menit_offset) picked = r;
  }
  if (!picked) return null;
  const amount = picked.tipe === "flat" ? picked.nominal : dendaDasar * picked.persen / 100;
  return { amount, label: picked.label };
}

// Pulang cepat: tier diurutkan naik. Yang dipakai adalah tier PALING
// TERAKHIR yang menit-lebih-cepatnya sudah terlampaui (makin cepat pulangnya,
// makin besar potongannya) -- sama seperti hitungDendaTelat.
function hitungDendaPulangCepat(checkOutAt, dayOfWeek, dendaDasar, tz, shift) {
  if (!checkOutAt) return null;
  if (dayOfWeek === 0 && !shift.scheduled) return null; // lihat catatan di hitungDendaTelat
  const dayType = dayOfWeek === 6 ? "saturday" : "weekday";
  const rules = penaltyRules.pulang_cepat[dayType] || [];
  const mins = zonedMinutesOfDay(checkOutAt, tz);
  const earlyMinutes = shift.endMin - mins;
  let picked = null;
  for (const r of rules) {
    if (earlyMinutes > r.menit_offset) picked = r;
  }
  if (!picked) return null;
  const amount = picked.tipe === "flat" ? picked.nominal : dendaDasar * picked.persen / 100;
  return { amount, label: picked.label };
}

let period = "";
let employees = [];
let jobLevels = [];
let wageByUser = {};
let salaryByUser = {};
let attendanceByUser = {};
let overtimeByUser = {};
let adjByUser = {};
let claimByUser = {}; // { [userId]: [{ amount, category, expense_date }] } — klaim reimbursement yang dibayar di periode terpilih (SQL 011)
let loanByUser = {}; // { [userId]: [{ loan_id, seq, amount, status }] } — cicilan kasbon periode terpilih (SQL 010)
let allowancesByUser = {}; // { [userId]: [{ nama, nominal }] } — dari Master Tunjangan (aktif saja)
let penaltyRules = { telat: { weekday: [], saturday: [] }, pulang_cepat: { weekday: [], saturday: [] } };
let overrideByKey = {}; // { "${user_id}_${tanggal}": schedule_id } — tukar shift disetujui (SQL 013)
let scheduleDaysByKey = {}; // { "${schedule_id}_${day_of_week}": work_schedule_days row } — lihat resolveShiftWindow()
let tzByLokasi = {}; // { [nama_lokasi]: timezone } — dari Master Lokasi Kantor, dipakai supaya potongan telat/pulang-cepat dihitung sesuai jam SETEMPAT tiap cabang, bukan satu zona global.
let currentSlip = null; // slip yang sedang dibuka di modal detail
let cutoffDay = 1; // 1 = kalender biasa; diisi dari payroll_settings saat loadData
let periodRange = { start: "", end: "" }; // rentang tanggal aktual (hasil cut-off) untuk periode terpilih
let finalizedPeriods = {}; // { [period]: { period_start, period_end, cutoff_start_day, finalized_by, finalized_at } } — dimuat sekali saat render()
let periodInfo = null; // baris payroll_periods utk periode yg SEDANG dibuka, atau null kalau masih draft
let frozenSlipsByUser = {}; // { [userId]: snapshot } — dari payroll_slips, hanya terisi kalau periodInfo != null
// Tampilan daftar untuk staff (banyak karyawan): pencarian, filter, halaman, pilihan massal.
let viewState = { q: "", dept: "", status: "semua", page: 1, pageSize: 25, selected: new Set() };
let pendingData = []; // gaji ditahan di periode lain (kotak "Gaji ditahan di periode lain")
let pendingSel = new Set(); // "period|user_id" yang dicentang di kotak itu
const payStatusOf = s => s.pay?.pay_status || "siap";
const PAY_LABEL = { siap: "Siap", ditahan: "Ditahan", dibayar: "Dibayar" };

function injectSlipStyle() {
  if (document.getElementById("slp-style")) return;
  const st = document.createElement("style");
  st.id = "slp-style";
  st.textContent = `
    .slp-toolbar { display:flex; gap:12px; flex-wrap:wrap; align-items:center; justify-content:space-between; margin:0 0 12px; }
    .slp-tabs { display:flex; gap:6px; flex-wrap:wrap; }
    .slp-tab { border:1px solid var(--border, #ddd); background:var(--surface, #fff); border-radius:999px; padding:6px 12px; font-size:13px; cursor:pointer; }
    .slp-tab.active { background:var(--primary, #1f4d3a); color:#fff; border-color:transparent; }
    .slp-tab small { opacity:.75; margin-left:4px; }
    .slp-filters { display:flex; gap:8px; flex-wrap:wrap; }
    .slp-filters input, .slp-filters select { min-width:160px; }
    .slp-bulk { display:flex; gap:10px; flex-wrap:wrap; align-items:center; padding:10px 14px; margin:0 0 12px; border-radius:12px; background:var(--warn-bg, #fff6e0); border:1px solid var(--border, #ddd); }
    .slp-bulk strong { margin-right:4px; }
    .slp-pager { display:flex; gap:10px; flex-wrap:wrap; align-items:center; justify-content:space-between; margin-top:12px; font-size:13px; }
    .slp-pager-nav { display:flex; gap:6px; align-items:center; }
    .slp-chk { width:18px; height:18px; cursor:pointer; }
    .slp-paycell { display:flex; align-items:center; gap:6px; }
    .slp-sub { font-size:12px; color:var(--muted, #777); max-width:170px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .slp-menu-btn { border:1px solid var(--border, #ddd); background:var(--surface, #fff); border-radius:8px; width:30px; height:28px; cursor:pointer; line-height:1; font-size:16px; }
    .slp-menu { position:fixed; z-index:3000; min-width:190px; background:var(--surface, #fff); border:1px solid var(--border, #ddd); border-radius:10px; box-shadow:0 8px 24px rgba(0,0,0,.15); padding:6px; }
    .slp-menu button { display:block; width:100%; text-align:left; background:none; border:0; padding:8px 10px; border-radius:6px; cursor:pointer; font-size:14px; }
    .slp-menu button:hover { background:var(--bg, #f3f1ea); }
    .slp-click { cursor:pointer; }
    .slp-pend-table td { vertical-align:middle; }
  `;
  document.head.appendChild(st);
}

let slipMetaByUser = {}; // { [userId]: baris payroll_slips (pay_status, hold_reason, ...) } — hanya terisi kalau periodInfo != null
let payReady = false; // false kalau SQL 026 belum dijalankan (kolom pay_status belum ada) -> fitur tahan/rilis disembunyikan
let currentUser = null; // disimpan supaya bisa dipakai di onFinalize/onUnlock

// Batasan akses berdasarkan role, dihitung sekali di awal render():
// - canFinalize: HANYA super_admin yang boleh finalisasi/buka kunci periode.
// - canEditAdjust: super_admin/super_admin_hr/admin_hr boleh, Karyawan TIDAK
//   (dia cuma boleh lihat & cetak slip miliknya sendiri, tidak bisa
//   mengubah tunjangan/potongan siapa pun termasuk dirinya sendiri).
// - isKaryawan: kalau true, daftar karyawan disaring cuma baris dirinya
//   sendiri (walau tabel profiles yang dibaca RLS-nya memang sudah
//   otomatis cuma balikin baris sendiri utk role ini, filter ini jaga-jaga
//   di sisi tampilan juga).
let roleFlags = { isKaryawan: false, canFinalize: false, canEditAdjust: true, canManagePay: false };

export async function render(container, user, opts = {}) {
  currentUser = user;
  // forceSelfOnly: dipakai oleh menu "Slip Gaji Saya" (lihat js/modules/
  // employee-slip-gaji.js) supaya SIAPA PUN yang membukanya lewat menu itu
  // -- termasuk Super Admin HR/Admin HR yang tidak (atau belum tentu)
  // dikasih akses menu "Slip Gaji" (kelola semua karyawan) -- tetap hanya
  // melihat slip miliknya sendiri, tanpa tombol finalisasi/edit apa pun.
  // Menu "Slip Gaji" biasa (tanpa opts ini) tetap pakai role asli seperti
  // sebelumnya.
  roleFlags = {
    isKaryawan: opts.forceSelfOnly || !STAFF_ROLES.includes(user.role),
    canFinalize: !opts.forceSelfOnly && user.role === "super_admin",
    canEditAdjust: !opts.forceSelfOnly && STAFF_ROLES.includes(user.role),
    // Tahan/rilis gaji: Super Admin atau staff HR (server tetap memeriksa akses menu "slip-gaji").
    canManagePay: !opts.forceSelfOnly && STAFF_ROLES.includes(user.role),
  };
  period = dateOnlyISO(new Date()).slice(0, 7);
  injectSlipStyle();
  viewState = { q: "", dept: "", status: "semua", page: 1, pageSize: 25, selected: new Set() };
  pendingSel = new Set();
  cutoffDay = await getPayrollCutoffDay();

  // Ambil semua periode yang sudah difinalisasi sekali di awal, supaya
  // label dropdown (rentang tanggal) periode LAMA yang sudah dikunci tetap
  // menampilkan rentang yang dibekukan saat itu, bukan hasil hitung ulang
  // pakai cutoff yang berlaku sekarang.
  const { data: fp } = await supabase.from("payroll_periods").select("*");
  finalizedPeriods = {};
  (fp || []).forEach(r => { finalizedPeriods[r.period] = r; });

  // Kalau pakai cut-off (bukan kalender biasa), pakai dropdown yang
  // labelnya langsung rentang tanggal ("21 Agu 2026 – 20 Sep 2026")
  // supaya tidak perlu menebak-nebak arti nama bulannya. Kalau kalender
  // biasa (cutoffDay = 1), input bulan bawaan browser sudah jelas.
  const periodFilterHtml = cutoffDay > 1
    ? `<select id="filter-period">${buildPeriodOptions(period, cutoffDay).map(o =>
        `<option value="${o.value}" ${o.value === period ? "selected" : ""}>${o.label}</option>`).join("")}</select>`
    : `<input type="month" id="filter-period" value="${period}">`;

  container.innerHTML = `
    <div class="pg-head">
      <div>
        <h1>Slip Gaji</h1>
        <p class="pg-head-sub">${roleFlags.isKaryawan
          ? "Slip gaji kamu, dihitung otomatis dari absensi, lembur, dan data upah/gaji. Kalau ada yang dirasa keliru, hubungi HR/Admin."
          : "Dihitung otomatis dari absensi, lembur, riwayat upah/gaji, dan Master Level. Tunjangan/potongan yang tidak tercatat otomatis bisa ditambahkan manual per karyawan. Rentang tanggal periode mengikuti pengaturan cut-off di menu Pengaturan Sistem, sampai periode itu difinalisasi."}</p>
      </div>
      <div class="filter-row pg-head-actions">
        ${periodFilterHtml}
        ${roleFlags.isKaryawan ? "" : `<button id="btn-export" class="btn-secondary">Export Ringkasan (Excel)</button>`}
      </div>
    </div>

    <div id="slip-lock-banner"></div>
    <div id="slip-pending"></div>
    <div id="slip-summary" class="dash-stats"></div>
    <div id="slip-toolbar"></div>
    <div id="slip-bulkbar"></div>
    <div id="slip-table" class="table-wrap"><p class="muted">Memuat…</p></div>
    <div id="slip-pager"></div>

    <!-- Modal: detail & cetak slip -->
    <div id="modal-slip" class="modal hidden">
      <div class="modal-box modal-box-lg">
        <div class="modal-actions no-print" style="justify-content:space-between; margin-bottom:14px;">
          ${roleFlags.canEditAdjust ? `<button type="button" id="btn-edit-adjust" class="btn-secondary">✏️ Edit Tunjangan/Potongan</button>` : `<span></span>`}
          <div style="display:flex; gap:10px;">
            <button type="button" id="btn-print-slip" class="btn-secondary">🖨️ Cetak / Simpan PDF</button>
            <button type="button" id="btn-close-slip" class="btn-primary">Tutup</button>
          </div>
        </div>
        <div id="slip-content" class="slip-print-area"></div>
      </div>
    </div>

    <!-- Modal: tahan / rilis gaji -->
    <div id="modal-pay" class="modal hidden">
      <div class="modal-box">
        <h3 id="pay-title">Tahan Gaji</h3>
        <p class="muted small" id="pay-emp-label" style="margin-top:-4px;"></p>
        <form id="form-pay">
          <div class="form-row" id="pay-row-reason">
            <label>Alasan penahanan <textarea name="reason" rows="3" placeholder="Contoh: serah terima aset belum selesai"></textarea></label>
          </div>
          <div class="form-row two-col" id="pay-row-paid">
            <label>Tanggal dibayar <input type="date" name="paid_at"></label>
            <label>Catatan <input name="note" placeholder="Contoh: transfer BCA, ref 12345"></label>
          </div>
          <div class="modal-actions">
            <button type="button" id="btn-cancel-pay" class="btn-secondary">Batal</button>
            <button type="submit" class="btn-primary" id="btn-submit-pay">Simpan</button>
          </div>
        </form>
      </div>
    </div>

    <!-- Modal: edit penyesuaian manual -->
    <div id="modal-adjust" class="modal hidden">
      <div class="modal-box">
        <h3>Tunjangan &amp; Potongan Manual</h3>
        <p class="muted small" id="adjust-emp-label" style="margin-top:-4px;"></p>
        <form id="form-adjust">
          <div class="form-row two-col">
            <label>Hari Perjalanan Dinas <input type="number" name="hari_dinas" min="0" step="1" value="0"></label>
            <label>Tunjangan Lain (Rp) <input type="number" name="tunjangan_lain" min="0" step="1" value="0"></label>
          </div>
          <div class="form-row">
            <label>Keterangan Tunjangan Lain <input name="keterangan_tunjangan" placeholder="Contoh: Bonus, insentif, dsb (THR diatur di menu THR)"></label>
          </div>
          <div class="form-row">
            <label>Potongan Lain (Rp) <input type="number" name="potongan_lain" min="0" step="1" value="0"></label>
          </div>
          <div class="form-row">
            <label>Keterangan Potongan Lain <input name="keterangan_potongan" placeholder="Contoh: Kasbon, pinjaman, dsb"></label>
          </div>
          <div class="modal-actions">
            <button type="button" id="btn-cancel-adjust" class="btn-secondary">Batal</button>
            <button type="submit" class="btn-primary">Simpan</button>
          </div>
        </form>
      </div>
    </div>
  `;

  document.getElementById("filter-period").addEventListener("change", e => {
    period = e.target.value;
    viewState.status = "semua"; viewState.page = 1; viewState.selected = new Set();
    loadAndRender();
  });
  document.getElementById("btn-export")?.addEventListener("click", doExport);
  document.getElementById("btn-close-slip").addEventListener("click", () => document.getElementById("modal-slip").classList.add("hidden"));
  document.getElementById("btn-print-slip").addEventListener("click", printSlip);
  document.getElementById("btn-edit-adjust")?.addEventListener("click", () => openAdjustModal(currentSlip.emp.id));
  document.getElementById("btn-cancel-adjust").addEventListener("click", () => document.getElementById("modal-adjust").classList.add("hidden"));
  document.getElementById("form-adjust").addEventListener("submit", e => onSubmitAdjust(e, user));
  document.getElementById("btn-cancel-pay").addEventListener("click", () => document.getElementById("modal-pay").classList.add("hidden"));
  document.getElementById("form-pay").addEventListener("submit", onSubmitPay);

  await loadAndRender();
}

// -----------------------------------------------------------------------
async function loadAndRender() {
  const el = document.getElementById("slip-table");
  el.innerHTML = `<p class="muted">Memuat…</p>`;
  await loadData(period);
  renderLockBanner();
  renderSummary();
  renderToolbar();
  renderTable();
  renderPendingHolds(); // tidak ditunggu: daftar gaji tertunda dimuat terpisah
}

async function loadData(p) {
  cutoffDay = await getPayrollCutoffDay();

  // Kalau periode ini sudah difinalisasi, pakai rentang tanggal yang
  // DIBEKUKAN saat itu (bukan hasil hitung ulang dari cutoff sekarang),
  // dan nanti render pakai snapshot payroll_slips, bukan hitung live.
  periodInfo = finalizedPeriods[p] || null;
  periodRange = periodInfo
    ? { start: periodInfo.period_start, end: periodInfo.period_end }
    : payrollPeriodRange(p, cutoffDay);
  const { start, end } = periodRange;

  const [{ data: emp, error: errEmp }, { data: levels }, { data: wages }, { data: salaries }, { data: att }, { data: ot }, { data: adj }, { data: rules }, { data: schedDays }, { data: types }, { data: alw }, { data: slips }, { data: locs }, { data: ovr }] = await Promise.all([
    supabase.from("profiles").select("*").order("full_name"), // termasuk nonaktif: yang resign di tengah/akhir periode tetap digaji (disaring di bawah)
    supabase.from("job_levels").select("*"),
    supabase.from("wage_history").select("*").lte("effective_date", end).order("effective_date", { ascending: false }),
    supabase.from("salary_history").select("*").lte("effective_date", end).order("effective_date", { ascending: false }),
    supabase.from("attendance").select("*").gte("date", start).lte("date", end),
    supabase.from("overtime_requests").select("*").eq("status", "approved").gte("date", start).lte("date", end),
    supabase.from("payroll_adjustments").select("*").eq("period", p),
    supabase.from("late_penalty_rules").select("*").eq("is_active", true).order("menit_offset", { ascending: true }),
    supabase.from("work_schedule_days").select("*"),
    supabase.from("allowance_types").select("*").eq("is_active", true),
    supabase.from("employee_allowances").select("*").eq("is_active", true),
    periodInfo ? supabase.from("payroll_slips").select("*").eq("period", p) : Promise.resolve({ data: [] }),
    supabase.from("office_locations").select("name, timezone"),
    supabase.from("schedule_overrides").select("user_id, work_date, schedule_id").gte("work_date", start).lte("work_date", end),
  ]);

  if (errEmp) { toast("Gagal memuat data karyawan: " + errEmp.message, "error"); }

  employees = emp || []; // termasuk yg status/grade-nya belum diatur (biar admin tahu perlu dilengkapi)
  // Karyawan NONAKTIF (resign) tetap masuk slip periode yang masih mencakup masa
  // kerjanya: resign_date >= awal periode. Kalau resign_date belum diisi, dianggap
  // masih relevan bila punya absensi di periode ini. Periode yang sudah
  // difinalisasi memakai roster snapshot (lihat getSlipList).
  const punyaAbsen = new Set((att || []).map(a => a.user_id));
  employees = employees.filter(e => {
    if (e.is_active) return true;
    if (periodInfo) return true; // periode final: disaring lagi lewat snapshot di getSlipList
    if (e.resign_date) return e.resign_date >= start;
    return punyaAbsen.has(e.id);
  });
  // Karyawan biasa hanya boleh lihat baris dirinya sendiri, walau query di
  // atas tidak difilter per user_id — RLS profiles sebenarnya sudah
  // otomatis membatasi ini di sisi database, filter di sini cuma jaga-jaga
  // tambahan di sisi tampilan supaya tetap benar walau RLS-nya nanti
  // berubah.
  if (roleFlags.isKaryawan && currentUser) {
    employees = employees.filter(e => e.id === currentUser.id);
  }
  jobLevels = levels || [];

  wageByUser = groupByUserSorted(wages);
  salaryByUser = groupByUserSorted(salaries);

  attendanceByUser = {};
  (att || []).forEach(a => { (attendanceByUser[a.user_id] ??= []).push(a); });

  overtimeByUser = {};
  (ot || []).forEach(o => { (overtimeByUser[o.user_id] ??= []).push(o); });

  adjByUser = {};
  (adj || []).forEach(a => { adjByUser[a.user_id] = a; });

  penaltyRules = { telat: { weekday: [], saturday: [] }, pulang_cepat: { weekday: [], saturday: [] } };
  (rules || []).forEach(r => { (penaltyRules[r.jenis]?.[r.day_type] ?? []).push(r); });

  // Jam masuk/pulang per (jadwal, hari-dalam-minggu) -- dipakai resolveShiftWindow()
  // supaya denda telat/pulang-cepat dihitung relatif thd jadwal MASING-MASING
  // karyawan, bukan jam dinding tetap (lihat komentar di hitungDendaTelat).
  scheduleDaysByKey = {};
  (schedDays || []).forEach(d => { scheduleDaysByKey[`${d.schedule_id}_${d.day_of_week}`] = d; });
  overrideByKey = {};
  (ovr || []).forEach(o => { overrideByKey[`${o.user_id}_${o.work_date}`] = o.schedule_id; });

  tzByLokasi = {};
  (locs || []).forEach(l => { tzByLokasi[l.name] = l.timezone; });

  const typeNameById = {};
  (types || []).forEach(t => { typeNameById[t.id] = t.nama; });
  allowancesByUser = {};
  (alw || []).forEach(a => {
    const nama = typeNameById[a.allowance_type_id];
    if (!nama) return; // jenisnya sudah dinonaktifkan, jangan dihitung
    (allowancesByUser[a.user_id] ??= []).push({ nama, nominal: a.nominal || 0 });
  });

  // Cicilan kasbon yang jatuh di periode ini (dipotong otomatis). Kalau SQL 010
  // belum dijalankan / paket tanpa fitur kasbon, hasilnya kosong -> tidak ada potongan.
  loanByUser = {};
  const { data: loanInst } = await supabase.from("loan_installments")
    .select("user_id, loan_id, seq, amount, status").eq("period", p).in("status", ["scheduled", "paid"]);
  (loanInst || []).forEach(i => { (loanByUser[i.user_id] ??= []).push(i); });

  // Reimbursement yang disetujui & dijadwalkan dibayar di periode ini. Kosong kalau
  // SQL 011 belum dijalankan / paket tanpa fitur reimburse.
  claimByUser = {};
  const { data: claimRows } = await supabase.from("expense_claims")
    .select("user_id, amount, category, expense_date").eq("pay_period", p).in("status", ["approved", "paid"]);
  (claimRows || []).forEach(c => { (claimByUser[c.user_id] ??= []).push(c); });

  frozenSlipsByUser = {};
  slipMetaByUser = {};
  (slips || []).forEach(s => { frozenSlipsByUser[s.user_id] = s.snapshot; slipMetaByUser[s.user_id] = s; });
  // Kolom pay_status ada hanya kalau SQL 026 sudah dijalankan. Untuk periode draft
  // (tidak ada baris slip) dianggap siap — kontrol tahan/rilis memang hanya untuk periode final.
  payReady = !periodInfo || (slips || []).every(s => s.pay_status !== undefined);
}

// -----------------------------------------------------------------------
// MODE FINAL vs DRAFT
// Kalau periode sudah difinalisasi (periodInfo != null), semua tampilan
// (ringkasan, tabel, modal detail, export) pakai snapshot yang dibekukan
// di payroll_slips — TIDAK dihitung ulang dari absensi/tarif yang berlaku
// sekarang. Kalau belum, tetap dihitung live seperti sebelumnya.
// -----------------------------------------------------------------------
function getSlipList() {
  if (periodInfo) {
    // Roster yang ditampilkan = karyawan yang benar-benar punya slip beku
    // saat difinalisasi (karyawan baru sesudahnya tidak ikut nongol di
    // periode lama; karyawan yang keluar setelahnya tetap tampil di sini).
    return employees
      .map(e => frozenSlipsByUser[e.id] && { ...frozenSlipsByUser[e.id], pay: slipMetaByUser[e.id] })
      .filter(Boolean)
      // Slip yang ditahan tidak boleh tampil di tampilan "slip saya" (RLS sudah menyembunyikannya
      // untuk Karyawan biasa; filter ini menutup kasus staff yang membuka menu Slip Gaji Saya).
      .filter(x => !(roleFlags.isKaryawan && x.pay?.pay_status === "ditahan"));
  }
  return employees.map(computeSlip);
}

function getSlip(userId) {
  if (periodInfo) return frozenSlipsByUser[userId] || null;
  const emp = employees.find(e => e.id === userId);
  return emp ? computeSlip(emp) : null;
}

function renderLockBanner() {
  const el = document.getElementById("slip-lock-banner");
  if (!el) return;
  if (roleFlags.isKaryawan) { el.innerHTML = ""; return; } // status finalisasi tidak relevan buat karyawan, cukup lihat slipnya saja
  if (periodInfo) {
    const namaPenetap = employees.find(e => e.id === periodInfo.finalized_by)?.full_name || "—";
    el.innerHTML = `
      <div class="pg-banner pg-banner-ok">
        <span class="pg-banner-icon">🔒</span>
        <div class="pg-banner-text">
          <strong>Periode Final${payStateBadge()}</strong>
          <span>Difinalisasi oleh ${namaPenetap} pada ${fmtDate(periodInfo.finalized_at)}. Nilai di bawah dibekukan, tidak berubah walau pengaturan cut-off/tarif berubah lagi nanti.</span>
        </div>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          ${(payReady && roleFlags.canManagePay && siapItems().length) ? `<button id="btn-pay-all" class="btn-primary">💸 Tandai semua dibayar (${siapItems().length})</button>` : ""}
          ${roleFlags.canFinalize ? `<button id="btn-unlock-period" class="btn-secondary">🔓 Buka Kunci</button>` : ""}
        </div>
      </div>`;
    document.getElementById("btn-unlock-period")?.addEventListener("click", onUnlock);
    document.getElementById("btn-pay-all")?.addEventListener("click", () => {
      const items = siapItems();
      const nTahan = Object.values(slipMetaByUser).filter(m => m.pay_status === "ditahan").length;
      openPayModal("bayar", items, `${items.length} slip berstatus Siap${nTahan ? ` (${nTahan} yang ditahan tidak ikut)` : ""} — periode ${periodLabel(period)}`);
    });
  } else {
    el.innerHTML = `
      <div class="pg-banner pg-banner-warn">
        <span class="pg-banner-icon">📝</span>
        <div class="pg-banner-text">
          <strong>Draft</strong>
          <span>Nilai masih dihitung otomatis dan bisa berubah kalau absensi/lembur/tarif/pengaturan cut-off diubah.${roleFlags.canFinalize ? " Finalisasi untuk mengunci angka periode ini." : " Menunggu Super Admin memfinalisasi periode ini."}</span>
        </div>
        ${roleFlags.canFinalize ? `<button id="btn-finalize-period" class="btn-primary">🔒 Finalisasi Periode Ini</button>` : ""}
      </div>`;
    document.getElementById("btn-finalize-period")?.addEventListener("click", onFinalize);
  }
}

// Slip periode terpilih yang berstatus Siap (belum ditahan/dibayar).
function siapItems() {
  return Object.values(slipMetaByUser)
    .filter(m => (m.pay_status || "siap") === "siap")
    .map(m => ({ period, userId: m.user_id }));
}

// Lencana alur pembayaran periode: Belum dibayar -> Sebagian dibayar -> Lunas.
function payStateBadge() {
  if (!payReady) return "";
  const metas = Object.values(slipMetaByUser);
  if (!metas.length) return "";
  const dibayar = metas.filter(m => m.pay_status === "dibayar").length;
  const ditahan = metas.filter(m => m.pay_status === "ditahan").length;
  let txt, cls;
  if (dibayar === metas.length) { txt = "Lunas"; cls = "badge-ok"; }
  else if (dibayar > 0) { txt = `Sebagian dibayar (${dibayar}/${metas.length})`; cls = "badge-warn"; }
  else { txt = "Belum dibayar"; cls = "badge-muted"; }
  return ` <span class="badge ${cls}" style="margin-left:8px;">${txt}</span>${ditahan ? ` <span class="badge badge-warn">${ditahan} ditahan</span>` : ""}`;
}

async function onFinalize() {
  if (!roleFlags.canFinalize) { toast("Hanya Super Admin yang bisa finalisasi periode.", "error"); return; }
  if (!employees.length) { toast("Tidak ada data karyawan untuk difinalisasi", "error"); return; }
  const ok = await confirmDialog({
    title: `Finalisasi periode ${periodLabel(period)}?`,
    message: "Setelah ini, angka slip gaji periode ini dikunci dan tidak akan berubah otomatis lagi walau cut-off/tarif diubah di kemudian hari. Bisa dibuka kunci lagi kalau perlu dikoreksi.",
    confirmLabel: "Finalisasi",
  });
  if (!ok) return;

  const { data: inserted, error: errPeriod } = await supabase.from("payroll_periods").insert({
    period,
    period_start: periodRange.start,
    period_end: periodRange.end,
    cutoff_start_day: cutoffDay,
    finalized_by: currentUser.id,
  }).select().single();
  if (errPeriod) { toast("Gagal finalisasi: " + errPeriod.message, "error"); return; }

  const rows = employees.map(emp => {
    const slip = computeSlip(emp);
    return { period, user_id: emp.id, snapshot: slip, gaji_bersih: slip.gajiBersih };
  });
  const { error: errSlips } = await supabase.from("payroll_slips").insert(rows);
  if (errSlips) {
    // rollback baris payroll_periods supaya tidak nyangkut setengah-jadi
    await supabase.from("payroll_periods").delete().eq("period", period);
    toast("Gagal menyimpan slip: " + errSlips.message, "error");
    return;
  }

  finalizedPeriods[period] = inserted;
  toast("Periode berhasil difinalisasi", "success");
  await loadAndRender();
}

async function onUnlock() {
  if (!roleFlags.canFinalize) { toast("Hanya Super Admin yang bisa membuka kunci periode.", "error"); return; }
  const metas = Object.values(slipMetaByUser);
  const nDibayar = metas.filter(m => m.pay_status === "dibayar").length;
  const nDitahan = metas.filter(m => m.pay_status === "ditahan").length;
  if (nDibayar) { toast(`Tidak bisa buka kunci: ${nDibayar} slip sudah ditandai dibayar. Batalkan status dibayarnya dulu.`, "error"); return; }
  const ok = await confirmDialog({
    title: `Buka kunci periode ${periodLabel(period)}?`,
    message: "Slip yang sudah dibekukan akan dihapus dan periode ini kembali ke mode draft (dihitung live). Angka bisa jadi berbeda dari yang tadinya sudah dicetak, sampai difinalisasi ulang." +
      (nDitahan ? ` Perhatian: ${nDitahan} slip yang sedang ditahan akan kehilangan status tahannya.` : ""),
    confirmLabel: "Buka Kunci",
    confirmClass: "btn-outline-danger",
  });
  if (!ok) return;

  const { error } = await supabase.from("payroll_periods").delete().eq("period", period);
  if (error) { toast("Gagal membuka kunci: " + error.message, "error"); return; }

  delete finalizedPeriods[period];
  toast("Periode dibuka kunci, kembali ke mode draft", "success");
  await loadAndRender();
}

function groupByUserSorted(rows) {
  const map = {};
  (rows || []).forEach(r => { (map[r.user_id] ??= []).push(r); });
  return map; // sudah urut desc dari query
}

// -----------------------------------------------------------------------
// PERHITUNGAN SATU SLIP
// -----------------------------------------------------------------------
// Kepesertaan BPJS per karyawan (022_bpjs_kepesertaan.sql). Dipotong hanya kalau
// status "aktif" DAN tanggal mulai dipotong <= akhir periode slip (kosong = sejak awal).
// status === undefined = kolom belum ada di database (SQL belum dijalankan) -> perilaku
// lama (selalu dipotong) supaya slip tidak mendadak nol.
function bpjsPotongan(status, mulai, periodEnd) {
  if (status === undefined) return { aktif: true, ket: "" };
  if (status === "belum") return { aktif: false, ket: "belum terdaftar" };
  if (status === "berhenti") return { aktif: false, ket: "tidak aktif" };
  if (status === "aktif" && mulai && periodEnd && mulai > periodEnd) return { aktif: false, ket: `mulai ${fmtDate(mulai)}` };
  return { aktif: status === "aktif", ket: "" };
}

function computeSlip(emp) {
  const level = jobLevels.find(l => l.grade === emp.grade && l.level === emp.level) || null;
  const attRows = attendanceByUser[emp.id] || [];
  const hariHadir = attRows.filter(a => a.check_in).length;
  const hariTelat = attRows.filter(a => a.check_in_status === "telat").length;

  const otRows = overtimeByUser[emp.id] || [];
  const jamHari = (o) => o.total_jam ?? roundOvertimeHours(o.start_time, o.end_time);
  const jamLemburBiasa = otRows.filter(o => !o.is_hari_libur).reduce((s, o) => s + jamHari(o), 0);
  const jamLemburLibur = otRows.filter(o => o.is_hari_libur).reduce((s, o) => s + jamHari(o), 0);

  // Denda keterlambatan & pulang cepat — dihitung per hari dari jam
  // check-in/check-out asli terhadap tabel jam bertingkat di Master Denda
  // Telat (bukan dari status telat/tepat-waktu jadwal kerja, yang dipakai
  // untuk keperluan monitoring absensi saja). Hanya totalnya yang tampil
  // di slip gaji karyawan, rincian per hari tidak dicetak.
  let dendaKeterlambatan = 0;
  let dendaPulangCepat = 0;
  const dendaDasar = level?.denda_terlambat || 0;
  const tz = tzByLokasi[emp.lokasi_kerja]; // zona waktu cabang tempat karyawan ini ditempatkan
  for (const a of attRows) {
    const dow = dayOfWeekFromDateStr(a.date);
    const shift = resolveShiftWindow(emp, dow, a.date);
    const telat = hitungDendaTelat(a.check_in, dow, dendaDasar, tz, shift);
    if (telat) dendaKeterlambatan += telat.amount;
    const cepat = hitungDendaPulangCepat(a.check_out, dow, dendaDasar, tz, shift);
    if (cepat) dendaPulangCepat += cepat.amount;
  }

  const adj = adjByUser[emp.id] || { hari_dinas: 0, tunjangan_lain: 0, keterangan_tunjangan: "", potongan_lain: 0, keterangan_potongan: "" };

  let gajiPokok = 0;
  let gajiPokokLabel = "-";
  if (emp.status_karyawan === "bulanan") {
    const s = (salaryByUser[emp.id] || [])[0];
    gajiPokok = s ? s.monthly_salary : 0;
    gajiPokokLabel = "Gaji Bulanan";
  } else if (emp.status_karyawan === "harian") {
    const w = (wageByUser[emp.id] || [])[0];
    gajiPokok = w ? w.daily_wage * hariHadir : 0;
    gajiPokokLabel = w ? `Upah Harian (${fmtRupiah(w.daily_wage)} x ${hariHadir} hari)` : "Upah Harian";
  }

  const rateLemburBiasa = level?.upah_lembur_hari_biasa || 0;
  const rateLemburLibur = level?.upah_lembur_hari_libur || 0;
  const uangLembur = jamLemburBiasa * rateLemburBiasa + jamLemburLibur * rateLemburLibur;
  const uangDinas = (adj.hari_dinas || 0) * (level?.uang_perjalanan_dinas || 0);
  const tunjanganList = allowancesByUser[emp.id] || []; // dari Master Tunjangan, per karyawan
  const tunjanganTambahan = tunjanganList.reduce((s, t) => s + (t.nominal || 0), 0);
  const tunjanganLain = adj.tunjangan_lain || 0;
  const totalPendapatan = gajiPokok + uangLembur + uangDinas + tunjanganTambahan + tunjanganLain;

  const upahLapor = level?.upah_lapor_bpjs || 0;
  const bpjsKes = bpjsPotongan(emp.bpjs_kes_status, emp.bpjs_kes_mulai, periodRange?.end);
  const bpjsTk = bpjsPotongan(emp.bpjs_tk_status, emp.bpjs_tk_mulai, periodRange?.end);
  const bpjsKesKaryawan = bpjsKes.aktif ? upahLapor * (level?.bpjs_kesehatan_karyawan_persen || 0) / 100 : 0;
  const bpjsTkKaryawan = bpjsTk.aktif ? upahLapor * (level?.bpjs_tk_karyawan_persen || 0) / 100 : 0;
  const pph21 = totalPendapatan * (level?.pph21_persen || 0) / 100;
  const potonganLain = adj.potongan_lain || 0;
  const potonganKasbon = (loanByUser[emp.id] || []).reduce((s, i) => s + Number(i.amount || 0), 0);
  const totalPotongan = dendaKeterlambatan + dendaPulangCepat + bpjsKesKaryawan + bpjsTkKaryawan + pph21 + potonganLain + potonganKasbon;

  // Reimbursement = penggantian biaya, BUKAN penghasilan: tidak masuk dasar PPh21,
  // hanya ditambahkan ke take home pay.
  const reimbursement = (claimByUser[emp.id] || []).reduce((s, c) => s + Number(c.amount || 0), 0);
  const gajiBersih = totalPendapatan - totalPotongan + reimbursement;

  return {
    emp, level, adj, hariHadir, hariTelat, jamLemburBiasa, jamLemburLibur,
    gajiPokok, gajiPokokLabel, rateLemburBiasa, rateLemburLibur, uangLembur, uangDinas, tunjanganList, tunjanganTambahan, tunjanganLain, totalPendapatan,
    dendaKeterlambatan, dendaPulangCepat, upahLapor, bpjsKesKaryawan, bpjsTkKaryawan, bpjsKesKet: bpjsKes.ket, bpjsTkKet: bpjsTk.ket, pph21, potonganLain, potonganKasbon, totalPotongan, reimbursement, gajiBersih,
  };
}

// -----------------------------------------------------------------------
function renderSummary() {
  const el = document.getElementById("slip-summary");
  if (roleFlags.isKaryawan) { el.innerHTML = ""; return; } // ringkasan agregat cuma relevan buat staff yang lihat banyak karyawan
  const slips = getSlipList();
  const totalBersih = slips.reduce((s, x) => s + x.gajiBersih, 0);
  const totalLembur = slips.reduce((s, x) => s + x.jamLemburBiasa + x.jamLemburLibur, 0);
  const belumDiatur = slips.filter(x => !x.emp.status_karyawan).length;

  const svg = paths => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  el.innerHTML = `
    <div class="dash-stat">
      <div class="dash-stat-top"><span class="dash-stat-icon">${svg('<path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/>')}</span><span class="dash-stat-label">Karyawan</span></div>
      <div class="dash-stat-value">${slips.length}</div>
    </div>
    <div class="dash-stat ok">
      <div class="dash-stat-top"><span class="dash-stat-icon">${svg('<path d="M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/>')}</span><span class="dash-stat-label">Total Gaji Bersih</span></div>
      <div class="dash-stat-value dash-stat-value-sm">${fmtRupiah(totalBersih)}</div>
    </div>
    <div class="dash-stat">
      <div class="dash-stat-top"><span class="dash-stat-icon">${svg('<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>')}</span><span class="dash-stat-label">Total Jam Lembur</span></div>
      <div class="dash-stat-value">${fmtJam(totalLembur)}</div>
    </div>
    ${(periodInfo && payReady) ? (() => {
      const sum = st => slips.filter(x => (x.pay?.pay_status || "siap") === st).reduce((a, x) => a + x.gajiBersih, 0);
      const cnt = st => slips.filter(x => (x.pay?.pay_status || "siap") === st).length;
      return `
    <div class="dash-stat ok slp-click" data-filter="dibayar" title="Klik untuk memfilter">
      <div class="dash-stat-top"><span class="dash-stat-icon">${svg('<path d="M20 6L9 17l-5-5"/>')}</span><span class="dash-stat-label">Sudah Dibayar (${cnt("dibayar")})</span></div>
      <div class="dash-stat-value dash-stat-value-sm">${fmtRupiah(sum("dibayar"))}</div>
    </div>
    ${cnt("ditahan") ? `<div class="dash-stat warn slp-click" data-filter="ditahan" title="Klik untuk memfilter">
      <div class="dash-stat-top"><span class="dash-stat-icon">${svg('<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/>')}</span><span class="dash-stat-label">Ditahan (${cnt("ditahan")})</span></div>
      <div class="dash-stat-value dash-stat-value-sm">${fmtRupiah(sum("ditahan"))}</div>
    </div>` : ""}`;
    })() : ""}
    ${belumDiatur ? `
    <div class="dash-stat warn">
      <div class="dash-stat-top"><span class="dash-stat-icon">${svg('<path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><path d="M12 9v4M12 17h.01"/>')}</span><span class="dash-stat-label">Status Karyawan Belum Diatur</span></div>
      <div class="dash-stat-value">${belumDiatur}</div>
    </div>` : ""}
  `;
  el.querySelectorAll("[data-filter]").forEach(card => card.addEventListener("click", () => {
    viewState.status = viewState.status === card.dataset.filter ? "semua" : card.dataset.filter;
    viewState.page = 1;
    renderToolbar(); renderTable();
  }));
}

function renderTable() {
  const el = document.getElementById("slip-table");
  const slips = getSlipList();
  // Kartu slip Karyawan tidak dibungkus .table-wrap (supaya tidak dobel border).
  el.classList.toggle("table-wrap", !(roleFlags.isKaryawan && slips.length === 1));
  if (!slips.length) { el.innerHTML = `<p class="muted">${periodInfo ? (roleFlags.isKaryawan ? "Slip gaji periode ini belum tersedia. Hubungi HR/Admin jika perlu." : "Tidak ada slip yang difinalisasi untuk periode ini.") : "Belum ada data karyawan aktif."}</p>`; return; }

  // Tampilan Karyawan (1 slip = dirinya sendiri): kartu ringkasan, bukan
  // tabel satu baris. Tombol tetap memakai class .btn-detail supaya handler
  // klik di bawah dipakai bersama.
  if (roleFlags.isKaryawan && slips.length === 1) {
    const s = slips[0];
    const statusBadge = s.emp.status_karyawan
      ? `<span class="badge badge-ok">${s.emp.status_karyawan === "bulanan" ? "Bulanan" : "Harian"}</span>`
      : `<span class="badge badge-warn">Status belum diatur</span>`;
    el.innerHTML = `
      <div class="pg-slip">
        <div class="pg-slip-head">
          <div>
            <h2>${escapeHtml(s.emp.full_name)}</h2>
            <p class="pg-slip-meta">${s.emp.grade ? `${escapeHtml(s.emp.grade)} — ${escapeHtml(s.emp.level || "-")}` : "Grade belum diatur"} ${statusBadge}</p>
          </div>
          <button type="button" class="btn-primary btn-detail" data-id="${s.emp.id}">Lihat Detail &amp; Cetak Slip</button>
        </div>
        <div class="pg-slip-grid">
          <div><span class="pg-slip-label">Hadir / Telat</span><span class="pg-slip-value">${s.hariHadir} / ${s.hariTelat} <small>hari</small></span></div>
          <div><span class="pg-slip-label">Lembur</span><span class="pg-slip-value">${fmtJam(s.jamLemburBiasa + s.jamLemburLibur)}</span></div>
          <div><span class="pg-slip-label">Gaji Pokok</span><span class="pg-slip-value">${fmtRupiah(s.gajiPokok)}</span></div>
          <div class="pg-slip-net ${s.gajiBersih < 0 ? "neg" : ""}"><span class="pg-slip-label">Gaji Bersih</span><span class="pg-slip-value">${fmtRupiah(s.gajiBersih)}</span></div>
        </div>
      </div>
    `;
    el.querySelectorAll(".btn-detail").forEach(btn => {
      btn.addEventListener("click", () => openSlipModal(btn.dataset.id));
    });
    return;
  }

  // Tampilan staff: dicari/difilter, dibagi per halaman, bisa dipilih massal.
  const showPay = !!(periodInfo && payReady && !roleFlags.isKaryawan);
  const canBulk = showPay && roleFlags.canManagePay;
  const filtered = filteredSlips();
  const total = filtered.length;
  const pages = Math.max(1, Math.ceil(total / viewState.pageSize));
  viewState.page = Math.min(Math.max(1, viewState.page), pages);
  const from = (viewState.page - 1) * viewState.pageSize;
  const pageRows = filtered.slice(from, from + viewState.pageSize);
  renderBulkBar();
  renderPager(total, pages, from, pageRows.length);

  if (!total) { el.innerHTML = `<p class="muted" style="padding:16px;">Tidak ada karyawan yang cocok dengan filter/pencarian.</p>`; return; }

  const allSelected = canBulk && filtered.every(s => viewState.selected.has(s.emp.id));
  el.innerHTML = `
    <table class="table">
      <thead>
        <tr>
          ${canBulk ? `<th style="width:34px;"><input type="checkbox" class="slp-chk" id="slp-chk-all" title="Pilih semua hasil filter (${total})" ${allSelected ? "checked" : ""}></th>` : ""}
          <th>Nama</th><th>Grade</th><th>Status</th>
          <th>Hadir / Telat</th><th>Lembur</th>
          <th>Gaji Pokok</th><th>Gaji Bersih</th>${showPay ? "<th>Pembayaran</th>" : ""}<th></th>
        </tr>
      </thead>
      <tbody>
        ${pageRows.map(s => `
          <tr>
            ${canBulk ? `<td><input type="checkbox" class="slp-chk slp-chk-row" data-id="${s.emp.id}" ${viewState.selected.has(s.emp.id) ? "checked" : ""}></td>` : ""}
            <td>${escapeHtml(s.emp.full_name)}</td>
            <td>${s.emp.grade ? `${escapeHtml(s.emp.grade)} — ${escapeHtml(s.emp.level || "-")}` : `<span class="muted">-</span>`}</td>
            <td>${s.emp.status_karyawan
              ? `<span class="badge badge-ok">${s.emp.status_karyawan === "bulanan" ? "Bulanan" : "Harian"}</span>`
              : `<span class="badge badge-warn">Belum diatur</span>`}</td>
            <td>${s.hariHadir} / ${s.hariTelat}</td>
            <td>${fmtJam(s.jamLemburBiasa + s.jamLemburLibur)}</td>
            <td>${fmtRupiah(s.gajiPokok)}</td>
            <td><strong>${fmtRupiah(s.gajiBersih)}</strong></td>
            ${showPay ? `<td>${payCellHtml(s)}</td>` : ""}
            <td><button class="btn-link btn-detail" data-id="${s.emp.id}">Detail &amp; Cetak</button></td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;

  el.querySelectorAll(".btn-detail").forEach(btn => {
    btn.addEventListener("click", () => openSlipModal(btn.dataset.id));
  });
  el.querySelectorAll(".slp-menu-btn").forEach(btn => {
    btn.addEventListener("click", ev => { ev.stopPropagation(); openRowMenu(btn); });
  });
  el.querySelectorAll(".slp-chk-row").forEach(cb => cb.addEventListener("change", () => {
    if (cb.checked) viewState.selected.add(cb.dataset.id); else viewState.selected.delete(cb.dataset.id);
    renderTable();
  }));
  document.getElementById("slp-chk-all")?.addEventListener("change", e => {
    if (e.target.checked) filtered.forEach(s => viewState.selected.add(s.emp.id));
    else filtered.forEach(s => viewState.selected.delete(s.emp.id));
    renderTable();
  });
}

// Daftar yang tampil: setelah pencarian nama/kode, filter departemen, dan filter status bayar.
function filteredSlips() {
  const q = viewState.q.trim().toLowerCase();
  const usePay = !!(periodInfo && payReady);
  return getSlipList().filter(s => {
    if (q && !`${s.emp.full_name || ""} ${s.emp.employee_code || ""}`.toLowerCase().includes(q)) return false;
    if (viewState.dept && (s.emp.department || "") !== viewState.dept) return false;
    if (usePay && viewState.status !== "semua" && payStatusOf(s) !== viewState.status) return false;
    return true;
  });
}

function renderToolbar() {
  const el = document.getElementById("slip-toolbar");
  if (!el) return;
  if (roleFlags.isKaryawan) { el.innerHTML = ""; return; }
  const all = getSlipList();
  const usePay = !!(periodInfo && payReady);
  if (!usePay) viewState.status = "semua";
  const depts = [...new Set(all.map(s => s.emp.department).filter(Boolean))].sort();
  const cnt = st => all.filter(s => payStatusOf(s) === st).length;
  const tabs = [["semua", "Semua", all.length], ["siap", "Siap", cnt("siap")], ["ditahan", "Ditahan", cnt("ditahan")], ["dibayar", "Dibayar", cnt("dibayar")]];
  el.innerHTML = `
    <div class="slp-toolbar">
      ${usePay ? `<div class="slp-tabs">${tabs.map(([k, label, n]) =>
        `<button type="button" class="slp-tab ${viewState.status === k ? "active" : ""}" data-status="${k}">${label}<small>${n}</small></button>`).join("")}</div>` : "<span></span>"}
      <div class="slp-filters">
        <input type="search" id="slp-q" placeholder="Cari nama / kode karyawan…" value="${escapeHtml(viewState.q)}">
        ${depts.length > 1 ? `<select id="slp-dept"><option value="">Semua departemen</option>${depts.map(d => `<option value="${escapeHtml(d)}" ${viewState.dept === d ? "selected" : ""}>${escapeHtml(d)}</option>`).join("")}</select>` : ""}
      </div>
    </div>`;
  el.querySelectorAll(".slp-tab").forEach(b => b.addEventListener("click", () => {
    viewState.status = b.dataset.status; viewState.page = 1;
    renderToolbar(); renderTable();
  }));
  let t = null;
  document.getElementById("slp-q").addEventListener("input", e => {
    clearTimeout(t);
    t = setTimeout(() => { viewState.q = e.target.value; viewState.page = 1; renderTable(); }, 200);
  });
  document.getElementById("slp-dept")?.addEventListener("change", e => { viewState.dept = e.target.value; viewState.page = 1; renderTable(); });
}

function renderPager(total, pages, from, shown) {
  const el = document.getElementById("slip-pager");
  if (!el) return;
  if (roleFlags.isKaryawan || !total) { el.innerHTML = ""; return; }
  el.innerHTML = `
    <div class="slp-pager">
      <span class="muted">Menampilkan ${from + 1}–${from + shown} dari ${total} karyawan</span>
      <div class="slp-pager-nav">
        <label class="small muted">Per halaman
          <select id="slp-size">${[25, 50, 100].map(n => `<option value="${n}" ${viewState.pageSize === n ? "selected" : ""}>${n}</option>`).join("")}</select>
        </label>
        <button type="button" class="btn-secondary" id="slp-prev" ${viewState.page <= 1 ? "disabled" : ""}>‹</button>
        <span>Hal. ${viewState.page} / ${pages}</span>
        <button type="button" class="btn-secondary" id="slp-next" ${viewState.page >= pages ? "disabled" : ""}>›</button>
      </div>
    </div>`;
  document.getElementById("slp-prev").addEventListener("click", () => { viewState.page--; renderTable(); });
  document.getElementById("slp-next").addEventListener("click", () => { viewState.page++; renderTable(); });
  document.getElementById("slp-size").addEventListener("change", e => { viewState.pageSize = Number(e.target.value); viewState.page = 1; renderTable(); });
}

// Bar aksi massal: muncul begitu ada karyawan yang dicentang.
function renderBulkBar() {
  const el = document.getElementById("slip-bulkbar");
  if (!el) return;
  const usePay = !!(periodInfo && payReady && !roleFlags.isKaryawan && roleFlags.canManagePay);
  if (!usePay || !viewState.selected.size) { el.innerHTML = ""; return; }
  const chosen = getSlipList().filter(s => viewState.selected.has(s.emp.id));
  const by = st => chosen.filter(s => payStatusOf(s) === st).map(s => ({ period, userId: s.emp.id }));
  const siap = by("siap"), ditahan = by("ditahan"), dibayar = by("dibayar");
  const bayarItems = [...siap, ...ditahan];
  el.innerHTML = `
    <div class="slp-bulk">
      <strong>${chosen.length} dipilih</strong>
      ${bayarItems.length ? `<button type="button" class="btn-primary" id="bk-bayar">Tandai dibayar (${bayarItems.length})</button>` : ""}
      ${siap.length ? `<button type="button" class="btn-secondary" id="bk-tahan">Tahan (${siap.length})</button>` : ""}
      ${ditahan.length ? `<button type="button" class="btn-secondary" id="bk-lepas">Lepas tahan (${ditahan.length})</button>` : ""}
      ${dibayar.length ? `<span class="small muted">${dibayar.length} sudah dibayar (dilewati)</span>` : ""}
      <button type="button" class="btn-link" id="bk-clear">Batal pilihan</button>
    </div>`;
  const label = `${chosen.length} karyawan — periode ${periodLabel(period)}`;
  document.getElementById("bk-bayar")?.addEventListener("click", () => openPayModal("bayar", bayarItems, label));
  document.getElementById("bk-tahan")?.addEventListener("click", () => openPayModal("tahan", siap, label));
  document.getElementById("bk-lepas")?.addEventListener("click", () => openPayModal("lepas", ditahan, label));
  document.getElementById("bk-clear").addEventListener("click", () => { viewState.selected = new Set(); renderTable(); });
}

// -----------------------------------------------------------------------
// TAHAN / RILIS GAJI (SQL 026)
// -----------------------------------------------------------------------
function payCellHtml(s) {
  const st = payStatusOf(s);
  const id = s.emp.id, nm = escapeHtml(s.emp.full_name);
  const cls = { siap: "badge-muted", ditahan: "badge-warn", dibayar: "badge-ok" }[st];
  const tip = st === "ditahan" ? (s.pay?.hold_reason || "")
    : st === "dibayar" ? `${s.pay?.paid_at ? fmtDate(s.pay.paid_at) : ""}${s.pay?.pay_note ? " · " + s.pay.pay_note : ""}` : "";
  const canMenu = roleFlags.canManagePay && !(st === "dibayar" && !roleFlags.canFinalize);
  return `
    <div class="slp-paycell">
      <div>
        <span class="badge ${cls}" title="${escapeHtml(tip)}">${PAY_LABEL[st]}</span>
        ${tip ? `<div class="slp-sub" title="${escapeHtml(tip)}">${escapeHtml(tip)}</div>` : ""}
      </div>
      ${canMenu ? `<button type="button" class="slp-menu-btn" aria-label="Aksi pembayaran" aria-haspopup="menu" data-id="${id}" data-name="${nm}" data-st="${st}">⋯</button>` : ""}
    </div>`;
}

// Menu aksi per baris (⋯): isinya menyesuaikan status slip.
let menuEl = null;
let menuListenersOn = false;
function closeRowMenu() { menuEl?.remove(); menuEl = null; }
function openRowMenu(btn) {
  closeRowMenu();
  const st = btn.dataset.st;
  const items = st === "siap" ? [["tahan", "⏸ Tahan gaji"], ["bayar", "✔ Tandai dibayar"]]
    : st === "ditahan" ? [["bayar", "✔ Rilis (tandai dibayar)"], ["lepas", "↩ Lepas tahan"]]
    : roleFlags.canFinalize ? [["batal_bayar", "↩ Batalkan status dibayar"]] : [];
  if (!items.length) return;
  menuEl = document.createElement("div");
  menuEl.className = "slp-menu";
  menuEl.setAttribute("role", "menu");
  menuEl.innerHTML = items.map(([act, label]) => `<button type="button" role="menuitem" data-act="${act}">${label}</button>`).join("");
  document.body.appendChild(menuEl);
  const r = btn.getBoundingClientRect();
  const w = menuEl.offsetWidth, h = menuEl.offsetHeight;
  menuEl.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w)) + "px";
  menuEl.style.top = (r.bottom + h + 8 > window.innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4) + "px";
  menuEl.querySelectorAll("button").forEach(b => b.addEventListener("click", () => {
    closeRowMenu();
    openPayModal(b.dataset.act, [{ period, userId: btn.dataset.id }], `${btn.dataset.name} — periode ${periodLabel(period)}`);
  }));
  if (!menuListenersOn) {
    menuListenersOn = true;
    document.addEventListener("click", ev => { if (menuEl && !menuEl.contains(ev.target)) closeRowMenu(); });
    document.addEventListener("keydown", ev => { if (ev.key === "Escape") closeRowMenu(); });
    window.addEventListener("scroll", closeRowMenu, true);
    window.addEventListener("resize", closeRowMenu);
  }
}

// Modal tahan/rilis dipakai untuk satu slip maupun banyak slip sekaligus.
let payCtx = null; // { action, items: [{ period, userId }] }

function openPayModal(action, items, label) {
  if (!items?.length) { toast("Tidak ada slip yang bisa diproses untuk aksi ini", "error"); return; }
  payCtx = { action, items };
  const form = document.getElementById("form-pay");
  form.reset();
  const titles = { tahan: "Tahan Gaji", bayar: "Rilis / Tandai Dibayar", lepas: "Lepas Tahan", batal_bayar: "Batalkan Status Dibayar" };
  document.getElementById("pay-title").textContent = (items.length > 1 ? `${titles[action]} (${items.length} slip)` : titles[action]) || "Status Pembayaran";
  document.getElementById("pay-emp-label").textContent = label || "";
  document.getElementById("pay-row-reason").classList.toggle("hidden", action !== "tahan");
  document.getElementById("pay-row-paid").classList.toggle("hidden", action !== "bayar");
  if (action === "bayar") form.elements.paid_at.value = dateOnlyISO(new Date());
  const btn = document.getElementById("btn-submit-pay");
  btn.disabled = false;
  btn.textContent = { tahan: "Tahan", bayar: "Rilis", lepas: "Lepas tahan", batal_bayar: "Batalkan status" }[action] || "Simpan";
  document.getElementById("modal-pay").classList.remove("hidden");
}

// Jalankan fungsi async untuk banyak item dengan paralelisme terbatas.
async function runPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try { results[i] = await fn(items[i]); } catch (err) { results[i] = { error: err }; }
    }
  }));
  return results;
}

async function onSubmitPay(e) {
  e.preventDefault();
  if (!payCtx) return;
  const fd = new FormData(e.target);
  const { action, items } = payCtx;
  if (action === "tahan" && !String(fd.get("reason") || "").trim()) { toast("Alasan penahanan wajib diisi", "error"); return; }
  const btn = document.getElementById("btn-submit-pay");
  if (btn.disabled) return;
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = items.length > 1 ? `Memproses 0/${items.length}…` : "Memproses…";
  let done = 0;
  const results = await runPool(items, 6, async it => {
    const res = await supabase.rpc("set_slip_pay_status", {
      p_period: it.period, p_user: it.userId, p_action: action,
      p_reason: fd.get("reason") || null,
      p_paid_at: fd.get("paid_at") || null,
      p_note: fd.get("note") || null,
    });
    done++;
    if (items.length > 1) btn.textContent = `Memproses ${done}/${items.length}…`;
    return res;
  });
  const failed = results.filter(r => r?.error);
  const okCount = results.length - failed.length;
  btn.textContent = label;
  const msg = { tahan: "ditahan", bayar: "dirilis / ditandai dibayar", lepas: "dilepas dari tahanan", batal_bayar: "dibatalkan status dibayarnya" }[action];
  if (failed.length) {
    toast(`${okCount} slip berhasil, ${failed.length} gagal: ${failed[0].error.message}`, "error");
  } else {
    toast(items.length > 1 ? `${okCount} slip ${msg}` : `Slip ${msg}`, "success");
  }
  payCtx = null;
  viewState.selected = new Set(); pendingSel = new Set();
  document.getElementById("modal-pay").classList.add("hidden");
  btn.disabled = false;
  await loadAndRender();
}

// Daftar gaji yang masih ditahan di periode LAIN (mis. gaji periode sebelumnya
// yang belum dirilis), supaya tidak terlupa. Hanya untuk staff; bisa dicentang
// dan dirilis/dilepas langsung dari sini tanpa membuka periodenya.
async function renderPendingHolds() {
  const el = document.getElementById("slip-pending");
  if (!el) return;
  el.innerHTML = "";
  pendingData = [];
  if (roleFlags.isKaryawan || !roleFlags.canManagePay) return;
  const myPeriod = period;
  const { data, error } = await supabase.from("payroll_slips")
    .select("period, user_id, gaji_bersih, hold_reason, held_at, nama:snapshot->emp->>full_name")
    .eq("pay_status", "ditahan").neq("period", period).order("period", { ascending: false });
  if (error || !data?.length) return; // kolom belum ada (SQL 026 belum dijalankan) atau tidak ada yang tertunda
  if (myPeriod !== period) return; // pengguna sudah pindah periode saat query berjalan
  pendingData = data;
  drawPendingHolds();
}

function drawPendingHolds() {
  const el = document.getElementById("slip-pending");
  if (!el || !pendingData.length) return;
  const key = r => `${r.period}|${r.user_id}`;
  const items = () => pendingData.filter(r => pendingSel.has(key(r))).map(r => ({ period: r.period, userId: r.user_id }));
  const nSel = pendingSel.size;
  el.innerHTML = `
    <div class="pg-banner pg-banner-warn" style="flex-direction:column; align-items:stretch; gap:8px;">
      <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center; justify-content:space-between;">
        <div class="pg-banner-text"><strong>⏸ Gaji ditahan di periode lain (${pendingData.length})</strong>
          <span>Belum dirilis. Centang lalu rilis langsung dari sini, atau buka periodenya.</span></div>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          <button type="button" class="btn-primary" id="pd-bayar" ${nSel ? "" : "disabled"}>Rilis terpilih (${nSel})</button>
          <button type="button" class="btn-secondary" id="pd-lepas" ${nSel ? "" : "disabled"}>Lepas tahan</button>
        </div>
      </div>
      <table class="table slp-pend-table" style="margin:0;">
        <thead><tr>
          <th style="width:34px;"><input type="checkbox" class="slp-chk" id="pd-all" ${nSel === pendingData.length ? "checked" : ""}></th>
          <th>Nama</th><th>Periode</th><th>Gaji bersih</th><th>Alasan</th><th></th>
        </tr></thead>
        <tbody>
          ${pendingData.map(r => `
            <tr>
              <td><input type="checkbox" class="slp-chk pd-row" data-key="${escapeHtml(key(r))}" ${pendingSel.has(key(r)) ? "checked" : ""}></td>
              <td>${escapeHtml(r.nama || "—")}</td>
              <td>${escapeHtml(periodLabelFor(r.period))}</td>
              <td><strong>${fmtRupiah(r.gaji_bersih)}</strong></td>
              <td class="small muted">${escapeHtml(r.hold_reason || "")}</td>
              <td><button class="btn-link btn-goto" data-period="${escapeHtml(r.period)}">Buka periode</button></td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>`;
  el.querySelectorAll(".pd-row").forEach(cb => cb.addEventListener("change", () => {
    if (cb.checked) pendingSel.add(cb.dataset.key); else pendingSel.delete(cb.dataset.key);
    drawPendingHolds();
  }));
  document.getElementById("pd-all").addEventListener("change", e => {
    pendingSel = e.target.checked ? new Set(pendingData.map(key)) : new Set();
    drawPendingHolds();
  });
  const label = () => `${pendingSel.size} slip dari periode sebelumnya`;
  document.getElementById("pd-bayar").addEventListener("click", () => openPayModal("bayar", items(), label()));
  document.getElementById("pd-lepas").addEventListener("click", () => openPayModal("lepas", items(), label()));
  el.querySelectorAll(".btn-goto").forEach(btn => btn.addEventListener("click", () => {
    const sel = document.getElementById("filter-period");
    const val = btn.dataset.period;
    if (sel.tagName === "SELECT" && ![...sel.options].some(o => o.value === val)) {
      sel.add(new Option(periodLabelFor(val), val));
    }
    sel.value = val;
    period = val;
    viewState.status = "semua"; viewState.page = 1; viewState.selected = new Set();
    loadAndRender();
  }));
}

function periodLabelFor(p) {
  const f = finalizedPeriods[p];
  return f ? `${fmtDate(f.period_start)} – ${fmtDate(f.period_end)}` : p;
}

// -----------------------------------------------------------------------
// MODAL DETAIL SLIP
// -----------------------------------------------------------------------
// Daftar pilihan periode untuk dropdown (dipakai kalau cutoffDay > 1):
// 2 periode ke depan + 12 periode ke belakang dari bulan berjalan,
// masing-masing dilabeli langsung dengan rentang tanggal cut-off-nya.
function buildPeriodOptions(centerPeriod, cutoffD) {
  const [cy, cm] = centerPeriod.split("-").map(Number);
  const options = [];
  for (let offset = 2; offset >= -12; offset--) {
    const d = new Date(cy, cm - 1 + offset, 1);
    const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    // Periode yang sudah final pakai rentang yang DIBEKUKAN saat itu, bukan
    // hasil hitung ulang dari cutoff yang berlaku sekarang.
    const frozen = finalizedPeriods[value];
    const { start, end } = frozen
      ? { start: frozen.period_start, end: frozen.period_end }
      : payrollPeriodRange(value, cutoffD);
    options.push({ value, label: `${fmtDate(start)} – ${fmtDate(end)}${frozen ? " 🔒" : ""}` });
  }
  return options;
}

function periodLabel(p) {
  // Kalau pakai cut-off (bukan kalender biasa) ATAU periode ini sudah
  // difinalisasi, tampilkan rentang tanggal aktualnya langsung — nama
  // bulan ("September 2026") gampang disalahartikan karena bisa tidak
  // sama dengan bulan awal periodenya, apalagi kalau sudah dibekukan.
  if ((cutoffDay > 1 || periodInfo) && periodRange.start && periodRange.end) {
    return `${fmtDate(periodRange.start)} – ${fmtDate(periodRange.end)}`;
  }
  const [y, m] = p.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("id-ID", { month: "long", year: "numeric" });
}

function openSlipModal(userId) {
  currentSlip = getSlip(userId);
  renderSlipContent(currentSlip);
  const btnAdjust = document.getElementById("btn-edit-adjust");
  if (btnAdjust) {
    btnAdjust.disabled = !!periodInfo;
    btnAdjust.title = periodInfo ? "Periode ini sudah final — buka kunci dulu untuk mengubah tunjangan/potongan." : "";
  }
  document.getElementById("modal-slip").classList.remove("hidden");
}

function renderSlipContent(s) {
  const e = s.emp;
  document.getElementById("slip-content").innerHTML = `
    <div class="slip-box">
      <div class="slip-header">
        <div>
          <h2>${e.unit_pt || "Slip Gaji"}</h2>
          <p class="muted small" style="margin-top:2px;">Slip Gaji Karyawan</p>
        </div>
        <div class="slip-period">
          <div class="muted small">Periode</div>
          <div style="font-weight:600;">${periodLabel(period)}</div>
        </div>
      </div>

      <div class="slip-emp-grid">
        <div><span class="label">Nama</span>${escapeHtml(e.full_name)}</div>
        <div><span class="label">Kode Karyawan</span>${escapeHtml(e.employee_code || "-")}</div>
        <div><span class="label">Jabatan</span>${escapeHtml(e.position || "-")}</div>
        <div><span class="label">Departemen</span>${escapeHtml(e.department || "-")}${e.bagian ? ` / ${escapeHtml(e.bagian)}` : ""}</div>
        <div><span class="label">Grade / Level</span>${e.grade ? `${escapeHtml(e.grade)} — ${escapeHtml(e.level || "-")}` : "-"}</div>
        <div><span class="label">Status Karyawan</span>${e.status_karyawan === "bulanan" ? "Bulanan" : e.status_karyawan === "harian" ? "Harian" : "Belum diatur"}</div>
        <div><span class="label">Hari Hadir / Telat</span>${s.hariHadir} / ${s.hariTelat}</div>
        <div><span class="label">Jam Lembur (Biasa/Libur)</span>${fmtJam(s.jamLemburBiasa)} / ${fmtJam(s.jamLemburLibur)}</div>
      </div>

      <div class="slip-cols">
        <div class="slip-col">
          <h4>Pendapatan</h4>
          <div class="slip-line"><span>${s.gajiPokokLabel}</span><span>${fmtRupiah(s.gajiPokok)}</span></div>
          <div class="slip-line"><span>Uang Lembur (${fmtJam(s.jamLemburBiasa)} biasa + ${fmtJam(s.jamLemburLibur)} libur)</span><span>${fmtRupiah(s.uangLembur)}</span></div>
          <div class="slip-line"><span>Uang Perjalanan Dinas (${s.adj.hari_dinas || 0} hari)</span><span>${fmtRupiah(s.uangDinas)}</span></div>
          ${s.tunjanganList.map(t => `<div class="slip-line"><span>${escapeHtml(t.nama)}</span><span>${fmtRupiah(t.nominal)}</span></div>`).join("")}
          <div class="slip-line"><span>${escapeHtml(s.adj.keterangan_tunjangan || "Tunjangan Lain")}</span><span>${fmtRupiah(s.tunjanganLain)}</span></div>
          <div class="slip-line total"><span>Total Pendapatan</span><span>${fmtRupiah(s.totalPendapatan)}</span></div>
          ${(s.reimbursement || 0) > 0 ? `<div class="slip-line"><span>Reimbursement (penggantian biaya)</span><span>${fmtRupiah(s.reimbursement)}</span></div>` : ""}
        </div>
        <div class="slip-col">
          <h4>Potongan</h4>
          <div class="slip-line"><span>Denda Keterlambatan</span><span>${fmtRupiah(s.dendaKeterlambatan)}</span></div>
          <div class="slip-line"><span>Denda Pulang Cepat</span><span>${fmtRupiah(s.dendaPulangCepat)}</span></div>
          <div class="slip-line"><span>BPJS Kesehatan (${s.bpjsKesKet || (s.level?.bpjs_kesehatan_karyawan_persen ?? 0) + "%"})</span><span>${fmtRupiah(s.bpjsKesKaryawan)}</span></div>
          <div class="slip-line"><span>BPJS Ketenagakerjaan (${s.bpjsTkKet || (s.level?.bpjs_tk_karyawan_persen ?? 0) + "%"})</span><span>${fmtRupiah(s.bpjsTkKaryawan)}</span></div>
          <div class="slip-line"><span>PPh21 (${s.level?.pph21_persen ?? 0}%)</span><span>${fmtRupiah(s.pph21)}</span></div>
          <div class="slip-line"><span>${escapeHtml(s.adj.keterangan_potongan || "Potongan Lain")}</span><span>${fmtRupiah(s.potonganLain)}</span></div>
          ${(s.potonganKasbon || 0) > 0 ? `<div class="slip-line"><span>Potongan Kasbon</span><span>${fmtRupiah(s.potonganKasbon)}</span></div>` : ""}
          <div class="slip-line total"><span>Total Potongan</span><span>${fmtRupiah(s.totalPotongan)}</span></div>
        </div>
      </div>

      <div class="slip-net">
        <span class="label">Gaji Bersih (Take Home Pay)</span>
        <span class="value">${fmtRupiah(s.gajiBersih)}</span>
      </div>

      ${!s.level ? `<p class="small muted" style="margin-top:16px;">⚠️ Grade/Level karyawan ini belum cocok dengan data di Master Level — denda, lembur, BPJS, PPh21, dan uang dinas dihitung Rp 0. Lengkapi Master Level &amp; Data Karyawan terlebih dahulu.</p>` : ""}
      ${!e.status_karyawan ? `<p class="small muted" style="margin-top:8px;">⚠️ Status Karyawan (Bulanan/Harian) belum diatur di Data Karyawan, sehingga Gaji Pokok belum bisa dihitung.</p>` : ""}
      <p class="small muted" style="margin-top:16px;">Dicetak ${fmtDate(new Date())} — dihasilkan otomatis oleh sistem, tidak memerlukan tanda tangan basah.</p>
    </div>
  `;
}

// -----------------------------------------------------------------------
// PENYESUAIAN MANUAL (payroll_adjustments)
// -----------------------------------------------------------------------
function openAdjustModal(userId) {
  if (!roleFlags.canEditAdjust) { toast("Kamu tidak punya akses untuk mengubah tunjangan/potongan.", "error"); return; }
  if (periodInfo) { toast("Periode ini sudah final — buka kunci dulu untuk mengubah tunjangan/potongan.", "error"); return; }
  const emp = employees.find(e => e.id === userId);
  const adj = adjByUser[userId] || { hari_dinas: 0, tunjangan_lain: 0, keterangan_tunjangan: "", potongan_lain: 0, keterangan_potongan: "" };
  const form = document.getElementById("form-adjust");
  form.dataset.userId = userId;
  form.hari_dinas.value = adj.hari_dinas || 0;
  form.tunjangan_lain.value = adj.tunjangan_lain || 0;
  form.keterangan_tunjangan.value = adj.keterangan_tunjangan || "";
  form.potongan_lain.value = adj.potongan_lain || 0;
  form.keterangan_potongan.value = adj.keterangan_potongan || "";
  document.getElementById("adjust-emp-label").textContent = `${emp.full_name} — ${periodLabel(period)}`;
  document.getElementById("modal-adjust").classList.remove("hidden");
}

async function onSubmitAdjust(e, user) {
  e.preventDefault();
  const form = e.target;
  const userId = form.dataset.userId;
  const fd = new FormData(form);
  const payload = {
    user_id: userId,
    period,
    hari_dinas: Number(fd.get("hari_dinas")) || 0,
    tunjangan_lain: Number(fd.get("tunjangan_lain")) || 0,
    keterangan_tunjangan: fd.get("keterangan_tunjangan") || null,
    potongan_lain: Number(fd.get("potongan_lain")) || 0,
    keterangan_potongan: fd.get("keterangan_potongan") || null,
    updated_by: user.id,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase.from("payroll_adjustments").upsert(payload, { onConflict: "user_id,period" });
  if (error) { toast("Gagal menyimpan: " + error.message, "error"); return; }

  toast("Tunjangan/potongan tersimpan", "success");
  document.getElementById("modal-adjust").classList.add("hidden");

  const { data: adj } = await supabase.from("payroll_adjustments").select("*").eq("period", period);
  adjByUser = {};
  (adj || []).forEach(a => { adjByUser[a.user_id] = a; });

  const emp = employees.find(x => x.id === userId);
  currentSlip = computeSlip(emp);
  renderSlipContent(currentSlip);
  renderSummary();
  renderTable();
}

// -----------------------------------------------------------------------
function doExport() {
  const slips = getSlipList();
  if (!slips.length) { toast("Tidak ada data untuk diexport", "error"); return; }
  const rows = slips.map(s => ({
    "Nama": s.emp.full_name,
    "Kode Karyawan": s.emp.employee_code || "-",
    "Grade": s.emp.grade || "-",
    "Level": s.emp.level || "-",
    "Status": s.emp.status_karyawan || "-",
    "Hari Hadir": s.hariHadir,
    "Hari Telat": s.hariTelat,
    "Jam Lembur Biasa": s.jamLemburBiasa,
    "Jam Lembur Libur": s.jamLemburLibur,
    "Gaji Pokok": s.gajiPokok,
    "Uang Lembur": s.uangLembur,
    "Uang Dinas": s.uangDinas,
    "Tunjangan Tambahan (Total)": s.tunjanganTambahan,
    "Rincian Tunjangan Tambahan": s.tunjanganList.map(t => `${t.nama}: ${fmtRupiah(t.nominal)}`).join("; ") || "-",
    "Tunjangan Lain": s.tunjanganLain,
    "Total Pendapatan": s.totalPendapatan,
    "Denda Keterlambatan": s.dendaKeterlambatan,
    "Denda Pulang Cepat": s.dendaPulangCepat,
    "BPJS Kesehatan": s.bpjsKesKaryawan,
    "BPJS Ketenagakerjaan": s.bpjsTkKaryawan,
    "PPh21": s.pph21,
    "Potongan Lain": s.potonganLain,
    "Potongan Kasbon": s.potonganKasbon || 0,
    "Total Potongan": s.totalPotongan,
    "Reimbursement": s.reimbursement || 0,
    "Gaji Bersih": s.gajiBersih,
    ...(periodInfo && payReady ? {
      "Status Pembayaran": { siap: "Siap", ditahan: "Ditahan", dibayar: "Dibayar" }[s.pay?.pay_status || "siap"],
      "Tanggal Dibayar": s.pay?.paid_at || "",
      "Keterangan": s.pay?.pay_status === "ditahan" ? (s.pay?.hold_reason || "") : (s.pay?.pay_note || ""),
    } : {}),
  }));
  exportXLSX(`slip-gaji-ringkasan-${period}.xlsx`, rows, "Slip Gaji");
}
