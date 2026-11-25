-- =====================================================================
-- 029 — MASTER PT / VENDOR: PERSENTASE BPJS PERUSAHAAN DIISI PER VENDOR
--
-- Menggantikan centang "tagihkan BPJS" dari 028. Persentase BPJS yang
-- ditanggung perusahaan untuk tagihan vendor sekarang diisi di Master PT /
-- Vendor (bukan dari Master Level, yang hanya untuk perusahaan sendiri).
--   bpjs_kes_persen : % BPJS Kesehatan  x upah lapor karyawan (0 = tidak ditagihkan)
--   bpjs_tk_persen  : % BPJS Ketenagakerjaan x upah lapor    (0 = tidak ditagihkan)
--   fee_atas_bpjs   : (dari 028) fee dihitung dari gaji + BPJS perusahaan
--
-- Butuh 028 lebih dulu. Aman dijalankan ulang.
-- =====================================================================

begin;

alter table public.master_pt
  add column if not exists bpjs_kes_persen numeric not null default 0 check (bpjs_kes_persen >= 0),
  add column if not exists bpjs_tk_persen  numeric not null default 0 check (bpjs_tk_persen  >= 0);

-- Centang lama dari 028 tidak dipakai lagi.
alter table public.master_pt
  drop column if exists bpjs_kes_ditagihkan,
  drop column if exists bpjs_tk_ditagihkan;

commit;
