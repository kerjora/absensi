-- =====================================================================
-- 027 — SLIP GAJI: AKSI MASSAL TAHAN / RILIS / BATAL BAYAR (1 PANGGILAN)
--
-- Sebelumnya halaman memanggil set_slip_pay_status() satu kali per slip.
-- Untuk ratusan/ribuan karyawan itu lambat. Fungsi ini memproses banyak slip
-- dalam SATU panggilan & satu transaksi.
--
-- Aturan sama dengan set_slip_pay_status():
--   tahan       : siap -> ditahan (alasan wajib)
--   lepas       : ditahan -> siap
--   bayar       : siap/ditahan -> dibayar
--   batal_bayar : dibayar -> siap (hanya Super Admin)
-- Slip yang statusnya tidak cocok DILEWATI (bukan error); hasilnya dilaporkan:
--   { "updated": n, "skipped": m }
-- Akses sama: Super Admin, atau staff dengan menu "slip-gaji" aktif.
-- Setiap baris yang berubah tetap tercatat di audit log (trigger payroll_slips).
--
-- Butuh 026 lebih dulu. Aman dijalankan ulang.
-- =====================================================================

begin;

create or replace function public.set_slip_pay_status_bulk(
  p_items jsonb,              -- [{"period":"2026-11","user_id":"<uuid>"}, ...]
  p_action text,
  p_reason text default null,
  p_paid_at date default null,
  p_note text default null
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_total int;
  v_ids uuid[];
  v_from text[];
  v_done int := 0;
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
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'Daftar slip tidak valid';
  end if;
  v_total := jsonb_array_length(p_items);
  if v_total = 0 then return jsonb_build_object('updated', 0, 'skipped', 0); end if;
  if v_total > 5000 then raise exception 'Terlalu banyak slip sekaligus (maksimal 5000)'; end if;
  if p_action = 'tahan' and v_reason is null then raise exception 'Alasan penahanan wajib diisi'; end if;
  if p_action = 'batal_bayar' and not public.is_super() then
    raise exception 'Hanya Super Admin yang bisa membatalkan status dibayar';
  end if;

  v_from := case p_action
    when 'tahan' then array['siap']
    when 'lepas' then array['ditahan']
    when 'bayar' then array['siap', 'ditahan']
    else array['dibayar']
  end;

  select coalesce(array_agg(s.id), '{}') into v_ids
    from public.payroll_slips s
    join jsonb_to_recordset(p_items) as t(period text, user_id uuid)
      on t.period = s.period and t.user_id = s.user_id
   where s.tenant_id = public.current_tenant_id()
     and s.pay_status = any(v_from);

  if p_action = 'tahan' then
    update public.payroll_slips
       set pay_status = 'ditahan', hold_reason = v_reason, held_by = v_uid, held_at = now(),
           paid_at = null, paid_by = null, pay_note = null
     where id = any(v_ids) and pay_status = any(v_from);
  elsif p_action = 'lepas' then
    update public.payroll_slips
       set pay_status = 'siap', hold_reason = null, held_by = null, held_at = null
     where id = any(v_ids) and pay_status = any(v_from);
  elsif p_action = 'bayar' then
    update public.payroll_slips
       set pay_status = 'dibayar', paid_at = coalesce(p_paid_at, current_date), paid_by = v_uid, pay_note = v_note
     where id = any(v_ids) and pay_status = any(v_from);
  else
    update public.payroll_slips
       set pay_status = 'siap', paid_at = null, paid_by = null, pay_note = null,
           hold_reason = null, held_by = null, held_at = null
     where id = any(v_ids) and pay_status = any(v_from);
  end if;
  get diagnostics v_done = row_count;

  return jsonb_build_object('updated', v_done, 'skipped', v_total - v_done);
end;
$$;

revoke execute on function public.set_slip_pay_status_bulk(jsonb, text, text, date, text) from public, anon;
grant execute on function public.set_slip_pay_status_bulk(jsonb, text, text, date, text) to authenticated;

commit;
