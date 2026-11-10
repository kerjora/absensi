-- =====================================================================
-- 025 — KOREKSI ABSEN MASUK: STATUS TELAT IKUT DIHITUNG ULANG
--
-- MASALAH: saat Koreksi Absen "Lupa Absen Masuk" disetujui,
-- apply_attendance_correction() hanya mengganti kolom check_in. Kolom
-- check_in_status (telat / tepat_waktu) tidak disentuh, sehingga status
-- lama (mis. "Telat" dari jam absen yang salah) tetap tampil walau jam
-- sudah benar (mis. 06.45). Efeknya juga merembet ke laporan, analitik,
-- KPI, dan slip gaji yang menghitung hari telat dari check_in_status.
--
-- PERBAIKAN:
--   1. Fungsi internal _late_status_calc() — logika sama dengan
--      _late_status() (018) tetapi TANPA guard auth.uid(), karena dipanggil
--      dari decide_approval() oleh approver (bukan pemilik baris), dan
--      guard 018 akan mengembalikan null untuk kasus itu.
--   2. apply_attendance_correction() menghitung ulang check_in_status
--      setiap koreksi 'masuk' diterapkan (baris baru maupun yang sudah ada).
--   3. Backfill: baris attendance hasil koreksi masuk yang SUDAH disetujui
--      dihitung ulang statusnya (mis. kasus Muhamad Lutfi, 10 Nov 2026).
--
-- Aman dijalankan ulang.
-- =====================================================================

begin;

create or replace function public._late_status_calc(p_user uuid, p_date date, p_at timestamptz)
returns text language plpgsql stable security definer set search_path = public as $$
declare
  v_tz text;
  v_sched uuid;
  v_tol int := 0;
  v_day record;
  v_cutoff timestamptz;
begin
  select o.timezone into v_tz from public.profiles p
    join public.office_locations o on o.tenant_id = p.tenant_id and o.name = p.lokasi_kerja
   where p.id = p_user limit 1;
  v_tz := coalesce(v_tz, 'Asia/Jakarta');

  select coalesce(
           (select so.schedule_id from public.schedule_overrides so
             where so.user_id = p_user and so.work_date = p_date),
           (select p.schedule_id from public.profiles p where p.id = p_user))
    into v_sched;

  if v_sched is null then
    v_cutoff := ((p_date::timestamp + time '08:15') at time zone v_tz);
    return case when p_at > v_cutoff then 'telat' else 'tepat_waktu' end;
  end if;

  select coalesce(ws.late_tolerance_minutes, 0) into v_tol
    from public.work_schedules ws where ws.id = v_sched;

  select d.is_working_day, d.start_time into v_day
    from public.work_schedule_days d
   where d.schedule_id = v_sched and d.day_of_week = extract(dow from p_date)::int;

  if v_day.is_working_day is not true or v_day.start_time is null then
    return null;  -- hari libur / tanpa acuan: tidak diberi status
  end if;

  v_cutoff := ((p_date::timestamp + v_day.start_time) at time zone v_tz) + make_interval(mins => v_tol);
  return case when p_at > v_cutoff then 'telat' else 'tepat_waktu' end;
end;
$$;
revoke execute on function public._late_status_calc(uuid, date, timestamptz) from public, anon, authenticated;

create or replace function public.apply_attendance_correction(p_request_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_req public.attendance_correction_requests%rowtype;
  v_note text;
  v_status text;
begin
  select * into v_req from public.attendance_correction_requests where id = p_request_id;
  if not found then
    raise exception 'Pengajuan koreksi tidak ditemukan';
  end if;

  v_note := 'Dikoreksi lewat pengajuan koreksi absen (' ||
    case v_req.correction_type when 'masuk' then 'check-in' else 'check-out' end || ' disetujui).';

  if v_req.correction_type = 'masuk' then
    -- Status telat dihitung ulang dari jam hasil koreksi.
    v_status := public._late_status_calc(v_req.user_id, v_req.attendance_date, v_req.corrected_time);

    insert into public.attendance (user_id, date, check_in, check_in_status, notes)
      values (v_req.user_id, v_req.attendance_date, v_req.corrected_time, v_status, v_note)
    on conflict (user_id, date) do update
      set check_in = excluded.check_in,
          check_in_status = excluded.check_in_status,
          notes = coalesce(public.attendance.notes || ' | ', '') || v_note;
  else
    insert into public.attendance (user_id, date, check_out, notes)
      values (v_req.user_id, v_req.attendance_date, v_req.corrected_time, v_note)
    on conflict (user_id, date) do update
      set check_out = excluded.check_out,
          notes = coalesce(public.attendance.notes || ' | ', '') || v_note;
  end if;
end;
$$;
revoke execute on function public.apply_attendance_correction(uuid) from public, anon, authenticated;

-- Backfill: koreksi masuk yang sudah disetujui sebelum perbaikan ini.
-- Hanya baris yang check_in-nya masih sama dengan jam hasil koreksi.
update public.attendance a
   set check_in_status = public._late_status_calc(a.user_id, a.date, a.check_in)
  from public.attendance_correction_requests r
 where r.status = 'approved'
   and r.correction_type = 'masuk'
   and r.user_id = a.user_id
   and r.attendance_date = a.date
   and a.check_in = r.corrected_time
   and a.check_in_status is distinct from public._late_status_calc(a.user_id, a.date, a.check_in);

commit;

-- UJI MANUAL:
--   select a.date, a.check_in, a.check_in_status
--     from attendance a join profiles p on p.id = a.user_id
--    where p.full_name ilike 'MUHAMAD LUTFI' and a.date = '2026-11-10';
--   -> check_in 06:45 WIB harus 'tepat_waktu' (jika jadwal masuk >= 06:45).
