-- =====================================================================
-- 030 — MASTER PT / VENDOR: PPN ATAS DPP NILAI LAIN (11/12)
--
-- Tarif PPN ditulis 12%, tetapi untuk barang/jasa tidak mewah dikenakan
-- atas DPP nilai lain = 11/12 x harga (efektif 11%).
--   ppn_dpp_nilai_lain = true  : PPN = ppn_persen x (11/12 x management fee)
--   ppn_dpp_nilai_lain = false : PPN = ppn_persen x management fee (seperti sebelumnya)
-- Default false: invoice vendor yang sudah ada tidak berubah sampai diatur.
-- Setelah menjalankan ini: di Master PT / Vendor ubah PPN menjadi 12 dan centang
-- "PPN dihitung atas DPP nilai lain (11/12)".
--
-- Aman dijalankan ulang.
-- =====================================================================

begin;

alter table public.master_pt
  add column if not exists ppn_dpp_nilai_lain boolean not null default false;

commit;
