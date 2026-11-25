-- =====================================================================
-- 026 — SLIP GAJI: TAHAN (HOLD) & RILIS / TANDAI DIBAYAR
--
-- KEBUTUHAN: gaji satu karyawan kadang perlu ditahan (mis. karyawan resign
-- yang serah terimanya belum selesai) lalu dirilis belakangan, bahkan setelah
-- periode berikutnya berjalan. Angka slip tetap beku di periodenya.
--
-- STATUS PER SLIP (hanya ada setelah periode difinalisasi):
--   siap     : default setelah finalisasi
--   ditahan  : gaji ditahan (alasan wajib); slip DISEMBUNYIKAN dari karyawan
--   dibayar  : sudah dibayar (tanggal bayar + catatan)
--
-- AKSES:
--   * Ubah status lewat fungsi set_slip_pay_status() — boleh Super Admin, atau
--     staff (super_admin_hr/admin_hr) yang menu "slip-gaji"-nya aktif.
--     Membatalkan status "dibayar" hanya Super Admin.
--   * Karyawan TIDAK bisa membaca slip berstatus 'ditahan' (RLS). Staff tetap
--     bisa melihat semua slip.
--   * Perubahan tercatat di audit log lewat trigger audit payroll_slips yang
--     sudah ada (003).
--
-- Aman dijalankan ulang.
-- =====================================================================

begin;

alter table public.payroll_slips add column if not exists pay_status  text not null default 'siap';
alter table public.payroll_slips add column if not exists hold_reason text;
alter table public.payroll_slips add column if not exists held_by     uuid references public.profiles(id) on delete set null;
alter table public.payroll_slips add column if not exists held_at     timestamptz;
alter table public.payroll_slips add column if not exists paid_at     date;
alter table public.payroll_slips add column if not exists paid_by     uuid references public.profiles(id) on delete set null;
alter table public.payroll_slips add column if not exists pay_note    text;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.payroll_slips'::regclass and conname = 'payroll_slips_pay_status_check') then
    alter table public.payroll_slips
      add constraint payroll_slips_pay_status_check check (pay_status in ('siap', 'ditahan', 'dibayar'));
  end if;
end $$;

comment on column public.payroll_slips.pay_status is 'siap | ditahan | dibayar. Slip ditahan tidak terlihat oleh karyawan pemilik slip.';

create index if not exists idx_payroll_slips_ditahan on public.payroll_slips (tenant_id) where pay_status = 'ditahan';

-- Karyawan tidak boleh membaca slip yang ditahan; staff tetap bisa baca semua.
drop policy if exists "payroll_slips_select" on public.payroll_slips;
create policy "payroll_slips_select" on public.payroll_slips
  for select using ( public.is_staff() or (user_id = auth.uid() and pay_status <> 'ditahan') );

-- ---------------------------------------------------------------------
-- set_slip_pay_status(period, user, action, reason, paid_at, note)
--   action: 'tahan' | 'lepas' | 'bayar' | 'batal_bayar'
--   tahan       : siap -> ditahan (alasan wajib)
--   lepas       : ditahan -> siap
--   bayar       : siap/ditahan -> dibayar (tanggal bayar default hari ini)
--   batal_bayar : dibayar -> siap (hanya Super Admin)
-- Mengembalikan status baru.
-- ---------------------------------------------------------------------
create or replace function public.set_slip_pay_status(
  p_period text, p_user uuid, p_action text,
  p_reason text default null, p_paid_at date default null, p_note text default null
)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_row public.payroll_slips%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if v_uid is null then raise exception 'Belum login'; end if;
  if not (public.is_super() or (public.is_staff() and public.has_menu_access('slip-gaji'))) then
    raise exception 'Tidak punya akses mengelola status pembayaran slip';
  end if;
  if not public.tenant_has_feature('payroll') then
    raise exception 'Fitur payroll tidak aktif untuk paket ini';
  end if;
  if p_action not in ('tahan', 'lepas', 'bayar', 'batal_bayar') then
    raise exception 'Aksi tidak valid';
  end if;

  select * into v_row from public.payroll_slips
   where period = p_period and user_id = p_user and tenant_id = public.current_tenant_id()
   for update;
  if not found then
    raise exception 'Slip tidak ditemukan (periode belum difinalisasi?)';
  end if;

  if p_action = 'tahan' then
    if v_row.pay_status = 'dibayar' then raise exception 'Slip sudah dibayar, tidak bisa ditahan'; end if;
    if v_reason is null then raise exception 'Alasan penahanan wajib diisi'; end if;
    update public.payroll_slips
       set pay_status = 'ditahan', hold_reason = v_reason, held_by = v_uid, held_at = now(),
           paid_at = null, paid_by = null, pay_note = null
     where id = v_row.id;
    return 'ditahan';

  elsif p_action = 'lepas' then
    if v_row.pay_status <> 'ditahan' then raise exception 'Slip tidak sedang ditahan'; end if;
    update public.payroll_slips
       set pay_status = 'siap', hold_reason = null, held_by = null, held_at = null
     where id = v_row.id;
    return 'siap';

  elsif p_action = 'bayar' then
    if v_row.pay_status = 'dibayar' then raise exception 'Slip sudah ditandai dibayar'; end if;
    -- hold_reason/held_* sengaja dibiarkan sebagai jejak (slip dirilis dari status ditahan).
    update public.payroll_slips
       set pay_status = 'dibayar', paid_at = coalesce(p_paid_at, current_date), paid_by = v_uid,
           pay_note = nullif(btrim(coalesce(p_note, '')), '')
     where id = v_row.id;
    return 'dibayar';

  else -- batal_bayar
    if not public.is_super() then raise exception 'Hanya Super Admin yang bisa membatalkan status dibayar'; end if;
    if v_row.pay_status <> 'dibayar' then raise exception 'Slip belum ditandai dibayar'; end if;
    update public.payroll_slips
       set pay_status = 'siap', paid_at = null, paid_by = null, pay_note = null,
           hold_reason = null, held_by = null, held_at = null
     where id = v_row.id;
    return 'siap';
  end if;
end;
$$;

revoke execute on function public.set_slip_pay_status(text, uuid, text, text, date, text) from public, anon;
grant execute on function public.set_slip_pay_status(text, uuid, text, text, date, text) to authenticated;

commit;

-- UJI MANUAL (login sebagai admin, lewat aplikasi atau API):
--   1. Finalisasi sebuah periode -> semua slip berstatus 'siap'.
--   2. Tahan slip karyawan A dengan alasan -> karyawan A (login) tidak melihat slip periode itu.
--   3. Rilis (bayar) -> status 'dibayar' + tanggal bayar; karyawan A melihat slipnya lagi.
--   4. Cek menu Audit Log: ada entri update payroll_slips untuk tiap perubahan.
