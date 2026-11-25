-- =====================================================================
-- 028 — MASTER PT / VENDOR: ATURAN TAGIHAN BPJS PERUSAHAAN PER VENDOR
--
-- Tiap vendor outsourcing punya kontrak berbeda. Tiga pengaturan baru
-- (semua default false = invoice vendor yang sudah ada TIDAK berubah):
--   bpjs_kes_ditagihkan : tagihkan BPJS Kesehatan bagian perusahaan
--   bpjs_tk_ditagihkan  : tagihkan BPJS Ketenagakerjaan bagian perusahaan
--   fee_atas_bpjs       : management fee dihitung dari (gaji + BPJS perusahaan),
--                         bukan dari gaji saja
-- Nominal BPJS perusahaan dihitung di halaman Invoice Outsourcing dari snapshot
-- slip final (upah lapor x % perusahaan di Master Level).
--
-- Aman dijalankan ulang.
-- =====================================================================

begin;

alter table public.master_pt
  add column if not exists bpjs_kes_ditagihkan boolean not null default false,
  add column if not exists bpjs_tk_ditagihkan  boolean not null default false,
  add column if not exists fee_atas_bpjs       boolean not null default false;

commit;
